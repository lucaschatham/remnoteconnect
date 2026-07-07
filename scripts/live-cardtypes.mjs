#!/usr/bin/env node
import { assert, call, cleanupByText, emptyTrashOpId, requireBridge } from "./live-helpers.mjs";

const runId = `__rnc_cardtypes__-${Date.now().toString(36)}`;

function byCapability(result, name) {
  return (result.capabilities ?? []).find((row) => row.capability === name);
}

async function main() {
  await requireBridge();
  let result;
  try {
    result = await call("capabilityProbes", { runId, confirm: true });
    assert(byCapability(result, "frontBackCard")?.status === "PASS", "front/back flashcard did not materialize.");
    assert(byCapability(result, "clozeCard")?.status === "PASS", "cloze flashcard did not materialize.");
    assert(byCapability(result, "orderedInsertion")?.status === "PASS", "ordered insertion probe failed.");
    assert(byCapability(result, "properties")?.status === "PASS", "property probe failed.");
    assert(byCapability(result, "portals")?.status === "PASS", "portal probe failed.");

    const optionalCardTypes = ["conceptCard", "descriptorCard", "multiLineCard", "listAnswerCard", "imageOcclusion"];
    const optional = Object.fromEntries(optionalCardTypes.map((name) => [name, byCapability(result, name)?.status ?? "MISSING"]));

    if (result.cleanup?.opId) await emptyTrashOpId(result.cleanup.opId);
    await cleanupByText(runId);
    console.log(JSON.stringify({ status: "PASS", runId, required: "passed", optional }, null, 2));
  } catch (error) {
    try {
      if (result?.cleanup?.opId) await emptyTrashOpId(result.cleanup.opId);
      await cleanupByText(runId);
    } catch {
      // Preserve the original failure for the gate output.
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ status: "FAIL", runId, message: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exit(1);
});
