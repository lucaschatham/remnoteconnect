#!/usr/bin/env node
import { call } from "./live-helpers.mjs";

const rootId = process.env.REMNOTE_CONNECT_BENCH_ROOT_ID;
const count = Number(process.env.REMNOTE_CONNECT_BENCH_COUNT ?? 100);
const confirmed = process.argv.includes("--confirm");

if (!rootId || !Number.isInteger(count) || count < 1 || !confirmed) {
  console.error("Usage: REMNOTE_CONNECT_BENCH_ROOT_ID=REM_ID node scripts/bench-atlas-sync.mjs --confirm [REMNOTE_CONNECT_BENCH_COUNT=100]");
  console.error("The root must be a disposable, explicitly configured fast-local root. This benchmark leaves its generated data in that root.");
  process.exit(2);
}

const runId = `atlas-bench-${Date.now().toString(36)}`;
const hash = (value) => {
  const data = new TextEncoder().encode(value);
  return crypto.subtle.digest("SHA-256", data).then((digest) => `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`);
};
const elapsed = async (fn) => {
  const started = performance.now();
  const result = await fn();
  return { result, ms: Math.round(performance.now() - started) };
};
const wait = async (job) => call("jobWait", { jobId: job.jobId, timeoutMs: Math.max(120_000, count * 2_000) });

const documents = await Promise.all(Array.from({ length: count }, async (_, index) => {
  const markdown = `Atlas benchmark ${runId} skill ${index}`;
  return { externalId: `atlas:bench:${runId}:${index}`, contentHash: await hash(markdown), markdown };
}));
const manifest = {
  mode: "fast-local",
  batchId: runId,
  rootId,
  namespace: "learning-atlas",
  sourceRevision: "benchmark-v1",
  documents,
  flashcards: [],
  confirm: true,
  confirmCount: count > 50 ? count : undefined,
};

const initial = await elapsed(async () => wait(await call("syncAtlasBatch", manifest)));
const unchanged = await elapsed(async () => wait(await call("syncAtlasBatch", { ...manifest, batchId: `${runId}-unchanged` })));
const updatedDocuments = await Promise.all(documents.map(async (item, index) => {
  if (index >= Math.min(10, documents.length)) return item;
  const markdown = `${item.markdown} updated`;
  return { ...item, markdown, contentHash: await hash(markdown) };
}));
const incremental = await elapsed(async () => wait(await call("syncAtlasBatch", { ...manifest, batchId: `${runId}-incremental`, documents: updatedDocuments })));

console.log(JSON.stringify({
  status: "PASS",
  runId,
  count,
  initial: { ms: initial.ms, result: initial.result.result },
  unchanged: { ms: unchanged.ms, result: unchanged.result.result },
  incremental: { ms: incremental.ms, result: incremental.result.result },
  note: "Compare these local batch timings with the existing per-item durable import benchmark; this script intentionally leaves data in the disposable root for inspection.",
}, null, 2));
