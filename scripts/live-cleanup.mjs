#!/usr/bin/env node
import { assert, call, cleanupByText, requireBridge } from "./live-helpers.mjs";

const runId = `__rnc_cleanup__-${Date.now().toString(36)}`;

try {
  await requireBridge();
  await call("createDocument", {
    markdown: `- ${runId} Duplicate\n- ${runId} Duplicate\n- ${runId} Unique`,
    parentPath: runId,
    confirm: true,
  });

  const duplicates = await call("findDuplicates", {});
  const duplicateGroup = duplicates.groups.find((group) => group.text.includes(runId.toLowerCase()) && group.count >= 2);
  assert(
    duplicateGroup,
    "findDuplicates did not find seeded duplicate Rem.",
  );
  const [keepId, mergeId] = duplicateGroup.remIds;
  assert(keepId && mergeId, "Duplicate group did not return mergeable IDs.");

  const dryRun = await call("mergeRems", { keepId, mergeIds: [mergeId] });
  assert(dryRun.dryRun === true && dryRun.count === 1, "mergeRems did not default to a one-target dry-run.");

  const merged = await call("mergeRems", { keepId, mergeIds: [mergeId], confirm: true });
  const opId = merged.undo?.opId ?? merged.opId;
  assert(opId, "mergeRems did not return undo metadata.");

  const undone = await call("undo", { opId });
  assert(undone.count >= 1, "mergeRems undo did not restore any Rem.");

  const structuralWithoutHash = await call("mergeRems", { keepId, mergeIds: [mergeId], structural: true, confirm: true }).catch(
    (error) => error.details,
  );
  assert(structuralWithoutHash?.code === "experimental_disabled", "Structural merge was not rejected as experimental.");

  await cleanupByText(runId);
  const residue = await call("searchGraph", { query: `text:"${runId}"` });
  assert(residue.count === 0, "Cleanup test residue remains.");

  console.log(JSON.stringify({ status: "PASS", runId, duplicateGroups: duplicates.count, mergeOpId: opId }, null, 2));
} catch (error) {
  await cleanupByText(runId);
  console.error(JSON.stringify({ status: "FAIL", runId, message: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
}
