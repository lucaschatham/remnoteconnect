# RemNoteConnect — Bridge Reliability & Speed Plan

**Goal:** Make whole-KB daily use **reliable and fast fast fast** on top of the existing v3 safety model. The graph works (`scopeProbe` sees 33,959 Rems, ordered insertion verified), the safety spine is built (tombstone delete, split audit/undo, dry-run + magnitude + irreversible budget). What is broken is the *transport*: the bridge drops sockets mid-job, the daemon cancels in-flight work on reconnect, whole-graph scans are monolithic, and one write path skips the guard. Fix the transport; do not touch the safety axis except where noted.

**Role:** You are the implementing engineer. This is your spec. Repo: `/Users/HQ/Documents/Codex/RemNoteConnect` (it is a git repo now — commit per phase). Never print, log, or commit the daemon token. Package manager is pnpm. Keep it **lightweight** — no new services, no new packages, no big-bang rewrites. Every change below is surgical and named to a file.

---

## 0. Evidence this plan is built from (do not re-litigate — design from it)

A live review against the real 33k-Rem KB produced this, with all static gates green (typecheck, plugin 13 / daemon 23 unit tests, build, `check:no-token`):

```
live-cleanup:    FAIL plugin_reconnected
live-idempotent: FAIL residue remains
live-restore:    FAIL residue remains
scheduler-smoke: FAIL residue remains
e2e:             FAIL plugin_reconnected
chaos-async-job: FAIL residue remains
bench 500:       FAIL plugin_reconnected
residue search text:"__codex_": count 522
listTombstones: count 6
```

**Root cause is a single fault with a cascade:** the bridge opens overlapping sockets, the daemon cancels in-flight jobs when the second one authenticates, cancelled jobs never finish, so their test data is never cleaned up → `plugin_reconnected` failures **and** the 522-row residue are the *same bug* surfacing two ways.

---

## 1. The two failure modes (both must be closed — one fix does not cover the other)

You will be tempted to fix only the overlapping-socket path. That leaves the sequential path broken. Name both:

**Mode A — overlapping sockets (the loud one, `plugin_reconnected`).**
`plugin/src/bridgeClient.ts:47 connect()` calls `new WebSocket(url)` unconditionally, with no check that a socket is already `OPEN`/`CONNECTING`. `scheduleReconnect()` is wired to **both** `error` and `close` (`bridgeClient.ts:77-78`) on a fixed 2000 ms timer with no heartbeat. A transient `error` on a *live* socket therefore opens a **second** socket 2 s later while the first is still `OPEN` and mid-job. The second socket's `hello` hits `daemon/src/bridge.ts:187 replaceConnection()`, which calls `rejectPending("plugin_reconnected", …)` and kills **every** in-flight job. This is Mode A.

**Mode B — a genuine drop, sequential (the silent one, orphaned jobs → timeout).**
On a real network blip the socket `close` handler (`bridge.ts:178`) clears `this.ws`/`this.hello` but does **not** reject the pending map. In-flight sync jobs orphan until their 30 s `runJob` timeout (`bridge.ts:99`) fires → hard fail. Single-flight does nothing for Mode B; a job continuity layer is required on top.

**Why the asymmetry matters:** durable async jobs (`createFlashcardsAsync`/`importAsync`) already survive both modes — `durableJobs.ts:45-48 retryableBridgeError` re-queues on `plugin_reconnected`/`plugin_disconnected`/`timeout` and `kick()` resumes from `job.cursor`. The **synchronous** `bridge.runJob` path (findDuplicates, searchGraph, getDocument, backupGraph, restoreBackup, undo, single createFlashcard) has **no** such resilience. The reliability hole is the sync path.

---

## 2. Corrections locked (these bound the design — apply before drafting handlers)

1. **Read/write is the retry discriminator, and reuse what exists.** Auto-retry on `retryableBridgeError` is safe **only for idempotent/read actions** (`searchGraph`, `findDuplicates`, `getDocument`, `backupGraph`, `mapGraph`, `doctor`/`scopeProbe`, `describe`-class reads). Mutating actions must **not** blind-retry — a re-send could double-write. Mutations lean on the idempotency that already exists: the `externalId → existingRemId` index (`server.ts:329`, `durableJobs.ts:180`). Lift the existing `retryableBridgeError` predicate (`durableJobs.ts:45`) into `shared/` and reuse it; do not fork a second copy.

2. **Do NOT weaken the irreversible budget for tests.** The budget (`IRREVERSIBLE_SESSION_BUDGET = 3`, `server.ts:47`) is per-session and resets on daemon restart. A "test-only flag that raises the budget" would be a prod-reachable bypass and is exactly the *"guards an agent satisfies itself are theater"* trap this project already rejected. The correct fix for cleanup-heavy scripts is (a) **restart the daemon between them** so the budget resets, and (b) **stop swallowing cleanup errors** (`live-helpers.mjs:48`). No bypass flag, ever.

3. **`restoreBackup` is additive → reversible → guard proportionally.** `importSnapshot` (`executor.ts:859`) creates **new copies with new IDs**; it can be undone by tombstoning the restored subtree. It is *not* hard-delete or merge. Route it through the **dry-run-default + magnitude + `confirmCount`** path — NOT the `fromDryRun`-hash + irreversible-budget machinery. Over-guarding it as irreversible violates "rank by irreversibility" as much as the current under-guarding does.

4. **"Fast" is parallelism + a warm socket, not just chunking.** `findDuplicates` (`executor.ts:1037`) does ~33k **sequential** awaits today; chunking-for-safety alone leaves it reliable-but-slow. Parallelize *within* each chunk (bounded concurrency, mirror the `Promise.all` shape already in `findGraphRems`, `remnoteHelpers.ts:271`) and yield *between* chunks. The heartbeat is also a speed lever: a warm socket means zero per-op reconnect cost. Ship with a concrete target (§7).

5. **"Refuse duplicate while old is OPEN" must be coupled to heartbeat eviction.** If the daemon refuses a new socket while the old one is still `OPEN`, a half-open zombie socket would lock out reconnection forever. Server-side ping/pong with terminate-on-missed-pong is therefore mandatory, and the eviction interval **is** the reconnect-lockout window. Pick 10–15 s.

---

## 3. Phase 1 — Bridge stability (BUILD FIRST, blocking). Closes Mode A.

### 3.1 Plugin single-flight connect — `plugin/src/bridgeClient.ts`
- In `connect()`, **return early** if `this.socket` exists and `readyState` is `OPEN` or `CONNECTING`. Never open a second socket over a live one.
- On the socket `open` event, **clear the reconnect timer** (`this.reconnectTimer`) so a stale timer can't fire against a healthy socket.
- Replace the fixed 2000 ms reconnect with **exponential backoff + jitter** (e.g. 500 ms → 8 s cap). Reset the backoff to floor on a clean `open`.
- On `error`, **close the socket first**, null out `this.socket`, then schedule reconnect. Do not rely on `error` *and* `close` both firing; make the state machine deterministic (one live socket reference at a time; set `this.socket = undefined` in the `close` handler).
- Add a **client heartbeat**: respond to daemon pings (see 3.3) and/or send an app-level `{type:"ping"}` on an interval so an idle socket stays warm and a dead one is detected fast rather than via a stuck job.

### 3.2 Daemon graceful replace — `daemon/src/bridge.ts:187 replaceConnection()`
- On a new authenticated `hello`, if `this.ws` is still `OPEN` **and** `this.pending.size > 0`, treat the newcomer as a **duplicate**: close the *new* socket with `1013 "already connected, in-flight jobs"` and keep the existing connection + its pending jobs. Do **not** `rejectPending`.
- Only adopt the new socket (and only then `rejectPending` for anything truly unrecoverable) when the old socket is **not** `OPEN` (already closing/dead). This makes "exactly one bridge connection" a real enforced invariant instead of a hope (`INVARIANTS.md:62`).

### 3.3 Daemon heartbeat / zombie eviction — `daemon/src/bridge.ts`
- On `attach`, start a `ws.ping()` interval (10–15 s). Track `isAlive`; on `pong` set it true. If a ping cycle passes with no `pong`, `ws.terminate()` and clear `this.ws`/`this.hello` so the plugin's single-flight reconnect (3.1) can take over.
- Clear the interval in the `close` handler. This is the mechanism that prevents 3.2's "refuse duplicate" from becoming a permanent lockout (correction §2.5).

**Build gate for Phase 1:** re-run `e2e` and `bench 500`. `plugin_reconnected` must be **gone**. If it still appears, do not proceed — Mode A is not closed.

---

## 4. Phase 2 — Job continuity (blocking). Closes Mode B for the sync path.

### 4.1 Reject-pending on a real close — `daemon/src/bridge.ts:178`
- When the active socket closes and there are pending jobs, do not leave them to time out silently. Reject them with a **retryable** code (`plugin_disconnected`) immediately so the retry layer (4.2) can act, instead of blocking for the full 30 s timeout.

### 4.2 Idempotent-read auto-retry in dispatch — `daemon/src/server.ts` + `shared/`
- Lift `retryableBridgeError` (`durableJobs.ts:45`) into `shared/src/index.ts` and export it. Reuse in both places.
- Add an **action classification** in `shared/` metadata: `retryable: true` for read/idempotent actions only (`searchGraph`, `findDuplicates`, `getDocument`, `mapGraph`, `backupGraph`, `scopeProbe`). Wrap those `bridge.runJob` calls in `dispatchAction` with a **bounded retry** (e.g. 3 attempts, small backoff) gated on `retryableBridgeError`. Mutating actions are **not** wrapped (correction §2.1).
- Do not add retry to `undo`/`restoreBackup`/write paths — those rely on the `externalId` index and the guard path for safety.

**Build gate for Phase 2:** `chaos-async-job`, `live-idempotent`, `live-restore` must reach `residue == 0` for their own run (a job interrupted by a simulated drop now finishes on retry/resume rather than orphaning its test Rems).

---

## 5. Phase 3 — Fast whole-graph scans (speed + reliability). `plugin/src/executor.ts`, `plugin/src/remnoteHelpers.ts`

### 5.1 Chunk + parallelize + progress — `findDuplicates` (`executor.ts:1037`)
- Page `allAccessibleRems` into chunks (start 500). Within each chunk, resolve `richTextToString` with **bounded-concurrency `Promise.all`** (mirror `findGraphRems`, `remnoteHelpers.ts:271`), not a sequential `for … await`.
- **Emit progress** via the existing progress callback (`bridgeClient.ts:97`) each chunk, and **`await` a macro-task yield** between chunks so the event loop can service pings and the job never *looks* dead to the daemon timeout.
- Apply the same chunk+parallelize+yield shape to the `text:` branch of `findGraphRems` if it is not already bounded (it uses one big `Promise.all` today — cap its concurrency so 33k parallel awaits don't stampede the SDK).

### 5.2 Make long scans resumable (optional, only if Phase 2 leaves a gap)
- If a full scan still exceeds a comfortable single-job window after 5.1, promote `findDuplicates`/large `searchGraph` to a **durable job class** (reuse `durableJobs.ts` cursor/resume). Prefer *not* to if the retry layer + chunking already keeps them under target — keep it lightweight.

**Build gate for Phase 3:** `bench 500` green **and** a full-graph `findDuplicates` completes under the §7 target with zero cancellations.

---

## 6. Phase 4 — Correctness & fidelity (not hygiene — these are real defects)

### 6.1 Guard `restoreBackup` — `daemon/src/server.ts:280`
- Route `restoreBackup` through the same **dry-run-default → magnitude → `confirmCount`** path the other bulk mutations use (`shouldDefaultDryRun`, the preflight block at `server.ts:335-366`), passing `dryRun` through to `importSnapshot` (which already honors it, `executor.ts:862`). Do **not** attach `fromDryRun`-hash / irreversible-budget (correction §2.3). Without a `confirm:true`, `restoreBackup` must return a dry-run preview, not import.

### 6.2 Fix live cleanup — `scripts/live-helpers.mjs:44-51`
- **Stop swallowing errors** in `cleanupByText`'s `catch` (line 48): log the failure with the run id and the count of residue that could not be cleaned, and let the script exit non-zero so residue is never silent again.
- For cleanup-heavy suites, **restart the daemon between scripts** so the per-session irreversible budget (`emptyTrash`) resets — do not raise or bypass the budget (correction §2.2). Document this in the script runner / README.

### 6.3 Rich-text fidelity — `plugin/src/remnoteHelpers.ts:105,117`
- The fallback returns `""` for `i:"fi"|"ai"|"di"` and for unmatched types — a **silent fidelity regression** against the locked *full-fidelity docs* decision. Return **stable placeholders** instead: `[[remId]]` for Rem references, the media URL for image/audio/file segments, and a `{unsupportedRichText:<i>}` marker for genuinely unknown types.
- Surface a `decodeWarnings` array on read/export results so a lossy decode is visible, not swallowed.

**Build gate for Phase 4:** unit tests updated and green for the `restoreBackup` guard and the richtext placeholders; `live-restore` and `live-cleanup` residue == 0.

---

## 7. Phase 5 — Hygiene (small, do last, don't let it dominate)

- **CORS** (`daemon/src/security.ts:13`): require `config.allowedOrigins` membership for **browser** origins; keep the `origin === undefined` allowance for curl/CLI only. Drop the blanket `localhost`/`127.0.0.1` accept (contradicts `INVARIANTS.md:45` token-handling / no-wildcard-CORS).
- **Token print** (`daemon/src/cli.ts:7`): the raw `token` command violates "never print the token." Rename it behind an explicit `token --unsafe-print` (or replace with a copy-to-clipboard-without-echo / re-pair flow). The setup path should hand the token to the plugin without echoing it to a terminal.
- **Swap file**: add `*.swp` to `.gitignore` and remove the tracked-in `docs/.remnoteconnect-review-handover.md.swp`.

---

## 8. Acceptance gates (tie to the failing evidence — no teeth otherwise)

Run the **full named suite** after Phase 4; all must hold in one clean run:

| Gate | Required result |
|---|---|
| `live-cleanup`, `live-idempotent`, `live-restore`, `scheduler-smoke`, `e2e`, `chaos-async-job`, `bench 500` | **zero `plugin_reconnected`** anywhere |
| `residue search text:"__codex_"` | **== 0** (new residue prevented) |
| `listTombstones` | back to baseline (no accumulation from cancelled jobs) |
| `typecheck`, plugin unit, daemon unit, `build`, `check:no-token` | stay **green** |
| full-graph `findDuplicates` on 33k Rems | completes under **target** with **zero cancellations** |

**Latency target (name it, then hit it):** with the socket warm (Phase 1) and scans parallelized (Phase 3), a full-graph `findDuplicates` over ~34k Rems should complete in **well under 60 s** (set the concrete number from the first post-fix bench run and treat regressions past it as a gate failure). Heartbeat interval 10–15 s; sync-read retry ≤ 3 attempts.

**One-time cleanup, separate from this fix:** the existing **522** `__codex_*` residue rows predate the fix. This plan *prevents new* residue; it does not retroactively remove old rows. After the suite is green, run a **single manual sweep** (`searchGraph text:"__codex_"` → guarded `deleteRem` + `emptyTrash`, restarting the daemon as needed for the budget) to clear the backlog. Do not fold that sweep into an automated test.

---

## 9. Build order (enforce as gates, not suggestions)

1. **Phase 1** (bridge stability) → gate: `plugin_reconnected` gone from `e2e` + `bench 500`.
2. **Phase 2** (job continuity) → gate: interrupted jobs resume; `chaos-async-job` residue 0.
3. **Phase 3** (fast scans) → gate: `bench 500` green + `findDuplicates` under target.
4. **Phase 4** (correctness/fidelity) → gate: full suite green, residue 0.
5. **Phase 5** (hygiene) → gate: static gates green, no `.swp` tracked.

Do not advance a phase until its gate holds. Phases 1 and 2 are both blocking — a green Phase 1 with a broken sync path still fails real use.
