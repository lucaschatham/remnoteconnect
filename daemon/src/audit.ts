import { mkdir, readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";

export type AuditEvent = {
  ts: string;
  opId?: string;
  action: string;
  targetIds: string[];
  count?: number;
  status: "prepared" | "dry_run" | "success" | "outcome_unknown" | "error";
  durationMs?: number;
  errorCode?: string;
};

export function auditLogPath(logDir: string): string {
  return join(logDir, "audit.jsonl");
}

export async function appendAudit(logDir: string, event: AuditEvent): Promise<void> {
  await mkdir(logDir, { recursive: true });
  await appendFile(auditLogPath(logDir), `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

export async function tailAudit(logDir: string, n: number): Promise<AuditEvent[]> {
  try {
    const body = await readFile(auditLogPath(logDir), "utf8");
    return body
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-Math.max(0, n))
      .map((line) => JSON.parse(line) as AuditEvent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
