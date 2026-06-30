import { appendFile, mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export type DurableJobStatus = "queued" | "running" | "complete" | "error";

export type DurableJobRecord = {
  schemaVersion: 1;
  jobId: string;
  action: "createFlashcardsAsync" | "importAsync";
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
};

export function jobStorePath(appDir: string): string {
  return join(appDir, "jobs.jsonl");
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

export async function appendJobSnapshot(appDir: string, job: DurableJobRecord): Promise<void> {
  await mkdir(appDir, { recursive: true });
  await appendFile(jobStorePath(appDir), `${JSON.stringify({ ...job, updatedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
}

export async function readDurableJobs(appDir: string): Promise<Map<string, DurableJobRecord>> {
  const jobs = new Map<string, DurableJobRecord>();
  try {
    const body = await readFile(jobStorePath(appDir), "utf8");
    for (const line of body.split("\n")) {
      if (!line.trim()) continue;
      const job = JSON.parse(line) as Partial<DurableJobRecord>;
      if (job.schemaVersion === 1 && typeof job.jobId === "string" && typeof job.action === "string") {
        jobs.set(job.jobId, job as DurableJobRecord);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return jobs;
}

export async function readDurableJob(appDir: string, jobId: string): Promise<DurableJobRecord | undefined> {
  return (await readDurableJobs(appDir)).get(jobId);
}
