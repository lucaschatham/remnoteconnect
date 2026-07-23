#!/usr/bin/env node
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const tempDirs = [];
const children = new Set();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert(address && typeof address === "object", "failed to reserve an ephemeral port");
  const port = address.port;
  await new Promise((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
  return port;
}

async function daemonEnvironment(ankiPort) {
  const dir = await mkdtemp(join(tmpdir(), "rnc-listener-smoke-"));
  tempDirs.push(dir);
  return {
    dir,
    nativePort: await freePort(),
    pluginPort: await freePort(),
    ankiPort: ankiPort ?? (await freePort()),
  };
}

function startDaemon(ports) {
  const output = { stdout: "", stderr: "" };
  const child = spawn(process.execPath, [join(root, "daemon", "dist", "index.js")], {
    cwd: root,
    env: {
      ...process.env,
      REMNOTE_CONNECT_APP_DIR: join(ports.dir, "app"),
      REMNOTE_CONNECT_BACKUP_DIR: join(ports.dir, "backups"),
      REMNOTE_CONNECT_LOG_DIR: join(ports.dir, "logs"),
      REMNOTE_CONNECT_PORT: String(ports.nativePort),
      REMNOTE_CONNECT_PLUGIN_PORT: String(ports.pluginPort),
      REMNOTE_CONNECT_ANKI_COMPAT: "on",
      REMNOTE_CONNECT_ANKI_PORT: String(ports.ankiPort),
      REMNOTE_CONNECT_ANKI_API_KEY: "listener-smoke-key",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (output.stdout += chunk));
  child.stderr.on("data", (chunk) => (output.stderr += chunk));
  const exit = once(child, "exit").then(([code, signal]) => {
    children.delete(child);
    return { code, signal };
  });
  return { child, exit, output };
}

async function waitFor(check, description, timeoutMs = 8_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function stop(child, exit) {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await Promise.race([exit, new Promise((resolveWait) => setTimeout(resolveWait, 2_000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

try {
  const healthyPorts = await daemonEnvironment();
  const healthy = startDaemon(healthyPorts);
  await waitFor(
    () => healthy.output.stdout.includes(`AnkiConnect compatibility listening on http://127.0.0.1:${healthyPorts.ankiPort}`),
    "compatibility listener startup",
  );

  const versionResponse = await fetch(`http://127.0.0.1:${healthyPorts.ankiPort}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "version", version: 6, key: "listener-smoke-key" }),
  });
  assert(versionResponse.status === 200, `version returned HTTP ${versionResponse.status}`);
  assert(JSON.stringify(await versionResponse.json()) === JSON.stringify({ result: 6, error: null }), "version envelope mismatch");

  const deniedResponse = await fetch(`http://127.0.0.1:${healthyPorts.ankiPort}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "version", version: 6, key: "wrong" }),
  });
  assert((await deniedResponse.json()).error === "valid api key must be provided", "incorrect API key was not rejected");

  const pluginResponse = await fetch(`http://127.0.0.1:${healthyPorts.pluginPort}/`);
  assert(pluginResponse.status === 200, `plugin bundle returned HTTP ${pluginResponse.status}`);
  await stop(healthy.child, healthy.exit);

  const occupiedPort = await freePort();
  const blocker = createServer((_socket) => {});
  await new Promise((resolveListen, reject) => {
    blocker.once("error", reject);
    blocker.listen(occupiedPort, "127.0.0.1", resolveListen);
  });
  try {
    const conflictPorts = await daemonEnvironment(occupiedPort);
    const conflict = startDaemon(conflictPorts);
    const outcome = await Promise.race([
      conflict.exit,
      new Promise((_, reject) => setTimeout(() => reject(new Error("daemon did not exit after an occupied compatibility port")), 8_000)),
    ]);
    assert(outcome.code === 1, `occupied-port process exited with ${String(outcome.code)}`);
    assert(conflict.output.stderr.includes("EADDRINUSE"), "occupied-port failure did not identify EADDRINUSE");
    await expectConnectionFailure(`http://127.0.0.1:${conflictPorts.nativePort}/health`);
  } finally {
    await new Promise((resolveClose, reject) => blocker.close((error) => (error ? reject(error) : resolveClose())));
  }

  console.log(JSON.stringify({ status: "PASS", checks: ["listeners", "api-key", "plugin-bundle", "port-conflict-cleanup"] }));
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
}

async function expectConnectionFailure(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1_000) });
  } catch {
    return;
  }
  throw new Error(`listener remained reachable after startup failure: ${url}`);
}
