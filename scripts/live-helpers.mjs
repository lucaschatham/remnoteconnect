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
  await call("deleteRem", { remIds: uniqueIds, confirm: true, confirmCount: uniqueIds.length, opId });
  const dryRun = await call("emptyTrash", { opId });
  if (dryRun.count > 0) await call("emptyTrash", { opId, confirm: true, fromDryRun: dryRun.fromDryRun, confirmCount: dryRun.count });
}

export async function cleanupByText(runId) {
  try {
    const residue = await call("searchGraph", { query: `text:"${runId}"` });
    await hardDeleteTestIds(residue.remIds ?? residue.ids ?? [], `${runId}-cleanup`);
  } catch {
    // Best effort cleanup.
  }
}
