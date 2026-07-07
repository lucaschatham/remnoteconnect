#!/usr/bin/env node
import { assert, call, cleanupByText, requireBridge } from "./live-helpers.mjs";

const runId = `__rnc_idempotent__-${Date.now().toString(36)}`;
const externalId = `live:${runId}`;
const documentExternalId = `live-doc:${runId}`;

try {
  await requireBridge();
  const first = await call("createFlashcard", {
    deckPath: runId,
    front: `First ${runId}`,
    back: "Back one",
    externalId,
  });
  const second = await call("createFlashcard", {
    deckPath: runId,
    front: `Second ${runId}`,
    back: "Back two",
    externalId,
  });
  assert(second.id === first.id, "externalId rerun created a duplicate Rem instead of updating.");

  const read = await call("getFlashcard", { id: first.id });
  assert(read.text === `Second ${runId}`, "externalId rerun did not update the existing Rem.");

  const firstDoc = await call("createDocument", {
    markdown: `- First doc ${runId}`,
    parentPath: runId,
    externalId: documentExternalId,
    confirm: true,
  });
  const secondDoc = await call("createDocument", {
    markdown: `- Second doc ${runId}`,
    parentPath: runId,
    externalId: documentExternalId,
    confirm: true,
  });
  assert(secondDoc.id === firstDoc.id, "document externalId rerun created a duplicate Rem instead of updating.");
  const readDoc = await call("getRem", { id: firstDoc.id });
  assert(readDoc.text === `Second doc ${runId}`, "document externalId rerun did not update the existing Rem.");

  const search = await call("searchGraph", { query: `text:"${runId}"` });
  assert(search.count >= 1, "idempotent test search did not find created content.");

  await cleanupByText(runId);
  const residue = await call("searchGraph", { query: `text:"${runId}"` });
  assert(residue.count === 0, "Idempotent test residue remains.");

  console.log(JSON.stringify({ status: "PASS", runId, externalId, remId: first.id }, null, 2));
} catch (error) {
  await cleanupByText(runId);
  console.error(JSON.stringify({ status: "FAIL", runId, message: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
}
