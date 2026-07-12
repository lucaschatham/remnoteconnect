import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnkiCompatStore } from "../src/ankiCompatStore.js";

describe("AnkiCompatStore", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function store(): Promise<{ dir: string; store: AnkiCompatStore }> {
    const dir = await mkdtemp(join(tmpdir(), "rnc-anki-store-"));
    dirs.push(dir);
    return { dir, store: new AnkiCompatStore(dir) };
  }

  it("allocates one stable safe integer under concurrency and across restart", async () => {
    const fixture = await store();
    const ids = await Promise.all(Array.from({ length: 40 }, () => fixture.store.getOrCreatePublicId("note", "rem-1")));
    expect(new Set(ids).size).toBe(1);
    expect(Number.isSafeInteger(ids[0])).toBe(true);

    const restarted = new AnkiCompatStore(fixture.dir);
    expect(await restarted.resolvePublicId("note", "rem-1")).toBe(ids[0]);
    expect(await restarted.resolveExternalId("note", ids[0])).toBe("rem-1");
  });

  it("does not collide across entity kinds or recycle tombstoned identities", async () => {
    const fixture = await store();
    const noteId = await fixture.store.getOrCreatePublicId("note", "same-external-id");
    const cardId = await fixture.store.getOrCreatePublicId("card", "same-external-id");
    expect(cardId).not.toBe(noteId);

    expect(await fixture.store.tombstone("note", noteId)).toBe(true);
    expect(await fixture.store.resolveExternalId("note", noteId)).toBeUndefined();
    await expect(fixture.store.getOrCreatePublicId("note", "same-external-id")).rejects.toThrow("tombstoned");

    const nextId = await fixture.store.getOrCreatePublicId("note", "new-rem");
    expect(nextId).toBeGreaterThan(cardId);
    expect(nextId).not.toBe(noteId);
  });

  it("persists a large identity batch with unique IDs and owner-only permissions", async () => {
    const fixture = await store();
    const externalIds = Array.from({ length: 10_000 }, (_, index) => `rem-${index}`);
    const ids = await fixture.store.getOrCreatePublicIds("note", externalIds);
    expect(ids).toHaveLength(externalIds.length);
    expect(new Set(ids).size).toBe(externalIds.length);
    expect(ids.every(Number.isSafeInteger)).toBe(true);

    const statePath = join(fixture.dir, "anki-compat-v1.json");
    if (process.platform !== "win32") expect((await stat(statePath)).mode & 0o777).toBe(0o600);

    const restarted = new AnkiCompatStore(fixture.dir);
    expect(await restarted.resolveExternalId("note", ids.at(-1)!)).toBe(externalIds.at(-1));
  });

  it("fails closed on malformed state without overwriting it", async () => {
    const fixture = await store();
    const path = join(fixture.dir, "anki-compat-v1.json");
    await writeFile(path, '{"schemaVersion":99,"important":"retain"}\n');

    const corrupted = new AnkiCompatStore(fixture.dir);
    await expect(corrupted.snapshot()).rejects.toThrow("Unsupported or malformed");
    expect(await readFile(path, "utf8")).toContain('"important":"retain"');
  });
});
