#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assert, call, cleanupByText, url } from "./live-helpers.mjs";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const runId = `__codex_async__-${Date.now().toString(36)}`;
const logDir = join(homedir(), "Library", "Logs", "RemNoteConnect");
mkdirSync(logDir, { recursive: true });
const out = createWriteStream(join(logDir, "chaos-async-job.out.log"), { flags: "a" });
const err = createWriteStream(join(logDir, "chaos-async-job.err.log"), { flags: "a" });
const launchAgentLabel = process.env.REMNOTE_CONNECT_LAUNCH_AGENT_LABEL ?? "com.local.remnoteconnect.daemon";
const launchAgentTarget = `gui/${process.getuid?.() ?? execFileSync("id", ["-u"], { encoding: "utf8" }).trim()}/${launchAgentLabel}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listenerPid(port) {
  try {
    return execFileSync("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean);
  } catch {
    return undefined;
  }
}

function startDaemon() {
  const child = spawn(process.execPath, ["daemon/dist/index.js"], {
    cwd: root,
    detached: true,
    stdio: ["ignore", out, err],
    env: process.env,
  });
  child.unref();
  return child.pid;
}

function launchAgentLoaded() {
  try {
    execFileSync("launchctl", ["print", launchAgentTarget], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function restartDaemon() {
  if (launchAgentLoaded()) {
    execFileSync("launchctl", ["kickstart", "-k", launchAgentTarget], { stdio: "ignore" });
    await waitForHealth(true, 15_000);
    return { mode: "launchAgent", restartedPid: undefined };
  }
  const pid = listenerPid(8766);
  assert(pid, "No daemon process is listening on 8766.");
  process.kill(Number(pid), "SIGTERM");
  await waitForHealth(false, 10_000);
  return { mode: "spawn", killedPid: pid, restartedPid: startDaemon() };
}

async function waitForHealth(wantUp, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url.replace(/\/$/, "")}/health`);
      if (wantUp && response.ok) return;
      if (!wantUp && !response.ok) return;
    } catch {
      if (!wantUp) return;
    }
    await sleep(500);
  }
  throw new Error(`Daemon ${wantUp ? "did not start" : "did not stop"} before timeout.`);
}

async function waitForBridge(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await call("status");
      if (last.bridge?.connected === true && last.bridge?.activeConnections === 1) return last;
    } catch {
      // Daemon may still be starting.
    }
    await sleep(1000);
  }
  throw new Error(`Bridge did not reconnect before timeout. Last status: ${JSON.stringify(last?.bridge ?? null)}`);
}

async function waitForCursor(jobId, minCursor, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await call("jobStatus", { jobId });
    if (last.cursor >= minCursor && last.status !== "complete") return last;
    if (last.status === "complete") throw new Error(`Durable job completed before daemon kill; throttle did not hold. ${JSON.stringify(last)}`);
    await sleep(100);
  }
  throw new Error(`Durable job did not reach cursor ${minCursor}. Last status: ${JSON.stringify(last)}`);
}

async function ensureDaemonRunning() {
  if (listenerPid(8766)) return;
  if (launchAgentLoaded()) execFileSync("launchctl", ["kickstart", "-k", launchAgentTarget], { stdio: "ignore" });
  else startDaemon();
  await waitForHealth(true, 15_000);
}

try {
  await waitForBridge(5_000);
  const cards = Array.from({ length: 8 }, (_, index) => ({
    front: `${runId} front ${index}`,
    back: `${runId} back ${index}`,
    externalId: `live-async:${runId}:${index}`,
    batchId: runId,
  }));

  const queued = await call("createFlashcardsAsync", {
    confirm: true,
    deckPath: runId,
    batchId: runId,
    throttleMs: 350,
    cards,
  });
  const jobId = queued.jobId;
  assert(jobId, "createFlashcardsAsync did not return a jobId.");

  const beforeKill = await waitForCursor(jobId, 2, 10_000);
  const restart = await restartDaemon();
  await waitForHealth(true, 15_000);
  await waitForBridge(45_000);

  const completed = await call("jobWait", { jobId, timeoutMs: 60_000 });
  assert(completed.status === "complete", `jobWait did not complete resumed job: ${JSON.stringify(completed)}`);
  assert(completed.ids?.length === cards.length, "Resumed durable job did not report every created Rem id.");
  const materialized = await call("confirmMaterialized", { batchId: runId });
  assert(materialized.count === cards.length, "confirmMaterialized did not return every created Rem id.");

  await cleanupByText(runId);
  const residue = await call("searchGraph", { query: `text:"${runId}"` });
  assert(residue.count === 0, "Async chaos residue remains.");

  console.log(JSON.stringify({ status: "PASS", runId, jobId, beforeKill, ...restart, count: materialized.count }, null, 2));
} catch (error) {
  await ensureDaemonRunning().catch(() => undefined);
  await cleanupByText(runId).catch(() => undefined);
  console.error(JSON.stringify({ status: "FAIL", runId, message: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
}
