#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const tokenPath =
  process.env.REMNOTE_CONNECT_TOKEN_FILE ??
  join(homedir(), "Library", "Application Support", "RemNoteConnect", "token");
const token = process.env.REMNOTE_CONNECT_TOKEN ?? readFileSync(tokenPath, "utf8").trim();
const url = process.env.REMNOTE_CONNECT_URL ?? "http://127.0.0.1:8766";
const iterations = Number(process.env.REMNOTE_CONNECT_JOB_RETENTION_COUNT ?? process.argv[2] ?? 520);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function call(action, params = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, version: 1, params }),
  });
  const body = await response.json();
  if (!response.ok || body.error) throw new Error(`${action} failed: ${JSON.stringify(body.error ?? body)}`);
  return body.result;
}

try {
  const before = await call("status");
  assert(before.bridge?.connected === true, "Bridge is not connected.");
  const started = process.hrtime.bigint();
  for (let i = 0; i < iterations; i += 1) {
    await call("listRoots");
  }
  const after = await call("status");
  const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  assert(after.bridge.retainedJobs <= 500, `retainedJobs expected <= 500, got ${after.bridge.retainedJobs}.`);
  console.log(
    JSON.stringify(
      {
        status: "PASS",
        iterations,
        retainedJobsBefore: before.bridge.retainedJobs,
        retainedJobsAfter: after.bridge.retainedJobs,
        durationMs: Math.round(durationMs),
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(JSON.stringify({ status: "FAIL", message: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
}
