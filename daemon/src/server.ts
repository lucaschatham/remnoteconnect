import Fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ApiEnvelopeSchema,
  DAEMON_VERSION,
  actionMetadata,
  getActionMetadata,
  fail,
  IRREVERSIBLE_RECONFIRM_PHRASE,
  isPluginAction,
  nativeActions,
  adapterActions,
  ok,
  plannedActions,
  pluginActions,
  PROTOCOL_VERSION,
  retryableBridgeError,
  unsupportedAnkiActions,
  type ApiError,
  type ApiResponse,
  type RemSnapshot,
} from "@remnoteconnect/shared";
import { readSnapshotBackup, writeSnapshotBackup } from "./backup.js";
import type { DaemonConfig } from "./config.js";
import { PluginBridge } from "./bridge.js";
import { bearerToken, isAllowedHost, isAllowedOrigin, safeTokenEqual } from "./security.js";
import { appendAudit, tailAudit } from "./audit.js";
import { clearUndoRecords, readUndoRecord, writeUndoRecord, type UndoRecord } from "./undoStore.js";
import { dryRunHash } from "./dryRun.js";
import { appendExternalId, readExternalIdMap } from "./externalIdIndex.js";
import { DurableJobManager } from "./durableJobs.js";

export type ServerBundle = {
  app: FastifyInstance;
  bridge: PluginBridge;
};

type DispatchState = {
  dryRunHashes: Set<string>;
  irreversibleRemaining: number;
  startedAt: number;
};

const MAX_MULTI_DEPTH = 1;
const MAX_MULTI_ACTIONS = 50;
const MAGNITUDE_THRESHOLD = 50;
const IRREVERSIBLE_SESSION_BUDGET = 3;
const ENABLE_ACTION_LOGS = process.env.REMNOTE_CONNECT_LOG === "1";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeTokenFile(path: string, token: string): Promise<void> {
  await writeFile(path, `${token}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

function responseFromError(error: unknown): ApiResponse<never> {
  const candidate = error as Partial<ApiError> | undefined;
  if (candidate?.code && candidate?.message) {
    return fail(candidate.code as ApiError["code"], candidate.message, candidate.details);
  }
  return fail("internal_error", error instanceof Error ? error.message : String(error));
}

function pluginActionTimeout(action: string, params: Record<string, unknown>): number {
  if (action === "createFlashcards" || action === "addNotes") {
    const items = Array.isArray(params.cards) ? params.cards : Array.isArray(params.notes) ? params.notes : [];
    return Math.max(120_000, items.length * 1_000);
  }
  if (action === "capabilityProbes") return 120_000;
  return 30_000;
}

function resultRecord(result: unknown): Record<string, unknown> {
  return result && typeof result === "object" && !Array.isArray(result) ? (result as Record<string, unknown>) : {};
}

function countFromResult(result: unknown): number | undefined {
  const record = resultRecord(result);
  return typeof record.count === "number" ? record.count : undefined;
}

function idsFromResult(result: unknown): string[] {
  const record = resultRecord(result);
  const ids = [record.remIds, record.ids, record.cardIds]
    .flatMap((value) => (Array.isArray(value) ? value : []))
    .filter((value): value is string => typeof value === "string");
  return [...new Set(ids)];
}

function opIdFromResult(result: unknown, fallback?: string): string | undefined {
  const record = resultRecord(result);
  return typeof record.opId === "string" ? record.opId : fallback;
}

function cleanPluginResult(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const { undoRecord: _undoRecord, ...rest } = result as Record<string, unknown>;
  return rest;
}

function undoRecordFromResult(result: unknown): UndoRecord | undefined {
  const record = resultRecord(result);
  const undoRecord = record.undoRecord;
  if (undoRecord && typeof undoRecord === "object" && !Array.isArray(undoRecord)) return undoRecord as UndoRecord;
  return undefined;
}

function shouldDefaultDryRun(action: string, params: Record<string, unknown>): boolean {
  const meta = getActionMetadata(action);
  if (!meta?.mutates) return false;
  if (params.confirm === true || params.dryRun === true) return false;
  return meta.bulk || meta.magnitudeGuarded || meta.irreversible || action === "deleteRem" || action === "deleteNotes";
}

function externalIdFromParams(action: string, params: Record<string, unknown>): string | undefined {
  if (typeof params.externalId === "string" && params.externalId.trim()) return params.externalId.trim();
  if (action === "addNote" && params.note && typeof params.note === "object" && !Array.isArray(params.note)) {
    const externalId = (params.note as Record<string, unknown>).externalId;
    if (typeof externalId === "string" && externalId.trim()) return externalId.trim();
  }
  return undefined;
}

function requiresDryRunHash(action: string, params: Record<string, unknown>, meta: ReturnType<typeof getActionMetadata>): boolean {
  return Boolean(meta?.requiresDryRunHash || (action === "mergeRems" && params.structural === true));
}

function consumesIrreversibleBudget(action: string, params: Record<string, unknown>, meta: ReturnType<typeof getActionMetadata>): boolean {
  return Boolean(meta?.requiresDryRunHash || meta?.irreversible || (action === "mergeRems" && params.structural === true));
}

async function runBridgeJob(
  bridge: PluginBridge,
  action: string,
  params: Record<string, unknown>,
  timeoutMs: number,
  retryable: boolean,
): Promise<unknown> {
  const attempts = retryable ? 3 : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await bridge.runJob(action, params, timeoutMs);
    } catch (error) {
      if (!retryable || attempt >= attempts || !retryableBridgeError(error)) throw error;
      await sleep(250 * attempt);
    }
  }
  throw { code: "internal_error", message: "Bridge retry loop exhausted unexpectedly." } satisfies ApiError;
}

async function dispatchAction(
  action: string,
  params: Record<string, unknown>,
  bridge: PluginBridge,
  durableJobs: DurableJobManager,
  config: DaemonConfig,
  state: DispatchState,
  depth = 0,
): Promise<ApiResponse> {
  if (action === "version") return ok(PROTOCOL_VERSION);
  if (action === "status") {
    return ok({
      daemonVersion: DAEMON_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      appDir: config.appDir,
      backupDir: config.backupDir,
      logDir: config.logDir,
      bridge: bridge.status(),
    });
  }
  if (action === "capabilities") {
    return ok({
      native: nativeActions,
      adapter: adapterActions,
      unsupported: unsupportedAnkiActions,
      planned: plannedActions,
      plugin: pluginActions,
      bridge: bridge.status(),
    });
  }
  if (action === "describe") {
    return ok({
      protocolVersion: PROTOCOL_VERSION,
      actions: actionMetadata,
      magnitudeThreshold: MAGNITUDE_THRESHOLD,
      irreversibleSessionBudget: IRREVERSIBLE_SESSION_BUDGET,
      irreversibleReconfirmPhrase: IRREVERSIBLE_RECONFIRM_PHRASE,
      migrationFeatures: {
        durableAsync: true,
        parseAndInsertHtml: true,
        clozeWrite: true,
        mediaPipeline: "daemon-local-url",
        noteTypeMapping: "scripts/anki-migrate.mjs",
        finalAsDocument: true,
      },
      queryGrammar: ["deck:<path>", "tag:<tag>", "text:<string>", "id:<remId>"],
    });
  }
  if (action === "metrics") {
    const bridgeStatus = bridge.status();
    return ok({
      uptimeMs: Date.now() - state.startedAt,
      bridge: bridgeStatus,
      irreversibleRemaining: state.irreversibleRemaining,
      dryRunHashesRetained: state.dryRunHashes.size,
    });
  }
  if (action === "reconfirmIrreversibleBudget") {
    const phrase = typeof params.phrase === "string" ? params.phrase.trim() : "";
    if (params.confirm !== true || phrase !== IRREVERSIBLE_RECONFIRM_PHRASE) {
      return fail("confirm_required", "reconfirmIrreversibleBudget requires confirm:true and the exact irreversible confirmation phrase.", {
        phrase: IRREVERSIBLE_RECONFIRM_PHRASE,
      });
    }
    state.irreversibleRemaining = IRREVERSIBLE_SESSION_BUDGET;
    await appendAudit(config.logDir, {
      ts: new Date().toISOString(),
      action: "reconfirmIrreversibleBudget",
      targetIds: [],
      count: IRREVERSIBLE_SESSION_BUDGET,
      status: "success",
    });
    return ok({
      irreversibleRemaining: state.irreversibleRemaining,
      irreversibleSessionBudget: IRREVERSIBLE_SESSION_BUDGET,
    });
  }
  if (action === "rotateToken") {
    if (!bridge.status().connected) return fail("plugin_disconnected", "RemNote plugin must be connected before rotating the daemon token.");
    try {
      const nextToken = randomBytes(32).toString("hex");
      await bridge.runJob("setDaemonToken", { token: nextToken }, 10_000);
      await writeTokenFile(config.tokenFile, nextToken);
      config.token = nextToken;
      await appendAudit(config.logDir, {
        ts: new Date().toISOString(),
        action: "rotateToken",
        targetIds: [],
        count: 1,
        status: "success",
      });
      return ok({ rotated: true, tokenFile: config.tokenFile, pluginUpdated: true });
    } catch (error) {
      await appendAudit(config.logDir, {
        ts: new Date().toISOString(),
        action: "rotateToken",
        targetIds: [],
        status: "error",
        errorCode: (error as Partial<ApiError>)?.code,
      }).catch(() => undefined);
      return responseFromError(error);
    }
  }
  if (action === "doctor") {
    const bridgeStatus = bridge.status();
    const checks: Record<string, unknown> = {
      daemon: { ok: true, version: DAEMON_VERSION },
      bridge: bridgeStatus,
    };
    let okStatus = bridgeStatus.connected;
    if (bridgeStatus.connected) {
      try {
        const scopeProbe = await runBridgeJob(bridge, "scopeProbe", {}, 60_000, true);
        checks.scopeProbe = scopeProbe;
        okStatus = resultRecord(scopeProbe).ok === true;
      } catch (error) {
        checks.scopeProbe = {
          ok: false,
          error: error instanceof Error ? error.message : String((error as Partial<ApiError>)?.message ?? error),
          code: (error as Partial<ApiError>)?.code,
        };
        okStatus = false;
      }
    } else {
      checks.scopeProbe = { ok: false, error: "plugin_disconnected" };
    }
    return ok({ ok: okStatus, checks });
  }
  if (action === "jobStatus") {
    const jobId = typeof params.jobId === "string" ? params.jobId : "";
    const durable = await durableJobs.status(jobId);
    return durable ?? bridge.jobStatus(jobId);
  }
  if (action === "jobWait") {
    const jobId = typeof params.jobId === "string" ? params.jobId : "";
    if (!jobId) return fail("bad_request", "jobWait requires jobId.");
    return durableJobs.wait(jobId, Number(params.timeoutMs ?? 120_000));
  }
  if (action === "createFlashcardsAsync" || action === "importAsync") {
    return durableJobs.submit(action, params);
  }
  if (action === "confirmMaterialized") {
    return durableJobs.confirmMaterialized(params);
  }
  if (action === "journalTail") {
    return ok(await tailAudit(config.logDir, Number(params.n ?? 50)));
  }
  if (action === "undoClear") {
    return ok({ count: await clearUndoRecords(config.appDir, typeof params.opId === "string" ? params.opId : undefined) });
  }
  if (action === "undo") {
    const opId = typeof params.opId === "string" ? params.opId : "";
    if (!opId) return fail("bad_request", "undo requires opId.");
    try {
      const undoRecord = await readUndoRecord(config.appDir, opId);
      const started = Date.now();
      const result = await runBridgeJob(bridge, "undo", { undoRecord }, pluginActionTimeout("undo", params), false);
      await appendAudit(config.logDir, {
        ts: new Date().toISOString(),
        action: "undo",
        opId,
        targetIds: idsFromResult(result),
        count: countFromResult(result),
        status: "success",
        durationMs: Date.now() - started,
      });
      return ok(result);
    } catch (error) {
      return responseFromError(error);
    }
  }
  if (action === "backupGraph") {
    try {
      const snapshot = (await runBridgeJob(bridge, "backupGraph", params, 10 * 60_000, true)) as RemSnapshot;
      return ok(await writeSnapshotBackup(config.backupDir, "graph", snapshot));
    } catch (error) {
      return responseFromError(error);
    }
  }
  if (action === "restoreBackup") {
    const file = typeof params.file === "string" ? params.file : typeof params.path === "string" ? params.path : "";
    if (!file) return fail("bad_request", "restoreBackup requires file or path.");
    try {
      const snapshot = await readSnapshotBackup(config.backupDir, file);
      const rest = { ...params };
      delete rest.file;
      delete rest.path;
      return dispatchAction(
        "importSnapshot",
        {
          ...rest,
          snapshot,
          parentPath: typeof params.parentPath === "string" ? params.parentPath : "__restored__",
        },
        bridge,
        durableJobs,
        config,
        state,
        depth + 1,
      );
    } catch (error) {
      return responseFromError(error);
    }
  }
  if (unsupportedAnkiActions.includes(action as (typeof unsupportedAnkiActions)[number])) {
    return fail("unsupported", `${action} is an Anki-only action and is not supported by RemNoteConnect v1.`);
  }
  if (action === "multi") {
    const actions = Array.isArray(params.actions) ? params.actions : [];
    if (depth >= MAX_MULTI_DEPTH) {
      return fail("bad_request", `Nested multi actions are limited to depth ${MAX_MULTI_DEPTH}.`);
    }
    if (actions.length > MAX_MULTI_ACTIONS) {
      return fail("bad_request", `multi supports at most ${MAX_MULTI_ACTIONS} nested actions.`);
    }
    const results: ApiResponse[] = [];
    for (const item of actions) {
      const parsed = ApiEnvelopeSchema.safeParse(item);
      if (!parsed.success) {
        results.push(fail("bad_request", "Invalid nested action.", parsed.error.flatten()));
        continue;
      }
      results.push(await dispatchAction(parsed.data.action, parsed.data.params, bridge, durableJobs, config, state, depth + 1));
    }
    return ok(results);
  }
  const meta = getActionMetadata(action);
  if (meta && !meta.implemented) {
    return fail("not_implemented", `${action} is planned but is not implemented in this build.`);
  }
  if (!isPluginAction(action)) {
    return fail("unsupported", `Unknown action: ${action}`);
  }

  try {
    const started = Date.now();
    const actionParams = { ...params };
    const externalId = externalIdFromParams(action, actionParams);
    if (externalId && actionParams.existingRemId === undefined) {
      const externalIds = await readExternalIdMap(config.appDir);
      const existingRemId = externalIds.get(externalId);
      if (existingRemId) actionParams.existingRemId = existingRemId;
    }

    if (shouldDefaultDryRun(action, actionParams)) actionParams.dryRun = true;

    const actionMeta = getActionMetadata(action);
    const actionRequiresDryRunHash = requiresDryRunHash(action, actionParams, actionMeta);
    const actionConsumesIrreversibleBudget = consumesIrreversibleBudget(action, actionParams, actionMeta);
    const needsSafetyPreflight = actionParams.confirm === true && actionMeta && (actionMeta.magnitudeGuarded || actionRequiresDryRunHash);
    let preflight: unknown;
    let hash: string | undefined;
    if (needsSafetyPreflight) {
      preflight = await runBridgeJob(bridge, action, { ...actionParams, dryRun: true, confirm: false }, pluginActionTimeout(action, actionParams), true);
      const count = countFromResult(preflight);
      if (typeof count === "number" && count > MAGNITUDE_THRESHOLD && Number(actionParams.confirmCount) !== count) {
        return fail("magnitude_guard", `${action} resolved ${count} targets. Pass confirmCount:${count} to execute.`, {
          count,
          threshold: MAGNITUDE_THRESHOLD,
          targetIds: idsFromResult(preflight),
        });
      }
      if (actionRequiresDryRunHash) {
        hash = dryRunHash(action, preflight);
        if (typeof actionParams.fromDryRun !== "string") {
          return fail("dry_run_required", `${action} requires fromDryRun from a prior dry-run.`, { fromDryRun: hash });
        }
        if (actionParams.fromDryRun !== hash || !state.dryRunHashes.has(hash)) {
          return fail("dry_run_mismatch", `${action} fromDryRun does not match the current target set.`, { expected: hash });
        }
        if (state.irreversibleRemaining <= 0) {
          return fail("irreversible_budget_exceeded", "Irreversible operation session budget is exhausted. Run reconfirmIrreversibleBudget with explicit human confirmation before continuing.");
        }
        actionParams.irreversibleVerified = true;
      }
    }

    const result = await runBridgeJob(bridge, action, actionParams, pluginActionTimeout(action, actionParams), actionMeta?.retryable === true);
    const resultHash = actionRequiresDryRunHash && resultRecord(result).dryRun === true ? dryRunHash(action, result) : undefined;
    if (resultHash) {
      state.dryRunHashes.add(resultHash);
      const withHash = result && typeof result === "object" && !Array.isArray(result) ? { ...(result as Record<string, unknown>), fromDryRun: resultHash } : result;
      await appendAudit(config.logDir, {
        ts: new Date().toISOString(),
        action,
        opId: opIdFromResult(withHash),
        targetIds: idsFromResult(withHash),
        count: countFromResult(withHash),
        status: "dry_run",
        durationMs: Date.now() - started,
      });
      return ok(withHash);
    }

    const undoRecord = undoRecordFromResult(result);
    let undoStored: Awaited<ReturnType<typeof writeUndoRecord>> | undefined;
    if (undoRecord) undoStored = await writeUndoRecord(config.appDir, undoRecord);

    if (externalId) {
      const id = typeof resultRecord(result).id === "string" ? (resultRecord(result).id as string) : undefined;
      if (id) await appendExternalId(config.appDir, { action, externalId, remId: id });
    }

    if (actionConsumesIrreversibleBudget && actionParams.confirm === true) state.irreversibleRemaining -= 1;

    const cleanResult = cleanPluginResult(result);
    await appendAudit(config.logDir, {
      ts: new Date().toISOString(),
      action,
      opId: opIdFromResult(cleanResult, undoRecord?.opId),
      targetIds: idsFromResult(cleanResult),
      count: countFromResult(cleanResult),
      status: resultRecord(cleanResult).dryRun === true ? "dry_run" : "success",
      durationMs: Date.now() - started,
    });

    if (undoStored && cleanResult && typeof cleanResult === "object" && !Array.isArray(cleanResult)) {
      return ok({ ...(cleanResult as Record<string, unknown>), undo: { opId: undoStored.opId, targetCount: undoStored.targetCount } });
    }
    return ok(cleanResult);
  } catch (error) {
    await appendAudit(config.logDir, {
      ts: new Date().toISOString(),
      action,
      targetIds: [],
      status: "error",
      errorCode: (error as Partial<ApiError>)?.code,
    }).catch(() => undefined);
    return responseFromError(error);
  }
}

function setCors(reply: FastifyReply, origin?: string): void {
  if (origin) {
    reply.header("Access-Control-Allow-Origin", origin);
    reply.header("Vary", "Origin");
  }
  reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
  reply.header("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
}

function mediaContentType(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  return "application/octet-stream";
}

async function readMediaFile(config: DaemonConfig, name: string): Promise<{ body: Buffer; contentType: string }> {
  if (!/^[a-f0-9]{64}(?:\.[A-Za-z0-9]+)?$/.test(name)) {
    throw { code: "bad_request", message: "Invalid media name." } satisfies ApiError;
  }
  const mediaRoot = resolve(join(config.appDir, "media"));
  const mediaFile = resolve(join(mediaRoot, name));
  if (!mediaFile.startsWith(`${mediaRoot}/`)) throw { code: "bad_request", message: "Invalid media path." } satisfies ApiError;
  return { body: await readFile(mediaFile), contentType: mediaContentType(name) };
}

export function buildServer(config: DaemonConfig): ServerBundle {
  const app = Fastify({ logger: false });
  const bridge = new PluginBridge(config);
  const durableJobs = new DurableJobManager(config, bridge);
  const wss = bridge.createWebSocketServer();
  const state: DispatchState = {
    dryRunHashes: new Set<string>(),
    irreversibleRemaining: IRREVERSIBLE_SESSION_BUDGET,
    startedAt: Date.now(),
  };

  app.server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/bridge" || !isAllowedHost(request.headers.host, config)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!isAllowedHost(request.headers.host, config)) {
      reply.code(403).send(fail("forbidden_origin", "Host header is not local."));
      return;
    }
    const origin = request.headers.origin;
    if (!isAllowedOrigin(origin, config)) {
      reply.code(403).send(fail("forbidden_origin", "Origin is not allowed."));
      return;
    }
    setCors(reply, origin);
    if (request.method === "OPTIONS" || request.url === "/health" || (request.method === "GET" && request.url.startsWith("/media/"))) return;
    if (!safeTokenEqual(bearerToken(request), config.token)) {
      reply.code(401).send(fail("unauthorized", "Missing or invalid bearer token."));
    }
  });

  app.options("*", async (_request, reply) => {
    reply.code(204).send();
  });

  app.get("/health", async () => ok({ ok: true, daemonVersion: DAEMON_VERSION }));

  app.get("/media/:name", async (request: FastifyRequest<{ Params: { name: string } }>, reply) => {
    try {
      const media = await readMediaFile(config, request.params.name);
      reply.header("Cache-Control", "public, max-age=31536000, immutable");
      reply.type(media.contentType);
      return media.body;
    } catch (error) {
      const response = responseFromError(error);
      reply.code(response.error?.code === "bad_request" ? 400 : 404);
      return response;
    }
  });

  app.post("/", async (request: FastifyRequest, reply) => {
    const parsed = ApiEnvelopeSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return fail("bad_request", "Invalid RemNoteConnect request envelope.", parsed.error.flatten());
    }
    const startedAt = Date.now();
    const response = await dispatchAction(parsed.data.action, parsed.data.params, bridge, durableJobs, config, state);
    if (ENABLE_ACTION_LOGS) {
      console.error(
        JSON.stringify({
          at: new Date().toISOString(),
          action: parsed.data.action,
          durationMs: Date.now() - startedAt,
          ok: response.error === null,
          errorCode: response.error?.code,
        }),
      );
    }
    return response;
  });

  return { app, bridge };
}
