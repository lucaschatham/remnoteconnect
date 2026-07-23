import { chmod, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

export type UndoRecord = {
  schemaVersion: 1;
  opId: string;
  action: string;
  createdAt: string;
  targets: Array<Record<string, unknown>>;
  state?: "prepared" | "committed" | "outcome_unknown";
  planHash?: string;
  committedAt?: string;
};

export function undoDir(appDir: string): string {
  return join(appDir, "undo");
}

export function undoPath(appDir: string, opId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(opId)) throw new Error("Invalid undo opId.");
  const root = resolve(undoDir(appDir));
  const candidate = resolve(root, `${opId}.json`);
  const relativePath = relative(root, candidate);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) throw new Error("Invalid undo opId.");
  return candidate;
}

export async function writeUndoRecord(appDir: string, record: UndoRecord): Promise<{ path: string; opId: string; targetCount: number }> {
  if (record.schemaVersion !== 1 || !record.opId || !Array.isArray(record.targets)) {
    throw new Error("Invalid undo record.");
  }
  await mkdir(undoDir(appDir), { recursive: true });
  const path = undoPath(appDir, record.opId);
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ ...record, state: record.state ?? "prepared" }, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
  return { path, opId: record.opId, targetCount: record.targets.length };
}

export async function updateUndoRecordState(
  appDir: string,
  opId: string,
  state: NonNullable<UndoRecord["state"]>,
): Promise<UndoRecord> {
  const path = undoPath(appDir, opId);
  const current = await readUndoRecord(appDir, opId);
  const next: UndoRecord = {
    ...current,
    state,
    committedAt: state === "committed" ? new Date().toISOString() : current.committedAt,
  };
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  const handle = await open(tmp, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
  await chmod(path, 0o600);
  return next;
}

export async function readUndoRecord(appDir: string, opId: string): Promise<UndoRecord> {
  return JSON.parse(await readFile(undoPath(appDir, opId), "utf8")) as UndoRecord;
}

export async function listUndoRecords(appDir: string): Promise<Array<{ opId: string; path: string }>> {
  try {
    const files = await readdir(undoDir(appDir));
    return files
      .filter((file) => file.endsWith(".json"))
      .map((file) => ({ opId: file.slice(0, -5), path: undoPath(appDir, file.slice(0, -5)) }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function clearUndoRecords(appDir: string, opId?: string): Promise<number> {
  if (opId) {
    await rm(undoPath(appDir, opId), { force: true });
    return 1;
  }
  const records = await listUndoRecords(appDir);
  for (const record of records) await rm(record.path, { force: true });
  return records.length;
}
