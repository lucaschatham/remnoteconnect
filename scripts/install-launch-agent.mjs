#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { chooseNodeRuntime, pnpmInvocation, validateBuildPair } from "./install-utils.mjs";

const command = process.argv[2] ?? "install";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const label = "com.local.remnoteconnect.daemon";
const plistPath = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
const appDir = join(homedir(), "Library", "Application Support", "RemNoteConnect");
const runtimeDir = join(appDir, "runtime");
const nodeRuntime = defaultNodeRuntime();
const node = nodeRuntime.path;
const pnpm = defaultPnpmInvocation();
const guiTarget = `gui/${process.getuid?.() ?? ""}/${label}`;

function commandPath(name) {
  const found = spawnSync("/bin/zsh", ["-lc", `command -v ${name}`], { encoding: "utf8" });
  return found.status === 0 ? found.stdout.trim() || undefined : undefined;
}

function nodeCandidate(path) {
  if (!path || !existsSync(path)) return undefined;
  const checked = spawnSync(path, ["--version"], { encoding: "utf8" });
  if (checked.status !== 0) return undefined;
  return { path, version: checked.stdout.trim() };
}

function defaultNodeRuntime() {
  const explicit = process.env.NODE_BIN;
  const paths = explicit
    ? [explicit]
    : [
        "/opt/homebrew/opt/node@24/bin/node",
        "/usr/local/opt/node@24/bin/node",
        "/opt/homebrew/opt/node@22/bin/node",
        "/usr/local/opt/node@22/bin/node",
        process.execPath,
        commandPath("node"),
      ];
  return chooseNodeRuntime(paths.map(nodeCandidate).filter(Boolean));
}

function defaultPnpmInvocation() {
  return pnpmInvocation({
    explicit: process.env.PNPM_BIN,
    pnpmPath: commandPath("pnpm"),
    npxPath: commandPath("npx"),
  });
}

function runPnpm(args, options = {}) {
  return spawnSync(pnpm.command, [...pnpm.prefix, ...args], options);
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function plist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${label}</string>
    <key>WorkingDirectory</key>
    <string>${runtimeDir}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${escapeXml(node)}</string>
      <string>dist/index.js</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${homedir()}/Library/Logs/remnoteconnect-daemon.out.log</string>
    <key>StandardErrorPath</key>
    <string>${homedir()}/Library/Logs/remnoteconnect-daemon.err.log</string>
  </dict>
</plist>
`;
}

function launchctl(args) {
  return spawnSync("launchctl", args, { encoding: "utf8" });
}

function rotateLog(path, keep = 5) {
  for (let index = keep; index >= 1; index -= 1) {
    const source = index === 1 ? path : `${path}.${index - 1}`;
    const destination = `${path}.${index}`;
    if (!existsSync(source)) continue;
    rmSync(destination, { force: true });
    renameSync(source, destination);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function validateStagedRuntime(stagingDir) {
  const deployedPackage = readJson(join(stagingDir, "package.json"));
  const daemonBuild = readJson(join(stagingDir, "dist", "build-info.json"));
  const pluginBuild = readJson(join(stagingDir, "plugin", "dist", "build-info.json"));
  const build = validateBuildPair(daemonBuild, pluginBuild, deployedPackage.version);
  const syntax = spawnSync(node, ["--check", join(stagingDir, "dist", "index.js")], { encoding: "utf8" });
  if (syntax.status !== 0) throw new Error(syntax.stderr || "Staged daemon entry point failed `node --check`.");
  return build;
}

function installRuntime() {
  const pluginDist = join(root, "plugin", "dist");
  const stagingDir = `${runtimeDir}.staging-${process.pid}`;
  if (!existsSync(pluginDist)) {
    console.error("plugin/dist is missing. Run `npx pnpm@11.7.0 -r build` before installing the LaunchAgent.");
    process.exit(1);
  }
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(appDir, { recursive: true });
  const deployed = runPnpm(
    ["--config.confirmModulesPurge=false", "--filter", "@remnoteconnect/daemon", "deploy", "--legacy", stagingDir],
    { cwd: root, stdio: "inherit", env: { ...process.env, CI: "true", PNPM_CONFIG_CONFIRM_MODULES_PURGE: "false" } },
  );
  if (deployed.status !== 0) {
    rmSync(stagingDir, { recursive: true, force: true });
    if (deployed.error) console.error(`Failed to invoke pnpm at ${pnpm.command}: ${deployed.error.message}`);
    process.exit(deployed.status ?? 1);
  }
  const packagePath = join(stagingDir, "package.json");
  const deployedPackage = JSON.parse(readFileSync(packagePath, "utf8"));
  const deployedShared = join(stagingDir, "node_modules", "@remnoteconnect", "shared");
  const stagedShared = join(stagingDir, "shared");
  cpSync(deployedShared, stagedShared, { recursive: true, dereference: true });
  writeFileSync(
    packagePath,
    `${JSON.stringify(
      {
        name: deployedPackage.name,
        version: deployedPackage.version,
        private: true,
        type: "module",
        dependencies: { ...deployedPackage.dependencies, "@remnoteconnect/shared": "file:./shared" },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(join(stagingDir, "pnpm-workspace.yaml"), 'packages:\n  - "."\nallowBuilds:\n  esbuild: true\n', "utf8");
  const pruned = runPnpm(
    ["--dir", stagingDir, "prune", "--prod", "--ignore-scripts"],
    { stdio: "inherit", env: { ...process.env, CI: "true", PNPM_CONFIG_CONFIRM_MODULES_PURGE: "false" } },
  );
  if (pruned.status !== 0) {
    rmSync(stagingDir, { recursive: true, force: true });
    if (pruned.error) console.error(`Failed to prune the staged runtime: ${pruned.error.message}`);
    process.exit(pruned.status ?? 1);
  }
  for (const relative of ["src", "test", "tsconfig.json", "vitest.config.ts", "pnpm-workspace.yaml", "shared/src", "shared/tsconfig.json"]) {
    rmSync(join(stagingDir, relative), { recursive: true, force: true });
  }
  cpSync(pluginDist, join(stagingDir, "plugin", "dist"), { recursive: true });
  try {
    return { stagingDir, build: validateStagedRuntime(stagingDir) };
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

if (command === "install") {
  const { stagingDir, build } = installRuntime();
  const previousDir = `${runtimeDir}.previous`;
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(plistPath, plist(), "utf8");
  launchctl(["bootout", `gui/${process.getuid?.() ?? ""}`, plistPath]);
  rotateLog(join(homedir(), "Library", "Logs", "remnoteconnect-daemon.out.log"));
  rotateLog(join(homedir(), "Library", "Logs", "remnoteconnect-daemon.err.log"));
  rmSync(previousDir, { recursive: true, force: true });
  if (existsSync(runtimeDir)) renameSync(runtimeDir, previousDir);
  renameSync(stagingDir, runtimeDir);

  const loaded = launchctl(["bootstrap", `gui/${process.getuid?.() ?? ""}`, plistPath]);
  if (loaded.status !== 0) {
    rmSync(runtimeDir, { recursive: true, force: true });
    if (existsSync(previousDir)) renameSync(previousDir, runtimeDir);
    launchctl(["bootstrap", `gui/${process.getuid?.() ?? ""}`, plistPath]);
    console.error(loaded.stderr || loaded.stdout || "Failed to start the RemNoteConnect LaunchAgent.");
    process.exit(1);
  }
  console.log(JSON.stringify({
    status: "installed",
    plistPath,
    runtimeDir,
    rollbackRuntime: existsSync(previousDir) ? previousDir : undefined,
    loaded: true,
    node: nodeRuntime,
    build,
  }, null, 2));
} else if (command === "check") {
  const result = launchctl(["print", guiTarget]);
  let build;
  try {
    build = readJson(join(runtimeDir, "dist", "build-info.json"));
  } catch {
    build = undefined;
  }
  console.log(
    JSON.stringify(
      {
        plistPath,
        plistExists: existsSync(plistPath),
        runtimeExists: existsSync(runtimeDir),
        loaded: result.status === 0,
        label,
        node: nodeRuntime,
        build,
      },
      null,
      2,
    ),
  );
} else if (command === "uninstall") {
  launchctl(["bootout", `gui/${process.getuid?.() ?? ""}`, plistPath]);
  rmSync(plistPath, { force: true });
  console.log(JSON.stringify({ status: "uninstalled", plistPath }, null, 2));
} else {
  console.error("Usage: node scripts/install-launch-agent.mjs [install|check|uninstall]");
  process.exit(2);
}
