import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const tokenPath =
  process.env.REMNOTE_CONNECT_TOKEN_FILE ??
  join(homedir(), "Library", "Application Support", "RemNoteConnect", "token");
export const token = process.env.REMNOTE_CONNECT_TOKEN ?? readFileSync(tokenPath, "utf8").trim();
export const url = process.env.REMNOTE_CONNECT_URL ?? "http://127.0.0.1:8766";

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function call(action, params = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, version: 1, params }),
  });
  const body = await response.json();
  if (!response.ok || body.error) {
    const error = new Error(`${action} failed: ${JSON.stringify(body.error ?? body)}`);
    error.details = body.error ?? body;
    throw error;
  }
  return body.result;
}

export async function requireBridge() {
  const status = await call("status");
  assert(status.bridge?.connected === true, "Bridge is not connected.");
  return status;
}

export async function hardDeleteTestIds(ids, opId) {
  const uniqueIds = [...new Set((ids ?? []).filter(Boolean))];
  if (uniqueIds.length === 0) return;
  await call("readonly", { mode: "off" });
  const deleteDryRun = await call("deleteRem", { remIds: uniqueIds, dryRun: true });
  if ((deleteDryRun.count ?? 0) === 0) return;
  const deleted = await call("deleteRem", { remIds: uniqueIds, confirm: true, confirmCount: deleteDryRun.count });
  const tombstoneOpId = deleted.opId ?? opId;
  const dryRun = await call("emptyTrash", { tombstoneOpId });
  if (dryRun.count > 0) {
    try {
      const approvalNonce = await automatedTestApproval("emptyTrash", dryRun.fromDryRun, dryRun.count);
      await call("emptyTrash", { tombstoneOpId, confirm: true, fromDryRun: dryRun.fromDryRun, confirmCount: dryRun.count, approvalNonce });
    } catch (error) {
      if (error?.details?.code !== "irreversible_budget_exceeded") throw error;
      await resetTestBudget();
      const approvalNonce = await automatedTestApproval("emptyTrash", dryRun.fromDryRun, dryRun.count);
      await call("emptyTrash", { tombstoneOpId, confirm: true, fromDryRun: dryRun.fromDryRun, confirmCount: dryRun.count, approvalNonce });
    }
  }
}

export async function emptyTrashOpId(opId) {
  if (!opId) return;
  const dryRun = await call("emptyTrash", { tombstoneOpId: opId });
  if ((dryRun.count ?? 0) === 0) return;
  try {
    const approvalNonce = await automatedTestApproval("emptyTrash", dryRun.fromDryRun, dryRun.count);
    await call("emptyTrash", { tombstoneOpId: opId, confirm: true, fromDryRun: dryRun.fromDryRun, confirmCount: dryRun.count, approvalNonce });
  } catch (error) {
    if (error?.details?.code !== "irreversible_budget_exceeded") throw error;
    await resetTestBudget();
    const approvalNonce = await automatedTestApproval("emptyTrash", dryRun.fromDryRun, dryRun.count);
    await call("emptyTrash", { tombstoneOpId: opId, confirm: true, fromDryRun: dryRun.fromDryRun, confirmCount: dryRun.count, approvalNonce });
  }
}

async function automatedTestApproval(action, fromDryRun, confirmCount) {
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

async function resetTestBudget() {
  const challenge = await call("approveIrreversible", { stage: "challenge", sessionReset: true });
  const approval = await call("approveIrreversible", {
    stage: "approve",
    sessionReset: true,
    challengeId: challenge.challengeId,
    response: challenge.phrase,
  });
  await call("reconfirmIrreversibleBudget", { approvalNonce: approval.approvalNonce });
}

export async function cleanupByText(runId) {
  try {
    const residue = await call("searchGraph", { query: `text:"${runId}"` });
    await call("readonly", { mode: "off" });
    await hardDeleteTestIds(residue.remIds ?? residue.ids ?? [], `${runId}-cleanup`);
  } catch (error) {
    console.error(JSON.stringify({
      status: "CLEANUP_FAIL",
      runId,
      message: error instanceof Error ? error.message : String(error),
    }));
    throw error;
  }
}
