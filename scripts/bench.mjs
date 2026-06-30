#!/usr/bin/env node
import { call, cleanupByText } from "./live-helpers.mjs";

const runId = `__codex_bench__-${Date.now().toString(36)}`;
const requestedCount = Number(process.env.REMNOTE_CONNECT_BENCH_COUNT ?? process.argv[2] ?? 200);
const count = Number.isInteger(requestedCount) && requestedCount > 0 ? requestedCount : 200;

function msSince(start) {
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

try {
  const status = await call("status");
  if (!status.bridge?.connected) throw new Error("Bridge is not connected; start RemNote and load the localhost plugin first.");

  const cards = Array.from({ length: count }, (_, index) => ({
    front: `Bench front ${runId} ${index}`,
    back: `Bench back ${index}`,
    tags: ["codex-bench"],
    batchId: runId,
  }));

  let started = process.hrtime.bigint();
  const created = await call("createFlashcards", { cards, deckPath: runId, throttleMs: 0, batchId: runId, confirm: true });
  const createMs = msSince(started);

  started = process.hrtime.bigint();
  const search = await call("searchGraph", { query: `text:"Bench front ${runId}"` });
  const searchMs = msSince(started);

  console.log(
    JSON.stringify(
      {
        status: "PASS",
        runId,
        createdCount: created.count,
        createMs: Math.round(createMs),
        searchResultCount: search.count,
        searchMs: Math.round(searchMs),
        note: "Progress events are recorded inside daemon job history; the synchronous HTTP API does not stream them to this script yet.",
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(JSON.stringify({ status: "FAIL", runId, message: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  await cleanupByText(runId);
}
