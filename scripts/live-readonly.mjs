#!/usr/bin/env node
import { assert, call, cleanupByText, requireBridge } from "./live-helpers.mjs";

const runId = `__codex_readonly__-${Date.now().toString(36)}`;
let priorReadonly = false;

async function setReadonly(mode) {
  return call("readonly", { mode });
}

try {
  await requireBridge();
  priorReadonly = (await setReadonly("status")).readonlyMode === true;
  await setReadonly("off");

  const created = await call("createFlashcard", {
    deckPath: runId,
    front: `Read-only front ${runId}`,
    back: `Read-only back ${runId}`,
  });
  assert(typeof created.id === "string", "Setup create did not return a Rem id.");

  await setReadonly("on");
  let blockedCode = "";
  try {
    await call("createFlashcard", {
      deckPath: runId,
      front: `Blocked front ${runId}`,
      back: `Blocked back ${runId}`,
    });
  } catch (error) {
    blockedCode = error?.details?.code ?? "";
  }
  assert(blockedCode === "readonly_mode", `Expected readonly_mode for mutation, got ${blockedCode || "no error"}.`);

  const read = await call("searchGraph", { query: `id:${created.id}` });
  assert(read.count === 1, "Read action failed while read-only mode was enabled.");

  await setReadonly("off");
  await cleanupByText(runId);
  const residue = await call("searchGraph", { query: `text:"${runId}"` });
  assert(residue.count === 0, "Read-only test residue remains.");

  if (priorReadonly) await setReadonly("on");
  console.log(JSON.stringify({ status: "PASS", runId, blockedCode, readCount: read.count }, null, 2));
} catch (error) {
  try {
    await setReadonly("off");
    await cleanupByText(runId);
    if (priorReadonly) await setReadonly("on");
  } catch {
    // The primary failure below is more useful than a cleanup failure.
  }
  console.error(JSON.stringify({ status: "FAIL", runId, message: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
}
