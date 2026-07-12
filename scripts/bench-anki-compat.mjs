import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ok } from "../shared/dist/index.js";
import { loadConfig } from "../daemon/dist/config.js";
import { AnkiCompatDispatcher } from "../daemon/dist/ankiCompatDispatcher.js";
import { buildAnkiCompatServer } from "../daemon/dist/ankiCompatServer.js";
import { AnkiCompatStore } from "../daemon/dist/ankiCompatStore.js";

const dir = await mkdtemp(join(tmpdir(), "rnc-anki-bench-"));
const config = loadConfig({
  appDir: dir,
  backupDir: join(dir, "backups"),
  logDir: join(dir, "logs"),
  tokenFile: join(dir, "token"),
  token: "benchmark-token-benchmark-token",
  readonlyMode: false,
});
const store = new AnkiCompatStore(dir);
const dispatcher = new AnkiCompatDispatcher({
  appDir: dir,
  readonlyMode: () => false,
  store,
  dispatchNative: async (action) => (action === "deckNames" ? ok(["Default"]) : ok(null)),
});
const app = buildAnkiCompatServer({ config, dispatcher });
const headers = { host: "127.0.0.1:8765" };

function percentile(values, value) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)];
}

async function measure(action, iterations = 500) {
  const durations = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    const response = await app.inject({ method: "POST", url: "/", headers, payload: { action, version: 6 } });
    if (response.statusCode !== 200 || response.json().error) throw new Error(`${action} benchmark request failed`);
    durations.push(performance.now() - started);
  }
  return { p50Ms: percentile(durations, 0.5), p95Ms: percentile(durations, 0.95), maxMs: Math.max(...durations) };
}

try {
  const version = await measure("version");
  const translatedRead = await measure("deckNames");
  await store.getOrCreatePublicIds("note", Array.from({ length: 10_000 }, (_value, index) => `seed-${index}`));
  const sidecarDurations = [];
  for (let index = 0; index < 20; index += 1) {
    const started = performance.now();
    await store.getOrCreatePublicId("note", `append-${index}`);
    sidecarDurations.push(performance.now() - started);
  }
  const result = {
    version,
    translatedRead,
    sidecarAppendAt10k: {
      p50Ms: percentile(sidecarDurations, 0.5),
      p95Ms: percentile(sidecarDurations, 0.95),
      maxMs: Math.max(...sidecarDurations),
    },
  };
  console.log(JSON.stringify(result, null, 2));
  if (result.version.p95Ms >= 5 || result.translatedRead.p95Ms >= 10 || result.sidecarAppendAt10k.p95Ms >= 40) process.exitCode = 1;
} finally {
  await app.close();
  await rm(dir, { recursive: true, force: true });
}
