import type { ApiError, ApiResponse } from "@remnoteconnect/shared";
import { DEFAULT_DAEMON_HOST, fail, ok, retryableBridgeError } from "@remnoteconnect/shared";
import type { DaemonConfig } from "./config.js";
import type { PluginBridge } from "./bridge.js";
import { appendExternalId, appendExternalIds, readExternalIdIndex, readExternalIdMap } from "./externalIdIndex.js";
import { readAtlasPayload, removeAtlasPayload, writeAtlasPayload } from "./atlasPayloadStore.js";
import {
  appendJobSnapshot,
  createDurableJob,
  readDurableJob,
  readDurableJobs,
  type DurableJobRecord,
} from "./jobStore.js";

const MAGNITUDE_THRESHOLD = 50;

type PublicJob = Omit<DurableJobRecord, "params"> & { paramsStored: true };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function publicJob(job: DurableJobRecord): PublicJob {
  const { params: _params, ...rest } = job;
  return { ...rest, paramsStored: true };
}

function cardsFromParams(params: Record<string, unknown>): { pluginAction: "createFlashcard" | "addNote"; items: Record<string, unknown>[] } {
  if (Array.isArray(params.cards)) return { pluginAction: "createFlashcard", items: params.cards.map(asRecord) };
  if (Array.isArray(params.notes)) return { pluginAction: "addNote", items: params.notes.map(asRecord) };
  return { pluginAction: "createFlashcard", items: [] };
}

function externalIdFromItem(pluginAction: "createFlashcard" | "addNote", item: Record<string, unknown>): string | undefined {
  if (pluginAction === "createFlashcard") return str(item.externalId);
  return str(asRecord(item).externalId);
}

function idFromResult(result: unknown): string | undefined {
  const record = asRecord(result);
  return str(record.id);
}

function atlasItemCount(params: Record<string, unknown>): number {
  return (Array.isArray(params.documents) ? params.documents.length : 0) + (Array.isArray(params.flashcards) ? params.flashcards.length : 0);
}

function atlasSafeParams(params: Record<string, unknown>): Record<string, unknown> {
  return {
    mode: params.mode,
    batchId: params.batchId,
    rootId: params.rootId,
    namespace: params.namespace,
    sourceRevision: params.sourceRevision,
    reconcile: params.reconcile === true,
    atlasPayloadStored: true,
  };
}

function atlasValidationError(params: Record<string, unknown>, config: DaemonConfig): string | undefined {
  if (config.host !== DEFAULT_DAEMON_HOST || config.pluginHost !== DEFAULT_DAEMON_HOST) {
    return "syncAtlasBatch requires the daemon and plugin bridge to bind to 127.0.0.1.";
  }
  const rootId = config.fastLocalRootId;
  if (!rootId) return "syncAtlasBatch is disabled until REMNOTE_CONNECT_FAST_LOCAL_ROOT_ID is configured.";
  if (params.mode !== "fast-local") return "syncAtlasBatch requires mode:fast-local.";
  if (params.rootId !== rootId) return "syncAtlasBatch rootId does not match the configured fast-local root.";
  const documents = Array.isArray(params.documents) ? params.documents.map(asRecord) : [];
  const flashcards = Array.isArray(params.flashcards) ? params.flashcards.map(asRecord) : [];
  const kinds = new Map<string, "document" | "flashcard">();
  for (const [kind, items] of [["document", documents], ["flashcard", flashcards]] as const) {
    for (const item of items) {
      const externalId = str(item.externalId);
      if (!externalId) return "syncAtlasBatch contains an item without externalId.";
      if (kinds.has(externalId)) return `syncAtlasBatch contains duplicate externalId ${externalId}.`;
      kinds.set(externalId, kind);
    }
  }
  const documentParents = new Map(documents.map((item) => [str(item.externalId)!, str(item.parentExternalId)]));
  for (const [externalId, parentExternalId] of documentParents) {
    const visited = new Set<string>();
    let current = externalId;
    while (documentParents.has(current)) {
      if (visited.has(current)) return `syncAtlasBatch document parents contain a cycle at ${current}.`;
      visited.add(current);
      const parent = documentParents.get(current);
      if (!parent || !documentParents.has(parent)) break;
      current = parent;
    }
    if (parentExternalId && kinds.get(parentExternalId) === "flashcard") return `Document ${externalId} cannot have a flashcard parent.`;
  }
  for (const card of flashcards) {
    const parentExternalId = str(card.parentExternalId);
    if (parentExternalId && kinds.get(parentExternalId) === "flashcard") return `Flashcard ${str(card.externalId) ?? "<unknown>"} cannot have a flashcard parent.`;
  }
  return undefined;
}

function atlasRelevantExternalIds(params: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  for (const raw of [...(Array.isArray(params.documents) ? params.documents : []), ...(Array.isArray(params.flashcards) ? params.flashcards : [])]) {
    const item = asRecord(raw);
    const externalId = str(item.externalId);
    const parentExternalId = str(item.parentExternalId);
    if (externalId) ids.add(externalId);
    if (parentExternalId) ids.add(parentExternalId);
    for (const link of Array.isArray(item.links) ? item.links.map(asRecord) : []) {
      const targetExternalId = str(link.targetExternalId);
      if (targetExternalId) ids.add(targetExternalId);
    }
  }
  return ids;
}

function atlasIndexRecords(value: unknown): Array<{ externalId: string; remId: string; parentRemId?: string; contentHash?: string; namespace?: string; lastBatchId?: string; kind?: "document" | "flashcard" }> {
  if (!Array.isArray(value)) return [];
  return value.map(asRecord).flatMap((entry) => {
    const externalId = str(entry.externalId);
    const remId = str(entry.remId);
    if (!externalId || !remId) return [];
    return [{
      externalId,
      remId,
      parentRemId: str(entry.parentRemId),
      contentHash: str(entry.contentHash),
      namespace: str(entry.namespace),
      lastBatchId: str(entry.lastBatchId),
      kind: entry.kind === "flashcard" ? "flashcard" : entry.kind === "document" ? "document" : undefined,
    }];
  });
}

function publicError(error: unknown): { code: string; message: string; details?: unknown } {
  const candidate = error as Partial<ApiError>;
  return {
    code: typeof candidate.code === "string" ? candidate.code : "internal_error",
    message: typeof candidate.message === "string" ? candidate.message : error instanceof Error ? error.message : String(error),
    details: candidate.details,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class DurableJobManager {
  private running = new Set<string>();
  private readonly unsubscribeConnected: () => void;

  constructor(
    private readonly config: DaemonConfig,
    private readonly bridge: PluginBridge,
    private readonly isReadonly: () => boolean,
  ) {
    this.unsubscribeConnected = this.bridge.onConnected(() => void this.resumeSafeJobs());
  }

  async start(): Promise<void> {
    const jobs = await readDurableJobs(this.config.appDir);
    for (const job of jobs.values()) {
      if (job.status === "running") {
        if (job.activeItemIndex === undefined) {
          job.status = this.isReadonly() ? "paused_readonly" : "queued";
          job.error = undefined;
        } else {
          job.status = "outcome_unknown";
          job.outcomeUnknownAt = new Date().toISOString();
          job.error = { code: "outcome_unknown", message: "Daemon restarted while this item was in flight; it was not replayed." };
          await this.reconcileExternalId(job);
        }
        await this.save(job);
      }
    }
    await this.resumeSafeJobs();
  }

  async setReadonly(readonly: boolean): Promise<void> {
    if (readonly) {
      const jobs = await readDurableJobs(this.config.appDir);
      for (const job of jobs.values()) {
        if (job.status === "queued") {
          job.status = "paused_readonly";
          await this.save(job);
        }
      }
      return;
    }
    await this.resumeSafeJobs();
  }

  async submit(action: DurableJobRecord["action"], params: Record<string, unknown>): Promise<ApiResponse> {
    if (this.isReadonly()) return fail("readonly_mode", `${action} is blocked while read-only mode is enabled.`);
    if (action === "syncAtlasBatch") {
      const validationError = atlasValidationError(params, this.config);
      if (validationError) return fail(this.config.fastLocalRootId ? "forbidden_target" : "experimental_disabled", validationError);
      const priorUnknown = [...(await readDurableJobs(this.config.appDir)).values()].find(
        (job) => job.action === "syncAtlasBatch" && job.status === "outcome_unknown" && job.params.batchId === params.batchId,
      );
      const payload = priorUnknown ? { ...params, reconcile: true } : params;
      const job = createDurableJob(action, atlasSafeParams(payload), atlasItemCount(payload));
      await writeAtlasPayload(this.config.appDir, job.jobId, payload);
      if (priorUnknown) await removeAtlasPayload(this.config.appDir, priorUnknown.jobId);
      await this.save(job);
      void this.kick(job.jobId);
      return ok(publicJob(job));
    }
    const total = this.totalFor(action, params);
    if (params.dryRun === true || params.confirm !== true) {
      return ok({
        dryRun: true,
        action,
        count: total,
        warning: `${action} defaults to dry-run. Pass confirm:true to enqueue a durable job.`,
      });
    }
    if (total > MAGNITUDE_THRESHOLD && Number(params.confirmCount) !== total) {
      return fail("magnitude_guard", `${action} contains ${total} items. Pass confirmCount:${total} to enqueue it.`, {
        count: total,
        threshold: MAGNITUDE_THRESHOLD,
      });
    }
    const job = createDurableJob(action, params, total);
    await this.save(job);
    void this.kick(job.jobId);
    return ok(publicJob(job));
  }

  async status(jobId: string): Promise<ApiResponse | undefined> {
    const job = await readDurableJob(this.config.appDir, jobId);
    if (!job) return undefined;
    return ok(publicJob(job));
  }

  async wait(jobId: string, timeoutMs: number): Promise<ApiResponse> {
    const deadline = Date.now() + timeoutMs;
    let last: DurableJobRecord | undefined;
    while (Date.now() <= deadline) {
      last = await readDurableJob(this.config.appDir, jobId);
      if (!last) return fail("not_found", `No durable job found for ${jobId}`);
      if (last.status === "complete" || last.status === "error" || last.status === "cancelled" || last.status === "outcome_unknown") {
        return ok(publicJob(last));
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return fail("timeout", `Timed out waiting for durable job ${jobId}`, last ? publicJob(last) : undefined);
  }

  async confirmMaterialized(params: Record<string, unknown>): Promise<ApiResponse> {
    const jobId = str(params.jobId);
    if (jobId) {
      const job = await readDurableJob(this.config.appDir, jobId);
      if (!job) return fail("not_found", `No durable job found for ${jobId}`);
      return ok({ jobId, status: job.status, count: job.ids.length, ids: job.ids, remIds: job.ids });
    }
    const batchId = str(params.batchId);
    if (!batchId) return fail("bad_request", "confirmMaterialized requires jobId or batchId.");
    const matches = [...(await readDurableJobs(this.config.appDir)).values()].filter((job) => this.jobHasBatch(job, batchId));
    const ids = [...new Set(matches.flatMap((job) => job.ids))];
    return ok({ batchId, count: ids.length, ids, remIds: ids, jobs: matches.map((job) => publicJob(job)) });
  }

  private async kick(jobId: string): Promise<void> {
    if (this.running.has(jobId)) return;
    this.running.add(jobId);
    try {
      const job = await readDurableJob(this.config.appDir, jobId);
      if (!job || job.status === "complete" || job.status === "error" || job.status === "cancelled" || job.status === "outcome_unknown") return;
      if (this.isReadonly()) {
        if (job.status !== "paused_readonly") {
          job.status = "paused_readonly";
          await this.save(job);
        }
        return;
      }
      if (job.status === "paused_readonly") job.status = "queued";
      if (!this.bridge.status().connected) {
        if (job.status !== "queued") {
          job.status = "queued";
          await this.save(job);
        }
        return;
      }
      await this.process(job);
    } finally {
      this.running.delete(jobId);
    }
  }

  private async process(job: DurableJobRecord): Promise<void> {
    job.status = "running";
    await this.save(job);
    try {
      let result: Record<string, unknown> | undefined;
      if (job.action === "syncAtlasBatch") {
        result = await this.processAtlasBatch(job);
      } else if (job.action === "importAsync" && (str(job.params.markdown) || str(job.params.md))) {
        await this.processDocument(job);
      } else {
        await this.processFlashcards(job);
      }
      job.status = "complete";
      job.result = result ?? { count: job.ids.length, ids: job.ids, remIds: job.ids };
      await this.save(job);
      if (job.action === "syncAtlasBatch") await removeAtlasPayload(this.config.appDir, job.jobId);
    } catch (error) {
      if (retryableBridgeError(error)) {
        const details = asRecord((error as Partial<ApiError>).details);
        job.status = details.dispatched === false ? "queued" : "outcome_unknown";
        if (job.status === "outcome_unknown") job.outcomeUnknownAt = new Date().toISOString();
        job.error = publicError(error);
      } else {
        job.status = "error";
        job.error = publicError(error);
      }
      await this.save(job);
    }
  }

  private async processFlashcards(job: DurableJobRecord): Promise<void> {
    const { pluginAction, items } = cardsFromParams(job.params);
    const itemTimeoutMs = Number(job.params.itemTimeoutMs ?? 120_000);
    const inherited = {
      deckPath: job.params.deckPath ?? job.params.deckName,
      tags: job.params.tags,
      batchId: job.params.batchId,
      materializeTimeoutMs: job.params.materializeTimeoutMs ?? 0,
      waitForCards: false,
    };
    for (let index = job.cursor; index < items.length; index += 1) {
      const item = items[index] ?? {};
      const externalId = externalIdFromItem(pluginAction, item);
      const params: Record<string, unknown> =
        pluginAction === "addNote"
          ? { note: item, verbose: job.params.verbose }
          : { ...inherited, ...item, verbose: job.params.verbose };
      if (externalId && params.existingRemId === undefined) {
        const existingRemId = (await readExternalIdMap(this.config.appDir)).get(externalId);
        if (existingRemId) params.existingRemId = existingRemId;
      }
      job.activeItemIndex = index;
      job.activeExternalId = externalId;
      await this.save(job);
      const result = await this.bridge.runJob(pluginAction, params, itemTimeoutMs);
      const id = idFromResult(result);
      if (id) {
        job.ids = [...new Set([...job.ids, id])];
        if (externalId) await appendExternalId(this.config.appDir, { action: job.action, externalId, remId: id });
      }
      job.cursor = index + 1;
      delete job.activeItemIndex;
      delete job.activeExternalId;
      delete job.outcomeUnknownAt;
      job.progress.push({ completed: job.cursor, total: job.total, message: `Processed ${job.cursor}/${job.total}`, at: Date.now() });
      await this.save(job);
      const throttleMs = Number(job.params.throttleMs ?? 0);
      if (throttleMs > 0 && index < items.length - 1) await sleep(throttleMs);
    }
  }

  private async processDocument(job: DurableJobRecord): Promise<void> {
    if (job.cursor > 0) return;
    job.activeItemIndex = 0;
    job.activeExternalId = str(job.params.externalId);
    await this.save(job);
    const result = await this.bridge.runJob("createDocument", job.params, 10 * 60_000);
    const record = asRecord(result);
    const ids = Array.isArray(record.remIds) ? record.remIds.filter((id): id is string => typeof id === "string") : [];
    const id = str(record.id);
    job.ids = [...new Set([...(id ? [id] : []), ...ids])];
    const externalId = str(job.params.externalId);
    if (externalId && id) await appendExternalId(this.config.appDir, { action: job.action, externalId, remId: id });
    job.cursor = 1;
    delete job.activeItemIndex;
    delete job.activeExternalId;
    delete job.outcomeUnknownAt;
    job.progress.push({ completed: 1, total: job.total, message: "Processed document import", at: Date.now() });
    await this.save(job);
  }

  private async processAtlasBatch(job: DurableJobRecord): Promise<Record<string, unknown>> {
    const payload = await readAtlasPayload(this.config.appDir, job.jobId);
    const validationError = atlasValidationError(payload, this.config);
    if (validationError) throw { code: this.config.fastLocalRootId ? "forbidden_target" : "experimental_disabled", message: validationError } satisfies ApiError;
    const relevantExternalIds = atlasRelevantExternalIds(payload);
    const index = await readExternalIdIndex(this.config.appDir);
    const pluginParams = {
      ...payload,
      index: [...index.entries()]
        .filter(([externalId]) => relevantExternalIds.has(externalId))
        .map(([, { ts: _ts, action: _action, ...entry }]) => entry),
    };
    const persisted = new Set<string>();
    let checkpointChain = Promise.resolve();
    const persistCheckpoint = async (progress: { completed: number; total: number; message?: string; checkpoint?: Array<Record<string, unknown>>; at: number }): Promise<void> => {
      const entries = atlasIndexRecords(progress.checkpoint);
      const fresh = entries.filter((entry) => !persisted.has(entry.externalId));
      for (const entry of fresh) persisted.add(entry.externalId);
      if (fresh.length > 0) {
        await appendExternalIds(this.config.appDir, fresh.map((entry) => ({ ...entry, action: "syncAtlasBatch" })));
        job.ids = [...new Set([...job.ids, ...fresh.map((entry) => entry.remId)])];
      }
      job.cursor = progress.completed;
      job.progress.push({ completed: progress.completed, total: progress.total, message: progress.message, at: progress.at });
      await this.save(job);
    };
    job.activeItemIndex = job.cursor;
    await this.save(job);
    const timeoutMs = Math.max(120_000, job.total * 1_000);
    const result = await this.bridge.runJob("syncAtlasBatch", pluginParams, timeoutMs, {
      onProgress: (progress) => {
        checkpointChain = checkpointChain.then(() => persistCheckpoint(progress));
      },
    });
    await checkpointChain;
    const record = asRecord(result);
    const finalEntries = atlasIndexRecords(record.indexEntries).filter((entry) => !persisted.has(entry.externalId));
    if (finalEntries.length > 0) {
      await appendExternalIds(this.config.appDir, finalEntries.map((entry) => ({ ...entry, action: "syncAtlasBatch" })));
      job.ids = [...new Set([...job.ids, ...finalEntries.map((entry) => entry.remId)])];
    }
    job.cursor = job.total;
    delete job.activeItemIndex;
    delete job.activeExternalId;
    delete job.outcomeUnknownAt;
    return { ...record, ids: job.ids, remIds: job.ids };
  }

  private totalFor(action: DurableJobRecord["action"], params: Record<string, unknown>): number {
    if (action === "syncAtlasBatch") return atlasItemCount(params);
    if (action === "importAsync" && (str(params.markdown) || str(params.md))) return 1;
    return cardsFromParams(params).items.length;
  }

  private jobHasBatch(job: DurableJobRecord, batchId: string): boolean {
    if (job.params.batchId === batchId) return true;
    const { items } = cardsFromParams(job.params);
    return items.some((item) => item.batchId === batchId);
  }

  private async save(job: DurableJobRecord): Promise<void> {
    job.updatedAt = new Date().toISOString();
    await appendJobSnapshot(this.config.appDir, job);
  }

  private async reconcileExternalId(job: DurableJobRecord): Promise<void> {
    if (job.activeItemIndex === undefined || !job.activeExternalId) return;
    const remId = (await readExternalIdMap(this.config.appDir)).get(job.activeExternalId);
    if (!remId) return;
    job.ids = [...new Set([...job.ids, remId])];
    job.cursor = job.activeItemIndex + 1;
    delete job.activeItemIndex;
    delete job.activeExternalId;
    delete job.outcomeUnknownAt;
    job.error = undefined;
    job.status = this.isReadonly() ? "paused_readonly" : "queued";
  }

  private async resumeSafeJobs(): Promise<void> {
    if (this.isReadonly() || !this.bridge.status().connected) return;
    const jobs = await readDurableJobs(this.config.appDir);
    for (const job of jobs.values()) {
      if (job.status === "paused_readonly") {
        job.status = "queued";
        await this.save(job);
      }
      if (job.status === "queued") void this.kick(job.jobId);
    }
  }
}
