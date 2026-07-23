import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function atlasPayloadPath(appDir: string, jobId: string): string {
  return join(appDir, "atlas-batches", `${jobId}.json`);
}

export async function writeAtlasPayload(appDir: string, jobId: string, payload: Record<string, unknown>): Promise<void> {
  const path = atlasPayloadPath(appDir, jobId);
  const directory = join(appDir, "atlas-batches");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writeFile(path, JSON.stringify(payload), { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function readAtlasPayload(appDir: string, jobId: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readFile(atlasPayloadPath(appDir, jobId), "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Atlas payload for ${jobId} is invalid.`);
  return parsed as Record<string, unknown>;
}

export async function removeAtlasPayload(appDir: string, jobId: string): Promise<void> {
  await unlink(atlasPayloadPath(appDir, jobId)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}
