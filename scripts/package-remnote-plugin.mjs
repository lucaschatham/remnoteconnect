#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PUBLIC_PLUGIN_ID = "remnoteconnect-local-v3";
export const PUBLIC_PLUGIN_NAME = "RemNoteConnect";
export const REQUIRED_PLUGIN_FILES = Object.freeze([
  "index.html",
  "index.js",
  "README.md",
  "snippet.css",
  "manifest.json",
]);

function manifestVersion(version) {
  if (!version || typeof version !== "object") return undefined;
  const { major, minor, patch } = version;
  if (![major, minor, patch].every(Number.isInteger)) return undefined;
  return `${major}.${minor}.${patch}`;
}

export function releaseArchiveName(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid release version: ${version}`);
  return `RemNoteConnect-v${version}-remnote-plugin.zip`;
}

export function validateReleaseInputs({
  manifest,
  buildInfo,
  packageVersion,
  headCommit,
  distFiles,
}) {
  if (manifest?.id !== PUBLIC_PLUGIN_ID) {
    throw new Error(`Expected public plugin ID ${PUBLIC_PLUGIN_ID}.`);
  }
  if (manifest?.name !== PUBLIC_PLUGIN_NAME) {
    throw new Error(`Expected public plugin name ${PUBLIC_PLUGIN_NAME}.`);
  }
  if (manifestVersion(manifest?.version) !== packageVersion) {
    throw new Error("Plugin manifest version must match the package version.");
  }
  if (buildInfo?.version !== packageVersion || buildInfo?.clean !== true) {
    throw new Error("Plugin output must come from a clean release build with the package version.");
  }
  if (buildInfo?.commit !== headCommit) {
    throw new Error("Plugin release build must match the current Git commit.");
  }
  const expectedBuildHash = `v${packageVersion}+git.${headCommit.slice(0, 12).toLowerCase()}`;
  if (buildInfo?.buildHash !== expectedBuildHash) {
    throw new Error("Plugin release build hash does not match its version and Git commit.");
  }
  for (const file of REQUIRED_PLUGIN_FILES) {
    if (!distFiles.includes(file)) throw new Error(`Plugin release is missing ${file}.`);
  }
}

export function packageRemNotePlugin(root = resolve(fileURLToPath(new URL("..", import.meta.url)))) {
  const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const distDir = join(root, "plugin", "dist");
  const manifest = JSON.parse(readFileSync(join(distDir, "manifest.json"), "utf8"));
  const buildInfo = JSON.parse(readFileSync(join(distDir, "build-info.json"), "utf8"));
  const headCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
  if (dirty) throw new Error("Plugin packaging requires a clean Git worktree.");
  validateReleaseInputs({
    manifest,
    buildInfo,
    packageVersion,
    headCommit,
    distFiles: readdirSync(distDir),
  });

  const artifactsDir = join(root, ".artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  const archive = join(artifactsDir, releaseArchiveName(packageVersion));
  if (existsSync(archive)) unlinkSync(archive);
  execFileSync("zip", ["-X", "-q", archive, ...REQUIRED_PLUGIN_FILES], { cwd: distDir });
  return { archive, version: packageVersion, pluginId: manifest.id, pluginName: manifest.name, buildHash: buildInfo.buildHash };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  try {
    console.log(JSON.stringify(packageRemNotePlugin(), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
