import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { startPluginStaticServer } from "../src/pluginStatic.js";
import { BRIDGE_MAX_PAYLOAD_BYTES } from "../src/bridge.js";
import { BUILD_HASH, IRREVERSIBLE_RECONFIRM_PHRASE } from "@remnoteconnect/shared";

function testBundle(options: { readonlyMode?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "remnote-connect-"));
  const config = loadConfig({
    appDir: join(dir, "app"),
    backupDir: join(dir, "backups"),
    tokenFile: join(dir, "app", "token"),
    token: "test-token-test-token",
    readonlyMode: options.readonlyMode ?? false,
  });
  const bundle = buildServer(config);
  return { ...bundle, config, dir };
}

const authHeaders = { host: "127.0.0.1:8766", authorization: "Bearer test-token-test-token" };

async function listen(bundle: ReturnType<typeof testBundle>): Promise<number> {
  await bundle.app.listen({ host: "127.0.0.1", port: 0 });
  const address = bundle.app.server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address.");
  return address.port;
}

function connectPlugin(
  port: number,
  handlers: { onJob?: (message: { jobId: string; action: string; params: Record<string, unknown> }, ws: WebSocket) => void; pluginBuildHash?: string } = {},
) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`, {
    headers: { origin: "http://127.0.0.1:8080" },
  });
  const ready = new Promise<void>((resolve, reject) => {
    ws.once("open", () => {
      ws.send(
        JSON.stringify({
          type: "hello",
          token: "test-token-test-token",
          pluginVersion: "test",
          pluginBuildHash: handlers.pluginBuildHash ?? BUILD_HASH,
          transport: "websocket",
          capabilities: { test: true },
        }),
      );
    });
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString("utf8"));
      if (message.type === "hello_ack") resolve();
      if (message.type === "job") handlers.onJob?.(message, ws);
    });
    ws.once("error", reject);
  });
  return { ws, ready };
}

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (!accept(last) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    last = await read();
  }
  return last;
}

describe("daemon server", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("serves unauthenticated health", async () => {
    const bundle = testBundle();
    dirs.push(bundle.dir);
    const response = await bundle.app.inject({ method: "GET", url: "/health", headers: { host: "127.0.0.1:8766" } });
    expect(response.statusCode).toBe(200);
    expect(response.json().result.ok).toBe(true);
  });

  it("serves the built plugin bundle from the daemon process", async () => {
    const bundle = testBundle();
    dirs.push(bundle.dir);
    const dist = join(bundle.dir, "plugin-dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>RemNoteConnect</title>", "utf8");
    writeFileSync(join(dist, "manifest.json"), "{\"name\":\"RemNoteConnect\"}", "utf8");

    const server = await startPluginStaticServer({ ...bundle.config, pluginPort: 0, pluginDistDir: dist });
    expect(server).toBeTruthy();
    const address = server?.address();
    if (!address || typeof address === "string") throw new Error("Expected static server TCP address.");
    const html = await fetch(`http://127.0.0.1:${address.port}/`).then((response) => response.text());
    expect(html).toContain("RemNoteConnect");
    const manifest = await fetch(`http://127.0.0.1:${address.port}/manifest.json`).then((response) => response.json());
    expect(manifest.name).toBe("RemNoteConnect");
    await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
  });

  it("rejects missing token", async () => {
    const bundle = testBundle();
    dirs.push(bundle.dir);
    const response = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: { host: "127.0.0.1:8766" },
      payload: { action: "version", version: 1 },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("unauthorized");
  });

  it("answers version with a token", async () => {
    const bundle = testBundle();
    dirs.push(bundle.dir);
    const response = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: { host: "127.0.0.1:8766", authorization: "Bearer test-token-test-token" },
      payload: { action: "version", version: 1 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ result: 1, error: null });
  });

  it("rejects disallowed HTTP origin", async () => {
    const bundle = testBundle();
    dirs.push(bundle.dir);
    const response = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: { ...authHeaders, origin: "https://evil.example" },
      payload: { action: "version", version: 1 },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("forbidden_origin");
  });

  it("answers CORS preflight with allowed headers", async () => {
    const bundle = testBundle();
    dirs.push(bundle.dir);
    const response = await bundle.app.inject({
      method: "OPTIONS",
      url: "/",
      headers: { host: "127.0.0.1:8766", origin: "http://127.0.0.1:8080" },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:8080");
    expect(response.headers["access-control-allow-headers"]).toContain("Authorization");
  });

  it("rejects non-local host", async () => {
    const bundle = testBundle();
    dirs.push(bundle.dir);
    const response = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: { host: "example.com", authorization: "Bearer test-token-test-token" },
      payload: { action: "version", version: 1 },
    });
    expect(response.statusCode).toBe(403);
  });

  it("returns stable unsupported errors", async () => {
    const bundle = testBundle();
    dirs.push(bundle.dir);
    const response = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: { host: "127.0.0.1:8766", authorization: "Bearer test-token-test-token" },
      payload: { action: "modelNames", version: 1 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().error.code).toBe("unsupported");
  });

  it("describes action metadata and rejects planned actions with not_implemented", async () => {
    const bundle = testBundle();
    dirs.push(bundle.dir);
    const describe = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: { action: "describe", version: 1 },
    });
    expect(describe.json().result.actions.deleteRem).toMatchObject({
      mutates: true,
      reversible: true,
      magnitudeGuarded: true,
    });

    const planned = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: { action: "updateDocument", version: 1, params: {} },
    });
    expect(planned.json().error.code).toBe("not_implemented");
  });

  it("toggles daemon-enforced read-only mode and blocks mutating plugin actions before dispatch", async () => {
    const bundle = testBundle({ readonlyMode: true });
    dirs.push(bundle.dir);
    const port = await listen(bundle);
    const seenActions: string[] = [];
    const { ws, ready } = connectPlugin(port, {
      onJob(message, socket) {
        seenActions.push(message.action);
        socket.send(JSON.stringify({ type: "result", jobId: message.jobId, result: { count: 0, ids: [] }, error: null }));
      },
    });
    await ready;

    const initialStatus = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: { action: "status", version: 1 },
    });
    expect(initialStatus.json().result.readonlyMode).toBe(true);

    const enabled = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: { action: "readonly", version: 1, params: { mode: "on" } },
    });
    expect(enabled.json().result).toMatchObject({ readonlyMode: true, changed: false });

    const status = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: { action: "status", version: 1 },
    });
    expect(status.json().result.readonlyMode).toBe(true);

    const read = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: { action: "searchGraph", version: 1, params: { query: "text:noop" } },
    });
    expect(read.json().error).toBeNull();
    expect(seenActions).toEqual(["searchGraph"]);

    const blockedPluginMutation = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: { action: "createFlashcard", version: 1, params: { front: "A", back: "B" } },
    });
    expect(blockedPluginMutation.json().error.code).toBe("readonly_mode");

    const dryRunPluginMutation = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: { action: "rewriteNativeLinks", version: 1, params: { dryRun: true, candidates: [{ sourceNodeId: "a", targetRemId: "b", raw: "B" }] } },
    });
    expect(dryRunPluginMutation.json().error).toBeNull();
    expect(dryRunPluginMutation.json().result).toMatchObject({ count: 0 });

    const blockedDaemonMutation = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: { action: "createFlashcardsAsync", version: 1, params: { cards: [{ front: "A", back: "B" }], confirm: true } },
    });
    expect(blockedDaemonMutation.json().error.code).toBe("readonly_mode");
    expect(seenActions).toEqual(["searchGraph", "rewriteNativeLinks"]);

    const disabled = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: { action: "readonly", version: 1, params: { mode: "off" } },
    });
    expect(disabled.json().result).toMatchObject({ readonlyMode: false, changed: true });

    const mutationAfterDisable = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: { action: "createFlashcard", version: 1, params: { front: "A", back: "B" } },
    });
    expect(mutationAfterDisable.json().error).toBeNull();
    expect(seenActions).toEqual(["searchGraph", "rewriteNativeLinks", "createFlashcard"]);
    ws.close();
    await bundle.app.close();
  });

  it("warns when the connected plugin build does not match the daemon build", async () => {
    const bundle = testBundle();
    dirs.push(bundle.dir);
    const port = await listen(bundle);
    const { ws, ready } = connectPlugin(port, {
      pluginBuildHash: "stale-plugin-build",
      onJob(message, socket) {
        expect(message.action).toBe("scopeProbe");
        socket.send(JSON.stringify({ type: "result", jobId: message.jobId, result: { ok: true }, error: null }));
      },
    });
    await ready;

    const doctor = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: { action: "doctor", version: 1 },
    });
    expect(doctor.json().result.ok).toBe(true);
    expect(doctor.json().result.warnings[0]).toContain("stale-plugin-build");
    expect(doctor.json().result.checks.build).toMatchObject({
      ok: false,
      daemonBuildHash: BUILD_HASH,
      pluginBuildHash: "stale-plugin-build",
    });
    ws.close();
    await bundle.app.close();
  });

  it("reports plugin disconnected for plugin actions", async () => {
    const bundle = testBundle();
    dirs.push(bundle.dir);
    const response = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: { host: "127.0.0.1:8766", authorization: "Bearer test-token-test-token" },
      payload: { action: "createFlashcard", version: 1, params: { front: "A", back: "B" } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().error.code).toBe("plugin_disconnected");
  });

  it("sets the local bridge payload limit above the ws default for graph backups", () => {
    expect(BRIDGE_MAX_PAYLOAD_BYTES).toBeGreaterThan(100 * 1024 * 1024);
  });

  it("passes backupGraph timeoutMs through the bridge and writes a snapshot", async () => {
    const bundle = testBundle();
    dirs.push(bundle.dir);
    const port = await listen(bundle);
    const { ws, ready } = connectPlugin(port, {
      onJob(message, socket) {
        expect(message.action).toBe("backupGraph");
        expect(message.params.timeoutMs).toBe(180_000);
        socket.send(
          JSON.stringify({
            type: "result",
            jobId: message.jobId,
            result: {
              schemaVersion: 1,
              exportedAt: "2026-07-02T00:00:00.000Z",
              rootId: "root",
              rootName: "Graph",
              warning: "Snapshot restore recreates Rem as copies with new IDs.",
              nodeCount: 1,
              nodes: [{ id: "root", text: "Graph", children: [] }],
            },
            error: null,
          }),
        );
      },
    });
    await ready;

    const response = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: { action: "backupGraph", version: 1, params: { timeoutMs: 180_000 } },
    });

    expect(response.json().error).toBeNull();
    expect(response.json().result.nodeCount).toBe(1);
    expect(existsSync(response.json().result.path)).toBe(true);
    ws.close();
    await bundle.app.close();
  });

  it("destructive actions default to dry-run and need the plugin bridge to resolve targets", async () => {
    const bundle = testBundle();
    dirs.push(bundle.dir);
    const response = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: { host: "127.0.0.1:8766", authorization: "Bearer test-token-test-token" },
      payload: { action: "deleteRem", version: 1, params: { remIds: ["x"] } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().error.code).toBe("plugin_disconnected");
  });

  it("routes HTTP plugin actions through an authenticated WebSocket bridge", async () => {
    const bundle = testBundle();
    dirs.push(bundle.dir);
    const port = await listen(bundle);
    const { ws, ready } = connectPlugin(port, {
      onJob(message, socket) {
        expect(message.action).toBe("createFlashcard");
        socket.send(
          JSON.stringify({
            type: "result",
            jobId: message.jobId,
            result: { id: "rem-1", text: "front" },
            error: null,
          }),
        );
      },
    });

    await ready;

    const response = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: { host: "127.0.0.1:8766", authorization: "Bearer test-token-test-token" },
      payload: {
        action: "createFlashcard",
        version: 1,
        params: { front: "front", back: "back" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ result: { id: "rem-1", text: "front" }, error: null });
    ws.close();
    await bundle.app.close();
  });

  it("rotates the daemon token through the connected plugin without echoing the token", async () => {
    const bundle = testBundle();
    dirs.push(bundle.dir);
    const port = await listen(bundle);
    let storedToken = "";
    const { ws, ready } = connectPlugin(port, {
      onJob(message, socket) {
        expect(message.action).toBe("setDaemonToken");
        expect(typeof message.params.token).toBe("string");
        storedToken = String(message.params.token);
        socket.send(JSON.stringify({ type: "result", jobId: message.jobId, result: { stored: true }, error: null }));
      },
    });
    await ready;

    const rotated = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: { action: "rotateToken", version: 1 },
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().result).toMatchObject({ rotated: true, pluginUpdated: true });
    expect(JSON.stringify(rotated.json())).not.toContain(storedToken);
    expect(storedToken).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(bundle.config.tokenFile, "utf8").trim()).toBe(storedToken);
    expect(statSync(bundle.config.tokenFile).mode & 0o777).toBe(0o600);

    const oldToken = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: { action: "version", version: 1 },
    });
    expect(oldToken.statusCode).toBe(401);

    const newToken = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: { host: "127.0.0.1:8766", authorization: `Bearer ${storedToken}` },
      payload: { action: "version", version: 1 },
    });
    expect(newToken.json()).toEqual({ result: 1, error: null });
    ws.close();
    await bundle.app.close();
  });

  it("closes WebSocket connections with bad origin, bad token, or non-json hello", async () => {
    const bundle = testBundle();
    dirs.push(bundle.dir);
    const port = await listen(bundle);

    async function closeCode(ws: WebSocket, firstFrame?: string): Promise<number> {
      return new Promise((resolve, reject) => {
        ws.once("open", () => {
          if (firstFrame !== undefined) ws.send(firstFrame);
        });
        ws.once("close", (code) => resolve(code));
        ws.once("error", reject);
      });
    }

    await expect(
      closeCode(
        new WebSocket(`ws://127.0.0.1:${port}/bridge`, {
          headers: { origin: "https://evil.example" },
        }),
      ),
    ).resolves.toBe(1008);

    await expect(
      closeCode(
        new WebSocket(`ws://127.0.0.1:${port}/bridge`, {
          headers: { origin: "http://127.0.0.1:8080" },
        }),
        JSON.stringify({ type: "hello", token: "wrong-token-wrong-token", transport: "websocket" }),
      ),
    ).resolves.toBe(1008);

    await expect(
      closeCode(
        new WebSocket(`ws://127.0.0.1:${port}/bridge`, {
          headers: { origin: "http://127.0.0.1:8080" },
        }),
        "not json",
      ),
    ).resolves.toBe(1003);
    await bundle.app.close();
  });

  it("bounds multi recursion and returns per-item results", async () => {
    const bundle = testBundle();
    dirs.push(bundle.dir);
    const response = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: {
        action: "multi",
        version: 1,
        params: {
          actions: [
            { action: "version", version: 1 },
            { action: "multi", version: 1, params: { actions: [{ action: "version", version: 1 }] } },
            { bad: true },
          ],
        },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().result[0]).toEqual({ result: 1, error: null });
    expect(response.json().result[1].error.code).toBe("bad_request");
    expect(response.json().result[2].error.code).toBe("bad_request");

    const tooMany = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: { action: "multi", version: 1, params: { actions: Array.from({ length: 51 }, () => ({ action: "version" })) } },
    });
    expect(tooMany.json().error.code).toBe("bad_request");
  });

  it("reports unknown and completed job status", async () => {
    const bundle = testBundle();
    dirs.push(bundle.dir);
    const port = await listen(bundle);
    let completedJobId = "";
    const { ws, ready } = connectPlugin(port, {
      onJob(message, socket) {
        completedJobId = message.jobId;
        socket.send(JSON.stringify({ type: "result", jobId: message.jobId, result: { ok: true }, error: null }));
      },
    });
    await ready;

    const unknown = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: { action: "jobStatus", version: 1, params: { jobId: "missing" } },
    });
    expect(unknown.json().error.code).toBe("not_found");

    await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: { action: "createFlashcard", version: 1, params: { front: "A", back: "B" } },
    });

    const complete = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: { action: "jobStatus", version: 1, params: { jobId: completedJobId } },
    });
    expect(complete.json().result.status).toBe("complete");
    ws.close();
    await bundle.app.close();
  });

  it("exposes sanitized pending job progress in status", async () => {
    const bundle = testBundle();
    dirs.push(bundle.dir);
    const port = await listen(bundle);
    let pendingJobId = "";
    const { ws, ready } = connectPlugin(port, {
      onJob(message, socket) {
        pendingJobId = message.jobId;
        socket.send(JSON.stringify({ type: "progress", jobId: message.jobId, completed: 12, total: 100, message: "Snapshotted 12/100 Rem" }));
      },
    });
    await ready;

    const controller = new AbortController();
    const request = fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: {
        host: "127.0.0.1:8766",
        authorization: "Bearer test-token-test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "backupGraph", version: 1, params: {} }),
      signal: controller.signal,
    });

    const summary = await eventually(
      async () => {
        const status = await bundle.app.inject({ method: "POST", url: "/", headers: authHeaders, payload: { action: "status", version: 1 } });
        return status.json().result.bridge.pendingJobSummaries?.[0];
      },
      (value) => value?.lastProgress?.completed === 12,
    );
    expect(summary).toMatchObject({
      jobId: pendingJobId,
      status: "pending",
      action: "backupGraph",
      progressCount: 1,
      lastProgress: { completed: 12, total: 100, message: "Snapshotted 12/100 Rem" },
    });
    expect(JSON.stringify(summary)).not.toContain("test-token-test-token");

    controller.abort();
    await expect(request).rejects.toThrow();
    ws.close();
    await bundle.app.close();
  });

  it("clears a pending bridge job when the HTTP client aborts", async () => {
    const bundle = testBundle();
    dirs.push(bundle.dir);
    const port = await listen(bundle);
    let pendingJobId = "";
    const { ws, ready } = connectPlugin(port, {
      onJob(message) {
        pendingJobId = message.jobId;
      },
    });
    await ready;

    const controller = new AbortController();
    const request = fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: {
        host: "127.0.0.1:8766",
        authorization: "Bearer test-token-test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "createFlashcard", version: 1, params: { front: "A", back: "B" } }),
      signal: controller.signal,
    });

    await eventually(
      async () => {
        const status = await bundle.app.inject({ method: "POST", url: "/", headers: authHeaders, payload: { action: "status", version: 1 } });
        return status.json().result.bridge.pendingJobs as number;
      },
      (pendingJobs) => pendingJobs === 1,
    );
    expect(pendingJobId).toMatch(/[0-9a-f-]{36}/);

    controller.abort();
    await expect(request).rejects.toThrow();

    await eventually(
      async () => {
        const status = await bundle.app.inject({ method: "POST", url: "/", headers: authHeaders, payload: { action: "status", version: 1 } });
        return status.json().result.bridge.pendingJobs as number;
      },
      (pendingJobs) => pendingJobs === 0,
    );

    const aborted = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: { action: "jobStatus", version: 1, params: { jobId: pendingJobId } },
    });
    expect(aborted.json().result.status).toBe("aborted");

    ws.close();
    await bundle.app.close();
  });

  it("runs durable async flashcard jobs and confirms materialized ids", async () => {
    const bundle = testBundle();
    dirs.push(bundle.dir);
    const port = await listen(bundle);
    let created = 0;
    const { ws, ready } = connectPlugin(port, {
      onJob(message, socket) {
        expect(message.action).toBe("createFlashcard");
        created += 1;
        socket.send(
          JSON.stringify({
            type: "result",
            jobId: message.jobId,
            result: { id: `async-${created}`, externalId: message.params.externalId, batchId: message.params.batchId },
            error: null,
          }),
        );
      },
    });
    await ready;

    const dryRun = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: { action: "createFlashcardsAsync", version: 1, params: { cards: [{ front: "A" }, { front: "B" }] } },
    });
    expect(dryRun.json().result).toMatchObject({ dryRun: true, count: 2 });

    const queued = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: {
        action: "createFlashcardsAsync",
        version: 1,
        params: {
          confirm: true,
          deckPath: "Async",
          batchId: "batch-1",
          cards: [
            { front: "A", back: "A back", externalId: "ext-a" },
            { front: "B", back: "B back", externalId: "ext-b" },
          ],
        },
      },
    });
    const jobId = queued.json().result.jobId;
    expect(jobId).toMatch(/[0-9a-f-]{36}/);

    const waited = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: { action: "jobWait", version: 1, params: { jobId, timeoutMs: 5000 } },
    });
    expect(waited.json().result).toMatchObject({ status: "complete", cursor: 2, total: 2, ids: ["async-1", "async-2"] });
    expect(waited.json().result.paramsStored).toBe(true);
    expect(waited.json().result.params).toBeUndefined();

    const materialized = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: { action: "confirmMaterialized", version: 1, params: { batchId: "batch-1" } },
    });
    expect(materialized.json().result).toMatchObject({ count: 2, remIds: ["async-1", "async-2"] });
    expect(readFileSync(join(bundle.config.appDir, "external-id-index.jsonl"), "utf8")).toContain("ext-b");
    ws.close();
    await bundle.app.close();
  });

  it("uses daemon externalId index for idempotent document reruns", async () => {
    const bundle = testBundle();
    dirs.push(bundle.dir);
    const port = await listen(bundle);
    const seenExisting: unknown[] = [];
    const { ws, ready } = connectPlugin(port, {
      onJob(message, socket) {
        expect(message.action).toBe("createDocument");
        seenExisting.push(message.params.existingRemId);
        socket.send(
          JSON.stringify({
            type: "result",
            jobId: message.jobId,
            result:
              message.params.dryRun === true || message.params.confirm !== true
                ? { dryRun: true, count: 1, remIds: message.params.existingRemId ? ["doc-1"] : [] }
                : { id: "doc-1", count: 1, remIds: ["doc-1"], updatedExisting: Boolean(message.params.existingRemId) },
            error: null,
          }),
        );
      },
    });
    await ready;

    const first = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: {
        action: "createDocument",
        version: 1,
        params: { markdown: "- First", parentPath: "Docs", externalId: "doc-ext", confirm: true },
      },
    });
    expect(first.json().error).toBeNull();

    const second = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: {
        action: "createDocument",
        version: 1,
        params: { markdown: "- Second", parentPath: "Docs", externalId: "doc-ext", confirm: true },
      },
    });
    expect(second.json().result).toMatchObject({ id: "doc-1", updatedExisting: true });
    expect(seenExisting).toEqual([undefined, "doc-1"]);
    ws.close();
    await bundle.app.close();
  });

  it("resumes durable async jobs from JSONL after a daemon restart", async () => {
    const first = testBundle();
    dirs.push(first.dir);
    const firstPort = await listen(first);
    let firstSeen = 0;
    const firstPlugin = connectPlugin(firstPort, {
      onJob(message, socket) {
        firstSeen += 1;
        if (firstSeen === 1) {
          socket.send(JSON.stringify({ type: "result", jobId: message.jobId, result: { id: "resume-1" }, error: null }));
          return;
        }
        socket.send(
          JSON.stringify({
            type: "result",
            jobId: message.jobId,
            result: null,
            error: { code: "plugin_reconnected", message: "simulated restart" },
          }),
        );
      },
    });
    await firstPlugin.ready;

    const queued = await first.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: {
        action: "createFlashcardsAsync",
        version: 1,
        params: {
          confirm: true,
          cards: [
            { front: "First", back: "One" },
            { front: "Second", back: "Two" },
          ],
        },
      },
    });
    const jobId = queued.json().result.jobId;
    const queuedStatus = await eventually(
      async () =>
        first.app.inject({
          method: "POST",
          url: "/",
          headers: authHeaders,
          payload: { action: "jobStatus", version: 1, params: { jobId } },
        }),
      (response) => response.json().result?.status === "queued" && response.json().result?.cursor === 1,
    );
    expect(queuedStatus.json().result).toMatchObject({ status: "queued", cursor: 1, ids: ["resume-1"] });
    firstPlugin.ws.close();
    await first.app.close();

    const second = buildServer(first.config);
    const secondPort = await listen(second as ReturnType<typeof testBundle>);
    const secondPlugin = connectPlugin(secondPort, {
      onJob(message, socket) {
        socket.send(JSON.stringify({ type: "result", jobId: message.jobId, result: { id: "resume-2" }, error: null }));
      },
    });
    await secondPlugin.ready;

    const waited = await second.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: { action: "jobWait", version: 1, params: { jobId, timeoutMs: 5000 } },
    });
    expect(waited.json().result).toMatchObject({ status: "complete", cursor: 2, ids: ["resume-1", "resume-2"] });
    secondPlugin.ws.close();
    await second.app.close();
  });

  it("stores undo state and writes content-free audit for soft delete", async () => {
    const bundle = testBundle();
    dirs.push(bundle.dir);
    const port = await listen(bundle);
    const seenActions: string[] = [];
    const { ws, ready } = connectPlugin(port, {
      onJob(message, socket) {
        seenActions.push(message.action);
        expect(message.action).toBe("deleteRem");
        expect(message.params.backupVerified).toBeUndefined();
        if (message.params.dryRun === true || message.params.confirm !== true) {
          socket.send(
            JSON.stringify({
              type: "result",
              jobId: message.jobId,
              result: { dryRun: true, count: 1, remIds: ["rem-1"] },
              error: null,
            }),
          );
          return;
        }
        socket.send(
          JSON.stringify({
            type: "result",
            jobId: message.jobId,
            result: {
              opId: "op-soft-delete",
              count: 1,
              remIds: ["rem-1"],
              tombstoneParentId: "trash-op",
              undoRecord: {
                schemaVersion: 1,
                opId: "op-soft-delete",
                action: "deleteRem",
                createdAt: "2026-01-01T00:00:00.000Z",
                targets: [{ id: "rem-1", parentId: "parent-1", siblingIndex: 2, richText: "secret note body" }],
              },
            },
            error: null,
          }),
        );
      },
    });
    await ready;

    const response = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: { action: "deleteRem", version: 1, params: { remIds: ["rem-1"], confirm: true } },
    });

    expect(response.json().error).toBeNull();
    expect(seenActions).toEqual(["deleteRem", "deleteRem"]);
    expect(response.json().result.undo).toEqual({ opId: "op-soft-delete", targetCount: 1 });
    expect(response.json().result.undoRecord).toBeUndefined();

    const undoPath = join(bundle.config.appDir, "undo", "op-soft-delete.json");
    expect(existsSync(undoPath)).toBe(true);
    expect(statSync(undoPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(undoPath, "utf8")).toContain("secret note body");

    const auditPath = join(bundle.config.logDir, "audit.jsonl");
    const audit = readFileSync(auditPath, "utf8");
    expect(audit).toContain("op-soft-delete");
    expect(audit).not.toContain("secret note body");
    ws.close();
    await bundle.app.close();
  });

  it("requires a prior dry-run hash before emptyTrash executes", async () => {
    const bundle = testBundle();
    dirs.push(bundle.dir);
    const port = await listen(bundle);
    const seenActions: string[] = [];
    const { ws, ready } = connectPlugin(port, {
      onJob(message, socket) {
        seenActions.push(message.action);
        if (message.action !== "emptyTrash") return;
        if (message.params.confirm === true) expect(message.params.irreversibleVerified).toBe(true);
        socket.send(
          JSON.stringify({
            type: "result",
            jobId: message.jobId,
            result:
              message.params.dryRun === true || message.params.confirm !== true
                ? { dryRun: true, count: 1, remIds: ["trash-1"] }
                : { count: 1, remIds: ["trash-1"] },
            error: null,
          }),
        );
      },
    });
    await ready;

    const missingHash = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: { action: "emptyTrash", version: 1, params: { confirm: true } },
    });
    expect(missingHash.json().error.code).toBe("dry_run_required");
    const suggestedHash = missingHash.json().error.details.fromDryRun;
    expect(suggestedHash).toMatch(/^[a-f0-9]{64}$/);

    const dryRun = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: { action: "emptyTrash", version: 1, params: {} },
    });
    expect(dryRun.json().error).toBeNull();
    expect(dryRun.json().result.fromDryRun).toBe(suggestedHash);

    const executed = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: { action: "emptyTrash", version: 1, params: { confirm: true, fromDryRun: dryRun.json().result.fromDryRun } },
    });
    expect(executed.json().error).toBeNull();
    expect(executed.json().result).toMatchObject({ count: 1, remIds: ["trash-1"] });
    expect(seenActions).toEqual(["emptyTrash", "emptyTrash", "emptyTrash", "emptyTrash"]);
    ws.close();
    await bundle.app.close();
  });

  it("requires explicit human re-confirmation to reset the irreversible session budget", async () => {
    const bundle = testBundle();
    dirs.push(bundle.dir);
    const port = await listen(bundle);
    let executedCount = 0;
    const { ws, ready } = connectPlugin(port, {
      onJob(message, socket) {
        if (message.action !== "emptyTrash") return;
        if (message.params.confirm === true && message.params.dryRun !== true) executedCount += 1;
        socket.send(
          JSON.stringify({
            type: "result",
            jobId: message.jobId,
            result:
              message.params.dryRun === true || message.params.confirm !== true
                ? { dryRun: true, count: 1, remIds: ["trash-budget"] }
                : { count: 1, remIds: ["trash-budget"] },
            error: null,
          }),
        );
      },
    });
    await ready;

    const dryRun = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: { action: "emptyTrash", version: 1, params: {} },
    });
    const fromDryRun = dryRun.json().result.fromDryRun;

    for (let i = 0; i < 3; i += 1) {
      const executed = await bundle.app.inject({
        method: "POST",
        url: "/",
        headers: authHeaders,
        payload: { action: "emptyTrash", version: 1, params: { confirm: true, fromDryRun } },
      });
      expect(executed.json().error).toBeNull();
    }

    const exhausted = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: { action: "emptyTrash", version: 1, params: { confirm: true, fromDryRun } },
    });
    expect(exhausted.json().error.code).toBe("irreversible_budget_exceeded");
    expect(executedCount).toBe(3);

    const rejectedReset = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: { action: "reconfirmIrreversibleBudget", version: 1, params: { confirm: true, phrase: "reset it" } },
    });
    expect(rejectedReset.json().error.code).toBe("confirm_required");

    const reset = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: {
        action: "reconfirmIrreversibleBudget",
        version: 1,
        params: { confirm: true, phrase: IRREVERSIBLE_RECONFIRM_PHRASE },
      },
    });
    expect(reset.json().error).toBeNull();
    expect(reset.json().result.irreversibleRemaining).toBe(3);

    const afterReset = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: { action: "emptyTrash", version: 1, params: { confirm: true, fromDryRun } },
    });
    expect(afterReset.json().error).toBeNull();
    expect(executedCount).toBe(4);
    expect(readFileSync(join(bundle.config.logDir, "audit.jsonl"), "utf8")).toContain("reconfirmIrreversibleBudget");
    ws.close();
    await bundle.app.close();
  });

  it("gates structural merge behind a prior dry-run hash while default merge stays reversible", async () => {
    const bundle = testBundle();
    dirs.push(bundle.dir);
    const port = await listen(bundle);
    const seen: Array<{ action: string; params: Record<string, unknown> }> = [];
    const { ws, ready } = connectPlugin(port, {
      onJob(message, socket) {
        seen.push({ action: message.action, params: message.params });
        if (message.action !== "mergeRems") return;
        if (message.params.structural === true && message.params.confirm === true) {
          expect(message.params.irreversibleVerified).toBe(true);
        }
        socket.send(
          JSON.stringify({
            type: "result",
            jobId: message.jobId,
            result:
              message.params.dryRun === true || message.params.confirm !== true
                ? { dryRun: true, structural: message.params.structural === true, count: 1, remIds: ["loser-1"] }
                : { opId: "op-merge", count: 1, remIds: ["loser-1"] },
            error: null,
          }),
        );
      },
    });
    await ready;

    const defaultMerge = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: {
        action: "mergeRems",
        version: 1,
        params: { keepId: "keeper-1", mergeIds: ["loser-1"], confirm: true },
      },
    });
    expect(defaultMerge.json().error).toBeNull();
    expect(defaultMerge.json().result).toMatchObject({ opId: "op-merge", count: 1 });

    const missingHash = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: {
        action: "mergeRems",
        version: 1,
        params: { keepId: "keeper-1", mergeIds: ["loser-1"], structural: true, confirm: true },
      },
    });
    expect(missingHash.json().error.code).toBe("dry_run_required");

    const dryRun = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: {
        action: "mergeRems",
        version: 1,
        params: { keepId: "keeper-1", mergeIds: ["loser-1"], structural: true },
      },
    });
    expect(dryRun.json().error).toBeNull();
    expect(dryRun.json().result.fromDryRun).toMatch(/^[a-f0-9]{64}$/);

    const executed = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: {
        action: "mergeRems",
        version: 1,
        params: {
          keepId: "keeper-1",
          mergeIds: ["loser-1"],
          structural: true,
          confirm: true,
          fromDryRun: dryRun.json().result.fromDryRun,
        },
      },
    });
    expect(executed.json().error).toBeNull();
    expect(executed.json().result).toMatchObject({ opId: "op-merge", count: 1 });
    expect(seen.map((item) => item.action)).toEqual(["mergeRems", "mergeRems", "mergeRems", "mergeRems", "mergeRems", "mergeRems"]);
    expect(seen.filter((item) => item.params.confirm === true && item.params.structural === true)).toHaveLength(1);
    expect(seen.filter((item) => item.params.dryRun === true)).toHaveLength(4);
    ws.close();
    await bundle.app.close();
  });

  it("caps retained job history after many completed jobs", async () => {
    const bundle = testBundle();
    dirs.push(bundle.dir);
    const port = await listen(bundle);
    const { ws, ready } = connectPlugin(port, {
      onJob(message, socket) {
        socket.send(JSON.stringify({ type: "result", jobId: message.jobId, result: { ok: true }, error: null }));
      },
    });
    await ready;

    for (let i = 0; i < 510; i += 1) {
      const response = await bundle.app.inject({
        method: "POST",
        url: "/",
        headers: authHeaders,
        payload: { action: "createFlashcard", version: 1, params: { front: `A ${i}`, back: "B" } },
      });
      expect(response.json().error).toBeNull();
    }

    const status = await bundle.app.inject({
      method: "POST",
      url: "/",
      headers: authHeaders,
      payload: { action: "status", version: 1 },
    });
    expect(status.json().result.bridge.retainedJobs).toBeLessThanOrEqual(500);
    ws.close();
    await bundle.app.close();
  });
});
