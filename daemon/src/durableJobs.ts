import type { ApiError, ApiResponse } from "@remnoteconnect/shared";
import { fail, ok, retryableBridgeError } from "@remnoteconnect/shared";
import type { DaemonConfig } from "./config.js";
import type { PluginBridge } from "./bridge.js";
import { appendExternalId, readExternalIdMap } from "./externalIdIndex.js";
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

  async submit(action: "createFlashcardsAsync" | "importAsync", params: Record<string, unknown>): Promise<ApiResponse> {
    if (this.isReadonly()) return fail("readonly_mode", `${action} is blocked while read-only mode is enabled.`);
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
      if (job.action === "importAsync" && (str(job.params.markdown) || str(job.params.md))) {
        await this.processDocument(job);
      } else {
        await this.processFlashcards(job);
      }
      job.status = "complete";
      job.result = { count: job.ids.length, ids: job.ids, remIds: job.ids };
      await this.save(job);
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

  private totalFor(action: "createFlashcardsAsync" | "importAsync", params: Record<string, unknown>): number {
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
