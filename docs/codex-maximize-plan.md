# RemNoteConnect — Maximize Plan v2

**Goal:** Let Codex *completely run* the RemNote instance — author full-fidelity documents, create flashcards, search and map the whole graph, and clean up in bulk — safely, fast, with minimal maintenance, over a token-cheap interface.

**Role:** You are the implementing engineer. This is your spec. The prior hardening pass is done (managed-root containment, `restoreBackup`, `forbidden_target`, job-retention cap, token-safe CORS, plugin unit tests, the `scripts/*.mjs` fleet, `docs/INVARIANTS.md` all exist). This plan *expands surface area and re-bases the safety model*. Repo: `/Users/HQ/Documents/Codex/RemNoteConnect`. It is not a git repo — run `git init` first so your work is reviewable. Never print, log, or commit the daemon token.

---

## 0. Decisions locked (these change the architecture)

| Decision | Choice | Consequence |
|---|---|---|
| **Graph scope** | **Whole-KB, always on** | Manifest scope → `{ "type": "All", "level": "ReadCreateModifyDelete" }` (verified valid in `@remnote/plugin-sdk@0.0.46`). The managed-root containment invariant is **removed** as the safety mechanism. |
| **Doc richness** | **Full fidelity** | Rich text, references, portals, LaTeX, images, tables, code blocks, Rem properties/slots. |
| **Interface** | **CLI-first** (`rnc`), token-minimal, max coverage | Codex already has a shell tool, so a CLI costs **zero extra tool-schema tokens** (an MCP server loads a schema per tool into context — that's the token tax to skip). HTTP stays underneath; MCP becomes a future thin shim. |

Because containment-by-location is gone, **the safety budget moves from *where* an op may act to *what* guarantees every op carries.** Section 1 is that budget and it is the spine of this plan — build it first.

---

## 0.5 Red-team amendments (v3 — these SUPERSEDE v2 where they conflict)

An engineering red-team found that v2 guards the wrong axis. Apply these before anything else; they change Section 1.

1. **The danger axis is *irreversibility*, not *destructiveness*.** Soft-delete is reversible → treat it as a safe op. The real threats are **`mergeRems` and `emptyTrash`** (and any reference-repointing op): they cannot be cleanly reversed. Gate *those* hardest; barely tax the reversible ops. v2 gated them roughly equally — fix that.

2. **Split AUDIT from UNDO into two artifacts** (v2 conflated them, creating a contradiction — you cannot "never log text" *and* "restore text from the journal"):
   - `~/Library/Logs/RemNoteConnect/audit.jsonl` — token-safe, **content-free** (action, opId, target ids, counts, status). For humans/metrics. Safe to keep forever.
   - `~/Library/Application Support/RemNoteConnect/undo/<opId>.json` — local, mode `0600`, gitignored. Holds the **full prior state** (old parent, **sibling index**, old rich text, old tags, and for merges the **complete inverse reference map**) needed to actually reverse. Prune after the op is committed (`emptyTrash` or explicit `rnc undo-clear`).

3. **Undo must restore *position*, not just parent.** Journal the sibling index; `undo` re-inserts at the original position (verify the SDK supports ordered insertion; if not, document the degradation). Order is meaning in an outliner.

4. **Irreversible ops require time-separation + a session budget** (a magnitude guard the agent fills in itself is theater):
   - `mergeRems` / `emptyTrash` reject unless the caller passes `fromDryRun:<hash>` — the hash of a **prior** dry-run result. An agent cannot preview and execute destructive structure in one call.
   - Session budget: after K irreversible ops (default 3), further ones require a fresh human re-confirm token. Reversible ops are unmetered.

5. **Default dedup is non-destructive.** `mergeRems` default = tombstone the duplicate and leave a reference to the keeper (fully reversible). True structural merge (repoint inbound refs + delete) is a separate opt-in verb behind amendment #4's gate, and must write the inverse ref-map to the undo store.

6. **Do NOT snapshot the whole graph every session.** First **verify RemNote's native sync history / trash scope** (probe task) — lean on it as the coarse net. `backupGraph` becomes **explicit/opt-in**, not auto-per-session (recursive per-node snapshot of 10k+ Rems is minutes + a fat file, and conflicts with "fast"). The per-op undo store is the real safety; `backupGraph` is disaster recovery.

7. **De-risk the build (YAGNI):**
   - Registry in Phase 0 is an **additive metadata table** keyed by action name (drives confirm/backup/CLI/describe). **Leave handlers in the existing `switch`**; extract incrementally once stable. No big-bang executor rewrite.
   - CLI ships as a **single zero-build `scripts/rnc.mjs`**, not a TS workspace package (minimal maintenance). `describe`-driven, HTTP underneath, MCP shim deferred.

8. **Idempotency via a daemon-side index, not graph tags.** Maintain an `externalId → remId` JSONL map in the app dir (O(1), reconciled on startup). Do **not** write `rnc:ext:*` tags into the user's "everything" graph — it pollutes the KB and is O(n) to query.

9. **Reversibility is load-bearing; guards are convenience.** State this explicitly in `INVARIANTS.md`. With an autonomous agent holding a whole-KB token, the only real safety is (a) it can be undone, or (b) a human is in the loop. Magnitude/confirm guards only stop *accidental* breadth, not a confidently-wrong agent.

10. **Performance: measure-first, "don't read after write" is the lever.** Drop `summarizeRem` + `waitForCards` from the hot path (return `{id}` only). Parallelize bulk writes with bounded concurrency (start at 8) **only after** verifying the SDK is write-safe under concurrency on a shared parent. Frame the target as "measure the dominant cost, then cut it," not a fixed multiplier.

---

## 1. Safety model that replaces containment — BUILD FIRST (blocking)

**Anchoring fact (do not design around this — design *from* it):** `importSnapshot`/`restoreBackup` recreate Rems as **copies with new IDs**; inbound references, portals, and spaced-repetition scheduling are **lost** (see `docs/INVARIANTS.md` and the snapshot warning string). The SDK has **no ID-preserving delete** — only `rem.remove()` (hard) and `rem.setParent()`. Therefore **snapshot-restore is NOT a valid undo.** For a whole-KB, agent-driven system, "backup before delete" alone is a trap: restoring a deleted Rem gives a new ID and breaks every reference into it from the rest of your graph.

### 1.1 Delete by tombstone, not by removal
- **Soft-delete is the default.** "Delete" = `setParent()` the target to a tombstone container `RemNoteConnect/Trash/<opId>/`. The Rem keeps its `_id`, so references, portals, and scheduling survive. **Undo = move it back** to its journaled parent.
- **Hard delete is a separate, rarely-run, heavily-gated verb** `emptyTrash` (requires `confirm:true` + magnitude echo, see 1.4). `rem.remove()` is only ever reachable through `emptyTrash`.
- **Verify first:** confirm `@remnote/plugin-sdk@0.0.46` has no native trash/restore that preserves `_id`. If one exists, prefer it; if not (expected), tombstone-via-`setParent` is the only reversible delete and the plan stands.

### 1.2 Operation journal (real undo + audit)
- Append-only JSONL at `~/Library/Application Support/RemNoteConnect/journal.jsonl`. One line per mutation: `{ opId, ts, action, scope, targetIds, before, after }` where `before`/`after` capture the reversible state (old parent for moves/deletes, old text for renames, old tags for retags). **Never log card/note text bodies or the token** — store text as length + sha, or omit, per the token-handling invariant.
- `undo <opId>` replays the inverse from the journal: move tombstoned Rems back, restore old parent/text/tags. Mutations on stable `_id`s (move/rename/retag/edit/soft-delete) are genuinely reversible this way.
- `journalTail [n]` for audit.

### 1.3 Whole-graph backup (coarse safety net, not undo)
- `backupGraph` snapshots the entire KB to the backup dir. Auto-trigger once before the **first** graph-scoped mutation of a session. This is disaster recovery / "I want the old text back as a copy," explicitly **not** the undo path (1.2 is). Surface the lossy caveat on every snapshot response (already an invariant).

### 1.4 Pre-flight guards on every mutating action
- **Dry-run by default** for anything destructive, bulk, or that resolves >1 target. Execution requires `confirm:true`. The CLI enforces this (Section 4).
- **Magnitude guard:** if an op resolves more than `N` targets (default 50, configurable), it rejects unless the caller passes `confirmCount:<exactCount>` echoing the resolved count. This stops a hallucinated-broad query from silently nuking the graph.
- **Reference-aware delete:** before soft-deleting, compute inbound references/portals that would dangle and return them; proceeding is fine for soft-delete (refs survive the tombstone), but `emptyTrash` on a Rem with inbound refs requires `force:true`.
- **Optimistic concurrency (light):** capture `updatedAt` at read; if it changed before the write, skip that target and report it (handles the user editing in RemNote mid-bulk). Name it, don't over-build it.

### 1.5 Sequencing rule (treat as a build gate)
**No graph-scoped delete verb may be exposed until soft-delete + journal + `backupGraph` + magnitude guard all exist and are tested.** The dangerous verb cannot be callable before its undo substrate ships. Enforce by ordering the phases (Section 5) and by a test that asserts `bulkDelete`/`deleteRem` reject with `not_implemented`/`forbidden_target` if the journal module is absent.

---

## 2. Target architecture (robust / fast / minimal-maintenance / extensible)

### 2.1 Action registry — the extensibility backbone
Replace the giant `switch` in `plugin/src/executor.ts` and the hardcoded `Set`s in `daemon/src/server.ts` (`destructiveActions`, `requireConfirm`, `wantsBackup`) with one registry.
- **Metadata** (serializable) lives in `shared/`: `{ name, summary, paramSchema (zod), scope: "managed"|"graph"|"either", mutates, destructive, requiresConfirm, requiresBackup, magnitudeGuarded }`.
- **Handlers** (keyed by `name`) live in `plugin/`.
- One source feeds: envelope validation, `capabilities`, a new `describe` action (full schema dump for agent discovery), CLI subcommand generation, future MCP tools, and the daemon's confirm/backup decisions.
- **Guard test:** assert `shared` metadata names ↔ `plugin` handler keys are 1:1, so the registry can't silently drift.

### 2.2 Token-minimal I/O (serves the "least tokens" requirement directly)
- `executeAction` currently returns a full `summarizeRem` (path, tags, cards, rich text) on **every** mutation — huge waste for bulk. **Default return = `{ id }` or `{ count, ids }`.** Full detail only behind `verbose:true` / `rnc --verbose`.
- **`map`** read primitive returns **TSV (`id\ttitle` per line, indented by depth)**, not JSON — the cheapest way for an agent to see the graph and plan cleanup. `rnc map --depth N`.
- **Markdown is the doc interchange format** (Section 3): agent writes Markdown, reads Markdown. Far fewer tokens than rich-text JSON and already supported via `richText.parseFromMarkdown` / `toMarkdown`.

### 2.3 Single-process daily driver
Have the **daemon serve the built plugin bundle** on `127.0.0.1:8080` (static file serving) so the daily driver is one process, not daemon + Vite. Vite stays for development only. This removes the "still depends on a dev-style plugin server" limitation and halves the things that can break.

### 2.4 Durable, resumable jobs — JSONL, not SQLite
Persist job state + the operation journal as **append-only JSONL files in the app dir**. (Deliberately *not* SQLite: a native module that recompiles per Node version violates the "minimal maintenance" requirement; YAGNI on indexed history.) Async bulk returns a `jobId`, survives a daemon restart, and is resumable. `jobStatus`/`jobWait` read from the store.

### 2.5 Backpressure + retry
Bulk SDK writes go through a bounded-concurrency queue with throttle and retry-with-backoff, so large imports don't overwhelm RemNote or trip timeouts. Size the daemon job timeout from batch length (already done for bulk create — generalize it).

---

## 3. Surface area to add (answers "what's missing from the spec")

Implement as registry entries. Group letters map to build phases.

**A — Full-fidelity document authoring**
- `createDocument { markdown | docSpec, parentPath?, externalId? }` → parses Markdown (or a structured DocSpec for things Markdown can't express) into a nested Rem tree. Returns root id + child count.
- `getDocument { id, format: "markdown"|"tree" }` → reconstructs the doc for the agent to read/edit cheaply.
- `updateDocument` / `appendToDocument` — edit in place by id (stable, journaled).
- **Rich-text builder** mapping a compact spec → `RichTextInterface`: bold/italic/code/strikethrough, links, **Rem references `[[id]]` and `[[Name]]`**, **portals**, **LaTeX**, **images**, **tables**, **code blocks**.
- `setProperty` / `getProperties` — RemNote's Rem-as-property/slot (descriptor) model, for structured docs.

**B — Whole-graph read & navigation (cheap maps)**
- `map { rootId?, depth? }` → TSV outline (the keystone agent primitive).
- `getRem { id }`, `listDocuments`, `searchGraph { query }` (use the SDK's own search if `@remnote/plugin-sdk` exposes one; else cached full traversal), graph-wide `findByTag`.

**C — Bulk cleanup (the "clean up in bulk" ask — none of these exist yet)**
- `findDuplicates { by: "text"|"externalId" }`, `mergeRems { keepId, mergeIds }` (repoint children + inbound refs to `keepId`, then tombstone the losers), `findOrphans`, `findEmpty`, `normalizeText` (trim/whitespace/dedupe), `bulkRetag`, `bulkMove`, `bulkDelete { query }` — all **query-driven, dry-run by default, magnitude-guarded, journaled**.

**D — Lifecycle / safety verbs** (from Section 1)
- `backupGraph`, `undo { opId }`, `listTombstones`, `restoreTombstone { opId|id }`, `emptyTrash { confirm, confirmCount, force? }`, `journalTail { n }`.

**E — Bulk / async / idempotency**
- `createFlashcardsAsync` / `importAsync` → `jobId`; `jobStatus`/`jobWait`; `confirmMaterialized { batchId }` (resolve real card ids without slowing create).
- **`externalId` upsert for BOTH docs and cards** — store the key as a tag/slot on any created Rem so a re-run updates instead of duplicating. (An agent re-running a doc script must not duplicate whole trees.)

---

## 4. CLI spec (`rnc`) — primary interface

New `packages/cli` (or `cli/`), `bin: { "rnc": "dist/cli.js" }`, thin HTTP client over the daemon. Reads the token from the token file (never as an arg). Subcommands generated from the registry.

- `rnc describe` → dumps the full action schema (one call = total API discovery; max coverage, min tokens).
- `rnc map --depth 3` → TSV graph map.
- `rnc create-document --md ./notes.md --parent "Inbox"` → id.
- `rnc search "text:mitochondria"` / `rnc find-duplicates --by text`.
- Destructive verbs **default to dry-run**; need `--confirm` (and `--confirm-count N` past the magnitude threshold).
- Output: compact by default (`{id}`/`{count}`), `--json` minified, `--verbose` for full summaries.
- `rnc undo <opId>`, `rnc backup-graph`, `rnc empty-trash --confirm --confirm-count N`.

---

## 5. Build phases (each phase = deliverable + its acceptance test; ship in order)

- **Phase 0 — Registry + token-minimal returns + `All` scope.** Refactor to the registry; default `{id}`/`{count}` returns; manifest scope → `All/ReadCreateModifyDelete`; `doctor` gains a **scope probe** that reads a known *out-of-root* Rem and confirms access (RemNote re-prompts for `All` on reload; if the user doesn't approve, whole-KB silently fails — this is the runtime-vs-grants trap, catch it here). *Test: registry 1:1 parity; describe returns all actions; scope probe green.*
- **Phase 1 — Safety substrate (BLOCKS all graph delete + every irreversible verb).** Per §0.5: split **audit.jsonl** (content-free) from the **undo store** (0600, full prior state incl. sibling index + rich text + inverse ref-map); soft-delete/tombstone; `undo` (restores parent **and position**); dry-run default; magnitude guard (accidental-breadth only); `fromDryRun:<hash>` + session-budget gate for irreversible verbs; optimistic-concurrency skip. **Probe task first:** verify RemNote's native sync-history / trash scope and document what it does/doesn't cover, so `backupGraph` stays opt-in. *Test: soft-delete preserves `_id` + inbound ref; undo restores parent AND sibling index; irreversible verb refuses without a valid prior dry-run hash; session budget blocks op K+1; delete verbs refuse if undo store absent.*
- **Phase 2 — Whole-graph read + CLI.** `map` (TSV), `getRem`, `listDocuments`, `searchGraph`, `rnc` with `describe`. *Test: map round-trips a known subtree; CLI dry-run/confirm gating.*
- **Phase 3 — Full-fidelity docs.** Markdown⇄Rem, rich-text builder (refs/portals/latex/images/tables/code), properties. *Test: markdown→createDocument→getDocument markdown round-trip preserves structure + a reference + LaTeX.*
- **Phase 4 — Bulk cleanup.** dedup/merge/orphans/empty/normalize/bulkRetag/bulkMove/bulkDelete. *Test: dedup finds seeded dupes; merge repoints children + inbound ref then tombstones loser; all dry-run by default.*
- **Phase 5 — Durable async + idempotency.** JSONL job store, `createFlashcardsAsync`, `confirmMaterialized`, externalId upsert (docs+cards). *Test: async job survives daemon restart mid-run; re-running an import with same externalIds creates 0 duplicates.*
- **Phase 6 — Daily driver.** Daemon serves built plugin; LaunchAgent install/check/uninstall; backup retention (last N / X days / pinned); `metrics` action; JSONL daemon log; `pnpm doctor` full. *Test: doctor green from cold login; retention prunes correctly; metrics report p50/p95.*

---

## 6. Test plan (rewritten — supersedes the old Section 4)

**Static gates**
```sh
npx pnpm@11.7.0 -r typecheck
npx pnpm@11.7.0 --filter @remnoteconnect/plugin test
npx pnpm@11.7.0 --filter @remnoteconnect/daemon test
npx pnpm@11.7.0 --filter @remnoteconnect/cli test
npx pnpm@11.7.0 -r build
npx pnpm@11.7.0 check:no-token
```
**Unit (mock SDK via existing `plugin/test/fakeRemGraph.ts`)**
- Registry 1:1 parity (shared metadata ↔ plugin handlers).
- Rich-text builder + Markdown round-trip (refs, portals, LaTeX, image, table, code survive).
- Tombstone delete preserves `_id`; `undo` restores parent/text/tags; journal replay is deterministic.
- Magnitude guard rejects at threshold+1; dry-run mutates nothing; optimistic-concurrency skip on changed `updatedAt`.
- mergeRems repoints children + inbound references before tombstoning.

**Live gates** (gate every one on `status.bridge.connected === true`, never `/health` alone)
```sh
node scripts/live-security.mjs
node scripts/live-scope.mjs        # NEW: proves All-scope grant by touching an out-of-root Rem
node scripts/live-softdelete.mjs   # NEW: soft-delete -> ref still resolves -> undo restores
node scripts/live-docs.mjs         # NEW: markdown round-trip incl. reference + LaTeX
node scripts/live-cleanup.mjs      # NEW: seed dupes -> find -> merge -> verify -> undo
node scripts/live-idempotent.mjs   # NEW: re-run import, assert 0 duplicates
node scripts/live-restore.mjs
node scripts/scheduler-smoke.mjs
node scripts/job-retention.mjs 520
node scripts/e2e.mjs
node scripts/bench.mjs 500
```
**Chaos / restart:** kill daemon → reconnect; kill plugin server → reconnect; relaunch RemNote → `connected === true`; **kill daemon mid async-bulk → job resumes from JSONL** (new). Run `e2e.mjs` after each.

**Safety gates (new, must all pass):**
- No path reaches `rem.remove()` except through `emptyTrash`.
- Graph-delete AND all irreversible verbs are unreachable before the undo substrate exists.
- `undo` restores a soft-deleted Rem with the **same `_id`**, intact inbound references, **and original sibling position**.
- Irreversible verbs (`mergeRems` structural, `emptyTrash`) reject without a matching `fromDryRun:<hash>`; the session budget blocks the (K+1)th irreversible op until human re-confirm.
- Default `mergeRems` is non-destructive (tombstone + reference to keeper) and is undoable; the destructive variant writes a complete inverse ref-map to the undo store and is proven reversible by a merge→undo→assert-references test.
- Audit log contains **no** card/note/text content or token; undo store is mode `0600` and gitignored.

**Residue gates:** zero results for `__codex_e2e__`, `__codex_restore__`, `__codex_bench__`, `__codex_scheduler__`, `__codex_docs__`, `__codex_cleanup__`; empty `RemNoteConnect/Trash` after teardown; no token files in `plugin/public` or `plugin/dist`.

**Performance targets:** bulk create ≥ 5× faster than today's ~5 cards/s (parallelize within batch, drop default materialize wait, minimal returns); `map` of a 5k-Rem graph < 2s; whole-graph search p95 budget recorded by `bench.mjs`.

**Acceptance criteria:** all static + live + safety gates green; restart/chaos reconnect and resume without manual repair; `undo` proven to restore IDs and references; zero residue; `status.bridge.connected === true`, `activeConnections === 1`, `pendingJobs === 0`.

---

## 7. Directives you (the human) still aren't giving but should

Add to `docs/INVARIANTS.md` (it currently still encodes the *old* managed-root containment model — rewrite that section to the whole-KB model below, don't just append):

1. **Reversibility before capability.** No destructive verb ships until it is reversible by stable `_id` (tombstone + journal), never by snapshot-restore. Snapshots are coarse disaster recovery, not undo.
2. **Default to safe.** Every destructive/bulk/graph op is dry-run until `confirm:true`; past the magnitude threshold it requires an echoed exact count.
3. **Every mutation is audited.** Append-only journal, token-safe, sufficient to `undo`.
4. **Prove the grant, don't assume it.** `doctor` must confirm `All` scope was actually approved by reading an out-of-root Rem (runtime-vs-grants trap).
5. **One interchange format.** Markdown in/out for docs; TSV for maps; `{id}`/`{count}` for mutations — minimize agent tokens by default, full detail on request.
6. **Idempotent by `externalId`** for docs and cards, so an agent re-run never duplicates.

---

## 8. What I'm still unclear on (your call — sane defaults assumed if you don't answer)

- **Trash location.** With containment gone, where do tombstones live? *Default: keep `RemNoteConnect/Trash/` — one known, sweepable area; the `RemNoteConnect` root survives as the operational home even though writes are no longer confined to it.*
- **KB size / perf target.** How many Rems in your real graph (1k? 10k? 100k?) — sets whether `map`/search need an index. *Default: assume ~10k, traverse + cache; add index only if bench misses budget.*
- **Sync timing.** Bulk ops apply to the local replica then sync to RemNote cloud. A large soft-delete will propagate to all devices on sync — acceptable? *Default: assume yes; `backupGraph` before session covers it.*
- **Daily-driver plugin packaging.** Is "daemon serves the built bundle, RemNote loads `127.0.0.1:8080`" acceptable, or do you want a properly published/unlisted RemNote plugin install so nothing local needs to be running to load it? *Default: serve-built; revisit if RemNote supports clean local install.*
- **Magnitude threshold `N`.** Default 50 before the echoed-count guard — raise/lower to taste.

**Scope guard:** stay in this repo. Do not run `supabase`, do not touch the Daybreaker workspace, do not hard-delete any real Rem outside `emptyTrash`. Log out-of-scope needs under a Discoveries section and stop.
