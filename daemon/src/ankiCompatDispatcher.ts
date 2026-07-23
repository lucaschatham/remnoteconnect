import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  ANKI_CONNECT_API_VERSION,
  ankiConnectActionsByName,
  type ApiResponse,
  type AnkiConnectRequest,
} from "@remnoteconnect/shared";
import { AnkiCompatStore, type AnkiModelRecord } from "./ankiCompatStore.js";
import { safeTokenEqual } from "./security.js";

export type NativeDispatch = (action: string, params: Record<string, unknown>) => Promise<ApiResponse>;

type DispatcherOptions = {
  appDir: string;
  apiKey?: string;
  readonlyMode: () => boolean;
  dispatchNative: NativeDispatch;
  store: AnkiCompatStore;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numbers(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((item): item is number => Number.isSafeInteger(item)) : [];
}

function safeFilename(value: unknown): string {
  if (typeof value !== "string" || !value || basename(value) !== value || value === "." || value === "..") {
    throw new Error("invalid media filename");
  }
  return value;
}

function wildcardMatch(pattern: string, value: string): boolean {
  if (pattern.length > 1_024) throw new Error("media filename pattern exceeds 1024 characters");
  let patternIndex = 0;
  let valueIndex = 0;
  let starIndex = -1;
  let retryValueIndex = 0;
  while (valueIndex < value.length) {
    if (patternIndex < pattern.length && (pattern[patternIndex] === "?" || pattern[patternIndex] === value[valueIndex])) {
      patternIndex += 1;
      valueIndex += 1;
    } else if (patternIndex < pattern.length && pattern[patternIndex] === "*") {
      starIndex = patternIndex;
      patternIndex += 1;
      retryValueIndex = valueIndex;
    } else if (starIndex >= 0) {
      patternIndex = starIndex + 1;
      retryValueIndex += 1;
      valueIndex = retryValueIndex;
    } else {
      return false;
    }
  }
  while (patternIndex < pattern.length && pattern[patternIndex] === "*") patternIndex += 1;
  return patternIndex === pattern.length;
}

const DEFAULT_MODEL_CSS = ".card { font-family: arial; font-size: 20px; text-align: center; color: black; background-color: white; }";

function basicModel(id: number, name: "Basic" | "Cloze"): AnkiModelRecord {
  const isCloze = name === "Cloze";
  const fields = isCloze ? ["Text", "Back Extra"] : ["Front", "Back"];
  return {
    id,
    name,
    inOrderFields: fields,
    cardTemplates: [
      {
        Name: isCloze ? "Cloze" : "Card 1",
        Front: isCloze ? "{{cloze:Text}}" : "{{Front}}",
        Back: isCloze ? "{{cloze:Text}}<br>{{Back Extra}}" : "{{FrontSide}}<hr id=answer>{{Back}}",
      },
    ],
    css: DEFAULT_MODEL_CSS,
    isCloze,
    fieldMetadata: Object.fromEntries(fields.map((field) => [field, { description: "", font: "Arial", fontSize: 20 }])),
  };
}

export class AnkiCompatDispatcher {
  private readonly mediaDir: string;

  constructor(private readonly options: DispatcherOptions) {
    this.mediaDir = resolve(join(options.appDir, "anki-media"));
  }

  authorize(request: AnkiConnectRequest): void {
    if (this.options.apiKey && !safeTokenEqual(request.key, this.options.apiKey) && request.action !== "requestPermission") {
      throw new Error("valid api key must be provided");
    }
  }

  async dispatch(request: AnkiConnectRequest): Promise<unknown> {
    const action = ankiConnectActionsByName.get(request.action);
    if (!action) throw new Error("unsupported action");
    this.authorize(request);
    if (action.status !== "blocked" && action.mutates && this.options.readonlyMode()) {
      throw new Error(`${request.action} is blocked because RemNoteConnect read-only mode is enabled`);
    }

    const params = request.params;
    switch (request.action) {
      case "version":
        return ANKI_CONNECT_API_VERSION;
      case "requestPermission":
        return { permission: "granted", requireApikey: Boolean(this.options.apiKey), version: ANKI_CONNECT_API_VERSION };
      case "getProfiles":
        return ["RemNote"];
      case "getActiveProfile":
        return "RemNote";
      case "loadProfile":
        return params.name === "RemNote";
      case "apiReflect":
        return this.reflect(params);
      case "deckNames":
        return this.native("deckNames", {});
      case "deckNamesAndIds":
        return this.deckNamesAndIds();
      case "deckNameFromId":
        return this.deckNameFromId(params);
      case "createDeck":
        return this.createDeck(params);
      case "getDecks":
        return this.getDecks(params);
      case "getDeckConfig":
        return this.getDeckConfig(params);
      case "saveDeckConfig":
        return this.saveDeckConfig(params);
      case "setDeckConfigId":
        return this.setDeckConfigId(params);
      case "cloneDeckConfigId":
        return this.cloneDeckConfigId(params);
      case "removeDeckConfigId":
        return this.removeDeckConfigId(params);
      case "addNote":
        return this.addNote(record(params.note));
      case "addNotes":
        return this.addNotes(params);
      case "canAddNote":
        return this.canAddNote(record(params.note));
      case "canAddNoteWithErrorDetail":
        return this.canAddNoteWithErrorDetail(record(params.note));
      case "canAddNotes":
        return (Array.isArray(params.notes) ? params.notes : []).map((note) => this.canAddNote(record(note)));
      case "canAddNotesWithErrorDetail":
        return (Array.isArray(params.notes) ? params.notes : []).map((note) => this.canAddNoteWithErrorDetail(record(note)));
      case "findNotes":
        return this.findNotes(params);
      case "notesInfo":
        return this.notesInfo(params);
      case "notesModTime":
        return this.notesModTime(params);
      case "updateNoteFields":
        return this.updateNoteFields(record(params.note));
      case "updateNote":
        return this.updateNote(record(params.note));
      case "updateNoteModel":
        return this.updateNoteModel(record(params.note));
      case "updateNoteTags":
        return this.updateNoteTags(Number(params.note), params.tags);
      case "getNoteTags":
        return this.getNoteTags(Number(params.note));
      case "addTags":
        return this.changeTags(params.notes, params.tags, []);
      case "removeTags":
        return this.changeTags(params.notes, [], params.tags);
      case "getTags":
        return this.getTags();
      case "replaceTags":
        return this.replaceTags(params.notes, params.tag_to_replace, params.replace_with_tag);
      case "replaceTagsInAllNotes":
        return this.replaceTags(await this.findNotes({ query: "" }), params.tag_to_replace, params.replace_with_tag);
      case "findCards":
        return this.findCards(params);
      case "cardsToNotes":
        return this.cardsToNotes(params);
      case "changeDeck":
        return this.changeDeck(params);
      case "deleteNotes":
        return this.deleteNotes(params);
      case "modelNames":
        return this.modelNames();
      case "modelNamesAndIds":
        return this.modelNamesAndIds();
      case "createModel":
        return this.createModel(params);
      case "modelNameFromId":
        return this.modelNameFromId(params);
      case "findModelsById":
        return this.findModelsById(params);
      case "findModelsByName":
        return this.findModelsByName(params);
      case "modelFieldNames":
        return (await this.requireModel(String(params.modelName ?? ""))).inOrderFields;
      case "modelFieldDescriptions": {
        const model = await this.requireModel(String(params.modelName ?? ""));
        return model.inOrderFields.map((field) => model.fieldMetadata[field]?.description ?? "");
      }
      case "modelFieldFonts": {
        const model = await this.requireModel(String(params.modelName ?? ""));
        return Object.fromEntries(model.inOrderFields.map((field) => [field, { font: model.fieldMetadata[field]?.font ?? "Arial", size: model.fieldMetadata[field]?.fontSize ?? 20 }]));
      }
      case "modelFieldsOnTemplates":
        return this.modelFieldsOnTemplates(params);
      case "modelTemplates":
        return Object.fromEntries((await this.requireModel(String(params.modelName ?? ""))).cardTemplates.map((template) => [template.Name, { Front: template.Front, Back: template.Back }]));
      case "modelStyling":
        return { css: (await this.requireModel(String(params.modelName ?? ""))).css };
      case "updateModelTemplates":
        return this.updateModelTemplates(params);
      case "updateModelStyling":
        return this.updateModelStyling(params);
      case "findAndReplaceInModels":
        return this.findAndReplaceInModels(params);
      case "modelTemplateRename":
        return this.mutateTemplate(params, "rename");
      case "modelTemplateReposition":
        return this.mutateTemplate(params, "reposition");
      case "modelTemplateAdd":
        return this.mutateTemplate(params, "add");
      case "modelTemplateRemove":
        return this.mutateTemplate(params, "remove");
      case "modelFieldRename":
        return this.mutateField(params, "rename");
      case "modelFieldReposition":
        return this.mutateField(params, "reposition");
      case "modelFieldAdd":
        return this.mutateField(params, "add");
      case "modelFieldRemove":
        return this.mutateField(params, "remove");
      case "modelFieldSetFont":
        return this.mutateField(params, "font");
      case "modelFieldSetFontSize":
        return this.mutateField(params, "fontSize");
      case "modelFieldSetDescription":
        return this.mutateField(params, "description");
      case "storeMediaFile":
        return this.storeMediaFile(params);
      case "retrieveMediaFile":
        return this.retrieveMediaFile(params);
      case "getMediaFilesNames":
        return this.getMediaFilesNames(params);
      case "deleteMediaFile":
        return this.deleteMediaFile(params);
      case "getMediaDirPath":
        await mkdir(this.mediaDir, { recursive: true });
        return this.mediaDir;
      default:
        throw new Error(action.limitation ?? `${request.action} is recognized but not implemented in this RemNoteConnect build`);
    }
  }

  private async native(action: string, params: Record<string, unknown>): Promise<unknown> {
    const response = await this.options.dispatchNative(action, params);
    if (response.error) throw new Error(response.error.message);
    return response.result;
  }

  private reflect(params: Record<string, unknown>): Record<string, unknown> {
    if (!Array.isArray(params.scopes)) throw new Error("scopes has invalid value");
    if (params.actions !== undefined && !Array.isArray(params.actions)) throw new Error("actions has invalid value");
    const scopes = strings(params.scopes);
    const result: Record<string, unknown> = { scopes: [] };
    if (scopes.includes("actions")) {
      const requested = params.actions === undefined ? [...ankiConnectActionsByName.keys()].sort() : strings(params.actions);
      result.scopes = ["actions"];
      result.actions = requested.filter((name) => ankiConnectActionsByName.has(name));
    }
    return result;
  }

  private async deckNamesAndIds(): Promise<Record<string, number>> {
    const names = strings(await this.native("deckNames", {}));
    const ids = await this.options.store.getOrCreatePublicIds("deck", names);
    return Object.fromEntries(names.map((name, index) => [name, ids[index]]));
  }

  private async deckNameFromId(params: Record<string, unknown>): Promise<string> {
    const id = Number(params.deckId);
    const name = await this.options.store.resolveExternalId("deck", id);
    if (!name) throw new Error(`deck was not found: ${id}`);
    return name;
  }

  private async createDeck(params: Record<string, unknown>): Promise<number> {
    const deck = String(params.deck ?? "");
    if (!deck) throw new Error("deck is required");
    await this.native("createDeck", { deck, dryRun: false, confirm: true });
    return this.options.store.getOrCreatePublicId("deck", deck);
  }

  private async getDecks(params: Record<string, unknown>): Promise<Record<string, number[]>> {
    const cards = numbers(params.cards);
    const output: Record<string, number[]> = {};
    const snapshot = await this.options.store.snapshot();
    for (const cardId of cards) {
      const external = await this.options.store.resolveExternalId("card", cardId);
      if (!external) continue;
      const noteId = snapshot.cardNoteIds[external];
      const deckName = String(snapshot.noteMetadata[String(noteId)]?.deckName ?? "Default");
      (output[deckName] ??= []).push(cardId);
    }
    return output;
  }

  private async ensureDefaultDeckConfig(): Promise<number> {
    const id = await this.options.store.getOrCreatePublicId("deckConfig", "Default");
    const snapshot = await this.options.store.snapshot();
    if (snapshot.deckConfigs[String(id)]) return id;
    await this.options.store.mutate((data) => {
      data.deckConfigs[String(id)] = {
        id,
        name: "Default",
        mod: Math.floor(Date.now() / 1000),
        usn: 0,
        maxTaken: 60,
        autoplay: true,
        timer: 0,
        replayq: true,
        new: {},
        rev: {},
        lapse: {},
        dyn: false,
      };
    });
    return id;
  }

  private async getDeckConfig(params: Record<string, unknown>): Promise<Record<string, unknown> | false> {
    const deck = String(params.deck ?? "");
    const deckNames = strings(await this.native("deckNames", {}));
    if (!deckNames.includes(deck)) return false;
    const deckId = await this.options.store.getOrCreatePublicId("deck", deck);
    const defaultId = await this.ensureDefaultDeckConfig();
    const snapshot = await this.options.store.snapshot();
    const configId = snapshot.deckConfigAssignments[String(deckId)] ?? defaultId;
    return structuredClone(snapshot.deckConfigs[String(configId)]);
  }

  private async saveDeckConfig(params: Record<string, unknown>): Promise<boolean> {
    const config = record(params.config);
    const id = Number(config.id);
    if (!Number.isSafeInteger(id)) return false;
    const snapshot = await this.options.store.snapshot();
    if (!snapshot.deckConfigs[String(id)]) return false;
    await this.options.store.mutate((data) => {
      data.deckConfigs[String(id)] = { ...structuredClone(config), id, mod: Math.floor(Date.now() / 1000), usn: 0 };
    });
    return true;
  }

  private async setDeckConfigId(params: Record<string, unknown>): Promise<boolean> {
    const decks = strings(params.decks);
    const configId = Number(params.configId);
    const snapshot = await this.options.store.snapshot();
    if (!snapshot.deckConfigs[String(configId)]) return false;
    const existingDecks = strings(await this.native("deckNames", {}));
    if (decks.some((deck) => !existingDecks.includes(deck))) return false;
    const deckIds = await this.options.store.getOrCreatePublicIds("deck", decks);
    await this.options.store.mutate((data) => {
      for (const deckId of deckIds) data.deckConfigAssignments[String(deckId)] = configId;
    });
    return true;
  }

  private async cloneDeckConfigId(params: Record<string, unknown>): Promise<number | false> {
    const sourceId = Number(params.cloneFrom ?? "1");
    await this.ensureDefaultDeckConfig();
    const source = (await this.options.store.snapshot()).deckConfigs[String(sourceId)];
    if (!source) return false;
    const name = String(params.name ?? "");
    const id = await this.options.store.getOrCreatePublicId("deckConfig", name);
    await this.options.store.mutate((data) => {
      data.deckConfigs[String(id)] = { ...structuredClone(source), id, name, mod: Math.floor(Date.now() / 1000), usn: 0 };
    });
    return id;
  }

  private async removeDeckConfigId(params: Record<string, unknown>): Promise<boolean> {
    const id = Number(params.configId);
    const defaultId = await this.ensureDefaultDeckConfig();
    const snapshot = await this.options.store.snapshot();
    if (id === defaultId || !snapshot.deckConfigs[String(id)]) return false;
    await this.options.store.mutate((data) => {
      delete data.deckConfigs[String(id)];
      for (const [deckId, configId] of Object.entries(data.deckConfigAssignments)) {
        if (configId === id) data.deckConfigAssignments[deckId] = defaultId;
      }
      const identity = data.identities.find((item) => item.kind === "deckConfig" && item.publicId === id);
      if (identity) {
        identity.tombstoned = true;
        identity.tombstonedAt = new Date().toISOString();
      }
    });
    return true;
  }

  private canAddNote(note: Record<string, unknown>): boolean {
    const fields = record(note.fields);
    return Object.values(fields).some((value) => String(record(value).value ?? value ?? "").trim().length > 0);
  }

  private canAddNoteWithErrorDetail(note: Record<string, unknown>): { canAdd: boolean; error: string | null } {
    const canAdd = this.canAddNote(note);
    return { canAdd, error: canAdd ? null : "cannot create note because it is empty" };
  }

  private async addNote(note: Record<string, unknown>): Promise<number> {
    if (!this.canAddNote(note)) throw new Error("cannot create note because it is empty");
    const result = record(await this.native("addNote", { note, verbose: true }));
    const externalId = String(result.id ?? "");
    if (!externalId) throw new Error("RemNote did not return a note identity");
    const publicId = await this.options.store.getOrCreatePublicId("note", externalId);
    const cardExternalIds = (Array.isArray(result.cards) ? result.cards : []).map((item) => String(record(item).id ?? "")).filter(Boolean);
    await this.options.store.getOrCreatePublicIds("card", cardExternalIds);
    await this.options.store.mutate((data) => {
      data.noteMetadata[String(publicId)] = {
        fields: record(note.fields),
        modelName: String(note.modelName ?? "Basic"),
        deckName: String(note.deckName ?? result.path ?? "Default"),
        cardExternalIds,
      };
      for (const cardExternalId of cardExternalIds) data.cardNoteIds[cardExternalId] = publicId;
    });
    return publicId;
  }

  private async addNotes(params: Record<string, unknown>): Promise<Array<number | null>> {
    const notes = Array.isArray(params.notes) ? params.notes.map(record) : [];
    const valid = notes.map((note) => this.canAddNote(note));
    const candidates = notes.filter((_note, index) => valid[index]);
    if (candidates.length === 0) return notes.map(() => null);
    const result = record(
      await this.native("addNotes", {
        notes: candidates,
        confirm: true,
        confirmCount: candidates.length,
        dryRun: false,
      }),
    );
    const externalIds = strings(result.ids ?? result.remIds);
    const createdIds = await this.options.store.getOrCreatePublicIds("note", externalIds);
    const metadataEntries: Array<[string, Record<string, unknown>]> = [];
    for (let index = 0; index < externalIds.length; index += 1) {
      const note = candidates[index];
      metadataEntries.push([
        String(createdIds[index]),
        {
          fields: record(note.fields),
          modelName: String(note.modelName ?? "Basic"),
          deckName: String(note.deckName ?? "Default"),
          cardExternalIds: [],
        },
      ]);
    }
    await this.options.store.mutate((data) => Object.assign(data.noteMetadata, Object.fromEntries(metadataEntries)));
    let createdIndex = 0;
    return valid.map((isValid) => (isValid ? (createdIds[createdIndex++] ?? null) : null));
  }

  private async findNotes(params: Record<string, unknown>): Promise<number[]> {
    const query = await this.translateQuery(String(params.query ?? ""));
    const result = record(await this.native("searchFlashcards", { query }));
    const externalIds = strings(result.ids ?? result.remIds);
    const activeExternalIds: string[] = [];
    for (const externalId of externalIds) {
      if (await this.options.store.isTombstoned("note", externalId)) continue;
      activeExternalIds.push(externalId);
    }
    return this.options.store.getOrCreatePublicIds("note", activeExternalIds);
  }

  private async translateQuery(query: string): Promise<string> {
    const noteMatch = query.match(/(?:^|\s)nid:(\d+)/);
    if (noteMatch) {
      const externalId = await this.options.store.resolveExternalId("note", Number(noteMatch[1]));
      if (!externalId) return "id:__missing_anki_note__";
      return `id:${externalId}`;
    }
    if (/\b(?:cid|prop|is|rated|added|edited):/i.test(query) || /\sOR\s|(^|\s)-\S|\([^)]*\)/i.test(query)) {
      throw new Error("query uses Anki search syntax that cannot be translated faithfully");
    }
    return query.replace(/deck:"([^"]+)"/g, "deck:$1");
  }

  private async notesInfo(params: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const publicIds = params.query === undefined ? numbers(params.notes) : await this.findNotes({ query: params.query });
    const externalIds = await Promise.all(publicIds.map((id) => this.options.store.resolveExternalId("note", id)));
    const valid = externalIds.flatMap((externalId, index) => (externalId ? [{ externalId, publicId: publicIds[index], outputIndex: index }] : []));
    const nativeRows = (await this.native("notesInfo", { notes: valid.map((item) => item.externalId) })) as unknown[];
    const snapshot = await this.options.store.snapshot();
    const allCardExternalIds = nativeRows.flatMap((raw) =>
      (Array.isArray(record(raw).cards) ? (record(raw).cards as unknown[]) : []).map((card) => String(record(card).id ?? "")).filter(Boolean),
    );
    const allCardPublicIds = await this.options.store.getOrCreatePublicIds("card", allCardExternalIds);
    const publicCardIdByExternalId = new Map(allCardExternalIds.map((externalId, index) => [externalId, allCardPublicIds[index]]));
    const output: Record<string, unknown>[] = publicIds.map(() => ({}));
    const metadataUpdates: Array<{ noteId: number; cardExternalIds: string[]; deckName: string }> = [];

    nativeRows.forEach((raw, index) => {
        const row = record(raw);
        const noteId = valid[index].publicId;
        const metadata = snapshot.noteMetadata[String(noteId)] ?? {};
        const nativeCards = Array.isArray(row.cards) ? row.cards.map(record) : [];
        const cardExternalIds = nativeCards.map((card) => String(card.id ?? "")).filter(Boolean);
        const cards = cardExternalIds.map((externalId) => publicCardIdByExternalId.get(externalId)!);
        const fields = Object.keys(record(metadata.fields)).length
          ? this.ankiFields(record(metadata.fields))
          : {
              Front: { value: String(row.text ?? ""), order: 0 },
              Back: { value: String(row.backText ?? ""), order: 1 },
            };
        output[valid[index].outputIndex] = {
          noteId,
          profile: "RemNote",
          modelName: String(metadata.modelName ?? "Basic"),
          tags: (Array.isArray(row.tags) ? row.tags : []).map((tag) => String(record(tag).text ?? "")).filter(Boolean),
          fields,
          cards,
          mod: Math.floor(Number(row.updatedAt ?? 0) / 1000),
        };
        metadataUpdates.push({ noteId, cardExternalIds, deckName: String(row.path ?? "Default") });
    });
    const metadataChanged = metadataUpdates.some((update) => {
      const existing = snapshot.noteMetadata[String(update.noteId)] ?? {};
      return (
        JSON.stringify(strings(existing.cardExternalIds)) !== JSON.stringify(update.cardExternalIds) ||
        existing.deckName === undefined ||
        update.cardExternalIds.some((externalId) => snapshot.cardNoteIds[externalId] !== update.noteId)
      );
    });
    if (metadataChanged) {
      await this.options.store.mutate((data) => {
        for (const update of metadataUpdates) {
          const metadata = (data.noteMetadata[String(update.noteId)] ??= {});
          metadata.cardExternalIds = update.cardExternalIds;
          metadata.deckName ??= update.deckName;
          for (const cardExternalId of update.cardExternalIds) data.cardNoteIds[cardExternalId] = update.noteId;
        }
      });
    }
    return output;
  }

  private async requireNoteExternalId(publicId: number): Promise<string> {
    if (!Number.isSafeInteger(publicId)) throw new Error("note id must be an integer");
    const externalId = await this.options.store.resolveExternalId("note", publicId);
    if (!externalId) throw new Error(`note was not found: ${publicId}`);
    return externalId;
  }

  private fieldValue(fields: Record<string, unknown>, names: string[], fallbackIndex: number): unknown {
    for (const name of names) {
      const match = Object.entries(fields).find(([field]) => field.toLowerCase() === name.toLowerCase());
      if (match) return record(match[1]).value ?? match[1];
    }
    const entry = Object.values(fields)[fallbackIndex];
    return record(entry).value ?? entry;
  }

  private ankiFields(fields: Record<string, unknown>): Record<string, { value: string; order: number }> {
    return Object.fromEntries(
      Object.entries(fields).map(([name, raw], order) => {
        const field = record(raw);
        return [name, { value: String(field.value ?? raw ?? ""), order: Number.isInteger(field.order) ? Number(field.order) : order }];
      }),
    );
  }

  private async updateNoteFields(note: Record<string, unknown>): Promise<null> {
    const noteId = Number(note.id);
    const externalId = await this.requireNoteExternalId(noteId);
    const fields = record(note.fields);
    const front = this.fieldValue(fields, ["Front", "Question", "Text"], 0);
    const back = this.fieldValue(fields, ["Back", "Answer", "Back Extra"], 1);
    await this.native("updateFlashcard", {
      id: externalId,
      ...(front === undefined ? {} : { front }),
      ...(back === undefined ? {} : { back }),
      dryRun: false,
    });
    await this.options.store.mutate((data) => {
      const metadata = (data.noteMetadata[String(noteId)] ??= {});
      metadata.fields = { ...record(metadata.fields), ...fields };
    });
    return null;
  }

  private async updateNote(note: Record<string, unknown>): Promise<null> {
    if (note.fields !== undefined) await this.updateNoteFields(note);
    if (note.tags !== undefined) await this.updateNoteTags(Number(note.id), note.tags);
    return null;
  }

  private async updateNoteModel(note: Record<string, unknown>): Promise<null> {
    const noteId = Number(note.id);
    await this.requireNoteExternalId(noteId);
    const modelName = String(note.modelName ?? "");
    await this.requireModel(modelName);
    await this.options.store.mutate((data) => {
      const metadata = (data.noteMetadata[String(noteId)] ??= {});
      metadata.modelName = modelName;
      if (note.fields !== undefined) metadata.fields = record(note.fields);
    });
    if (note.fields !== undefined) await this.updateNoteFields(note);
    return null;
  }

  private tagWords(value: unknown): string[] {
    if (Array.isArray(value)) return strings(value).map((tag) => tag.trim()).filter(Boolean);
    return typeof value === "string" ? value.split(/\s+/).map((tag) => tag.trim()).filter(Boolean) : [];
  }

  private async getNoteTags(noteId: number): Promise<string[]> {
    const rows = await this.notesInfo({ notes: [noteId] });
    return strings(rows[0]?.tags);
  }

  private async changeTags(noteIdsValue: unknown, addValue: unknown, removeValue: unknown): Promise<null> {
    const noteIds = numbers(noteIdsValue);
    const externalIds = await Promise.all(noteIds.map((id) => this.requireNoteExternalId(id)));
    if (externalIds.length === 0) return null;
    await this.native("bulkRetag", {
      remIds: externalIds,
      addTags: this.tagWords(addValue),
      removeTags: this.tagWords(removeValue),
      confirm: true,
      confirmCount: externalIds.length,
      dryRun: false,
    });
    return null;
  }

  private async updateNoteTags(noteId: number, value: unknown): Promise<null> {
    const desired = this.tagWords(value);
    const current = await this.getNoteTags(noteId);
    const desiredSet = new Set(desired);
    const currentSet = new Set(current);
    return this.changeTags(
      [noteId],
      desired.filter((tag) => !currentSet.has(tag)),
      current.filter((tag) => !desiredSet.has(tag)),
    );
  }

  private async replaceTags(noteIds: unknown, from: unknown, to: unknown): Promise<null> {
    const replacement = this.tagWords(to);
    return this.changeTags(noteIds, replacement, this.tagWords(from));
  }

  private async getTags(): Promise<string[]> {
    const noteIds = await this.findNotes({ query: "" });
    if (noteIds.length === 0) return [];
    const notes = await this.notesInfo({ notes: noteIds });
    return [...new Set(notes.flatMap((note) => strings(note.tags)))].sort();
  }

  private async notesModTime(params: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    return (await this.notesInfo({ notes: params.notes })).map((note) => ({ noteId: note.noteId, mod: note.mod }));
  }

  private async noteIdForCard(cardId: number): Promise<number | undefined> {
    const externalCardId = await this.options.store.resolveExternalId("card", cardId);
    if (!externalCardId) return undefined;
    const snapshot = await this.options.store.snapshot();
    return snapshot.cardNoteIds[externalCardId];
  }

  private async findCards(params: Record<string, unknown>): Promise<number[]> {
    const noteIds = await this.findNotes(params);
    const rows = await this.notesInfo({ notes: noteIds });
    return rows.flatMap((row) => numbers(row.cards));
  }

  private async cardsToNotes(params: Record<string, unknown>): Promise<number[]> {
    const noteIds = await Promise.all(numbers(params.cards).map((cardId) => this.noteIdForCard(cardId)));
    return [...new Set(noteIds.filter((noteId): noteId is number => noteId !== undefined))];
  }

  private async changeDeck(params: Record<string, unknown>): Promise<null> {
    const cards = numbers(params.cards);
    const noteIds = (await Promise.all(cards.map((cardId) => this.noteIdForCard(cardId)))).filter((id): id is number => id !== undefined);
    const externalIds = await Promise.all(noteIds.map((id) => this.requireNoteExternalId(id)));
    if (externalIds.length > 0) {
      await this.native("changeDeck", {
        remIds: externalIds,
        deck: String(params.deck ?? ""),
        confirm: true,
        confirmCount: externalIds.length,
        dryRun: false,
      });
      await this.options.store.mutate((data) => {
        for (const noteId of noteIds) {
          const metadata = (data.noteMetadata[String(noteId)] ??= {});
          metadata.deckName = String(params.deck ?? "");
        }
      });
    }
    return null;
  }

  private async deleteNotes(params: Record<string, unknown>): Promise<null> {
    const publicIds = numbers(params.notes);
    const externalIds = await Promise.all(publicIds.map((id) => this.options.store.resolveExternalId("note", id)));
    const valid = externalIds.flatMap((externalId, index) => (externalId ? [{ externalId, publicId: publicIds[index] }] : []));
    if (valid.length === 0) return null;
    await this.native("deleteNotes", { notes: valid.map((item) => item.externalId), confirm: true, confirmCount: valid.length, dryRun: false });
    const snapshot = await this.options.store.snapshot();
    const cardPublicIds = valid.flatMap(({ publicId }) => {
      const noteId = publicId;
      const externalCards = strings(snapshot.noteMetadata[String(noteId)]?.cardExternalIds);
      return snapshot.identities
        .filter((identity) => identity.kind === "card" && externalCards.includes(identity.externalId) && !identity.tombstoned)
        .map((identity) => identity.publicId);
    });
    const tombstoneIds = new Set([...valid.map((item) => item.publicId), ...cardPublicIds]);
    await this.options.store.mutate((data) => {
      for (const identity of data.identities) {
        if (!tombstoneIds.has(identity.publicId) || identity.tombstoned) continue;
        identity.tombstoned = true;
        identity.tombstonedAt = new Date().toISOString();
      }
    });
    return null;
  }

  private async ensureDefaultModels(): Promise<void> {
    const snapshot = await this.options.store.snapshot();
    if (snapshot.models.Basic && snapshot.models.Cloze) return;
    const [basicId, clozeId] = await this.options.store.getOrCreatePublicIds("model", ["Basic", "Cloze"]);
    await this.options.store.mutate((data) => {
      data.models.Basic ??= basicModel(basicId, "Basic");
      data.models.Cloze ??= basicModel(clozeId, "Cloze");
    });
  }

  private async modelNames(): Promise<string[]> {
    await this.ensureDefaultModels();
    return Object.keys((await this.options.store.snapshot()).models);
  }

  private async modelNamesAndIds(): Promise<Record<string, number>> {
    await this.ensureDefaultModels();
    return Object.fromEntries(Object.values((await this.options.store.snapshot()).models).map((model) => [model.name, model.id]));
  }

  private async createModel(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.ensureDefaultModels();
    const name = String(params.modelName ?? "");
    if (!name) throw new Error("modelName is required");
    if ((await this.options.store.snapshot()).models[name]) throw new Error(`Model name already exists: ${name}`);
    const fields = strings(params.inOrderFields);
    const templates = (Array.isArray(params.cardTemplates) ? params.cardTemplates : []).map((item) => {
      const template = record(item);
      return {
        ...template,
        Name: String(template.Name ?? "Card 1"),
        Front: String(template.Front ?? ""),
        Back: String(template.Back ?? ""),
      };
    });
    if (fields.length === 0) throw new Error("Must provide at least one field for inOrderFields");
    if (templates.length === 0) throw new Error("Must provide at least one card for cardTemplates");
    if (new Set(fields).size !== fields.length) throw new Error("inOrderFields must contain unique field names");
    if (new Set(templates.map((template) => template.Name)).size !== templates.length) throw new Error("cardTemplates must contain unique template names");
    const id = await this.options.store.getOrCreatePublicId("model", name);
    const model: AnkiModelRecord = {
      id,
      name,
      inOrderFields: fields,
      cardTemplates: templates,
      css: typeof params.css === "string" ? params.css : DEFAULT_MODEL_CSS,
      isCloze: params.isCloze === true,
      fieldMetadata: Object.fromEntries(fields.map((field) => [field, { description: "", font: "Arial", fontSize: 20 }])),
    };
    await this.options.store.mutate((data) => {
      data.models[name] = model;
    });
    return this.modelJson(model);
  }

  private async requireModel(name: string): Promise<AnkiModelRecord> {
    await this.ensureDefaultModels();
    const model = (await this.options.store.snapshot()).models[name];
    if (!model) throw new Error(`model was not found: ${name}`);
    return model;
  }

  private async modelNameFromId(params: Record<string, unknown>): Promise<string> {
    await this.ensureDefaultModels();
    const id = Number(params.modelId);
    const model = Object.values((await this.options.store.snapshot()).models).find((item) => item.id === id);
    if (!model) throw new Error(`model was not found: ${id}`);
    return model.name;
  }

  private modelJson(model: AnkiModelRecord): Record<string, unknown> {
    return {
      id: model.id,
      name: model.name,
      type: model.isCloze ? 1 : 0,
      css: model.css,
      flds: model.inOrderFields.map((name, ord) => ({
        name,
        ord,
        font: model.fieldMetadata[name]?.font ?? "Arial",
        size: model.fieldMetadata[name]?.fontSize ?? 20,
        description: model.fieldMetadata[name]?.description ?? "",
      })),
      tmpls: model.cardTemplates.map((template, ord) => ({ name: template.Name, ord, qfmt: template.Front, afmt: template.Back })),
    };
  }

  private async findModelsById(params: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    await this.ensureDefaultModels();
    const models = Object.values((await this.options.store.snapshot()).models);
    return numbers(params.modelIds).map((id) => {
      const model = models.find((item) => item.id === id);
      if (!model) throw new Error(`model was not found: ${id}`);
      return this.modelJson(model);
    });
  }

  private async findModelsByName(params: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    return Promise.all(strings(params.modelNames).map(async (name) => this.modelJson(await this.requireModel(name))));
  }

  private templateFields(template: string): string[] {
    const fields: string[] = [];
    for (const match of template.matchAll(/{{[^#/}]+?}}/g)) {
      const field = match[0].replace(/[{}]/g, "").split(":").at(-1) ?? "";
      if (field && field !== "FrontSide" && !fields.includes(field)) fields.push(field);
    }
    return fields;
  }

  private async modelFieldsOnTemplates(params: Record<string, unknown>): Promise<Record<string, [string[], string[]]>> {
    const model = await this.requireModel(String(params.modelName ?? ""));
    return Object.fromEntries(
      model.cardTemplates.map((template) => {
        const front = this.templateFields(template.Front);
        const back = this.templateFields(template.Back).filter((field) => !front.includes(field));
        return [template.Name, [front, back] as [string[], string[]]];
      }),
    );
  }

  private async updateModelTemplates(params: Record<string, unknown>): Promise<null> {
    const input = record(params.model);
    const name = String(input.name ?? "");
    await this.requireModel(name);
    const templates = record(input.templates);
    await this.options.store.mutate((data) => {
      const model = data.models[name];
      for (const template of model.cardTemplates) {
        const update = record(templates[template.Name]);
        if (typeof update.Front === "string" && update.Front) template.Front = update.Front;
        if (typeof update.Back === "string" && update.Back) template.Back = update.Back;
      }
    });
    return null;
  }

  private async updateModelStyling(params: Record<string, unknown>): Promise<null> {
    const input = record(params.model);
    const name = String(input.name ?? "");
    await this.requireModel(name);
    await this.options.store.mutate((data) => {
      data.models[name].css = String(input.css ?? "");
    });
    return null;
  }

  private async findAndReplaceInModels(params: Record<string, unknown>): Promise<number> {
    await this.ensureDefaultModels();
    const requested = String(params.modelName ?? "");
    const find = String(params.findText ?? "");
    const replace = String(params.replaceText ?? "");
    let updated = 0;
    await this.options.store.mutate((data) => {
      const models = requested ? [data.models[requested]].filter(Boolean) : Object.values(data.models);
      if (requested && models.length === 0) throw new Error(`model was not found: ${requested}`);
      for (const model of models) {
        let changed = false;
        if (params.css !== false && model.css.includes(find)) {
          model.css = model.css.replaceAll(find, replace);
          changed = true;
        }
        for (const template of model.cardTemplates) {
          if (params.front !== false && template.Front.includes(find)) {
            template.Front = template.Front.replaceAll(find, replace);
            changed = true;
          }
          if (params.back !== false && template.Back.includes(find)) {
            template.Back = template.Back.replaceAll(find, replace);
            changed = true;
          }
        }
        if (changed) updated += 1;
      }
    });
    return updated;
  }

  private async mutateTemplate(params: Record<string, unknown>, operation: "rename" | "reposition" | "add" | "remove"): Promise<null> {
    const modelName = String(params.modelName ?? "");
    await this.requireModel(modelName);
    await this.options.store.mutate((data) => {
      const templates = data.models[modelName].cardTemplates;
      if (operation === "add") {
        const input = record(params.template);
        const name = String(input.Name ?? "");
        if (!name) throw new Error("template Name is required");
        const next = { ...input, Name: name, Front: String(input.Front ?? ""), Back: String(input.Back ?? "") };
        const index = templates.findIndex((template) => template.Name === name);
        if (index >= 0) templates[index] = next;
        else templates.push(next);
        return;
      }
      const name = String(params.templateName ?? params.oldTemplateName ?? "");
      const index = templates.findIndex((template) => template.Name === name);
      if (index < 0) throw new Error(`template was not found: ${name}`);
      if (operation === "rename") {
        const next = String(params.newTemplateName ?? "");
        if (!next) throw new Error("newTemplateName is required");
        if (templates.some((template, templateIndex) => templateIndex !== index && template.Name === next)) {
          throw new Error(`template already exists: ${next}`);
        }
        templates[index].Name = next;
      }
      if (operation === "remove") {
        if (templates.length === 1) throw new Error("cannot remove the last card template");
        templates.splice(index, 1);
      }
      if (operation === "reposition") {
        if (!Number.isInteger(params.index)) throw new Error("index should be an integer");
        const [template] = templates.splice(index, 1);
        const destination = Math.max(0, Math.min(Number(params.index), templates.length));
        templates.splice(destination, 0, template);
      }
    });
    return null;
  }

  private async mutateField(
    params: Record<string, unknown>,
    operation: "rename" | "reposition" | "add" | "remove" | "font" | "fontSize" | "description",
  ): Promise<boolean | null> {
    const modelName = String(params.modelName ?? "");
    await this.requireModel(modelName);
    let descriptionResult: boolean | null = null;
    await this.options.store.mutate((data) => {
      const model = data.models[modelName];
      const fieldName = String(params.fieldName ?? params.oldFieldName ?? "");
      if (operation === "add") {
        if (!fieldName) throw new Error("fieldName is required");
        if (!model.inOrderFields.includes(fieldName)) {
          const destination = params.index === undefined ? model.inOrderFields.length : Math.max(0, Math.min(Number(params.index), model.inOrderFields.length));
          model.inOrderFields.splice(destination, 0, fieldName);
          model.fieldMetadata[fieldName] = { description: "", font: "Arial", fontSize: 20 };
        }
        return;
      }
      const index = model.inOrderFields.indexOf(fieldName);
      if (index < 0) throw new Error(`field was not found: ${fieldName}`);
      if (operation === "rename") {
        const next = String(params.newFieldName ?? "");
        if (!next) throw new Error("newFieldName is required");
        if (model.inOrderFields.includes(next)) throw new Error(`field already exists: ${next}`);
        model.inOrderFields[index] = next;
        model.fieldMetadata[next] = model.fieldMetadata[fieldName];
        delete model.fieldMetadata[fieldName];
        for (const template of model.cardTemplates) {
          template.Front = this.renameTemplateField(template.Front, fieldName, next);
          template.Back = this.renameTemplateField(template.Back, fieldName, next);
        }
      } else if (operation === "remove") {
        if (model.inOrderFields.length === 1) throw new Error("cannot remove the last model field");
        model.inOrderFields.splice(index, 1);
        delete model.fieldMetadata[fieldName];
      } else if (operation === "reposition") {
        if (!Number.isInteger(params.index)) throw new Error("index should be an integer");
        const [field] = model.inOrderFields.splice(index, 1);
        const destination = Math.max(0, Math.min(Number(params.index), model.inOrderFields.length));
        model.inOrderFields.splice(destination, 0, field);
      } else if (operation === "font") {
        if (typeof params.font !== "string") throw new Error("font should be a string");
        model.fieldMetadata[fieldName].font = params.font;
      } else if (operation === "fontSize") {
        if (!Number.isInteger(params.fontSize)) throw new Error("fontSize should be an integer");
        model.fieldMetadata[fieldName].fontSize = Number(params.fontSize);
      } else {
        if (typeof params.description !== "string") throw new Error("description should be a string");
        model.fieldMetadata[fieldName].description = params.description;
        descriptionResult = true;
      }
    });
    return operation === "description" ? descriptionResult : null;
  }

  private renameTemplateField(template: string, from: string, to: string): string {
    return template.replace(/{{([^{}]+)}}/g, (match, expression: string) => {
      const separator = expression.lastIndexOf(":");
      const prefix = separator >= 0 ? expression.slice(0, separator + 1) : expression.startsWith("#") || expression.startsWith("/") ? expression[0] : "";
      const field = separator >= 0 ? expression.slice(separator + 1) : prefix ? expression.slice(1) : expression;
      return field === from ? `{{${prefix}${to}}}` : match;
    });
  }

  private async storeMediaFile(params: Record<string, unknown>): Promise<string | null> {
    const filename = safeFilename(params.filename);
    let body: Buffer;
    if (typeof params.data === "string" && params.data) {
      const data = params.data.replace(/\s+/g, "");
      if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error("media data is not valid base64");
      body = Buffer.from(data, "base64");
    } else if (typeof params.path === "string" && params.path) {
      const path = resolve(params.path);
      if ((await stat(path)).size > 25 * 1024 * 1024) throw new Error("media file exceeds the 25 MiB compatibility limit");
      body = await readFile(path);
    } else if (typeof params.url === "string" && params.url) {
      const url = new URL(params.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("media URL must use http or https");
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`media download failed with status ${response.status}`);
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > 25 * 1024 * 1024) throw new Error("media file exceeds the 25 MiB compatibility limit");
      if (!response.body) throw new Error("media download returned no body");
      const chunks: Buffer[] = [];
      let received = 0;
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk);
        received += buffer.byteLength;
        if (received > 25 * 1024 * 1024) throw new Error("media file exceeds the 25 MiB compatibility limit");
        chunks.push(buffer);
      }
      body = Buffer.concat(chunks, received);
    } else {
      throw new Error("storeMediaFile requires data, path, or url");
    }
    if (body.byteLength > 25 * 1024 * 1024) throw new Error("media file exceeds the 25 MiB compatibility limit");
    if (typeof params.skipHash === "string" && createHash("md5").update(body).digest("hex") === params.skipHash) return null;
    await mkdir(this.mediaDir, { recursive: true });
    const destination = join(this.mediaDir, filename);
    if (params.deleteExisting === false) {
      await writeFile(destination, body, { flag: "wx", mode: 0o600 });
    } else {
      const tempPath = join(this.mediaDir, `.${filename}.${process.pid}.${Date.now()}.tmp`);
      try {
        await writeFile(tempPath, body, { flag: "wx", mode: 0o600 });
        await rm(destination, { force: true });
        await rename(tempPath, destination);
      } finally {
        await rm(tempPath, { force: true });
      }
    }
    return filename;
  }

  private async retrieveMediaFile(params: Record<string, unknown>): Promise<string | false> {
    const filename = safeFilename(params.filename);
    const path = join(this.mediaDir, filename);
    try {
      const pathInfo = await lstat(path);
      if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) throw new Error("media path is not a regular file");
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!(await handle.stat()).isFile()) throw new Error("media path is not a regular file");
        return (await handle.readFile()).toString("base64");
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error("media path is not a regular file");
      throw error;
    }
  }

  private async getMediaFilesNames(params: Record<string, unknown>): Promise<string[]> {
    await mkdir(this.mediaDir, { recursive: true });
    const pattern = String(params.pattern ?? "*");
    return (await readdir(this.mediaDir)).filter((name) => wildcardMatch(pattern, name)).sort();
  }

  private async deleteMediaFile(params: Record<string, unknown>): Promise<null> {
    const filename = safeFilename(params.filename);
    await rm(join(this.mediaDir, filename), { force: true });
    return null;
  }
}
