import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { RemSnapshot, RemSnapshotNode } from "@remnoteconnect/shared";

export type BackupWriteResult = {
  path: string;
  sha256: string;
  bytes: number;
  nodeCount: number;
  warning: string;
};

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

export async function writeSnapshotBackup(
  backupDir: string,
  label: string,
  snapshot: RemSnapshot,
): Promise<BackupWriteResult> {
  const nodeCount = countSnapshotNodes(snapshot.nodes);
  if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.nodes) || snapshot.nodes.length === 0 || nodeCount === 0) {
    throw { code: "backup_failed", message: "Refusing destructive action because the backup snapshot is empty or invalid." };
  }
  if (snapshot.nodeCount !== undefined && snapshot.nodeCount !== nodeCount) {
    throw {
      code: "backup_failed",
      message: "Refusing destructive action because the backup snapshot node count does not match its metadata.",
      details: { expected: snapshot.nodeCount, actual: nodeCount },
    };
  }
  const body = `${JSON.stringify(snapshot, null, 2)}\n`;
  const sha256 = createHash("sha256").update(body).digest("hex");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${timestamp}-${safeName(label || "snapshot")}-${sha256.slice(0, 10)}.json`;
  const path = join(backupDir, filename);
  await writeFile(path, body, { mode: 0o600 });
  const readBack = await readFile(path);
  const readBackSha256 = createHash("sha256").update(readBack).digest("hex");
  if (readBackSha256 !== sha256) {
    throw { code: "backup_failed", message: "Refusing destructive action because backup checksum verification failed." };
  }
  return {
    path,
    sha256,
    bytes: Buffer.byteLength(body, "utf8"),
    nodeCount,
    warning: snapshot.warning,
  };
}

export function countSnapshotNodes(nodes: RemSnapshotNode[] | undefined): number {
  return (nodes ?? []).reduce((count, node) => count + 1 + countSnapshotNodes(node.children), 0);
}

export async function readSnapshotBackup(backupDir: string, file: string): Promise<RemSnapshot> {
  const backupRoot = resolve(backupDir);
  const candidate = resolve(backupRoot, isAbsolute(file) ? basename(file) : file);
  if (!candidate.startsWith(`${backupRoot}/`) && candidate !== backupRoot) {
    throw { code: "bad_request", message: "Backup file must be inside the configured backup directory." };
  }
  const body = await readFile(candidate, "utf8");
  const snapshot = JSON.parse(body) as RemSnapshot;
  const nodeCount = countSnapshotNodes(snapshot.nodes);
  if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.nodes) || snapshot.nodes.length === 0 || nodeCount === 0) {
    throw { code: "backup_failed", message: "Backup snapshot is empty or invalid." };
  }
  return snapshot;
}
