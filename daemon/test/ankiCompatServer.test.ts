import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  ANKI_CONNECT_ACTION_SET_SHA256,
  ANKI_CONNECT_API_VERSION,
  ANKI_CONNECT_SOURCE_COMMIT,
  ankiConnectActionManifest,
  ankiConnectActionNames,
  ok,
} from "@remnoteconnect/shared";
import { loadConfig } from "../src/config.js";
import { AnkiCompatDispatcher } from "../src/ankiCompatDispatcher.js";
import { buildAnkiCompatServer } from "../src/ankiCompatServer.js";
import { AnkiCompatStore } from "../src/ankiCompatStore.js";

describe("AnkiConnect compatibility contract", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function fixture(options: { readonlyMode?: boolean; apiKey?: string } = {}) {
    const dir = await mkdtemp(join(tmpdir(), "rnc-anki-server-"));
    dirs.push(dir);
    const config = loadConfig({
      appDir: dir,
      backupDir: join(dir, "backups"),
      logDir: join(dir, "logs"),
      tokenFile: join(dir, "token"),
      token: "test-token-test-token",
      readonlyMode: options.readonlyMode ?? false,
      ankiCompatApiKey: options.apiKey,
    });
    const dispatchNative = vi.fn(async (action: string, params: Record<string, unknown>) => {
      if (action === "deckNames") return ok(["Default", "Science::Physics"]);
      if (action === "createDeck") return ok({ id: `deck:${String(params.deck)}` });
      if (action === "addNote") {
        return ok({
          id: "rem-note-1",
          path: "Default",
          cards: [{ id: "rem-card-1", remId: "rem-note-1" }],
        });
      }
      if (action === "addNotes") return ok({ ids: ["rem-note-2", "rem-note-3"], remIds: ["rem-note-2", "rem-note-3"] });
      if (action === "searchFlashcards") return ok({ ids: ["rem-note-1"], remIds: ["rem-note-1"] });
      if (action === "findNotes") return ok(["rem-note-1"]);
      if (action === "notesInfo") {
        return ok([
          {
            id: "rem-note-1",
            text: "Question",
            backText: "Answer",
            updatedAt: 1_700_000_000_000,
            tags: [{ text: "physics" }],
            cards: [{ id: "rem-card-1", remId: "rem-note-1" }],
          },
        ]);
      }
      return ok(null);
    });
    const dispatcher = new AnkiCompatDispatcher({
      appDir: dir,
      apiKey: options.apiKey,
      readonlyMode: () => options.readonlyMode ?? false,
      dispatchNative,
      store: new AnkiCompatStore(dir),
    });
    return { app: buildAnkiCompatServer({ config, dispatcher }), dispatchNative, dir };
  }

  it("pins all 122 unique official action names with complete metadata", () => {
    expect(ANKI_CONNECT_SOURCE_COMMIT).toBe("de6e6e1b8aaf4ae195eb1d1ff6db5409b99b2a3e");
    expect(ankiConnectActionManifest).toHaveLength(122);
    expect(new Set(ankiConnectActionNames).size).toBe(122);
    expect(createHash("sha256").update([...ankiConnectActionNames].sort().join("\n")).digest("hex")).toBe(ANKI_CONNECT_ACTION_SET_SHA256);
    expect(ankiConnectActionNames[0]).toBe("version");
    expect(ankiConnectActionNames.at(-1)).toBe("importPackage");
    for (const action of ankiConnectActionManifest) {
      expect(action.name).not.toBe("");
      expect(action.summary).not.toBe("");
      expect(action.family).not.toBe("");
      expect(action.status).not.toBe("");
      if (action.status === "blocked") expect(action.limitation).not.toBe("");
    }
  });

  it("matches v6 and legacy v4 response envelopes", async () => {
    const { app } = await fixture();
    const v6 = await app.inject({
      method: "POST",
      url: "/",
      headers: { host: "127.0.0.1:8765" },
      payload: { action: "version", version: 6 },
    });
    expect(v6.statusCode).toBe(200);
    expect(v6.json()).toEqual({ result: ANKI_CONNECT_API_VERSION, error: null });

    const v4 = await app.inject({
      method: "POST",
      url: "/",
      headers: { host: "127.0.0.1:8765" },
      payload: { action: "version", version: 4 },
    });
    expect(v4.json()).toBe(ANKI_CONNECT_API_VERSION);

    const browserProbe = await app.inject({ method: "GET", url: "/", headers: { host: "127.0.0.1:8765" } });
    expect(browserProbe.json()).toEqual({ apiVersion: "AnkiConnect v.6" });

    const malformed = await app.inject({
      method: "POST",
      url: "/",
      headers: { host: "127.0.0.1:8765", "content-type": "application/json" },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(200);
    expect(malformed.json()).toMatchObject({ result: null });
    expect(typeof malformed.json().error).toBe("string");
    await app.close();
  });

  it("preserves per-item responses and order in multi", async () => {
    const { app } = await fixture();
    const response = await app.inject({
      method: "POST",
      url: "/",
      headers: { host: "localhost:8765" },
      payload: {
        action: "multi",
        version: 6,
        params: {
          actions: [
            { action: "version", version: 6 },
            { action: "notReal", version: 6 },
            { action: "version", version: 4 },
          ],
        },
      },
    });
    expect(response.json()).toEqual({
      result: [
        { result: 6, error: null },
        { result: null, error: "unsupported action" },
        6,
      ],
      error: null,
    });
    const missingActions = await app.inject({
      method: "POST",
      url: "/",
      headers: { host: "localhost:8765" },
      payload: { action: "multi", version: 6 },
    });
    expect(missingActions.json().error).toContain("requires actions");
    await app.close();
  });

  it("enforces the optional API key and reports request permission", async () => {
    const { app } = await fixture({ apiKey: "secret" });
    const denied = await app.inject({
      method: "POST",
      url: "/",
      headers: { host: "127.0.0.1:8765" },
      payload: { action: "version", version: 6 },
    });
    expect(denied.json()).toEqual({ result: null, error: "valid api key must be provided" });

    const allowed = await app.inject({
      method: "POST",
      url: "/",
      headers: { host: "127.0.0.1:8765" },
      payload: { action: "version", version: 6, key: "secret" },
    });
    expect(allowed.json()).toEqual({ result: 6, error: null });

    const permission = await app.inject({
      method: "POST",
      url: "/",
      headers: { host: "127.0.0.1:8765" },
      payload: { action: "requestPermission", version: 6 },
    });
    expect(permission.json().result).toEqual({ permission: "granted", requireApikey: true, version: 6 });
    await app.close();
  });

  it("creates and reads note, deck, model, and media data with Anki-shaped IDs", async () => {
    const { app, dispatchNative } = await fixture();
    const headers = { host: "127.0.0.1:8765" };

    const deck = await app.inject({ method: "POST", url: "/", headers, payload: { action: "createDeck", version: 6, params: { deck: "Science::Physics" } } });
    expect(Number.isSafeInteger(deck.json().result)).toBe(true);

    const note = await app.inject({
      method: "POST",
      url: "/",
      headers,
      payload: {
        action: "addNote",
        version: 6,
        params: { note: { deckName: "Default", modelName: "Basic", fields: { Front: "Question", Back: "Answer" }, tags: ["physics"] } },
      },
    });
    const noteId = note.json().result;
    expect(Number.isSafeInteger(noteId)).toBe(true);

    const info = await app.inject({ method: "POST", url: "/", headers, payload: { action: "notesInfo", version: 6, params: { notes: [noteId] } } });
    expect(info.json().result[0]).toMatchObject({ noteId, profile: "RemNote", modelName: "Basic", tags: ["physics"] });
    expect(info.json().result[0].fields).toEqual({
      Front: { value: "Question", order: 0 },
      Back: { value: "Answer", order: 1 },
    });
    expect(Number.isSafeInteger(info.json().result[0].cards[0])).toBe(true);

    const models = await app.inject({ method: "POST", url: "/", headers, payload: { action: "modelNamesAndIds", version: 6 } });
    expect(Object.keys(models.json().result)).toEqual(["Basic", "Cloze"]);

    const createdModel = await app.inject({
      method: "POST",
      url: "/",
      headers,
      payload: {
        action: "createModel",
        version: 6,
        params: {
          modelName: "Interview",
          inOrderFields: ["Prompt", "Response"],
          cardTemplates: [{ Name: "Card 1", Front: "{{Prompt}}", Back: "{{Response}}" }],
        },
      },
    });
    expect(createdModel.json().result).toMatchObject({ name: "Interview", type: 0 });
    await app.inject({
      method: "POST",
      url: "/",
      headers,
      payload: { action: "modelFieldRename", version: 6, params: { modelName: "Interview", oldFieldName: "Prompt", newFieldName: "Question" } },
    });
    const templates = await app.inject({ method: "POST", url: "/", headers, payload: { action: "modelTemplates", version: 6, params: { modelName: "Interview" } } });
    expect(templates.json().result["Card 1"].Front).toBe("{{Question}}");

    const invalidModel = await app.inject({ method: "POST", url: "/", headers, payload: { action: "createModel", version: 6, params: { modelName: "Empty", inOrderFields: [], cardTemplates: [] } } });
    expect(invalidModel.json().error).toContain("at least one field");

    const stored = await app.inject({ method: "POST", url: "/", headers, payload: { action: "storeMediaFile", version: 6, params: { filename: "tone.mp3", data: Buffer.from("audio").toString("base64") } } });
    expect(stored.json().result).toBe("tone.mp3");
    const retrieved = await app.inject({ method: "POST", url: "/", headers, payload: { action: "retrieveMediaFile", version: 6, params: { filename: "tone.mp3" } } });
    expect(Buffer.from(retrieved.json().result, "base64").toString()).toBe("audio");

    const skipped = await app.inject({ method: "POST", url: "/", headers, payload: { action: "storeMediaFile", version: 6, params: { filename: "hello.txt", data: Buffer.from("hello").toString("base64"), skipHash: "5d41402abc4b2a76b9719d911017c592" } } });
    expect(skipped.json()).toEqual({ result: null, error: null });

    const invalidMedia = await app.inject({ method: "POST", url: "/", headers, payload: { action: "storeMediaFile", version: 6, params: { filename: "bad.bin", data: "%%%" } } });
    expect(invalidMedia.json().error).toContain("valid base64");

    expect(dispatchNative).toHaveBeenCalled();
    await app.close();
  });

  it("blocks mutations in native read-only mode before dispatch", async () => {
    const { app, dispatchNative } = await fixture({ readonlyMode: true });
    const response = await app.inject({
      method: "POST",
      url: "/",
      headers: { host: "127.0.0.1:8765" },
      payload: { action: "addNote", version: 6, params: { note: { fields: { Front: "A" } } } },
    });
    expect(response.json().error).toContain("read-only mode");
    expect(dispatchNative).not.toHaveBeenCalled();

    const unsupported = await app.inject({
      method: "POST",
      url: "/",
      headers: { host: "127.0.0.1:8765" },
      payload: { action: "sync", version: 6 },
    });
    expect(unsupported.json().error).not.toContain("read-only mode");
    expect(unsupported.json().error).toContain("no faithful equivalent");
    await app.close();
  });

  it("hides soft-deleted Rem behind tombstoned compatibility identities", async () => {
    const { app } = await fixture();
    const headers = { host: "127.0.0.1:8765" };
    const created = await app.inject({
      method: "POST",
      url: "/",
      headers,
      payload: { action: "addNote", version: 6, params: { note: { fields: { Front: "Question", Back: "Answer" } } } },
    });
    const noteId = created.json().result;
    const before = await app.inject({ method: "POST", url: "/", headers, payload: { action: "findNotes", version: 6, params: { query: "Question" } } });
    expect(before.json().result).toEqual([noteId]);

    const deleted = await app.inject({ method: "POST", url: "/", headers, payload: { action: "deleteNotes", version: 6, params: { notes: [noteId] } } });
    expect(deleted.json()).toEqual({ result: null, error: null });
    const after = await app.inject({ method: "POST", url: "/", headers, payload: { action: "findNotes", version: 6, params: { query: "Question" } } });
    expect(after.json().result).toEqual([]);
    await app.close();
  });

  it("recognizes every official action and never reports it as unknown", async () => {
    const { app } = await fixture();
    const reflected = await app.inject({
      method: "POST",
      url: "/",
      headers: { host: "127.0.0.1:8765" },
      payload: { action: "apiReflect", version: 6, params: { scopes: ["actions"] } },
    });
    expect(reflected.json().result.actions).toEqual([...ankiConnectActionNames].sort());

    for (const action of ankiConnectActionManifest) {
      const response = await app.inject({
        method: "POST",
        url: "/",
        headers: { host: "127.0.0.1:8765" },
        payload: { action: action.name, version: 6 },
      });
      expect(response.json().error).not.toBe("unsupported action");
      if (action.status !== "blocked") expect(response.json().error ?? "").not.toContain("recognized but not implemented");
    }
    await app.close();
  });
});
