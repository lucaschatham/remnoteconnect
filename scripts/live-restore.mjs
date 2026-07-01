#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hardDeleteTestIds } from "./live-helpers.mjs";

const tokenPath =
  process.env.REMNOTE_CONNECT_TOKEN_FILE ??
  join(homedir(), "Library", "Application Support", "RemNoteConnect", "token");
const token = process.env.REMNOTE_CONNECT_TOKEN ?? readFileSync(tokenPath, "utf8").trim();
const url = process.env.REMNOTE_CONNECT_URL ?? "http://127.0.0.1:8766";
const runId = `__codex_restore__-${Date.now().toString(36)}`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function call(action, params = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, version: 1, params }),
  });
  const body = await response.json();
  if (!response.ok || body.error) throw new Error(`${action} failed: ${JSON.stringify(body.error ?? body)}`);
  return body.result;
}

async function cleanup() {
  try {
    const residue = await call("searchGraph", { query: `text:"${runId}"` });
    await hardDeleteTestIds(residue.remIds ?? residue.ids ?? [], `${runId}-cleanup`);
  } catch {
    // Best effort cleanup.
  }
}

try {
  const status = await call("status");
  assert(status.bridge?.connected === true, "Bridge is not connected.");

  const front = `Restore front ${runId}`;
  const back = `Restore back ${runId}`;
  const created = await call("createFlashcard", { deckPath: runId, front, back, batchId: runId, tags: ["codex-restore"] });

  const snapshot = await call("exportSubtree", { id: created.id });
  assert(snapshot.nodeCount === 1, "exportSubtree did not snapshot one Rem.");

  const restored = await call("importSnapshot", { snapshot, parentPath: runId, confirm: true });
  assert(restored.count === 1, "importSnapshot did not restore one top-level Rem.");
  const restoredId = restored.remIds[0];
  assert(restoredId && restoredId !== created.id, "importSnapshot did not create a copy with a new ID.");

  const read = await call("getFlashcard", { id: restoredId });
  assert(read.text === front, "Restored front did not match.");
  assert(read.backText === back, "Restored back did not match.");

  await cleanup();
  const residue = await call("searchGraph", { query: `text:"${runId}"` });
  assert(residue.count === 0, "Restore test residue remains.");

  console.log(JSON.stringify({ status: "PASS", runId, originalId: created.id, restoredId }, null, 2));
} catch (error) {
  await cleanup();
  console.error(JSON.stringify({ status: "FAIL", runId, message: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
}
