import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type ExternalIdRecord = {
  ts: string;
  externalId: string;
  remId: string;
  action: string;
  parentRemId?: string;
  contentHash?: string;
  namespace?: string;
  lastBatchId?: string;
  kind?: "document" | "flashcard";
};

export function externalIdIndexPath(appDir: string): string {
  return join(appDir, "external-id-index.jsonl");
}

export async function readExternalIdIndex(appDir: string): Promise<Map<string, ExternalIdRecord>> {
  const map = new Map<string, ExternalIdRecord>();
  try {
    const body = await readFile(externalIdIndexPath(appDir), "utf8");
    for (const line of body.split("\n")) {
      if (!line.trim()) continue;
      const record = JSON.parse(line) as Partial<ExternalIdRecord>;
      if (typeof record.externalId === "string" && typeof record.remId === "string") {
        map.set(record.externalId, record as ExternalIdRecord);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return map;
}

export async function readExternalIdMap(appDir: string): Promise<Map<string, string>> {
  return new Map([...(await readExternalIdIndex(appDir)).entries()].map(([externalId, record]) => [externalId, record.remId]));
}

export async function appendExternalId(appDir: string, record: Omit<ExternalIdRecord, "ts">): Promise<void> {
  await appendExternalIds(appDir, [record]);
}

export async function appendExternalIds(appDir: string, records: Array<Omit<ExternalIdRecord, "ts">>): Promise<void> {
  if (records.length === 0) return;
  await mkdir(appDir, { recursive: true });
  const ts = new Date().toISOString();
  await appendFile(externalIdIndexPath(appDir), records.map((record) => `${JSON.stringify({ ts, ...record })}\n`).join(""), { mode: 0o600 });
}
