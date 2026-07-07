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

const runId = `__rnc_e2e__-${Date.now().toString(36)}`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function call(action, params = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ action, version: 1, params }),
  });
  const body = await response.json();
  if (!response.ok || body.error) {
    throw new Error(`${action} failed: ${JSON.stringify(body.error ?? body)}`);
  }
  return body.result;
}

async function pollBridgeConnected() {
  const deadline = Date.now() + 20_000;
  let lastStatus;
  while (Date.now() < deadline) {
    lastStatus = await call("status");
    if (lastStatus.bridge?.connected === true) return lastStatus;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`RemNote plugin bridge is not connected after 20s. Last status: ${JSON.stringify(lastStatus?.bridge ?? null)}`);
}

async function cleanup() {
  try {
    const residue = await call("searchGraph", { query: `text:"${runId}"` });
    await hardDeleteTestIds(residue.remIds ?? residue.ids ?? [], `${runId}-cleanup`);
  } catch {
    // Best-effort cleanup only; the main assertion failure is reported separately.
  }
}

try {
  await pollBridgeConnected();

  const front = `Codex E2E front ${runId}`;
  const back = `Codex E2E back ${runId}`;
  const created = await call("createFlashcard", {
    deckPath: runId,
    front,
    back,
    tags: ["rnc-e2e"],
    batchId: runId,
  });

  const read = await call("getFlashcard", { id: created.id });
  assert(read.text === front, "getFlashcard front did not match");
  assert(read.backText === back, "getFlashcard back did not match");

  const byId = await call("searchFlashcards", { query: `id:${created.id}` });
  assert(byId.count === 1 && byId.remIds.includes(created.id), "searchFlashcards id:<remId> did not return exactly the created card");

  const byText = await call("searchFlashcards", { query: `text:"${front}"` });
  assert(byText.remIds.includes(created.id), "searchFlashcards text query did not include the created card");

  const dryRun = await call("deleteRem", { id: created.id });
  assert(dryRun.dryRun === true && dryRun.count === 1 && dryRun.remIds.includes(created.id), "deleteRem default dry-run did not return the exact target");

  const deleted = await call("deleteRem", { id: created.id, confirm: true, opId: `${runId}-delete` });
  assert(deleted.count === 1 && deleted.remIds.includes(created.id), "deleteRem confirm did not tombstone the exact target");
  assert(deleted.undo?.opId === `${runId}-delete`, "delete response did not include stored undo metadata");

  const undo = await call("undo", { opId: deleted.undo.opId });
  assert(undo.restored.includes(created.id), "undo did not restore the soft-deleted Rem");

  await cleanup();
  const residue = await call("searchGraph", { query: `text:"${runId}"` });
  assert(residue.count === 0, "E2E disposable residue remains after cleanup");

  console.log(
    JSON.stringify(
      {
        status: "PASS",
        runId,
        createdRemId: created.id,
        undoOpId: deleted.undo.opId,
      },
      null,
      2,
    ),
  );
} catch (error) {
  await cleanup();
  console.error(JSON.stringify({ status: "FAIL", runId, message: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
}
