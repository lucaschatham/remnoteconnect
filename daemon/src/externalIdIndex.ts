import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type ExternalIdRecord = {
  ts: string;
  externalId: string;
  remId: string;
  action: string;
};

export function externalIdIndexPath(appDir: string): string {
  return join(appDir, "external-id-index.jsonl");
}

export async function readExternalIdMap(appDir: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const body = await readFile(externalIdIndexPath(appDir), "utf8");
    for (const line of body.split("\n")) {
      if (!line.trim()) continue;
      const record = JSON.parse(line) as Partial<ExternalIdRecord>;
      if (typeof record.externalId === "string" && typeof record.remId === "string") {
        map.set(record.externalId, record.remId);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return map;
}

export async function appendExternalId(appDir: string, record: Omit<ExternalIdRecord, "ts">): Promise<void> {
  await mkdir(appDir, { recursive: true });
  await appendFile(externalIdIndexPath(appDir), `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`, { mode: 0o600 });
}
