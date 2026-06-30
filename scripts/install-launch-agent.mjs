#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const command = process.argv[2] ?? "install";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const label = "com.local.remnoteconnect.daemon";
const plistPath = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
const appDir = join(homedir(), "Library", "Application Support", "RemNoteConnect");
const runtimeDir = join(appDir, "runtime");
const node = process.env.NODE_BIN ?? process.execPath;
const guiTarget = `gui/${process.getuid?.() ?? ""}/${label}`;

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

function installRuntime() {
  const pluginDist = join(root, "plugin", "dist");
  if (!existsSync(pluginDist)) {
    console.error("plugin/dist is missing. Run `npx pnpm@11.7.0 -r build` before installing the LaunchAgent.");
    process.exit(1);
  }
  rmSync(runtimeDir, { recursive: true, force: true });
  mkdirSync(appDir, { recursive: true });
  const deployed = spawnSync(
    "npx",
    ["pnpm@11.7.0", "--config.confirmModulesPurge=false", "--filter", "@remnoteconnect/daemon", "deploy", "--legacy", "--prod", runtimeDir],
    { cwd: root, stdio: "inherit", env: { ...process.env, CI: "true", PNPM_CONFIG_CONFIRM_MODULES_PURGE: "false" } },
  );
  if (deployed.status !== 0) process.exit(deployed.status ?? 1);
  cpSync(pluginDist, join(runtimeDir, "plugin", "dist"), { recursive: true });
}

if (command === "install") {
  installRuntime();
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(plistPath, plist(), "utf8");
  console.log(JSON.stringify({ status: "installed", plistPath, runtimeDir, load: `launchctl bootstrap gui/$(id -u) ${plistPath}` }, null, 2));
} else if (command === "check") {
  const result = launchctl(["print", guiTarget]);
  console.log(
    JSON.stringify(
      {
        plistPath,
        plistExists: existsSync(plistPath),
        runtimeExists: existsSync(runtimeDir),
        loaded: result.status === 0,
        label,
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
