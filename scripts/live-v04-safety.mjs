#!/usr/bin/env node
import { assert, call, cleanupByText, emptyTrashOpId, requireBridge } from "./live-helpers.mjs";

const runId = `__rnc_v04_safety__-${Date.now().toString(36)}`;
let priorReadonly = true;

async function testApproval(action, fromDryRun, confirmCount) {
  const challenge = await call("approveIrreversible", { stage: "challenge", action, fromDryRun, confirmCount });
  const approval = await call("approveIrreversible", {
    stage: "approve",
    action,
    fromDryRun,
    confirmCount,
    challengeId: challenge.challengeId,
    response: challenge.phrase,
  });
  return approval.approvalNonce;
}

async function recursiveTrashRace() {
  const created = await call("createDocument", {
    parentPath: runId,
    confirm: true,
    markdown: `- ${runId} recursive root\n  - ${runId} recursive child`,
  });
  const deleted = await call("deleteRem", { id: created.id, confirm: true });
  const tombstoneOpId = deleted.opId ?? deleted.undo?.opId;
  assert(tombstoneOpId, "Soft delete did not return a tombstone operation ID.");

  const preview = await call("emptyTrash", { tombstoneOpId });
  assert(preview.count >= 2, "emptyTrash preview did not recursively enumerate the fixture descendants.");
  const approvalNonce = await testApproval("emptyTrash", preview.fromDryRun, preview.count);

  await call("appendToDocument", {
    id: created.id,
    confirm: true,
    markdown: `- ${runId} late descendant`,
  });

  const mismatch = await call("emptyTrash", {
    tombstoneOpId,
    confirm: true,
    confirmCount: preview.count,
    fromDryRun: preview.fromDryRun,
    approvalNonce,
  }).catch((error) => error.details);
  assert(mismatch?.code === "dry_run_mismatch", "emptyTrash accepted a stale recursive preview after a descendant was added.");
  await emptyTrashOpId(tombstoneOpId);
  return { previewCount: preview.count, stalePlanCode: mismatch.code };
}

async function richTextNormalization() {
  const reference = await call("createRem", { parentPath: runId, text: `${runId} reference target` });
  const imageUrl = `https://example.com/${runId}.png`;
  const latex = `x_${runId.length}^2`;
  const created = await call("createDocument", {
    parentPath: runId,
    confirm: true,
    docSpec: {
      richText: {
        segments: [
          { type: "text", text: "  Bold   words  ", formats: ["bold"] },
          { type: "rem", id: reference.id },
          { type: "text", text: "  tail   text  " },
          { type: "latex", text: latex },
          { type: "image", url: imageUrl, width: 120, height: 80 },
        ],
      },
    },
  });
  const before = await call("exportSubtree", { id: created.id });
  const preview = await call("normalizeText", { id: created.id });
  assert(preview.count === 1 && preview.changes?.length === 1, "normalizeText preview did not enumerate the exact changed Rem.");
  assert(preview.changes[0].beforeHash !== preview.changes[0].afterHash, "normalizeText preview hashes did not describe a change.");

  const normalized = await call("normalizeText", { id: created.id, confirm: true });
  const after = await call("exportSubtree", { id: created.id });
  const beforeRichText = JSON.stringify(before.nodes?.[0]?.richText ?? null);
  const afterRichText = JSON.stringify(after.nodes?.[0]?.richText ?? null);
  for (const marker of [reference.id, latex, imageUrl, '"b":true']) {
    assert(beforeRichText.includes(marker), `Rich-text fixture did not materialize marker ${marker}.`);
    assert(afterRichText.includes(marker), `normalizeText lost rich-text marker ${marker}.`);
  }
  assert(normalized.undo?.opId, "normalizeText did not return write-ahead undo metadata.");
  await call("undo", { opId: normalized.undo.opId });
  return { normalizedId: created.id, planHash: normalized.planHash };
}

async function snapshotTags() {
  const tagName = `${runId}-tag`;
  const source = await call("createFlashcard", {
    deckPath: runId,
    front: `${runId} tagged source`,
    back: `${runId} tagged answer`,
    tags: [tagName],
  });
  const snapshot = await call("exportSubtree", { id: source.id });
  const sourceTagIds = (snapshot.nodes?.[0]?.tags ?? []).map((tag) => tag.id);
  assert(sourceTagIds.length === 1, "Snapshot fixture did not capture its tag association.");

  const restored = await call("importSnapshot", { snapshot, parentPath: runId, confirm: true });
  const copy = await call("exportSubtree", { id: restored.remIds[0] });
  const restoredTagIds = (copy.nodes?.[0]?.tags ?? []).map((tag) => tag.id);
  assert(sourceTagIds.every((id) => restoredTagIds.includes(id)), "Snapshot copy restoration did not preserve tag associations.");
  return { tagId: sourceTagIds[0], restoredId: restored.remIds[0] };
}

try {
  const status = await requireBridge();
  priorReadonly = status.readonlyMode === true;
  await call("readonly", { mode: "off" });
  const trash = await recursiveTrashRace();
  const normalization = await richTextNormalization();
  const tags = await snapshotTags();
  await cleanupByText(runId);
  const residue = await call("searchGraph", { query: `text:"${runId}"` });
  assert(residue.count === 0, "v0.4 live safety test residue remains.");
  if (priorReadonly) await call("readonly", { mode: "on" });
  console.log(JSON.stringify({ status: "PASS", runId, trash, normalization, tags }, null, 2));
} catch (error) {
  await call("readonly", { mode: "off" }).catch(() => undefined);
  await cleanupByText(runId).catch(() => undefined);
  if (priorReadonly) await call("readonly", { mode: "on" }).catch(() => undefined);
  console.error(JSON.stringify({ status: "FAIL", runId, message: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
}
