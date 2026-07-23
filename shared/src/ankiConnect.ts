import { z } from "zod";

export const ANKI_CONNECT_API_VERSION = 6;
export const ANKI_CONNECT_SOURCE_COMMIT = "de6e6e1b8aaf4ae195eb1d1ff6db5409b99b2a3e";
export const ANKI_CONNECT_ACTION_SET_SHA256 =
  "1f065a1b9f8d53c09f00a7ce743dce8" + "9c923e5d28bba6ceab1cd1967c04cf8a5";
export const DEFAULT_ANKI_CONNECT_HOST = "127.0.0.1";
export const DEFAULT_ANKI_CONNECT_PORT = 8765;

export const AnkiConnectRequestSchema = z.looseObject({
  action: z.string().min(1),
  version: z.number().int().optional().default(4),
  params: z.record(z.string(), z.unknown()).optional().default({}),
  key: z.string().optional(),
});

export type AnkiConnectRequest = z.infer<typeof AnkiConnectRequestSchema>;

export type AnkiConnectResponse<T = unknown> =
  | { result: T; error: null }
  | { result: null; error: string };

export type AnkiActionFamily =
  | "core"
  | "statistics"
  | "decks"
  | "media"
  | "notes"
  | "cards"
  | "models"
  | "reviews"
  | "gui"
  | "packages";

export type AnkiActionStatus = "native" | "translated" | "sidecar" | "blocked";

export type AnkiActionMetadata = {
  name: string;
  family: AnkiActionFamily;
  mutates: boolean;
  status: AnkiActionStatus;
  summary: string;
  limitation?: string;
};

const ACTIONS_BY_FAMILY = {
  core: [
    "version",
    "requestPermission",
    "getProfiles",
    "getActiveProfile",
    "loadProfile",
    "sync",
    "multi",
    "reloadCollection",
    "apiReflect",
  ],
  statistics: ["getNumCardsReviewedToday", "getNumCardsReviewedByDay", "getCollectionStatsHTML"],
  decks: [
    "deckNames",
    "deckNamesAndIds",
    "getDecks",
    "createDeck",
    "changeDeck",
    "deleteDecks",
    "getDeckConfig",
    "saveDeckConfig",
    "setDeckConfigId",
    "cloneDeckConfigId",
    "removeDeckConfigId",
    "getDeckStats",
    "deckNameFromId",
  ],
  media: ["storeMediaFile", "retrieveMediaFile", "getMediaFilesNames", "deleteMediaFile", "getMediaDirPath"],
  notes: [
    "addNote",
    "canAddNote",
    "canAddNoteWithErrorDetail",
    "updateNoteFields",
    "updateNote",
    "updateNoteModel",
    "updateNoteTags",
    "getNoteTags",
    "addTags",
    "removeTags",
    "getTags",
    "clearUnusedTags",
    "replaceTags",
    "replaceTagsInAllNotes",
    "findNotes",
    "notesInfo",
    "notesModTime",
    "deleteNotes",
    "removeEmptyNotes",
    "addNotes",
    "canAddNotes",
    "canAddNotesWithErrorDetail",
  ],
  cards: [
    "setEaseFactors",
    "setSpecificValueOfCard",
    "getEaseFactors",
    "suspend",
    "unsuspend",
    "suspended",
    "areSuspended",
    "areDue",
    "getIntervals",
    "findCards",
    "cardsInfo",
    "cardsModTime",
    "forgetCards",
    "relearnCards",
    "answerCards",
    "setDueDate",
    "cardsToNotes",
  ],
  models: [
    "modelNames",
    "createModel",
    "modelNamesAndIds",
    "findModelsById",
    "findModelsByName",
    "modelNameFromId",
    "modelFieldNames",
    "modelFieldDescriptions",
    "modelFieldFonts",
    "modelFieldsOnTemplates",
    "modelTemplates",
    "modelStyling",
    "updateModelTemplates",
    "updateModelStyling",
    "findAndReplaceInModels",
    "modelTemplateRename",
    "modelTemplateReposition",
    "modelTemplateAdd",
    "modelTemplateRemove",
    "modelFieldRename",
    "modelFieldReposition",
    "modelFieldAdd",
    "modelFieldRemove",
    "modelFieldSetFont",
    "modelFieldSetFontSize",
    "modelFieldSetDescription",
  ],
  reviews: ["cardReviews", "getReviewsOfCards", "getLatestReviewID", "insertReviews"],
  gui: [
    "guiBrowse",
    "guiEditNote",
    "guiSelectNote",
    "guiSelectCard",
    "guiSelectedNotes",
    "guiAddNoteSetData",
    "guiAddCards",
    "guiReviewActive",
    "guiCurrentCard",
    "guiStartCardTimer",
    "guiShowQuestion",
    "guiShowAnswer",
    "guiAnswerCard",
    "guiPlayAudio",
    "guiUndo",
    "guiDeckOverview",
    "guiDeckBrowser",
    "guiDeckReview",
    "guiImportFile",
    "guiExitAnki",
    "guiCheckDatabase",
  ],
  packages: ["exportPackage", "importPackage"],
} as const satisfies Record<AnkiActionFamily, readonly string[]>;

const MUTATING_ACTIONS = new Set([
  "loadProfile",
  "createDeck",
  "changeDeck",
  "deleteDecks",
  "saveDeckConfig",
  "setDeckConfigId",
  "cloneDeckConfigId",
  "removeDeckConfigId",
  "storeMediaFile",
  "deleteMediaFile",
  "addNote",
  "updateNoteFields",
  "updateNote",
  "updateNoteModel",
  "updateNoteTags",
  "addTags",
  "removeTags",
  "clearUnusedTags",
  "replaceTags",
  "replaceTagsInAllNotes",
  "deleteNotes",
  "removeEmptyNotes",
  "addNotes",
  "setEaseFactors",
  "setSpecificValueOfCard",
  "suspend",
  "unsuspend",
  "forgetCards",
  "relearnCards",
  "answerCards",
  "setDueDate",
  "createModel",
  "updateModelTemplates",
  "updateModelStyling",
  "findAndReplaceInModels",
  "modelTemplateRename",
  "modelTemplateReposition",
  "modelTemplateAdd",
  "modelTemplateRemove",
  "modelFieldRename",
  "modelFieldReposition",
  "modelFieldAdd",
  "modelFieldRemove",
  "modelFieldSetFont",
  "modelFieldSetFontSize",
  "modelFieldSetDescription",
  "insertReviews",
  "guiEditNote",
  "guiAddNoteSetData",
  "guiAddCards",
  "guiAnswerCard",
  "guiUndo",
  "guiImportFile",
  "guiExitAnki",
  "guiCheckDatabase",
  "exportPackage",
  "importPackage",
]);

const NATIVE_ACTIONS = new Set(["version", "multi", "apiReflect"]);

const TRANSLATED_ACTIONS = new Set([
  "requestPermission",
  "getProfiles",
  "getActiveProfile",
  "loadProfile",
  "deckNames",
  "deckNamesAndIds",
  "getDecks",
  "createDeck",
  "changeDeck",
  "deckNameFromId",
  "addNote",
  "canAddNote",
  "canAddNoteWithErrorDetail",
  "updateNoteFields",
  "updateNote",
  "updateNoteTags",
  "getNoteTags",
  "addTags",
  "removeTags",
  "getTags",
  "replaceTags",
  "replaceTagsInAllNotes",
  "findNotes",
  "notesInfo",
  "notesModTime",
  "deleteNotes",
  "addNotes",
  "canAddNotes",
  "canAddNotesWithErrorDetail",
  "findCards",
  "cardsToNotes",
]);

const SIDECAR_ACTIONS = new Set([
  "getDeckConfig",
  "saveDeckConfig",
  "setDeckConfigId",
  "cloneDeckConfigId",
  "removeDeckConfigId",
  ...ACTIONS_BY_FAMILY.media,
  "updateNoteModel",
  ...ACTIONS_BY_FAMILY.models,
]);

function statusFor(name: string): AnkiActionStatus {
  if (NATIVE_ACTIONS.has(name)) return "native";
  if (TRANSLATED_ACTIONS.has(name)) return "translated";
  if (SIDECAR_ACTIONS.has(name)) return "sidecar";
  return "blocked";
}

function limitationFor(name: string, family: AnkiActionFamily, status: AnkiActionStatus): string | undefined {
  if (status === "sidecar" && family === "models") {
    return "Model metadata round-trips for compatibility but does not replace RemNote's native card renderer.";
  }
  if (status === "sidecar" && family === "decks") {
    return "Deck configuration metadata round-trips but does not alter RemNote's native scheduler.";
  }
  if (status === "sidecar" && name === "updateNoteModel") {
    return "The compatibility model and fields are retained, while RemNote continues to render its native card type.";
  }
  if (["canAddNote", "canAddNoteWithErrorDetail", "canAddNotes", "canAddNotesWithErrorDetail"].includes(name)) {
    return "Validation covers required content; Anki's collection-specific duplicate rules have no exact RemNote equivalent.";
  }
  if (name === "deleteNotes") {
    return "Deleted notes are hidden through tombstoned IDs while RemNoteConnect retains the underlying Rem for reversible recovery.";
  }
  if (status !== "blocked") return undefined;
  if (family === "gui") return "RemNote does not expose Anki desktop GUI controls through the plugin SDK.";
  if (family === "packages") return "APKG import/export is unavailable without an independent compatible package implementation.";
  if (family === "statistics" || family === "reviews") return "RemNote does not expose equivalent collection review-log statistics through the plugin SDK.";
  if (family === "cards" || family === "decks") return "RemNote does not expose equivalent Anki scheduler state through the plugin SDK.";
  return "The current RemNote plugin SDK has no faithful equivalent for this action.";
}

export const ankiConnectActionManifest: readonly AnkiActionMetadata[] = Object.entries(ACTIONS_BY_FAMILY).flatMap(
  ([family, names]) =>
    names.map((name) => {
      const status = statusFor(name);
      return {
        name,
        family: family as AnkiActionFamily,
        mutates: MUTATING_ACTIONS.has(name),
        status,
        summary: `${name} compatibility behavior backed by RemNoteConnect.`,
        limitation: limitationFor(name, family as AnkiActionFamily, status),
      };
    }),
);

export const ankiConnectActionNames = ankiConnectActionManifest.map((action) => action.name);
export const ankiConnectActionsByName = new Map(ankiConnectActionManifest.map((action) => [action.name, action]));

export function formatAnkiConnectSuccess<T>(version: number, result: T): T | AnkiConnectResponse<T> {
  return version <= 4 ? result : { result, error: null };
}

export function formatAnkiConnectError(message: string): AnkiConnectResponse<never> {
  return { result: null, error: message };
}
