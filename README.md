# RemNoteConnect

Private local Mac bridge for controlling RemNote from terminal tools through an AnkiConnect-inspired JSON API.

## What It Does

- Runs a local daemon on `127.0.0.1:8766`.
- Loads a RemNote frontend plugin from `http://127.0.0.1:8080`.
- The plugin executes RemNote SDK reads/writes with whole-KB permission after RemNote approval.
- HTTP callers use `{ "action": "...", "version": 1, "params": { ... } }`.
- Destructive and bulk operations are dry-run-first. Soft delete moves Rem to `RemNoteConnect/Trash/<opId>` and writes a local undo record.
- `readonly` mode lets an LLM inspect/search/map the graph while daemon-side guards reject every mutating action.
- The plugin iframe shows bridge health, token presence, All-scope status, active jobs, heartbeat, and daemon/plugin build match.

This is workflow parity with AnkiConnect, not literal Anki compatibility. Anki-only model/template/package APIs return stable `unsupported` errors.

## Setup

1. Create a top-level Rem in RemNote named exactly:

   `RemNoteConnect`

2. Install and build:

   ```sh
   cd /Users/HQ/Documents/Codex/RemNoteConnect
   npx pnpm@11.7.0 install
   npx pnpm@11.7.0 build
   ```

3. Start the daemon:

   ```sh
   npx pnpm@11.7.0 --filter @remnoteconnect/daemon start
   ```

   The daemon also serves the built plugin bundle at `http://127.0.0.1:8080`.

4. Print the token:

   ```sh
   npx pnpm@11.7.0 token:unsafe
   ```

5. In RemNote desktop, load the local plugin from:

   `http://127.0.0.1:8080`

   Use `npx pnpm@11.7.0 dev:plugin` only when actively developing the plugin.

6. Open the RemNoteConnect plugin settings and paste the daemon token.

7. Run a smoke test:

   ```sh
   npx pnpm@11.7.0 smoke
   ```

8. Run the whole-KB scope check:

   ```sh
   node scripts/rnc.mjs doctor
   ```

## Example Calls

```sh
TOKEN="$(npx pnpm@11.7.0 --silent token:unsafe)"
curl -sS http://127.0.0.1:8766 \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"status","version":1}'
```

CLI-first usage:

```sh
node scripts/rnc.mjs describe
node scripts/rnc.mjs readonly on
node scripts/rnc.mjs map --depth 3
node scripts/rnc.mjs search 'text:mitochondria'
node scripts/rnc.mjs readonly off
node scripts/rnc.mjs create-document --doc-spec ./doc.json --parent Inbox --confirm
```

Create a flashcard:

```sh
curl -sS http://127.0.0.1:8766 \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "action":"createFlashcard",
    "version":1,
    "params":{
      "deckPath":"Behavior Change",
      "front":"What is an implementation intention?",
      "back":"A plan that links a situational cue to a specific response.",
      "tags":["behavior-change"]
    }
  }'
```

AnkiConnect-inspired addNote:

```sh
curl -sS http://127.0.0.1:8766 \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "action":"addNote",
    "version":1,
    "params":{
      "note":{
        "deckName":"Behavior Change",
        "fields":{"Front":"Cue?","Back":"Response."},
        "tags":["example"]
      }
    }
  }'
```

## API v1

Native actions:

- `version`, `status`, `capabilities`, `multi`, `jobStatus`
- `jobWait`, `confirmMaterialized`
- `describe`, `doctor`, `metrics`, `readonly`, `scopeProbe`
- `listRoots`, `createRem`, `createFolder`, `renameRem`, `moveRem`, `deleteRem`
- `map`, `getRem`, `searchGraph`, `backupGraph`, `journalTail`, `undo`, `undoClear`, `emptyTrash`
- `exportSubtree`, `importSnapshot`, `backupSubtree`, `validateSnapshot`
- `createFlashcard`, `createFlashcards`, `updateFlashcard`, `deleteFlashcards`, `getFlashcard`, `searchFlashcards`
- `searchRem`, `findByTag`, `auditManagedRoot`, `dryRunDelete`
- `createDocument`, `getDocument`, `appendToDocument`, `setProperty`, `getProperties`
- `listTombstones`, `restoreTombstone`, `bulkDelete`
- `findDuplicates`, `mergeRems`, `findOrphans`, `findEmpty`, `normalizeText`, `bulkRetag`, `bulkMove`
- `createFlashcardsAsync`, `importAsync`

AnkiConnect-inspired actions:

- `addNote`, `addNotes`, `canAddNote`
- `findNotes`, `notesInfo`, `deleteNotes`
- `deckNames`, `createDeck`, `changeDeck`

Query grammar:

- `deck:<path>`
- `tag:<tag>`
- `text:<text>`
- `id:<remId>`

Structured document specs use compact rich text and nested children:

```json
{
  "richText": {
    "segments": [
      { "type": "text", "text": "Concept ", "formats": ["bold"] },
      { "type": "latex", "text": "x^2" }
    ]
  },
  "properties": [{ "powerupCode": "b", "slot": "URL", "value": "https://example.com" }],
  "children": [{ "text": "Child Rem" }]
}
```

## Safety Model

- The daemon binds only to `127.0.0.1`.
- HTTP calls require a bearer token.
- WebSocket plugin auth uses a first-message token handshake.
- Host and Origin are validated.
- The plugin requests `All / ReadCreateModifyDelete`; `doctor` verifies the grant with `scopeProbe`.
- Soft delete is reversible by stable ID through the daemon undo store.
- `emptyTrash` is the only hard-delete path. It requires a prior dry-run hash.
- `backupGraph` is explicit and opt-in.
- Snapshot restore recreates Rem as copies with new IDs. It does not preserve inbound references, portals, or scheduling history.
- `readonly on` blocks every `mutates:true` action in the daemon before plugin dispatch.
- `doctor` warns if the connected plugin build hash does not match the daemon build hash.

## Daily Driver

After `npx pnpm@11.7.0 build`, generate a LaunchAgent:

```sh
npx pnpm@11.7.0 launch-agent:install
```

Then load the printed plist with the printed `launchctl bootstrap ...` command.

Check or remove it with:

```sh
npx pnpm@11.7.0 launch-agent:check
npx pnpm@11.7.0 launch-agent:uninstall
```

The normal daily-driver daemon serves the built RemNote plugin at `http://127.0.0.1:8080`; Vite is only needed for plugin development.

## Verification

Static gates:

```sh
npx pnpm@11.7.0 -r typecheck
npx pnpm@11.7.0 --filter @remnoteconnect/plugin test
npx pnpm@11.7.0 --filter @remnoteconnect/daemon test
npx pnpm@11.7.0 -r build
npx pnpm@11.7.0 check:no-token
npx pnpm@11.7.0 check:redteam
```

In non-interactive shells, if pnpm asks to purge `node_modules`, restore/verify dependencies explicitly:

```sh
CI=true npx pnpm@11.7.0 --config.confirmModulesPurge=false install --frozen-lockfile --prod=false
```

After RemNote has loaded `http://127.0.0.1:8080` and `node scripts/rnc.mjs doctor` is green:

```sh
node scripts/live-security.mjs
node scripts/live-readonly.mjs
node scripts/live-scope.mjs
node scripts/live-softdelete.mjs
node scripts/live-docs.mjs
node scripts/live-cleanup.mjs
node scripts/live-idempotent.mjs
npx pnpm@11.7.0 chaos:daemon
npx pnpm@11.7.0 chaos:async
```

## Recovery

- Stop daemon: `Ctrl-C` or unload the LaunchAgent.
- Token file: `~/Library/Application Support/RemNoteConnect/token`
- Backups: `~/Documents/RemNoteConnect/Backups`
- If a plugin causes trouble, open RemNote with plugin disabling according to RemNote’s documented recovery flow.

## RemNote Dark Mode

RemNoteConnect does not install global CSS, mutate RemNote theme state, or style the host app outside its sandboxed iframe. Core RemNote documents honor RemNote's native `Dark` interface setting and persist after app restart.

RemNote Community and generated study-deck routes may still render light. RemNote's own packaged app logic excludes those learning/community routes from the global dark-mode predicate, so that behavior is upstream RemNote UI behavior, not caused by this bridge.
