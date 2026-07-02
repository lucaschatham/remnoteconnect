#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const rootDir = new URL("..", import.meta.url).pathname;
const failures = [];

function read(path) {
  return readFileSync(join(rootDir, path), "utf8");
}

function check(name, condition, detail) {
  if (!condition) failures.push(`${name}: ${detail}`);
}

const shared = read("shared/src/index.ts");
const executor = read("plugin/src/executor.ts");
const server = read("daemon/src/server.ts");
const bridgeClient = read("plugin/src/bridgeClient.ts");
const manifest = JSON.parse(read("plugin/public/manifest.json"));

check("readonly-error-code", shared.includes('| "readonly_mode"'), "shared ErrorCode must include readonly_mode.");
check("readonly-metadata", shared.includes("readonly: action({") && shared.includes('cliName: "readonly"'), "readonly must be discoverable in action metadata.");
check("daemon-readonly-guard", server.includes("isBlockedByReadonly") && server.includes("readonlyMode"), "daemon must own the read-only guard.");
check("plugin-build-handshake", bridgeClient.includes("pluginBuildHash") && bridgeClient.includes("BUILD_HASH"), "plugin must report its build hash in hello.");
check("plugin-health-panel", bridgeClient.includes("renderHealth()") && bridgeClient.includes("All scope"), "plugin must render visible connection health.");

const scopes = Array.isArray(manifest.requiredScopes) ? manifest.requiredScopes : [];
check(
  "manifest-all-scope",
  scopes.some((scope) => scope?.type === "All" && scope?.level === "ReadCreateModifyDelete"),
  "plugin manifest must request All / ReadCreateModifyDelete for whole-KB mode.",
);

const remRemoveMatches = [...executor.matchAll(/await\s+rem\.remove\(\)/g)];
check("hard-delete-single-path", remRemoveMatches.length === 1, `expected exactly one rem.remove path, found ${remRemoveMatches.length}.`);
const removeIndex = remRemoveMatches[0]?.index ?? -1;
const functionIndex = executor.indexOf("async function removeRemTree");
const emptyTrashIndex = executor.indexOf('case "emptyTrash"');
check(
  "hard-delete-helper-only",
  functionIndex >= 0 && removeIndex > functionIndex && emptyTrashIndex > functionIndex,
  "rem.remove must stay isolated in removeRemTree and reachable only from emptyTrash.",
);
check(
  "card-delete-irreversible-gate",
  executor.includes("deleteFlashcards") && executor.includes("params.irreversibleVerified !== true") && executor.includes("await card.remove()"),
  "card.remove must remain behind daemon irreversible verification.",
);
check("no-graph-externalid-tags", !executor.includes("rnc:externalId"), "externalId idempotency must not write rnc:externalId tags into the graph.");

if (existsSync(join(rootDir, "scripts/check-no-token.mjs"))) {
  try {
    execFileSync(process.execPath, [join(rootDir, "scripts/check-no-token.mjs")], { cwd: rootDir, stdio: "pipe" });
  } catch (error) {
    failures.push(`token-scan: ${String(error.stdout ?? "")}${String(error.stderr ?? "")}`.trim());
  }
}

if (failures.length > 0) {
  console.error(`Static red-team checks failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}

console.log("Static red-team checks passed.");
