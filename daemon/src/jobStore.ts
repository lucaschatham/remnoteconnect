import { access, appendFile, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export type DurableJobStatus = "queued" | "running" | "outcome_unknown" | "paused_readonly" | "complete" | "error" | "cancelled";

export type DurableJobRecord = {
  schemaVersion: 1;
  jobId: string;
  action: "createFlashcardsAsync" | "importAsync" | "syncAtlasBatch";
  status: DurableJobStatus;
  createdAt: string;
  updatedAt: string;
  params: Record<string, unknown>;
  cursor: number;
  total: number;
  ids: string[];
  progress: Array<{ completed: number; total: number; message?: string; at: number }>;
  result?: Record<string, unknown>;
  error?: { code: string; message: string; details?: unknown };
  activeItemIndex?: number;
  activeExternalId?: string;
  outcomeUnknownAt?: string;
};

export function jobStorePath(appDir: string): string {
  return join(appDir, "jobs.jsonl");
}

export function isUnsupportedDirectorySyncError(
  error: unknown,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "win32") return false;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EINVAL" || code === "ENOTSUP";
}

export function createDurableJob(action: DurableJobRecord["action"], params: Record<string, unknown>, total: number): DurableJobRecord {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    jobId: randomUUID(),
    action,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    params,
    cursor: 0,
    total,
    ids: [],
    progress: [],
  };
}

function compactFinishedParams(params: Record<string, unknown>): Record<string, unknown> {
  const keep = ["batchId", "deckPath", "deckName", "parentPath", "externalId", "rootId", "namespace", "sourceRevision", "reconcile", "atlasPayloadStored"];
  const compact: Record<string, unknown> = {};
  for (const key of keep) {
    if (params[key] !== undefined) compact[key] = params[key];
  }
  return compact;
}

function snapshotForAppend(job: DurableJobRecord): Partial<DurableJobRecord> {
  const snapshot: Partial<DurableJobRecord> = {
    ...job,
    updatedAt: new Date().toISOString(),
    progress: job.progress.slice(-20),
  };
  if (job.status === "complete" || job.status === "error") {
    snapshot.params = compactFinishedParams(job.params);
  } else if (!(job.status === "queued" && job.cursor === 0)) {
    delete snapshot.params;
  }
  return snapshot;
}

function snapshotForCompaction(job: DurableJobRecord): Partial<DurableJobRecord> {
  const snapshot: Partial<DurableJobRecord> = {
    ...job,
    progress: job.progress.slice(-20),
  };
  if (job.status === "complete" || job.status === "error") {
    snapshot.params = compactFinishedParams(job.params);
  }
  return snapshot;
}

function mergeSnapshot(previous: DurableJobRecord | undefined, snapshot: Partial<DurableJobRecord>): DurableJobRecord | undefined {
  if (snapshot.schemaVersion !== 1 || typeof snapshot.jobId !== "string" || typeof snapshot.action !== "string") return previous;
  const merged = { ...(previous ?? {}), ...snapshot } as DurableJobRecord;
  if (snapshot.params === undefined && previous?.params) merged.params = previous.params;
  if (snapshot.progress === undefined && previous?.progress) merged.progress = previous.progress;
  if (snapshot.ids === undefined && previous?.ids) merged.ids = previous.ids;
  return merged;
}

async function readSnapshots(appDir: string, onSnapshot: (snapshot: Partial<DurableJobRecord>) => void): Promise<void> {
  const file = jobStorePath(appDir);
  try {
    await access(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const lines = (await readFile(file, "utf8")).split("\n");
  let lastContentIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].trim()) continue;
    lastContentIndex = index;
    break;
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    try {
      onSnapshot(JSON.parse(line) as Partial<DurableJobRecord>);
    } catch (error) {
      if (index === lastContentIndex) return;
      throw error;
    }
  }
}

export async function appendJobSnapshot(appDir: string, job: DurableJobRecord): Promise<void> {
  await mkdir(appDir, { recursive: true });
  await appendFile(jobStorePath(appDir), `${JSON.stringify(snapshotForAppend(job))}\n`, { mode: 0o600 });
}

export async function readDurableJobs(appDir: string): Promise<Map<string, DurableJobRecord>> {
  const jobs = new Map<string, DurableJobRecord>();
  await readSnapshots(appDir, (snapshot) => {
    const merged = mergeSnapshot(jobs.get(String(snapshot.jobId)), snapshot);
    if (merged) jobs.set(merged.jobId, merged);
  });
  return jobs;
}

export async function readDurableJob(appDir: string, jobId: string): Promise<DurableJobRecord | undefined> {
  let job: DurableJobRecord | undefined;
  await readSnapshots(appDir, (snapshot) => {
    if (snapshot.jobId !== jobId) return;
    job = mergeSnapshot(job, snapshot);
  });
  return job;
}

export async function compactDurableJobs(appDir: string): Promise<{ jobs: number }> {
  const jobs = await readDurableJobs(appDir);
  if (jobs.size === 0) return { jobs: 0 };
  await mkdir(appDir, { recursive: true });
  const file = jobStorePath(appDir);
  const tmp = `${file}.${process.pid}.tmp`;
  const lines = [...jobs.values()].map((job) => `${JSON.stringify(snapshotForCompaction(job))}\n`).join("");
  await writeFile(tmp, lines, { mode: 0o600 });
  const handle = await open(tmp, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
  const directory = await open(appDir, "r");
  try {
    try {
      await directory.sync();
    } catch (error) {
      if (!isUnsupportedDirectorySyncError(error)) throw error;
    }
  } finally {
    await directory.close();
  }
  return { jobs: jobs.size };
}
