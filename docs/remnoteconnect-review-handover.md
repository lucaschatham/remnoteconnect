# RemNoteConnect Review Handover

This handover is for another LLM or engineer reviewing the recent RemNoteConnect work in `/Users/HQ/Documents/Codex/RemNoteConnect`.

Do not print, paste, log, or commit the daemon token. The bridge token authorizes whole-knowledge-base RemNote access.

## Current Repo State

- Branch: `main`
- Working tree at handover time: clean
- Relevant commits:
  - `f789f7d feat: implement remnoteconnect v3 bridge`
  - `c53ad19 feat: add safe token rotation`
- Runtime daemon:
  - API: `http://127.0.0.1:8766`
  - Plugin bundle: `http://127.0.0.1:8080`
  - LaunchAgent label: `com.local.remnoteconnect.daemon`
  - App dir: `~/Library/Application Support/RemNoteConnect`
  - Logs: `~/Library/Logs/RemNoteConnect`
  - Backups: `~/Documents/RemNoteConnect/Backups`

At final validation, the bridge was connected with `activeConnections: 1`, `pendingJobs: 0`, and visible tombstones `0`.

## High-Level Change

RemNoteConnect was turned from a managed-root flashcard bridge into a local whole-KB RemNote control surface for Codex/terminal:

- Local Node daemon with authenticated HTTP API and WebSocket bridge.
- RemNote frontend plugin that performs all SDK reads/writes.
- CLI-first interface in `scripts/rnc.mjs`.
- Whole-KB `All / ReadCreateModifyDelete` RemNote scope.
- Reversible safety model based on tombstones and undo records, not managed-root containment.
- Full graph read/search/map, document authoring, flashcard creation, cleanup actions, async jobs, and live validation scripts.

## Connection And Plugin Loading Work

RemNote local plugin loading required several fixes:

- Changed the local plugin manifest ID to `remnoteconnect-codex-local-v3` in `plugin/public/manifest.json` to avoid stale RemNote plugin cache state.
- Made Vite emit stable `index.js` using `plugin/vite.config.ts`.
- Added `plugin/public/snippet.css` because RemNote tried to load that path in native/local plugin mode.
- Rebuilt `plugin/dist` and copied it into the daemon-served runtime at `~/Library/Application Support/RemNoteConnect/runtime/plugin/dist`.
- Restarted RemNote with remote debugging on port `9223` during validation.
- Confirmed RemNote loaded the local plugin iframe from `http://localhost:8080/index.html?...pluginId=remnoteconnect-codex-local-v3`.
- Confirmed the bridge connected over WebSocket with one active plugin connection.

If a reviewer sees an older local plugin iframe as well, rely on daemon status, not iframe count. The expected runtime invariant is `status.bridge.connected === true` and `activeConnections === 1`.

## Architecture Added

### Shared Package

Key file: `shared/src/index.ts`

- API envelope and response schemas.
- Action metadata registry used by `describe`, CLI discovery, and daemon guard decisions.
- Native, adapter, planned, and unsupported action lists.
- Query grammar: `deck:<path>`, `tag:<tag>`, `text:<string>`, `id:<remId>`.
- Added `rotateToken` metadata in `c53ad19`.

### Daemon

Key files:

- `daemon/src/server.ts`
- `daemon/src/bridge.ts`
- `daemon/src/config.ts`
- `daemon/src/security.ts`
- `daemon/src/audit.ts`
- `daemon/src/undoStore.ts`
- `daemon/src/durableJobs.ts`
- `daemon/src/jobStore.ts`
- `daemon/src/externalIdIndex.ts`
- `daemon/src/pluginStatic.ts`

Daemon responsibilities:

- Bind only to local host.
- Require `Authorization: Bearer <token>` for HTTP actions except `/health`.
- Validate Host and Origin.
- Accept one authenticated plugin WebSocket connection.
- Dispatch plugin jobs and retain compact job status.
- Enforce dry-run defaults, magnitude guard, irreversible dry-run hash, and irreversible session budget.
- Store audit events separately from undo payloads.
- Store external ID mappings daemon-side instead of polluting RemNote tags.
- Serve the built plugin bundle on `127.0.0.1:8080`.
- Run durable async imports/jobs from JSONL.

Token rotation added in `c53ad19`:

- `rotateToken` generates a new token.
- Sends it to the connected plugin through an internal `setDaemonToken` plugin job.
- Writes the token file with mode `0600`.
- Updates daemon in-memory auth.
- Returns only `{ rotated: true, tokenFile, pluginUpdated: true }`; it does not return the token.
- Unit test verifies old token is rejected and new token is accepted.

### Plugin

Key files:

- `plugin/src/main.ts`
- `plugin/src/bridgeClient.ts`
- `plugin/src/executor.ts`
- `plugin/src/remnoteHelpers.ts`

Plugin responsibilities:

- Register RemNote settings for daemon URL and token.
- Connect to daemon with WebSocket and first-message token handshake.
- Execute SDK actions only after daemon dispatch.
- Report capabilities and SDK method assumptions.

Important plugin improvements:

- Whole-KB graph operations now use `plugin.rem.getAll()` where needed.
- Rich-text reads use a defensive local decoder before SDK `richText.toString`, because live RemNote returned rich-text shapes that failed SDK validator calls during graph scans.
- `id:` search is O(1) where possible and graph scans avoid breaking on malformed/unsupported rich text.
- Undo restore now uses an empty rich-text value when previous back text is absent, avoiding `setBackText(undefined)` SDK failures.
- Trash listing ignores RemNote internal metadata children such as `Bullet Icon`, `Is Folder`, and `Status` so residue checks reflect real tombstones.
- `setDaemonToken` internal action stores rotated tokens in plugin-local `localStorage` under `remnoteconnect.daemonToken`; `bridgeClient` prefers that value over the manually entered setting. This is necessary because the SDK exposes `getSetting` but no supported `setSetting`.

### CLI And Scripts

Key files:

- `scripts/rnc.mjs`
- `scripts/live-*.mjs`
- `scripts/e2e.mjs`
- `scripts/bench.mjs`
- `scripts/chaos-daemon.mjs`
- `scripts/chaos-async-job.mjs`
- `scripts/install-launch-agent.mjs`
- `scripts/check-no-token.mjs`

CLI:

- `rnc describe`, `doctor`, `status`, `metrics`
- `rnc rotate-token`
- `rnc map`, `get`, `search`
- `rnc create-document`
- `rnc create-flashcards-async`, `import-async`
- `rnc delete`, `empty-trash`, `undo`, `journal-tail`, `backup-graph`
- Cleanup commands: `find-duplicates`, `find-empty`, `find-orphans`, `normalize-text`, `bulk-retag`, `bulk-move`, `merge`

Script improvements:

- Live helpers now pass `confirmCount` for bulk cleanup so teardown does not fail magnitude guard.
- `live-softdelete` cleanup now removes the full test path, not only the created card.
- `live-restore` now passes `confirm:true` to `importSnapshot`, matching safe-by-default semantics.
- Chaos scripts were made LaunchAgent-aware instead of spawning a source daemon over the daily-driver daemon.

## Safety Model

The safety model is documented in `docs/INVARIANTS.md`.

Core invariants:

- The plugin requests `All / ReadCreateModifyDelete`; managed-root containment is not the safety boundary.
- The load-bearing safety invariant is reversibility before capability.
- Soft delete means moving Rem to `RemNoteConnect/Trash/<opId>/`.
- `rem.remove()` is only reachable from `emptyTrash`.
- Undo records live in `~/Library/Application Support/RemNoteConnect/undo/<opId>.json` and store full local prior state.
- Audit logs live in `~/Library/Logs/RemNoteConnect/audit.jsonl` and must remain content-free.
- Snapshot restore is disaster recovery only; it recreates copies with new IDs and does not preserve inbound references, portals, or scheduling history.
- Destructive/bulk/graph operations are dry-run-first.
- Operations resolving more than 50 targets require exact `confirmCount`.
- Irreversible operations require `fromDryRun:<hash>` and consume an in-memory session budget.

Review this carefully: this tool has whole-KB write access, so safety is primarily undoability and human gating, not location containment.

## Implemented Surface Area

System/actions:

- `version`, `status`, `capabilities`, `describe`, `doctor`, `metrics`, `rotateToken`
- `multi`, `jobStatus`, `jobWait`, `confirmMaterialized`

Graph and hierarchy:

- `scopeProbe`, `listRoots`, `map`, `getRem`, `searchGraph`, `findByTag`
- `createRem`, `createFolder`, `renameRem`, `moveRem`, `bulkMove`

Documents:

- `createDocument`, `getDocument`, `appendToDocument`
- Markdown-first interchange.
- `docSpec` supports rich text segments, tags, properties, children, portals where SDK supports them.
- `setProperty`, `getProperties`

Flashcards:

- `createFlashcard`, `createFlashcards`, `createFlashcardsAsync`
- `updateFlashcard`, `getFlashcard`, `searchFlashcards`, `answerCard`
- Anki-inspired adapter actions such as `addNote`, `addNotes`, `findNotes`, `notesInfo`, `deckNames`, `createDeck`, `changeDeck`

Cleanup/safety:

- `deleteRem`, `bulkDelete`, `dryRunDelete`
- `listTombstones`, `restoreTombstone`, `emptyTrash`
- `undo`, `undoClear`, `journalTail`
- `backupGraph`, `exportSubtree`, `backupSubtree`, `validateSnapshot`, `importSnapshot`, `restoreBackup`
- `findDuplicates`, `mergeRems`, `findOrphans`, `findEmpty`, `normalizeText`, `bulkRetag`

Async/idempotency:

- Durable JSONL job store.
- `createFlashcardsAsync`, `importAsync`, `jobWait`, `confirmMaterialized`.
- Daemon-side `externalId -> remId` JSONL index for docs and cards.

## Validation Already Run

Static/unit gates that passed:

```sh
node --check scripts/rnc.mjs
npx pnpm@11.7.0 --config.verifyDepsBeforeRun=false -r typecheck
npx pnpm@11.7.0 --config.verifyDepsBeforeRun=false --filter @remnoteconnect/plugin test
npx pnpm@11.7.0 --config.verifyDepsBeforeRun=false --filter @remnoteconnect/daemon test
npx pnpm@11.7.0 --config.verifyDepsBeforeRun=false -r build
npx pnpm@11.7.0 --config.verifyDepsBeforeRun=false check:no-token
```

Observed unit results after token rotation:

- Plugin tests: `13 passed`
- Daemon tests: `23 passed`
- No standalone 64-hex tokens found in checked project files.

Live gates that passed before token rotation:

```sh
node scripts/live-security.mjs
node scripts/live-scope.mjs
node scripts/live-softdelete.mjs
node scripts/live-docs.mjs
node scripts/live-cleanup.mjs
node scripts/live-idempotent.mjs
node scripts/live-restore.mjs
node scripts/scheduler-smoke.mjs
node scripts/e2e.mjs
node scripts/job-retention.mjs 520
node scripts/bench.mjs 500
node scripts/chaos-daemon.mjs
node scripts/chaos-async-job.mjs
```

Important live observations:

- Scope probe confirmed whole-KB visibility with about 33k Rem.
- `live-security` passed: missing token `401`, wrong token `401`, bad HTTP Origin `403`, bad WebSocket Origin close `1008`.
- Soft-delete preserved Rem ID and undo restored the Rem.
- Docs test passed Markdown round-trip and property read.
- Cleanup test passed seeded duplicate discovery, non-destructive merge, undo, and structural-merge guard.
- Idempotency test passed for both flashcards and documents.
- Restore test verified snapshot restore creates a copy with a new ID.
- Scheduler smoke passed `answerCard`.
- Job retention capped retained jobs at `500`.
- Bench created 500 disposable cards in about 7.3s and found all 500 via graph search in about 1.7s.
- Chaos daemon restart passed and E2E survived reconnect.
- Async chaos killed the daemon at cursor 2/8, restarted through LaunchAgent, resumed, and completed 8/8.

Live token rotation validation:

- `rotateToken` succeeded without printing the old or new token.
- Old token was rejected with `401`.
- New token was accepted.
- Token file mode remained `600`.
- Daemon restarted and plugin reconnected with the rotated token.
- After reconnect settled, `live-scope` and `doctor` passed.
- Visible tombstones were `0`.

## Review Hot Spots

Focus a review on these areas:

1. Token rotation flow:
   - `daemon/src/server.ts`
   - `plugin/src/executor.ts`
   - `plugin/src/bridgeClient.ts`
   - Ensure the token is never returned, logged, committed, or included in build artifacts.

2. Whole-KB safety gates:
   - `daemon/src/server.ts`
   - `plugin/src/executor.ts`
   - Confirm dry-run defaults, magnitude guard, irreversible hash, and budget behavior.

3. Hard-delete isolation:
   - Search for `remove()` and verify only `emptyTrash` can reach Rem hard deletion in the plugin executor.

4. Undo correctness:
   - `plugin/src/executor.ts`
   - `daemon/src/undoStore.ts`
   - Confirm parent, sibling index, rich text, tags, properties, and structural merge inverse references are captured/restored.

5. Rich-text decoding:
   - `plugin/src/remnoteHelpers.ts`
   - The live SDK rejected some values passed to `richText.toString`; fallback decoding is intentional.

6. Trash filtering:
   - `plugin/src/executor.ts`
   - RemNote creates internal metadata Rem under some folder-like Rem. `listTombstones` and `emptyTrash` now ignore known empty metadata children by default.

7. Durable async jobs:
   - `daemon/src/durableJobs.ts`
   - `daemon/src/jobStore.ts`
   - Check restart/resume semantics and idempotency around `externalId`.

8. LaunchAgent daily-driver behavior:
   - `scripts/install-launch-agent.mjs`
   - `scripts/chaos-daemon.mjs`
   - `scripts/chaos-async-job.mjs`

## Known Limitations And Caveats

- Whole-KB access is powerful. A connected token plus plugin grant can modify the full local RemNote graph.
- Snapshot restore is lossy: new IDs, inbound references/portals/scheduling history not preserved.
- The RemNote SDK has no documented settings setter, so token rotation stores the rotated token in plugin-local `localStorage`. The manually entered RemNote plugin setting remains a fallback.
- The RemNote SDK method coverage is based on `@remnote/plugin-sdk@0.0.46` declarations and live probes. If RemNote updates the SDK or desktop runtime, rerun `doctor`, live gates, and chaos scripts.
- Graph search currently traverses the accessible graph on demand; it is acceptable for the tested ~33k Rem graph but may need indexing for much larger KBs.
- `findDuplicates` currently supports text-based duplicates. External-ID duplicate search is planned but not fully implemented.
- Structural merge is guarded and tested, but reference rewriting depends on SDK rich-text replacement behavior.
- RemNote reconnects cancel in-flight bridge jobs; durable async jobs are designed to recover through the daemon JSONL store.

## How To Reproduce Review

Start from a clean repo:

```sh
cd /Users/HQ/Documents/Codex/RemNoteConnect
git status --short --branch
```

Run static/unit checks:

```sh
npx pnpm@11.7.0 --config.verifyDepsBeforeRun=false -r typecheck
npx pnpm@11.7.0 --config.verifyDepsBeforeRun=false --filter @remnoteconnect/plugin test
npx pnpm@11.7.0 --config.verifyDepsBeforeRun=false --filter @remnoteconnect/daemon test
npx pnpm@11.7.0 --config.verifyDepsBeforeRun=false -r build
npx pnpm@11.7.0 --config.verifyDepsBeforeRun=false check:no-token
```

Check runtime:

```sh
node scripts/rnc.mjs status
node scripts/rnc.mjs doctor
node scripts/live-security.mjs
node scripts/live-scope.mjs
```

Run deeper live validation only when RemNote desktop is running, the local plugin is enabled, and disposable test writes are acceptable:

```sh
node scripts/live-softdelete.mjs
node scripts/live-docs.mjs
node scripts/live-cleanup.mjs
node scripts/live-idempotent.mjs
node scripts/live-restore.mjs
node scripts/scheduler-smoke.mjs
node scripts/e2e.mjs
node scripts/chaos-daemon.mjs
node scripts/chaos-async-job.mjs
```

Run performance check:

```sh
node scripts/bench.mjs 500
```

Residue check:

```sh
node scripts/rnc.mjs status
node scripts/rnc.mjs search 'text:"__codex_"'
node -e 'import("./scripts/live-helpers.mjs").then(async ({call}) => console.log(await call("listTombstones")))'
```

## Reviewer Warnings

- Do not run `emptyTrash` on real user content unless you first inspect the dry-run target list and have a matching `fromDryRun` hash and exact `confirmCount`.
- Do not paste or print the token. `scripts/rnc.mjs` reads it from the token file.
- Do not remove or edit user Rem outside disposable `__codex_*` test content during review.
- If a live test fails midway, use the test run ID in its output and clean through the bridge, not by direct database/file manipulation.
- If `doctor` fails immediately after a daemon restart, wait for the plugin reconnect to settle and rerun. A reconnect cancels in-flight bridge jobs by design.

