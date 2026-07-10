import Fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ApiEnvelopeSchema,
  BUILD_HASH,
  DAEMON_VERSION,
  describeActionMetadata,
  getActionMetadata,
  fail,
  isPluginAction,
  nativeActions,
  adapterActions,
  ok,
  plannedActions,
  pluginActions,
  PROTOCOL_VERSION,
  parseActionParams,
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
import { clearUndoRecords, listUndoRecords, readUndoRecord, updateUndoRecordState, writeUndoRecord, type UndoRecord } from "./undoStore.js";
import { dryRunHash } from "./dryRun.js";
import { appendExternalId, readExternalIdMap } from "./externalIdIndex.js";
import { DurableJobManager } from "./durableJobs.js";
import { IRREVERSIBLE_SESSION_BUDGET, MAGNITUDE_THRESHOLD, SafetyCoordinator } from "./safety.js";
import { PairingStore } from "./pairing.js";

export type ServerBundle = {
  app: FastifyInstance;
  bridge: PluginBridge;
};

type DispatchState = {
  startedAt: number;
  readonlyMode: boolean;
  safety: SafetyCoordinator;
  pairing: PairingStore;
};

const MAX_MULTI_DEPTH = 1;
const MAX_MULTI_ACTIONS = 50;
const DEFAULT_BODY_LIMIT_BYTES = 50 * 1024 * 1024;
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
  if (action === "backupGraph") {
    const requested = Number(params.timeoutMs);
    if (Number.isFinite(requested) && requested > 0) return Math.min(Math.max(requested, 120_000), 30 * 60_000);
    return 15 * 60_000;
  }
  if (action === "createFlashcards" || action === "addNotes") {
    const items = Array.isArray(params.cards) ? params.cards : Array.isArray(params.notes) ? params.notes : [];
    return Math.max(120_000, items.length * 1_000);
  }
  if (action === "createDocument" || action === "importAsync") {
    const markdownBytes = Buffer.byteLength(String(params.markdown ?? params.md ?? ""));
    const docSpecBytes = params.docSpec || params.document ? Buffer.byteLength(JSON.stringify(params.docSpec ?? params.document)) : 0;
    return Math.max(120_000, Math.ceil(Math.max(markdownBytes, docSpecBytes) / 5_000) * 1_000);
  }
  if (action === "rewriteNativeLinks") {
    const requested = Number(params.timeoutMs);
    if (Number.isFinite(requested) && requested > 0) return Math.min(Math.max(requested, 120_000), 30 * 60_000);
    const items = Array.isArray(params.candidates) ? params.candidates : Array.isArray(params.links) ? params.links : Array.isArray(params.rewrites) ? params.rewrites : [];
    return Math.max(10 * 60_000, items.length * 5_000);
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
  const ids = [record.remIds, record.ids, record.cardIds, record.targetIds]
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

function isBlockedByReadonly(action: string, state: DispatchState): boolean {
  return state.readonlyMode && getActionMetadata(action)?.mutates === true;
}

const INTERNAL_PARAM_NAMES = new Set(["irreversibleVerified", "undoPrepared", "expectedTargetIds", "expectedFingerprints", "undoRecord", "skipUndoRecord"]);
const PUBLIC_OP_ID_ACTIONS = new Set(["undo", "undoClear", "restoreTombstone"]);

function unsafePublicParam(action: string, params: Record<string, unknown>): string | undefined {
  for (const name of INTERNAL_PARAM_NAMES) if (params[name] !== undefined) return name;
  if (params.opId !== undefined && !PUBLIC_OP_ID_ACTIONS.has(action)) return "opId";
  return undefined;
}

async function runBridgeJob(
  bridge: PluginBridge,
  action: string,
  params: Record<string, unknown>,
  timeoutMs: number,
  retryable: boolean,
  signal?: AbortSignal,
): Promise<unknown> {
  const attempts = retryable ? 3 : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await bridge.runJob(action, params, timeoutMs, { signal });
    } catch (error) {
      if (!retryable || attempt >= attempts || !retryableBridgeError(error)) throw error;
      await sleep(250 * attempt);
    }
  }
  throw { code: "internal_error", message: "Bridge retry loop exhausted unexpectedly." } satisfies ApiError;
}

async function dispatchAction(
  action: string,
  inputParams: Record<string, unknown>,
  bridge: PluginBridge,
  durableJobs: DurableJobManager,
  config: DaemonConfig,
  state: DispatchState,
  depth = 0,
  signal?: AbortSignal,
  internal = false,
): Promise<ApiResponse> {
  let params = inputParams;
  const meta = getActionMetadata(action);
  if (!internal) {
    const unsafeParam = unsafePublicParam(action, params);
    if (unsafeParam) return fail("unsafe_parameter", `${unsafeParam} is daemon-internal and cannot be supplied by callers.`, { action, parameter: unsafeParam });
    if (meta) {
      const parsedParams = parseActionParams(action, params);
      if (!parsedParams.success) return fail("bad_request", `Invalid parameters for ${action}.`, parsedParams.error.flatten());
      params = parsedParams.data;
    }
  }
  if (meta && !meta.implemented) return fail("not_implemented", `${action} is not implemented in this build.`);
  if (action === "version") return ok(PROTOCOL_VERSION);
  if (action === "status") {
    return ok({
      daemonVersion: DAEMON_VERSION,
      daemonBuildHash: BUILD_HASH,
      protocolVersion: PROTOCOL_VERSION,
      readonlyMode: state.readonlyMode,
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
      actions: describeActionMetadata(),
      magnitudeThreshold: MAGNITUDE_THRESHOLD,
      irreversibleSessionBudget: IRREVERSIBLE_SESSION_BUDGET,
      contentFeatures: {
        durableAsync: true,
        parseAndInsertHtml: true,
        clozeWrite: true,
        mediaPipeline: "daemon-local-url",
        noteTypeMapping: "native RemNote card actions",
        finalAsDocument: true,
      },
      daemonBuildHash: BUILD_HASH,
      readonlyMode: state.readonlyMode,
      queryGrammar: ["deck:<path>", "tag:<tag>", "text:<string>", "id:<remId>"],
    });
  }
  if (action === "metrics") {
    const bridgeStatus = bridge.status();
    return ok({
      uptimeMs: Date.now() - state.startedAt,
      bridge: bridgeStatus,
      readonlyMode: state.readonlyMode,
      daemonBuildHash: BUILD_HASH,
      ...state.safety.metrics(),
    });
  }
  if (action === "readonly") {
    const mode = typeof params.mode === "string" ? params.mode : typeof params.enabled === "boolean" ? (params.enabled ? "on" : "off") : "status";
    if (mode !== "on" && mode !== "off" && mode !== "status") {
      return fail("bad_request", "readonly mode must be one of: on, off, status.");
    }
    const previous = state.readonlyMode;
    if (mode === "on") state.readonlyMode = true;
    if (mode === "off") state.readonlyMode = false;
    if (previous !== state.readonlyMode) {
      await durableJobs.setReadonly(state.readonlyMode);
      await appendAudit(config.logDir, {
        ts: new Date().toISOString(),
        action: "readonly",
        targetIds: [],
        count: state.readonlyMode ? 1 : 0,
        status: "success",
      });
    }
    return ok({
      readonlyMode: state.readonlyMode,
      changed: previous !== state.readonlyMode,
      daemonBuildHash: BUILD_HASH,
    });
  }
  if (isBlockedByReadonly(action, state)) {
    return fail("readonly_mode", `${action} is blocked because RemNoteConnect read-only mode is enabled. Run readonly off to allow mutations.`, {
      action,
      readonlyMode: true,
    });
  }
  if (action === "approveIrreversible") return state.safety.approve(params);
  if (action === "reconfirmIrreversibleBudget") {
    const reset = state.safety.resetBudget(typeof params.approvalNonce === "string" ? params.approvalNonce : "");
    if (!reset.error) {
      await appendAudit(config.logDir, {
        ts: new Date().toISOString(),
        action,
        targetIds: [],
        count: IRREVERSIBLE_SESSION_BUDGET,
        status: "success",
      });
    }
    return reset;
  }
  if (action === "pair") {
    const pairing = state.pairing.create();
    return ok({ ...pairing, instruction: "Paste this short-lived code into the RemNoteConnect daemon token setting." });
  }
  if (action === "rotateToken") {
    if (params.dryRun === true) return ok({ dryRun: true, wouldRotate: true });
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
    const warnings: string[] = [];
    const buildMatch = bridgeStatus.connected && bridgeStatus.pluginBuildHash === BUILD_HASH;
    if (bridgeStatus.connected && !buildMatch) {
      warnings.push(
        `Connected plugin build ${bridgeStatus.pluginBuildHash ?? "unknown"} does not match daemon build ${BUILD_HASH}; reload the RemNote local plugin bundle.`,
      );
    }
    const checks: Record<string, unknown> = {
      daemon: { ok: true, version: DAEMON_VERSION },
      bridge: bridgeStatus,
      build: {
        ok: buildMatch,
        daemonBuildHash: BUILD_HASH,
        pluginBuildHash: bridgeStatus.pluginBuildHash,
        warning: bridgeStatus.connected && !buildMatch ? warnings[0] : undefined,
      },
    };
    let okStatus = bridgeStatus.connected;
    if (bridgeStatus.connected) {
      try {
        const scopeProbe = await runBridgeJob(bridge, "scopeProbe", {}, 60_000, true, signal);
        checks.scopeProbe = scopeProbe;
        okStatus = resultRecord(scopeProbe).ok === true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String((error as Partial<ApiError>)?.message ?? error);
        checks.scopeProbe = {
          ok: false,
          error: message,
          code: (error as Partial<ApiError>)?.code,
        };
        if (message.includes("Managed root Rem")) {
          checks.initialization = { ok: false, command: "node scripts/rnc.mjs init" };
          warnings.push("The operational RemNoteConnect root is missing. Run: node scripts/rnc.mjs init");
        }
        okStatus = false;
      }
    } else {
      checks.scopeProbe = { ok: false, error: "plugin_disconnected" };
    }
    return ok({ ok: okStatus, checks, warnings, readonlyMode: state.readonlyMode });
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
    const requestedOpId = typeof params.opId === "string" ? params.opId : undefined;
    const records = (await listUndoRecords(config.appDir)).filter((record) => !requestedOpId || record.opId === requestedOpId);
    const preview = { dryRun: true, count: records.length, opIds: records.map((record) => record.opId).sort() };
    if (params.confirm !== true) {
      const recorded = state.safety.recordDryRun(action, preview);
      return ok({ ...preview, fromDryRun: recorded.hash, warning: "undoClear permanently removes local undo records." });
    }
    const verification = state.safety.consumeIrreversible(action, preview, params);
    if (verification.error) return verification;
    const count = await clearUndoRecords(config.appDir, requestedOpId);
    await appendAudit(config.logDir, {
      ts: new Date().toISOString(),
      action,
      targetIds: records.map((record) => record.opId),
      count,
      status: "success",
    });
    return ok({ count, opIds: records.map((record) => record.opId), irreversibleRemaining: verification.result.remaining });
  }
  if (action === "undo") {
    const opId = typeof params.opId === "string" ? params.opId : "";
    if (!opId) return fail("bad_request", "undo requires opId.");
    try {
      const undoRecord = await readUndoRecord(config.appDir, opId);
      if (params.dryRun === true) {
        return ok({ dryRun: true, opId, count: undoRecord.targets.length, remIds: undoRecord.targets.map((target) => target.id) });
      }
      const redoOpId = randomUUID();
      const targetIds = undoRecord.targets.map((target) => String(target.id ?? "")).filter(Boolean);
      const prepared = await runBridgeJob(
        bridge,
        "prepareMutation",
        { action: "undo", opId: redoOpId, params: { remIds: targetIds } },
        pluginActionTimeout("undo", params),
        false,
        signal,
      );
      const redoRecord = undoRecordFromResult(prepared);
      if (!redoRecord) return fail("internal_error", "undo could not create a write-ahead redo record.");
      await writeUndoRecord(config.appDir, { ...redoRecord, state: "prepared" });
      const started = Date.now();
      let result: unknown;
      try {
        result = await runBridgeJob(bridge, "undo", { undoRecord }, pluginActionTimeout("undo", params), false, signal);
        await updateUndoRecordState(config.appDir, redoOpId, "committed");
      } catch (error) {
        await updateUndoRecordState(config.appDir, redoOpId, "outcome_unknown").catch(() => undefined);
        throw error;
      }
      await appendAudit(config.logDir, {
        ts: new Date().toISOString(),
        action: "undo",
        opId,
        targetIds: idsFromResult(result),
        count: countFromResult(result),
        status: "success",
        durationMs: Date.now() - started,
      });
      return ok({ ...resultRecord(result), redoOpId });
    } catch (error) {
      return responseFromError(error);
    }
  }
  if (action === "restoreTombstone") {
    const requestedOpId = typeof params.opId === "string" ? params.opId : undefined;
    const requestedRemId = typeof params.remId === "string" ? params.remId : typeof params.id === "string" ? params.id : undefined;
    let undoRecord: UndoRecord | undefined;
    if (requestedOpId) undoRecord = await readUndoRecord(config.appDir, requestedOpId).catch(() => undefined);
    if (!undoRecord && requestedRemId) {
      for (const record of await listUndoRecords(config.appDir)) {
        const candidate = await readUndoRecord(config.appDir, record.opId).catch(() => undefined);
        if (candidate?.targets.some((target) => target.id === requestedRemId)) {
          undoRecord = candidate;
          break;
        }
      }
    }
    if (!undoRecord) return fail("not_found", "No daemon undo record matches the requested tombstone.");
    if (params.confirm !== true || params.dryRun === true) {
      return ok({
        dryRun: true,
        opId: undoRecord.opId,
        count: undoRecord.targets.length,
        remIds: undoRecord.targets.map((target) => target.id),
        warning: "restoreTombstone defaults to dry-run. Pass confirm:true to restore the exact targets.",
      });
    }
    if (undoRecord.targets.length > MAGNITUDE_THRESHOLD && Number(params.confirmCount) !== undoRecord.targets.length) {
      return fail("magnitude_guard", `restoreTombstone resolves ${undoRecord.targets.length} targets. Pass confirmCount:${undoRecord.targets.length}.`);
    }
    let redoOpId: string | undefined;
    try {
      redoOpId = randomUUID();
      const targetIds = undoRecord.targets.map((target) => String(target.id ?? "")).filter(Boolean);
      const prepared = await runBridgeJob(
        bridge,
        "prepareMutation",
        { action, opId: redoOpId, params: { remIds: targetIds } },
        pluginActionTimeout(action, params),
        false,
        signal,
      );
      const redoRecord = undoRecordFromResult(prepared);
      if (!redoRecord) return fail("internal_error", "restoreTombstone could not create a write-ahead undo record.");
      await writeUndoRecord(config.appDir, { ...redoRecord, state: "prepared" });
      const result = await runBridgeJob(bridge, "restoreTombstone", { undoRecord }, pluginActionTimeout(action, params), false, signal);
      await updateUndoRecordState(config.appDir, redoOpId, "committed");
      await appendAudit(config.logDir, {
        ts: new Date().toISOString(),
        action,
        opId: undoRecord.opId,
        targetIds: idsFromResult(result),
        count: countFromResult(result),
        status: "success",
      });
      return ok({ ...resultRecord(result), undo: { opId: redoOpId, targetCount: targetIds.length } });
    } catch (error) {
      if (redoOpId) await updateUndoRecordState(config.appDir, redoOpId, "outcome_unknown").catch(() => undefined);
      return responseFromError(error);
    }
  }
  if (action === "backupGraph") {
    try {
      const snapshot = (await runBridgeJob(bridge, "backupGraph", params, pluginActionTimeout("backupGraph", params), true, signal)) as RemSnapshot;
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
        signal,
        true,
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
      results.push(await dispatchAction(parsed.data.action, parsed.data.params, bridge, durableJobs, config, state, depth + 1, signal));
    }
    return ok(results);
  }
  if (!isPluginAction(action)) {
    return fail("unsupported", `Unknown action: ${action}`);
  }

  let preparedOpId: string | undefined;
  let operationOpId: string | undefined;
  let undoStored: Awaited<ReturnType<typeof writeUndoRecord>> | undefined;
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
    if (!actionMeta) return fail("unsupported", `Unknown action: ${action}`);
    if (action === "answerCard" || action === "deleteFlashcards") {
      return fail("experimental_disabled", `${action} is disabled until scheduler state can be captured, restored, and live-tested.`);
    }
    if (action === "mergeRems" && actionParams.structural === true) {
      return fail("experimental_disabled", "Structural merge is disabled until complete reference inversion and live undo verification are available.");
    }
    const actionRequiresDryRunHash = requiresDryRunHash(action, actionParams, actionMeta);
    const needsSafetyPreflight = actionParams.confirm === true && actionMeta && (actionMeta.magnitudeGuarded || actionRequiresDryRunHash);
    let preflight: unknown;
    let planHash: string | undefined;
    if (needsSafetyPreflight) {
      preflight = await runBridgeJob(bridge, action, { ...actionParams, dryRun: true, confirm: false }, pluginActionTimeout(action, actionParams), true, signal);
      const magnitudeError = state.safety.magnitudeError(action, preflight, actionParams.confirmCount);
      if (magnitudeError) return magnitudeError;
      if (actionRequiresDryRunHash) {
        const verification = state.safety.consumeIrreversible(action, preflight, actionParams);
        if (verification.error) return verification;
        planHash = verification.result.hash;
        actionParams.irreversibleVerified = true;
        actionParams.expectedTargetIds = verification.result.targetIds;
        actionParams.expectedFingerprints = resultRecord(preflight).fingerprints;
      }
    }

    if (actionMeta.undoStrategy === "writeAhead" && actionParams.dryRun !== true) {
      preparedOpId = randomUUID();
      const prepared = await runBridgeJob(
        bridge,
        "prepareMutation",
        { action, opId: preparedOpId, params: actionParams },
        pluginActionTimeout(action, actionParams),
        false,
        signal,
      );
      const undoRecord = undoRecordFromResult(prepared);
      if (!undoRecord) throw { code: "internal_error", message: `${action} did not produce a write-ahead undo record.` } satisfies ApiError;
      const preparedTargetIds = idsFromResult({ targetIds: resultRecord(prepared).targetIds });
      planHash = planHash ?? dryRunHash(action, { targetIds: preparedTargetIds, count: preparedTargetIds.length });
      undoStored = await writeUndoRecord(config.appDir, { ...undoRecord, state: "prepared", planHash });
      actionParams.opId = preparedOpId;
      actionParams.expectedTargetIds = preparedTargetIds;
      actionParams.expectedFingerprints = resultRecord(prepared).fingerprints;
      actionParams.undoPrepared = true;
    }

    if (actionMeta.mutates && actionParams.dryRun !== true) {
      operationOpId = preparedOpId ?? randomUUID();
      actionParams.opId = operationOpId;
      planHash = planHash ?? dryRunHash(action, {
        externalId,
        declaredCount:
          Array.isArray(actionParams.cards) ? actionParams.cards.length : Array.isArray(actionParams.notes) ? actionParams.notes.length : undefined,
      });
      await appendAudit(config.logDir, {
        ts: new Date().toISOString(),
        action,
        opId: operationOpId,
        targetIds: Array.isArray(actionParams.expectedTargetIds) ? (actionParams.expectedTargetIds as string[]) : [],
        count: Array.isArray(actionParams.expectedTargetIds) ? actionParams.expectedTargetIds.length : undefined,
        status: "prepared",
      });
    }

    const result = await runBridgeJob(bridge, action, actionParams, pluginActionTimeout(action, actionParams), actionMeta?.retryable === true, signal);
    if (resultRecord(result).dryRun === true) {
      const recorded = state.safety.recordDryRun(action, result);
      const withHash = result && typeof result === "object" && !Array.isArray(result) ? { ...(result as Record<string, unknown>), fromDryRun: recorded.hash } : result;
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

    if (preparedOpId) await updateUndoRecordState(config.appDir, preparedOpId, "committed");
    const outcomeUndoRecord = !undoStored ? undoRecordFromResult(result) : undefined;
    if (outcomeUndoRecord) undoStored = await writeUndoRecord(config.appDir, { ...outcomeUndoRecord, state: "committed" });

    if (externalId) {
      const id = typeof resultRecord(result).id === "string" ? (resultRecord(result).id as string) : undefined;
      if (id) await appendExternalId(config.appDir, { action, externalId, remId: id });
    }

    const cleanResult = cleanPluginResult(result);
    const enrichedResult = cleanResult && typeof cleanResult === "object" && !Array.isArray(cleanResult)
      ? {
          ...(cleanResult as Record<string, unknown>),
          opId: operationOpId ?? opIdFromResult(cleanResult),
          planHash,
          affectedCount: countFromResult(cleanResult),
        }
      : cleanResult;
    await appendAudit(config.logDir, {
      ts: new Date().toISOString(),
      action,
      opId: opIdFromResult(enrichedResult, outcomeUndoRecord?.opId),
      targetIds: idsFromResult(enrichedResult),
      count: countFromResult(enrichedResult),
      status: "success",
      durationMs: Date.now() - started,
    });

    if (undoStored && enrichedResult && typeof enrichedResult === "object" && !Array.isArray(enrichedResult)) {
      return ok({ ...(enrichedResult as Record<string, unknown>), undo: { opId: undoStored.opId, targetCount: undoStored.targetCount } });
    }
    return ok(enrichedResult);
  } catch (error) {
    if (preparedOpId) await updateUndoRecordState(config.appDir, preparedOpId, "outcome_unknown").catch(() => undefined);
    const errorDetails = resultRecord((error as Partial<ApiError>)?.details);
    const outcomeUnknown = meta?.mutates === true && errorDetails.outcomeUnknown === true;
    await appendAudit(config.logDir, {
      ts: new Date().toISOString(),
      action,
      opId: operationOpId ?? preparedOpId,
      targetIds: [],
      status: outcomeUnknown ? "outcome_unknown" : "error",
      errorCode: outcomeUnknown ? "outcome_unknown" : (error as Partial<ApiError>)?.code,
    }).catch(() => undefined);
    if (outcomeUnknown) {
      return fail("outcome_unknown", `${action} lost contact after dispatch; inspect RemNote before retrying.`, {
        opId: operationOpId ?? preparedOpId,
        originalError: (error as Partial<ApiError>)?.code,
      });
    }
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
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (lower.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
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
  const bodyLimit = Number(process.env.REMNOTE_CONNECT_BODY_LIMIT_BYTES ?? DEFAULT_BODY_LIMIT_BYTES);
  const app = Fastify({ logger: false, bodyLimit });
  const pairing = new PairingStore();
  const bridge = new PluginBridge(config, pairing);
  const state: DispatchState = {
    startedAt: Date.now(),
    readonlyMode: config.readonlyMode,
    safety: new SafetyCoordinator(),
    pairing,
  };
  const durableJobs = new DurableJobManager(config, bridge, () => state.readonlyMode);
  void durableJobs.start();
  const wss = bridge.createWebSocketServer();

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
    const abortController = new AbortController();
    let responseReady = false;
    const abortPendingJob = () => {
      if (!responseReady) abortController.abort();
    };
    request.raw.once("aborted", abortPendingJob);
    reply.raw.once("close", abortPendingJob);
    const startedAt = Date.now();
    try {
      const response = await dispatchAction(parsed.data.action, parsed.data.params, bridge, durableJobs, config, state, 0, abortController.signal);
      responseReady = true;
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
    } finally {
      responseReady = true;
      request.raw.off("aborted", abortPendingJob);
      reply.raw.off("close", abortPendingJob);
    }
  });

  return { app, bridge };
}
