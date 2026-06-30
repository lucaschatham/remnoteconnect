#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const roots = [
  "daemon/src",
  "daemon/test",
  "plugin/src",
  "plugin/test",
  "plugin/public",
  "plugin/dist",
  "shared/src",
  "scripts",
  "docs",
];
const files = ["package.json", "daemon/package.json", "plugin/package.json", "shared/package.json"];
const tokenPattern = /(?<![a-fA-F0-9])[a-fA-F0-9]{64}(?![a-fA-F0-9])/;
const rootDir = new URL("..", import.meta.url).pathname;

function walk(path) {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((entry) => walk(join(path, entry)));
}

for (const root of roots) {
  try {
    files.push(...walk(join(rootDir, root)));
  } catch {
    // Missing optional dirs are fine.
  }
}

const matches = [];
for (const file of files) {
  const path = file.startsWith("/") ? file : join(rootDir, file);
  try {
    if (statSync(path).isDirectory()) continue;
    const body = readFileSync(path, "utf8");
    if (tokenPattern.test(body)) matches.push(path.replace(`${rootDir}/`, ""));
  } catch {
    // Ignore binary or deleted files.
  }
}

if (matches.length > 0) {
  console.error(`Potential 64-hex token found in:\n${matches.join("\n")}`);
  process.exit(1);
}

console.log("No standalone 64-hex tokens found in checked project files.");
