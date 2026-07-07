import { z } from "zod";

export const PROTOCOL_VERSION = 1;
export const REMNOTE_CONNECT_VERSION = "0.3.2";
export const DAEMON_VERSION = REMNOTE_CONNECT_VERSION;
export const PLUGIN_VERSION = REMNOTE_CONNECT_VERSION;
export const BUILD_HASH = "public-v0.3.2";
export const DEFAULT_DAEMON_HOST = "127.0.0.1";
export const DEFAULT_DAEMON_PORT = 8766;
export const DEFAULT_DAEMON_URL = `http://${DEFAULT_DAEMON_HOST}:${DEFAULT_DAEMON_PORT}`;
export const DEFAULT_BRIDGE_URL = `ws://${DEFAULT_DAEMON_HOST}:${DEFAULT_DAEMON_PORT}/bridge`;
export const MANAGED_ROOT_NAME = "RemNoteConnect";
export const IRREVERSIBLE_RECONFIRM_PHRASE = "I understand irreversible RemNote operations cannot be undone";

export const ApiEnvelopeSchema = z.object({
  action: z.string().min(1),
  version: z.number().int().positive().optional().default(PROTOCOL_VERSION),
  params: z.record(z.string(), z.unknown()).optional().default({}),
});

export type ApiEnvelope = z.infer<typeof ApiEnvelopeSchema>;

export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden_origin"
  | "plugin_disconnected"
  | "plugin_reconnected"
  | "timeout"
  | "aborted"
  | "unsupported"
  | "not_implemented"
  | "not_found"
  | "confirm_required"
  | "dry_run_required"
  | "dry_run_mismatch"
  | "magnitude_guard"
  | "readonly_mode"
  | "irreversible_budget_exceeded"
  | "forbidden_target"
  | "backup_failed"
  | "plugin_error"
  | "internal_error";

export type ApiError = {
  code: ErrorCode;
  message: string;
  details?: unknown;
};

export type ApiResponse<T = unknown> =
  | { result: T; error: null }
  | { result: null; error: ApiError };

export const PluginJobSchema = z.object({
  type: z.literal("job"),
  jobId: z.string(),
  action: z.string(),
  params: z.record(z.string(), z.unknown()).optional().default({}),
});

export type PluginJob = z.infer<typeof PluginJobSchema>;

export const PluginHelloSchema = z.object({
  type: z.literal("hello"),
  token: z.string().min(16),
  pluginVersion: z.string().optional(),
  pluginBuildHash: z.string().optional(),
  transport: z.literal("websocket").default("websocket"),
  capabilities: z.record(z.string(), z.unknown()).optional(),
});

export type PluginHello = z.infer<typeof PluginHelloSchema>;

export const PluginResultSchema = z.object({
  type: z.literal("result"),
  jobId: z.string(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
    })
    .nullable()
    .optional(),
});

export type PluginResult = z.infer<typeof PluginResultSchema>;

export const PluginProgressSchema = z.object({
  type: z.literal("progress"),
  jobId: z.string(),
  completed: z.number().nonnegative(),
  total: z.number().nonnegative(),
  message: z.string().optional(),
});

export type PluginProgress = z.infer<typeof PluginProgressSchema>;

export type BridgeMessage = PluginHello | PluginJob | PluginResult | PluginProgress;

export type RichTextInput = string | unknown[];

export type RemSnapshotNode = {
  id: string;
  text: string;
  richText?: unknown;
  backText?: string;
  richBackText?: unknown;
  isFolder?: boolean;
  isDocument?: boolean;
  isCardItem?: boolean;
  practiceDirection?: "forward" | "backward" | "none" | "both";
  tags?: Array<{ id: string; text: string }>;
  cards?: Array<Record<string, unknown>>;
  children: RemSnapshotNode[];
};

export type RemSnapshot = {
  schemaVersion: 1;
  exportedAt: string;
  rootId: string;
  rootName: string;
  warning: string;
  nodeCount?: number;
  nodes: RemSnapshotNode[];
};

export type ActionHandler = "daemon" | "plugin" | "planned";

export type ActionMetadata = {
  name: string;
  summary: string;
  mutates: boolean;
  reversible: boolean;
  irreversible: boolean;
  bulk: boolean;
  retryable?: boolean;
  requiresDryRunHash: boolean;
  magnitudeGuarded: boolean;
  minimalReturn: string;
  cliName: string;
  handler: ActionHandler;
  implemented: boolean;
};

function action(meta: ActionMetadata): ActionMetadata {
  return meta;
}

export function retryableBridgeError(error: unknown): boolean {
  const code = (error as Partial<ApiError>)?.code;
  return code === "plugin_disconnected" || code === "plugin_reconnected" || code === "timeout";
}

export const actionMetadata = {
  version: action({
    name: "version",
    summary: "Return the RemNoteConnect protocol version.",
    mutates: false,
    reversible: true,
    irreversible: false,
    bulk: false,
    retryable: true,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "number",
    cliName: "version",
    handler: "daemon",
    implemented: true,
  }),
  status: action({
    name: "status",
    summary: "Return daemon and bridge connection status.",
    mutates: false,
    reversible: true,
    irreversible: false,
    bulk: false,
    retryable: true,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{bridge}",
    cliName: "status",
    handler: "daemon",
    implemented: true,
  }),
  capabilities: action({
    name: "capabilities",
    summary: "Return implemented and planned action groups.",
    mutates: false,
    reversible: true,
    irreversible: false,
    bulk: false,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{native,adapter,planned}",
    cliName: "capabilities",
    handler: "daemon",
    implemented: true,
  }),
  describe: action({
    name: "describe",
    summary: "Return action metadata for agent and CLI discovery.",
    mutates: false,
    reversible: true,
    irreversible: false,
    bulk: false,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{actions}",
    cliName: "describe",
    handler: "daemon",
    implemented: true,
  }),
  doctor: action({
    name: "doctor",
    summary: "Run daemon, bridge, and All-scope probes.",
    mutates: false,
    reversible: true,
    irreversible: false,
    bulk: false,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{ok,checks}",
    cliName: "doctor",
    handler: "daemon",
    implemented: true,
  }),
  metrics: action({
    name: "metrics",
    summary: "Return compact daemon runtime metrics.",
    mutates: false,
    reversible: true,
    irreversible: false,
    bulk: false,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{bridge,jobs}",
    cliName: "metrics",
    handler: "daemon",
    implemented: true,
  }),
  readonly: action({
    name: "readonly",
    summary: "Toggle or inspect daemon-enforced read-only mode. While enabled, every mutating action is rejected before plugin dispatch.",
    mutates: false,
    reversible: true,
    irreversible: false,
    bulk: false,
    retryable: true,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{readonlyMode}",
    cliName: "readonly",
    handler: "daemon",
    implemented: true,
  }),
  reconfirmIrreversibleBudget: action({
    name: "reconfirmIrreversibleBudget",
    summary: "Reset the irreversible operation session budget after explicit human re-confirmation.",
    mutates: false,
    reversible: true,
    irreversible: false,
    bulk: false,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{irreversibleRemaining}",
    cliName: "reconfirm-irreversible",
    handler: "daemon",
    implemented: true,
  }),
  rotateToken: action({
    name: "rotateToken",
    summary: "Rotate the local daemon token and persist it into connected plugin-local storage without returning the token.",
    mutates: true,
    reversible: false,
    irreversible: false,
    bulk: false,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{rotated}",
    cliName: "rotate-token",
    handler: "daemon",
    implemented: true,
  }),
  multi: action({
    name: "multi",
    summary: "Run multiple action envelopes and preserve response order.",
    mutates: false,
    reversible: true,
    irreversible: false,
    bulk: true,
    retryable: true,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "ApiResponse[]",
    cliName: "multi",
    handler: "daemon",
    implemented: true,
  }),
  jobStatus: action({
    name: "jobStatus",
    summary: "Return retained status for an in-flight or completed bridge job.",
    mutates: false,
    reversible: true,
    irreversible: false,
    bulk: false,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{status,progress}",
    cliName: "job-status",
    handler: "daemon",
    implemented: true,
  }),
  scopeProbe: action({
    name: "scopeProbe",
    summary: "Verify the plugin can enumerate the knowledge base through All scope.",
    mutates: false,
    reversible: true,
    irreversible: false,
    bulk: false,
    retryable: true,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{ok,totalRems,managedRootId}",
    cliName: "scope-probe",
    handler: "plugin",
    implemented: true,
  }),
  ankiMigrationProbes: action({
    name: "ankiMigrationProbes",
    summary: "Runtime probes for Anki migration fidelity: cloze, HTML, media, and deck-as-document.",
    mutates: true,
    reversible: true,
    irreversible: false,
    bulk: false,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{ok,probes}",
    cliName: "anki-migration-probes",
    handler: "plugin",
    implemented: true,
  }),
  capabilityProbes: action({
    name: "capabilityProbes",
    summary: "Runtime capability probes for SDK-supported card types, media, properties, portals, order, trash, and drift primitives.",
    mutates: true,
    reversible: true,
    irreversible: false,
    bulk: true,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{ok,capabilities}",
    cliName: "capability-probes",
    handler: "plugin",
    implemented: true,
  }),
  listRoots: action({
    name: "listRoots",
    summary: "Return the operational RemNoteConnect root.",
    mutates: false,
    reversible: true,
    irreversible: false,
    bulk: false,
    retryable: true,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{id}",
    cliName: "list-roots",
    handler: "plugin",
    implemented: true,
  }),
  createRem: action({
    name: "createRem",
    summary: "Create a Rem under a path.",
    mutates: true,
    reversible: true,
    irreversible: false,
    bulk: false,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{id}",
    cliName: "create-rem",
    handler: "plugin",
    implemented: true,
  }),
  createFolder: action({
    name: "createFolder",
    summary: "Create or find a folder/document path.",
    mutates: true,
    reversible: true,
    irreversible: false,
    bulk: false,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{id}",
    cliName: "create-folder",
    handler: "plugin",
    implemented: true,
  }),
  renameRem: action({
    name: "renameRem",
    summary: "Rename a Rem by id.",
    mutates: true,
    reversible: true,
    irreversible: false,
    bulk: false,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{id}",
    cliName: "rename",
    handler: "plugin",
    implemented: true,
  }),
  moveRem: action({
    name: "moveRem",
    summary: "Move Rem under a target path.",
    mutates: true,
    reversible: true,
    irreversible: false,
    bulk: true,
    requiresDryRunHash: false,
    magnitudeGuarded: true,
    minimalReturn: "{count,ids}",
    cliName: "move",
    handler: "plugin",
    implemented: true,
  }),
  deleteRem: action({
    name: "deleteRem",
    summary: "Soft-delete Rem by moving them to RemNoteConnect/Trash/<opId>.",
    mutates: true,
    reversible: true,
    irreversible: false,
    bulk: true,
    requiresDryRunHash: false,
    magnitudeGuarded: true,
    minimalReturn: "{opId,count,remIds}",
    cliName: "delete",
    handler: "plugin",
    implemented: true,
  }),
  deleteNotes: action({
    name: "deleteNotes",
    summary: "AnkiConnect-style alias for soft-delete.",
    mutates: true,
    reversible: true,
    irreversible: false,
    bulk: true,
    requiresDryRunHash: false,
    magnitudeGuarded: true,
    minimalReturn: "{opId,count,remIds}",
    cliName: "delete-notes",
    handler: "plugin",
    implemented: true,
  }),
  deleteFlashcards: action({
    name: "deleteFlashcards",
    summary: "Remove generated cards, not Rem.",
    mutates: true,
    reversible: false,
    irreversible: true,
    bulk: true,
    requiresDryRunHash: true,
    magnitudeGuarded: true,
    minimalReturn: "{count,cardIds}",
    cliName: "delete-flashcards",
    handler: "plugin",
    implemented: true,
  }),
  dryRunDelete: action({
    name: "dryRunDelete",
    summary: "Resolve delete targets without mutating.",
    mutates: false,
    reversible: true,
    irreversible: false,
    bulk: true,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{count,remIds,cardIds}",
    cliName: "dry-run-delete",
    handler: "plugin",
    implemented: true,
  }),
  emptyTrash: action({
    name: "emptyTrash",
    summary: "Hard-delete tombstoned Rem. This is irreversible and hash-gated.",
    mutates: true,
    reversible: false,
    irreversible: true,
    bulk: true,
    requiresDryRunHash: true,
    magnitudeGuarded: true,
    minimalReturn: "{count,remIds}",
    cliName: "empty-trash",
    handler: "plugin",
    implemented: true,
  }),
  undo: action({
    name: "undo",
    summary: "Replay a daemon-stored undo record through the plugin.",
    mutates: true,
    reversible: true,
    irreversible: false,
    bulk: true,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{opId,restored}",
    cliName: "undo",
    handler: "daemon",
    implemented: true,
  }),
  journalTail: action({
    name: "journalTail",
    summary: "Read recent content-free audit events.",
    mutates: false,
    reversible: true,
    irreversible: false,
    bulk: false,
    retryable: true,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "AuditEvent[]",
    cliName: "journal-tail",
    handler: "daemon",
    implemented: true,
  }),
  undoClear: action({
    name: "undoClear",
    summary: "Prune undo records after human review.",
    mutates: true,
    reversible: false,
    irreversible: true,
    bulk: true,
    requiresDryRunHash: false,
    magnitudeGuarded: true,
    minimalReturn: "{count}",
    cliName: "undo-clear",
    handler: "daemon",
    implemented: true,
  }),
  backupGraph: action({
    name: "backupGraph",
    summary: "Explicitly snapshot the accessible graph as copy-only disaster recovery.",
    mutates: false,
    reversible: true,
    irreversible: false,
    bulk: true,
    retryable: true,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{path,sha256,nodeCount,warning}",
    cliName: "backup-graph",
    handler: "daemon",
    implemented: true,
  }),
  map: action({
    name: "map",
    summary: "Return a token-cheap TSV outline of the graph or subtree.",
    mutates: false,
    reversible: true,
    irreversible: false,
    bulk: true,
    retryable: true,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "tsv",
    cliName: "map",
    handler: "plugin",
    implemented: true,
  }),
  getRem: action({
    name: "getRem",
    summary: "Return one Rem by id.",
    mutates: false,
    reversible: true,
    irreversible: false,
    bulk: false,
    retryable: true,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{id,text,parentId}",
    cliName: "get",
    handler: "plugin",
    implemented: true,
  }),
  searchGraph: action({
    name: "searchGraph",
    summary: "Search accessible Rem by v1 query grammar.",
    mutates: false,
    reversible: true,
    irreversible: false,
    bulk: true,
    retryable: true,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{count,ids}",
    cliName: "search",
    handler: "plugin",
    implemented: true,
  }),
  findByTag: action({
    name: "findByTag",
    summary: "Search accessible Rem by exact tag name.",
    mutates: false,
    reversible: true,
    irreversible: false,
    bulk: true,
    retryable: true,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{count,ids}",
    cliName: "find-by-tag",
    handler: "plugin",
    implemented: true,
  }),
  auditManagedRoot: action({
    name: "auditManagedRoot",
    summary: "Legacy audit of the RemNoteConnect operational root.",
    mutates: false,
    reversible: true,
    irreversible: false,
    bulk: true,
    retryable: true,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{root,remCount}",
    cliName: "audit-managed-root",
    handler: "plugin",
    implemented: true,
  }),
  createFlashcard: action({
    name: "createFlashcard",
    summary: "Create or update one flashcard.",
    mutates: true,
    reversible: true,
    irreversible: false,
    bulk: false,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{id}",
    cliName: "create-flashcard",
    handler: "plugin",
    implemented: true,
  }),
  createFlashcards: action({
    name: "createFlashcards",
    summary: "Create flashcards serially with progress.",
    mutates: true,
    reversible: true,
    irreversible: false,
    bulk: true,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{count,ids}",
    cliName: "create-flashcards",
    handler: "plugin",
    implemented: true,
  }),
  updateFlashcard: action({
    name: "updateFlashcard",
    summary: "Update flashcard text, tags, or practice direction.",
    mutates: true,
    reversible: true,
    irreversible: false,
    bulk: false,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{id}",
    cliName: "update-flashcard",
    handler: "plugin",
    implemented: true,
  }),
  getFlashcard: action({
    name: "getFlashcard",
    summary: "Read a flashcard Rem by id.",
    mutates: false,
    reversible: true,
    irreversible: false,
    bulk: false,
    retryable: true,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{id,text}",
    cliName: "get-flashcard",
    handler: "plugin",
    implemented: true,
  }),
  searchFlashcards: action({
    name: "searchFlashcards",
    summary: "Search accessible flashcard Rem.",
    mutates: false,
    reversible: true,
    irreversible: false,
    bulk: true,
    retryable: true,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{count,ids}",
    cliName: "search-flashcards",
    handler: "plugin",
    implemented: true,
  }),
  searchRem: action({
    name: "searchRem",
    summary: "Legacy alias for searchGraph with summaries.",
    mutates: false,
    reversible: true,
    irreversible: false,
    bulk: true,
    retryable: true,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{count,ids}",
    cliName: "search-rem",
    handler: "plugin",
    implemented: true,
  }),
  exportSubtree: action({
    name: "exportSubtree",
    summary: "Export copy-only snapshot of target Rem subtree.",
    mutates: false,
    reversible: true,
    irreversible: false,
    bulk: true,
    retryable: true,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "snapshot",
    cliName: "export-subtree",
    handler: "plugin",
    implemented: true,
  }),
  backupSubtree: action({
    name: "backupSubtree",
    summary: "Legacy alias for exportSubtree.",
    mutates: false,
    reversible: true,
    irreversible: false,
    bulk: true,
    retryable: true,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "snapshot",
    cliName: "backup-subtree",
    handler: "plugin",
    implemented: true,
  }),
  validateSnapshot: action({
    name: "validateSnapshot",
    summary: "Validate a copy-only Rem snapshot.",
    mutates: false,
    reversible: true,
    irreversible: false,
    bulk: false,
    retryable: true,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{valid,nodeCount,warning}",
    cliName: "validate-snapshot",
    handler: "plugin",
    implemented: true,
  }),
  importSnapshot: action({
    name: "importSnapshot",
    summary: "Restore snapshot as copies with new ids.",
    mutates: true,
    reversible: true,
    irreversible: false,
    bulk: true,
    requiresDryRunHash: false,
    magnitudeGuarded: true,
    minimalReturn: "{count,remIds,warning}",
    cliName: "import-snapshot",
    handler: "plugin",
    implemented: true,
  }),
  restoreBackup: action({
    name: "restoreBackup",
    summary: "Read a daemon backup and import it as copies.",
    mutates: true,
    reversible: true,
    irreversible: false,
    bulk: true,
    requiresDryRunHash: false,
    magnitudeGuarded: true,
    minimalReturn: "{count,remIds,warning}",
    cliName: "restore-backup",
    handler: "daemon",
    implemented: true,
  }),
  answerCard: action({
    name: "answerCard",
    summary: "Append a scheduler repetition score to one card.",
    mutates: true,
    reversible: false,
    irreversible: true,
    bulk: false,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{id}",
    cliName: "answer-card",
    handler: "plugin",
    implemented: true,
  }),
  addNote: action({
    name: "addNote",
    summary: "AnkiConnect-inspired flashcard creation.",
    mutates: true,
    reversible: true,
    irreversible: false,
    bulk: false,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{id}",
    cliName: "add-note",
    handler: "plugin",
    implemented: true,
  }),
  addNotes: action({
    name: "addNotes",
    summary: "AnkiConnect-inspired bulk flashcard creation.",
    mutates: true,
    reversible: true,
    irreversible: false,
    bulk: true,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{count,ids}",
    cliName: "add-notes",
    handler: "plugin",
    implemented: true,
  }),
  canAddNote: action({
    name: "canAddNote",
    summary: "Validate an AnkiConnect-style note shape.",
    mutates: false,
    reversible: true,
    irreversible: false,
    bulk: false,
    retryable: true,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "boolean",
    cliName: "can-add-note",
    handler: "plugin",
    implemented: true,
  }),
  findNotes: action({
    name: "findNotes",
    summary: "Return Rem ids matching the v1 query grammar.",
    mutates: false,
    reversible: true,
    irreversible: false,
    bulk: true,
    retryable: true,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "string[]",
    cliName: "find-notes",
    handler: "plugin",
    implemented: true,
  }),
  notesInfo: action({
    name: "notesInfo",
    summary: "Return summaries for Rem ids.",
    mutates: false,
    reversible: true,
    irreversible: false,
    bulk: true,
    retryable: true,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "RemSummary[]",
    cliName: "notes-info",
    handler: "plugin",
    implemented: true,
  }),
  deckNames: action({
    name: "deckNames",
    summary: "Return folder/document paths.",
    mutates: false,
    reversible: true,
    irreversible: false,
    bulk: true,
    retryable: true,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "string[]",
    cliName: "deck-names",
    handler: "plugin",
    implemented: true,
  }),
  createDeck: action({
    name: "createDeck",
    summary: "AnkiConnect-inspired alias for createFolder.",
    mutates: true,
    reversible: true,
    irreversible: false,
    bulk: false,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{id}",
    cliName: "create-deck",
    handler: "plugin",
    implemented: true,
  }),
  changeDeck: action({
    name: "changeDeck",
    summary: "AnkiConnect-inspired alias for moveRem.",
    mutates: true,
    reversible: true,
    irreversible: false,
    bulk: true,
    requiresDryRunHash: false,
    magnitudeGuarded: true,
    minimalReturn: "{count,ids}",
    cliName: "change-deck",
    handler: "plugin",
    implemented: true,
  }),
  createDocument: action({
    name: "createDocument",
    summary: "Create a document tree from Markdown or structured docSpec.",
    mutates: true,
    reversible: true,
    irreversible: false,
    bulk: true,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{id,childCount}",
    cliName: "create-document",
    handler: "plugin",
    implemented: true,
  }),
  getDocument: action({
    name: "getDocument",
    summary: "Read a document as markdown or tree.",
    mutates: false,
    reversible: true,
    irreversible: false,
    bulk: true,
    retryable: true,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "markdown",
    cliName: "get-document",
    handler: "plugin",
    implemented: true,
  }),
  appendToDocument: action({
    name: "appendToDocument",
    summary: "Append Markdown or structured docSpec under an existing document Rem.",
    mutates: true,
    reversible: true,
    irreversible: false,
    bulk: true,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{count,remIds}",
    cliName: "append-document",
    handler: "plugin",
    implemented: true,
  }),
  setProperty: action({
    name: "setProperty",
    summary: "Set a RemNote powerup or tag property on a Rem.",
    mutates: true,
    reversible: true,
    irreversible: false,
    bulk: false,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{id}",
    cliName: "set-property",
    handler: "plugin",
    implemented: true,
  }),
  getProperties: action({
    name: "getProperties",
    summary: "Read RemNote powerup or tag properties from a Rem.",
    mutates: false,
    reversible: true,
    irreversible: false,
    bulk: false,
    retryable: true,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{properties}",
    cliName: "get-properties",
    handler: "plugin",
    implemented: true,
  }),
  updateDocument: action({
    name: "updateDocument",
    summary: "Planned full in-place Markdown document replacement.",
    mutates: true,
    reversible: true,
    irreversible: false,
    bulk: true,
    requiresDryRunHash: false,
    magnitudeGuarded: true,
    minimalReturn: "{id}",
    cliName: "update-document",
    handler: "planned",
    implemented: false,
  }),
  listTombstones: action({
    name: "listTombstones",
    summary: "List tombstoned operation folders.",
    mutates: false,
    reversible: true,
    irreversible: false,
    bulk: true,
    retryable: true,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{count,tombstones}",
    cliName: "list-tombstones",
    handler: "plugin",
    implemented: true,
  }),
  restoreTombstone: action({
    name: "restoreTombstone",
    summary: "Restore a tombstoned Rem using undo metadata where possible.",
    mutates: true,
    reversible: true,
    irreversible: false,
    bulk: true,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{count,remIds}",
    cliName: "restore-tombstone",
    handler: "plugin",
    implemented: true,
  }),
  bulkDelete: action({
    name: "bulkDelete",
    summary: "Query-driven soft delete, dry-run by default.",
    mutates: true,
    reversible: true,
    irreversible: false,
    bulk: true,
    requiresDryRunHash: false,
    magnitudeGuarded: true,
    minimalReturn: "{opId,count,remIds}",
    cliName: "bulk-delete",
    handler: "plugin",
    implemented: true,
  }),
  findDuplicates: action({
    name: "findDuplicates",
    summary: "Find duplicate Rem by normalized text.",
    mutates: false,
    reversible: true,
    irreversible: false,
    bulk: true,
    retryable: true,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{groups}",
    cliName: "find-duplicates",
    handler: "plugin",
    implemented: true,
  }),
  mergeRems: action({
    name: "mergeRems",
    summary: "Merge duplicates. Default is reversible tombstone; structural mode is dry-run-hash gated.",
    mutates: true,
    reversible: true,
    irreversible: false,
    bulk: true,
    requiresDryRunHash: false,
    magnitudeGuarded: true,
    minimalReturn: "{opId,count}",
    cliName: "merge",
    handler: "plugin",
    implemented: true,
  }),
  findOrphans: action({
    name: "findOrphans",
    summary: "Find accessible Rem with missing parents.",
    mutates: false,
    reversible: true,
    irreversible: false,
    bulk: true,
    retryable: true,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{count,ids}",
    cliName: "find-orphans",
    handler: "plugin",
    implemented: true,
  }),
  findEmpty: action({
    name: "findEmpty",
    summary: "Find accessible empty Rem.",
    mutates: false,
    reversible: true,
    irreversible: false,
    bulk: true,
    retryable: true,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{count,ids}",
    cliName: "find-empty",
    handler: "plugin",
    implemented: true,
  }),
  normalizeText: action({
    name: "normalizeText",
    summary: "Normalize whitespace in matching Rem text.",
    mutates: true,
    reversible: true,
    irreversible: false,
    bulk: true,
    requiresDryRunHash: false,
    magnitudeGuarded: true,
    minimalReturn: "{opId,count}",
    cliName: "normalize-text",
    handler: "plugin",
    implemented: true,
  }),
  rewriteNativeLinks: action({
    name: "rewriteNativeLinks",
    summary: "Rewrite verified source-child raw links into native Rem references. Dry-run and count guarded.",
    mutates: true,
    reversible: true,
    irreversible: false,
    bulk: true,
    requiresDryRunHash: false,
    magnitudeGuarded: true,
    minimalReturn: "{opId,count,remIds}",
    cliName: "rewrite-native-links",
    handler: "plugin",
    implemented: true,
  }),
  bulkRetag: action({
    name: "bulkRetag",
    summary: "Query-driven tag add/remove.",
    mutates: true,
    reversible: true,
    irreversible: false,
    bulk: true,
    requiresDryRunHash: false,
    magnitudeGuarded: true,
    minimalReturn: "{opId,count}",
    cliName: "bulk-retag",
    handler: "plugin",
    implemented: true,
  }),
  bulkMove: action({
    name: "bulkMove",
    summary: "Query-driven move.",
    mutates: true,
    reversible: true,
    irreversible: false,
    bulk: true,
    requiresDryRunHash: false,
    magnitudeGuarded: true,
    minimalReturn: "{opId,count}",
    cliName: "bulk-move",
    handler: "plugin",
    implemented: true,
  }),
  createFlashcardsAsync: action({
    name: "createFlashcardsAsync",
    summary: "Enqueue a durable JSONL-backed flashcard import.",
    mutates: true,
    reversible: true,
    irreversible: false,
    bulk: true,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{jobId}",
    cliName: "create-flashcards-async",
    handler: "daemon",
    implemented: true,
  }),
  importAsync: action({
    name: "importAsync",
    summary: "Enqueue a durable JSONL-backed document or flashcard import.",
    mutates: true,
    reversible: true,
    irreversible: false,
    bulk: true,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{jobId}",
    cliName: "import-async",
    handler: "daemon",
    implemented: true,
  }),
  jobWait: action({
    name: "jobWait",
    summary: "Wait for a durable job to complete or error.",
    mutates: false,
    reversible: true,
    irreversible: false,
    bulk: false,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{status}",
    cliName: "job-wait",
    handler: "daemon",
    implemented: true,
  }),
  confirmMaterialized: action({
    name: "confirmMaterialized",
    summary: "Return ids created by a durable job or batch id.",
    mutates: false,
    reversible: true,
    irreversible: false,
    bulk: true,
    requiresDryRunHash: false,
    magnitudeGuarded: false,
    minimalReturn: "{count,cardIds}",
    cliName: "confirm-materialized",
    handler: "daemon",
    implemented: true,
  }),
} as const satisfies Record<string, ActionMetadata>;

export type CreateFlashcardParams = {
  front: RichTextInput;
  back: RichTextInput;
  deckPath?: string;
  tags?: string[];
  externalId?: string;
  batchId?: string;
  plainDeckPath?: boolean;
  replaceChildrenOnUpdate?: boolean;
  practiceDirection?: "forward" | "backward" | "none" | "both";
};

export type CreateFolderParams = {
  path: string;
  asDocument?: boolean;
};

export type QueryTerm =
  | { type: "deck"; value: string }
  | { type: "tag"; value: string }
  | { type: "text"; value: string }
  | { type: "id"; value: string };

export function ok<T>(result: T): ApiResponse<T> {
  return { result, error: null };
}

export function fail(code: ErrorCode, message: string, details?: unknown): ApiResponse<never> {
  return { result: null, error: { code, message, details } };
}

export function parseQuery(query: string | undefined): QueryTerm[] {
  if (!query?.trim()) return [];
  const terms: QueryTerm[] = [];
  const matcher = /(\w+):(?:"([^"]+)"|(\S+))/g;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(query))) {
    const key = match[1];
    const value = match[2] ?? match[3] ?? "";
    if (key === "deck" || key === "tag" || key === "text" || key === "id") {
      terms.push({ type: key, value });
    }
  }
  if (terms.length === 0 && query.trim()) {
    terms.push({ type: "text", value: query.trim() });
  }
  return terms;
}

export function normalizePath(path: string): string[] {
  return path
    .split("::")
    .flatMap((part) => part.split("/"))
    .map((part) => part.trim())
    .filter(Boolean);
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export const nativeActions = [
  "version",
  "status",
  "capabilities",
  "describe",
  "doctor",
  "metrics",
  "readonly",
  "reconfirmIrreversibleBudget",
  "rotateToken",
  "multi",
  "jobStatus",
  "scopeProbe",
  "capabilityProbes",
  "listRoots",
  "createRem",
  "createFolder",
  "renameRem",
  "moveRem",
  "deleteRem",
  "emptyTrash",
  "undo",
  "journalTail",
  "undoClear",
  "backupGraph",
  "map",
  "getRem",
  "searchGraph",
  "exportSubtree",
  "importSnapshot",
  "createFlashcard",
  "createFlashcards",
  "updateFlashcard",
  "deleteFlashcards",
  "getFlashcard",
  "searchFlashcards",
  "searchRem",
  "findByTag",
  "auditManagedRoot",
  "dryRunDelete",
  "backupSubtree",
  "validateSnapshot",
  "restoreBackup",
  "answerCard",
  "createDocument",
  "getDocument",
  "appendToDocument",
  "setProperty",
  "getProperties",
  "listTombstones",
  "restoreTombstone",
  "bulkDelete",
  "findDuplicates",
  "mergeRems",
  "findOrphans",
  "findEmpty",
  "normalizeText",
  "rewriteNativeLinks",
  "bulkRetag",
  "bulkMove",
  "createFlashcardsAsync",
  "importAsync",
  "jobWait",
  "confirmMaterialized",
] as const;

export const adapterActions = [
  "addNote",
  "addNotes",
  "canAddNote",
  "findNotes",
  "notesInfo",
  "deleteNotes",
  "deckNames",
  "createDeck",
  "changeDeck",
] as const;

export const unsupportedAnkiActions = [
  "modelNames",
  "modelNamesAndIds",
  "modelFieldNames",
  "modelFieldsOnTemplates",
  "modelTemplates",
  "createModel",
  "exportPackage",
  "importPackage",
  "insertReviews",
  "setDueDate",
  "getReviewsOfCards",
] as const;

export const plannedActions = Object.values(actionMetadata)
  .filter((meta) => !meta.implemented)
  .map((meta) => meta.name);

export const pluginActions = Object.values(actionMetadata)
  .filter((meta) => meta.implemented && meta.handler === "plugin")
  .map((meta) => meta.name);

export function getActionMetadata(actionName: string): ActionMetadata | undefined {
  return actionMetadata[actionName as keyof typeof actionMetadata];
}

export function isPluginAction(action: string): boolean {
  return pluginActions.includes(action);
}
