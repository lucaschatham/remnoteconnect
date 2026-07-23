#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const BUILD_MARKER = "__REMNOTE_CONNECT_BUILD_HASH__";

export function buildIdentity(version, commit) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid release version: ${version}`);
  if (!/^[a-f0-9]{40}$/i.test(commit)) throw new Error(`Invalid Git commit: ${commit}`);
  return `v${version}+git.${commit.slice(0, 12).toLowerCase()}`;
}

export function replaceBuildMarker(content, buildHash) {
  const count = content.split(BUILD_MARKER).length - 1;
  return { content: content.split(BUILD_MARKER).join(buildHash), count };
}

export function releaseRoot(moduleUrl = import.meta.url) {
  return resolve(fileURLToPath(new URL("..", moduleUrl)));
}

function filesUnder(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function runBuild(root) {
  const result = spawnSync(
    process.env.NPX_BIN ?? "npx",
    ["--yes", "pnpm@11.7.0", "-r", "--filter", "@remnoteconnect/shared", "--filter", "@remnoteconnect/daemon", "--filter", "@remnoteconnect/plugin", "build"],
    { cwd: root, stdio: "inherit" },
  );
  if (result.status !== 0) {
    if (result.error) throw result.error;
    throw new Error(`Package build failed with exit code ${result.status ?? "unknown"}.`);
  }
}

export function createReleaseBuild(root = releaseRoot()) {
  const dirty = git(root, ["status", "--porcelain"]);
  if (dirty) {
    throw new Error("Release builds require a clean Git worktree. Commit the intended source state first.");
  }
  const commit = git(root, ["rev-parse", "HEAD"]);
  const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const buildHash = buildIdentity(rootPackage.version, commit);

  runBuild(root);

  let replacements = 0;
  for (const distDir of ["shared/dist", "daemon/dist", "plugin/dist"]) {
    for (const path of filesUnder(join(root, distDir))) {
      if (!/\.(?:js|mjs|cjs|html|json)$/.test(path)) continue;
      const original = readFileSync(path, "utf8");
      const replaced = replaceBuildMarker(original, buildHash);
      if (replaced.count === 0) continue;
      writeFileSync(path, replaced.content, "utf8");
      replacements += replaced.count;
    }
  }
  if (replacements < 2) {
    throw new Error(`Expected build markers in shared and plugin output, found ${replacements}.`);
  }

  const buildInfo = `${JSON.stringify(
    {
      version: rootPackage.version,
      buildHash,
      commit,
      builtAt: new Date().toISOString(),
      clean: true,
    },
    null,
    2,
  )}\n`;
  writeFileSync(join(root, "daemon", "dist", "build-info.json"), buildInfo, "utf8");
  writeFileSync(join(root, "plugin", "dist", "build-info.json"), buildInfo, "utf8");
  return { version: rootPackage.version, buildHash, commit, replacements };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  try {
    console.log(JSON.stringify(createReleaseBuild(), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
