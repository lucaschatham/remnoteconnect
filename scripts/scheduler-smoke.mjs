#!/usr/bin/env node
import { assert, call, cleanupByText, requireBridge } from "./live-helpers.mjs";

const runId = `__rnc_scheduler__-${Date.now().toString(36)}`;

try {
  await requireBridge();
  const created = await call("createFlashcard", {
    deckPath: runId,
    front: `Scheduler front ${runId}`,
    back: `Scheduler back ${runId}`,
    batchId: runId,
    tags: ["rnc-scheduler"],
    waitForCards: true,
    verbose: true,
  });

  let cardId = created.cards?.[0]?.id;
  for (let i = 0; !cardId && i < 12; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const read = await call("getFlashcard", { id: created.id });
    cardId = read.cards?.[0]?.id;
  }
  assert(cardId, "Created flashcard did not expose a card ID.");

  const answered = await call("answerCard", { cardId, score: 2 }).catch((error) => error.details);
  assert(answered?.code === "experimental_disabled", "answerCard was not rejected as experimental.");

  const found = await call("searchFlashcards", { query: `id:${created.id}` });
  assert(found.count === 1, "Card was not searchable after answerCard.");

  await cleanupByText(runId);
  const residue = await call("searchGraph", { query: `text:"${runId}"` });
  assert(residue.count === 0, "Scheduler test residue remains.");

  console.log(JSON.stringify({ status: "PASS", runId, remId: created.id, cardId, scheduler: "experimental_disabled" }, null, 2));
} catch (error) {
  await cleanupByText(runId);
  console.error(JSON.stringify({ status: "FAIL", runId, message: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
}
