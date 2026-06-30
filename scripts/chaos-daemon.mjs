#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assert, call, url } from "./live-helpers.mjs";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const logDir = join(homedir(), "Library", "Logs", "RemNoteConnect");
mkdirSync(logDir, { recursive: true });
const out = createWriteStream(join(logDir, "chaos-daemon.out.log"), { flags: "a" });
const err = createWriteStream(join(logDir, "chaos-daemon.err.log"), { flags: "a" });
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

async function waitForHealth(wantUp, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url.replace(/\/$/, "")}/health`);
      if (wantUp && response.ok) return;
      if (!wantUp && !response.ok) return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (!wantUp) return;
    }
    await sleep(500);
  }
  throw new Error(`Daemon ${wantUp ? "did not start" : "did not stop"} before timeout. ${lastError}`);
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

function restartDaemon() {
  if (launchAgentLoaded()) {
    execFileSync("launchctl", ["kickstart", "-k", launchAgentTarget], { stdio: "ignore" });
    return { mode: "launchAgent", restartedPid: undefined };
  }
  const pid = listenerPid(8766);
  assert(pid, "No daemon process is listening on 8766.");
  process.kill(Number(pid), "SIGTERM");
  return { mode: "spawn", killedPid: pid, restartedPid: undefined };
}

try {
  const before = await call("status");
  assert(before.bridge?.connected === true, "Bridge must be connected before chaos validation.");

  const restart = restartDaemon();
  if (restart.mode === "spawn") {
    await waitForHealth(false, 10_000);
    restart.restartedPid = startDaemon();
  }
  await waitForHealth(true, 15_000);
  const after = await waitForBridge(45_000);

  const e2e = spawn(process.execPath, ["scripts/e2e.mjs"], { cwd: root, stdio: "inherit", env: process.env });
  const code = await new Promise((resolve) => e2e.on("close", resolve));
  assert(code === 0, `E2E failed after daemon restart with exit code ${code}.`);

  console.log(JSON.stringify({ status: "PASS", ...restart, bridge: after.bridge }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: "FAIL", message: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
}
