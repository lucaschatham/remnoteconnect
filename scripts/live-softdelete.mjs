#!/usr/bin/env node
import { assert, call, cleanupByText, hardDeleteTestIds, requireBridge } from "./live-helpers.mjs";

const runId = `__codex_softdelete__-${Date.now().toString(36)}`;

try {
  await requireBridge();
  const created = await call("createFlashcard", {
    deckPath: runId,
    front: `Soft delete front ${runId}`,
    back: `Soft delete back ${runId}`,
  });

  const deleted = await call("deleteRem", { id: created.id, confirm: true, opId: `${runId}-delete` });
  assert(deleted.undo?.opId === `${runId}-delete`, "Soft delete did not store undo metadata.");

  const afterDelete = await call("searchGraph", { query: `id:${created.id}` });
  assert(afterDelete.count === 1, "Soft-deleted Rem ID was not still resolvable.");

  const undo = await call("undo", { opId: deleted.undo.opId });
  assert(undo.restored.includes(created.id), "Undo did not restore soft-deleted Rem.");

  await cleanupByText(runId);
  const residue = await call("searchGraph", { query: `text:"${runId}"` });
  assert(residue.count === 0, "Soft-delete test residue remains.");

  console.log(JSON.stringify({ status: "PASS", runId, remId: created.id, opId: deleted.undo.opId }, null, 2));
} catch (error) {
  await cleanupByText(runId);
  console.error(JSON.stringify({ status: "FAIL", runId, message: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
}
