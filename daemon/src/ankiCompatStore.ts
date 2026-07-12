import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ANKI_CONNECT_SOURCE_COMMIT } from "@remnoteconnect/shared";

export type AnkiIdentityKind = "note" | "card" | "deck" | "model" | "deckConfig";

export type AnkiIdentityRecord = {
  kind: AnkiIdentityKind;
  externalId: string;
  publicId: number;
  tombstoned: boolean;
  createdAt: string;
  tombstonedAt?: string;
};

export type AnkiModelRecord = {
  id: number;
  name: string;
  inOrderFields: string[];
  cardTemplates: Array<{ Name: string; Front: string; Back: string } & Record<string, unknown>>;
  css: string;
  isCloze: boolean;
  fieldMetadata: Record<string, { description: string; font: string; fontSize: number }>;
};

export type AnkiCompatData = {
  schemaVersion: 1;
  sourceCommit: string;
  nextPublicId: number;
  identities: AnkiIdentityRecord[];
  models: Record<string, AnkiModelRecord>;
  deckConfigs: Record<string, Record<string, unknown>>;
  deckConfigAssignments: Record<string, number>;
  noteMetadata: Record<string, Record<string, unknown>>;
  cardNoteIds: Record<string, number>;
};

const FIRST_PUBLIC_ID = 1_700_000_000_000;

function initialData(): AnkiCompatData {
  const createdAt = new Date().toISOString();
  return {
    schemaVersion: 1,
    sourceCommit: ANKI_CONNECT_SOURCE_COMMIT,
    nextPublicId: FIRST_PUBLIC_ID,
    identities: [
      {
        kind: "deckConfig",
        externalId: "Default",
        publicId: 1,
        tombstoned: false,
        createdAt,
      },
    ],
    models: {},
    deckConfigs: {},
    deckConfigAssignments: {},
    noteMetadata: {},
    cardNoteIds: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateData(value: unknown): AnkiCompatData {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("Unsupported or malformed Anki compatibility sidecar schema.");
  }
  if (!Number.isSafeInteger(value.nextPublicId) || Number(value.nextPublicId) < FIRST_PUBLIC_ID) {
    throw new Error("Anki compatibility sidecar has an invalid nextPublicId.");
  }
  if (
    !Array.isArray(value.identities) ||
    !isRecord(value.models) ||
    !isRecord(value.deckConfigs) ||
    !isRecord(value.deckConfigAssignments ?? {}) ||
    !isRecord(value.noteMetadata ?? {}) ||
    !isRecord(value.cardNoteIds ?? {})
  ) {
    throw new Error("Anki compatibility sidecar is missing required collections.");
  }
  const data = value as unknown as AnkiCompatData;
  data.deckConfigAssignments ??= {};
  data.noteMetadata ??= {};
  data.cardNoteIds ??= {};
  const publicIds = new Set<number>();
  const externalKeys = new Set<string>();
  for (const identity of data.identities) {
    if (
      !identity ||
      !["note", "card", "deck", "model", "deckConfig"].includes(identity.kind) ||
      typeof identity.externalId !== "string" ||
      !identity.externalId ||
      !Number.isSafeInteger(identity.publicId) ||
      typeof identity.tombstoned !== "boolean" ||
      typeof identity.createdAt !== "string" ||
      (identity.tombstonedAt !== undefined && typeof identity.tombstonedAt !== "string")
    ) {
      throw new Error("Anki compatibility sidecar contains an invalid identity record.");
    }
    const externalKey = `${identity.kind}\0${identity.externalId}`;
    if (publicIds.has(identity.publicId) || externalKeys.has(externalKey)) {
      throw new Error("Anki compatibility sidecar contains duplicate identities.");
    }
    publicIds.add(identity.publicId);
    externalKeys.add(externalKey);
  }
  let highestAllocated = FIRST_PUBLIC_ID - 1;
  for (const publicId of publicIds) highestAllocated = Math.max(highestAllocated, publicId);
  if (data.nextPublicId <= highestAllocated) {
    throw new Error("Anki compatibility sidecar nextPublicId would reuse an allocated identity.");
  }
  for (const [name, model] of Object.entries(data.models)) {
    if (
      !model ||
      model.name !== name ||
      !Number.isSafeInteger(model.id) ||
      !Array.isArray(model.inOrderFields) ||
      !model.inOrderFields.every((field) => typeof field === "string" && field.length > 0) ||
      !Array.isArray(model.cardTemplates) ||
      !model.cardTemplates.every(
        (template) =>
          template &&
          typeof template.Name === "string" &&
          template.Name.length > 0 &&
          typeof template.Front === "string" &&
          typeof template.Back === "string",
      ) ||
      typeof model.css !== "string" ||
      typeof model.isCloze !== "boolean" ||
      !isRecord(model.fieldMetadata)
    ) {
      throw new Error(`Anki compatibility sidecar contains an invalid model: ${name}.`);
    }
  }
  if (Object.values(data.cardNoteIds).some((noteId) => !Number.isSafeInteger(noteId))) {
    throw new Error("Anki compatibility sidecar contains an invalid card-to-note mapping.");
  }
  return data;
}

function cloneData(data: AnkiCompatData): AnkiCompatData {
  return structuredClone(data);
}

export class AnkiCompatStore {
  readonly path: string;
  private data?: AnkiCompatData;
  private queue: Promise<unknown> = Promise.resolve();
  private identitiesByExternal = new Map<string, AnkiIdentityRecord>();
  private identitiesByPublic = new Map<string, AnkiIdentityRecord>();

  constructor(appDir: string, filename = "anki-compat-v1.json") {
    this.path = join(appDir, filename);
  }

  async snapshot(): Promise<AnkiCompatData> {
    await this.ensureLoaded();
    return cloneData(this.data!);
  }

  async getOrCreatePublicId(kind: AnkiIdentityKind, externalId: string): Promise<number> {
    return (await this.getOrCreatePublicIds(kind, [externalId]))[0];
  }

  async getOrCreatePublicIds(kind: AnkiIdentityKind, externalIds: string[]): Promise<number[]> {
    if (externalIds.some((externalId) => !externalId)) {
      throw new Error("An external ID is required for compatibility identity allocation.");
    }
    await this.ensureLoaded();
    const existingIds = externalIds.map((externalId) => this.identitiesByExternal.get(`${kind}\0${externalId}`));
    const tombstone = existingIds.find((identity) => identity?.tombstoned);
    if (tombstone) throw new Error(`${kind} identity ${tombstone.publicId} is tombstoned.`);
    if (existingIds.every(Boolean)) return existingIds.map((identity) => identity!.publicId);
    return this.withMutation((data) => {
      const byExternal = new Map(data.identities.map((identity) => [`${identity.kind}\0${identity.externalId}`, identity]));
      return externalIds.map((externalId) => {
        const key = `${kind}\0${externalId}`;
        const existing = byExternal.get(key);
        if (existing) {
          if (existing.tombstoned) throw new Error(`${kind} identity ${existing.publicId} is tombstoned.`);
          return existing.publicId;
        }
        if (!Number.isSafeInteger(data.nextPublicId)) throw new Error("Anki compatibility public ID space is exhausted.");
        const publicId = data.nextPublicId;
        data.nextPublicId += 1;
        if (!Number.isSafeInteger(data.nextPublicId)) throw new Error("Anki compatibility public ID space is exhausted.");
        const identity: AnkiIdentityRecord = {
          kind,
          externalId,
          publicId,
          tombstoned: false,
          createdAt: new Date().toISOString(),
        };
        data.identities.push(identity);
        byExternal.set(key, identity);
        return publicId;
      });
    });
  }

  async resolveExternalId(kind: AnkiIdentityKind, publicId: number): Promise<string | undefined> {
    await this.ensureLoaded();
    const identity = this.identitiesByPublic.get(`${kind}\0${publicId}`);
    return identity && !identity.tombstoned ? identity.externalId : undefined;
  }

  async resolvePublicId(kind: AnkiIdentityKind, externalId: string): Promise<number | undefined> {
    await this.ensureLoaded();
    const identity = this.identitiesByExternal.get(`${kind}\0${externalId}`);
    return identity && !identity.tombstoned ? identity.publicId : undefined;
  }

  async isTombstoned(kind: AnkiIdentityKind, externalId: string): Promise<boolean> {
    await this.ensureLoaded();
    return this.identitiesByExternal.get(`${kind}\0${externalId}`)?.tombstoned === true;
  }

  async tombstone(kind: AnkiIdentityKind, publicId: number): Promise<boolean> {
    return this.withMutation((data) => {
      const identity = data.identities.find((item) => item.kind === kind && item.publicId === publicId);
      if (!identity || identity.tombstoned) return false;
      identity.tombstoned = true;
      identity.tombstonedAt = new Date().toISOString();
      return true;
    });
  }

  async mutate<T>(mutation: (draft: AnkiCompatData) => T | Promise<T>): Promise<T> {
    return this.withMutation(mutation);
  }

  private async ensureLoaded(): Promise<void> {
    if (this.data) return;
    try {
      this.data = validateData(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.data = initialData();
    }
    this.rebuildIndexes();
  }

  private async withMutation<T>(mutation: (draft: AnkiCompatData) => T | Promise<T>): Promise<T> {
    const operation = this.queue.then(async () => {
      await this.ensureLoaded();
      const draft = cloneData(this.data!);
      const result = await mutation(draft);
      validateData(draft);
      await this.persist(draft);
      this.data = draft;
      this.rebuildIndexes();
      return result;
    });
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async persist(data: AnkiCompatData): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(data)}\n`, { mode: 0o600 });
    await rename(tempPath, this.path);
  }

  private rebuildIndexes(): void {
    this.identitiesByExternal = new Map(this.data!.identities.map((identity) => [`${identity.kind}\0${identity.externalId}`, identity]));
    this.identitiesByPublic = new Map(this.data!.identities.map((identity) => [`${identity.kind}\0${identity.publicId}`, identity]));
  }
}
