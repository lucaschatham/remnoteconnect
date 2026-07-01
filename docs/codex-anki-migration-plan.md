# RemNoteConnect — Anki → RemNote Migration Plan (full fidelity)

**Goal:** Make RemNoteConnect capable of a **complete, full-fidelity Anki → RemNote migration** — every deck, note type, card type, cloze, tag, custom field, and media asset maps to its best RemNote equivalent — driven by a single Codex prompt (Part C), executed flawlessly through the plugin. "Nothing off limits" here means *complete Anki→RemNote coverage*, not a plugin-wide audit.

**Role:** You are the implementing engineer. Repo: `/Users/HQ/Documents/Codex/RemNoteConnect`. pnpm, git. Never print/log/commit the daemon token. Build order below is gated — do not skip Gate-0.

---

## 0. Dependency chain (state this out loud; it is the most important line here)

The prompt in Part C is only "flawless" **after** three things land, in order:

1. **Reliability plan lands** (`docs/codex-bridge-reliability-plan.md`). A 10k–100k-card migration on the *synchronous* `bridge.runJob` path would be murdered by the exact reconnect storm that plan fixes. **The migration MUST ride the durable async path** (`createFlashcardsAsync` / `importAsync` → `jobWait` / `jobStatus`), which already re-queues and resumes from `job.cursor` across reconnects (`durableJobs.ts:140-196`). Non-negotiable.
2. **This capability build lands** (Part A). Cloze, HTML fields, math, media, note-type mapping, and the AnkiConnect reader do not exist yet.
3. **Then** Part C runs.

**Fresh start is a gift.** The user chose no scheduling/review-history carryover. That removes an entire hard subsystem — do **not** write any scheduling/interval/ease/due-date write code. Cards enter RemNote's scheduler unseen.

---

## 1. Ground truth: what exists vs. what to build (verified against `@remnote/plugin-sdk@0.0.46` + current executor)

| Capability | Status today | Source of truth |
|---|---|---|
| Front/back flashcards, deck path, tags | **Exists** | `executor.ts:580 createFlashcard`, `addTags` |
| Bidirectional cards | **Exists** — `practiceDirection: "both"` | `executor.ts:607` |
| Custom fields → Rem properties | **Exists** — `setTagPropertyValue` / `setPowerupProperty` | `executor.ts:452,456` |
| AnkiConnect-shaped note ingest (Front/Back) | **Partial** — `ankiNoteToFlashcard` maps Front/Back only | `executor.ts:561` |
| Durable, resumable bulk create | **Exists** | `durableJobs.ts`, `jobStore.ts` |
| **HTML fields → rich text** | **Native SDK method exists, not wired** — `richText.parseAndInsertHtml(html, rem)` | `rich_text.d.ts:192` |
| **Cloze write** | **Public path exists, not wired** — `applyTextFormatToRange(text,start,end,'cloze')`; `RichTextFormatName` includes `'cloze'` | `rich_text.d.ts:101`, `interfaces.d.ts:48` |
| **LaTeX / math** | **SDK supports** — `richText.latex(text, block)` | `rich_text.d.ts:31` |
| **Media (image/audio) from local files** | **No upload API** — elements take a **URL** only | grep: no `uploadFile`/`storage` write in SDK |
| **AnkiConnect reader (`:8765`)** | **Does not exist** — nothing calls Anki | — |
| **Deck → Document (not just folder)** | **Gap** — `ensurePath(..., {finalAsFolder:true})` hangs cards in a *folder*, not a Document | `executor.ts:598` |

**Takeaway:** the SDK does most of the heavy lifting (`parseAndInsertHtml`, `latex`, `applyTextFormatToRange` with `'cloze'`). The build is mostly (a) an AnkiConnect reader/orchestrator, (b) wiring cloze + HTML + media + structure, (c) a note-type mapping table. Lighter than a from-scratch converter — but two claims are type-level and must be proven at runtime first.

---

## 2. Gate-0 — runtime probes (BLOCKING, run before writing any migration code)

Type definitions are the grants-level claim; a materialized card is the runtime claim (same trap as `doctor`/`scopeProbe`). Use the `__codex_*` disposable-rem harness: create → assert → **soft-delete** (never hard-delete). Restart the daemon if the irreversible budget is spent. Do **not** proceed to §3 until all four resolve.

- **P1 — Cloze actually materializes.** Create a disposable Rem, set text, call `applyTextFormatToRange(text, start, end, 'cloze')` over a token, read back, and assert a **`ClozeCard` (CardType = 5)** formed (`card.d.ts:42`, `interfaces.d.ts:1670`). Then probe Anki's multi-cloze grouping: does one line with two cloze spans produce **two** cards (Anki c1/c2 semantics) or one? Record the answer — it drives the cloze mapping in §3.4. **If cloze cannot be written via the SDK, stop and tell the user** — cloze is a large fraction of most collections and "full fidelity" changes shape.
- **P2 — `parseAndInsertHtml` fidelity.** Insert a representative Anki field: `<b>`, `<ul><li>`, `<img src="x.jpg">`, MathJax (`<anki-mathjax>` and `\(…\)`), `[sound:a.mp3]`. Read back via `toHTML`/`toMarkdown`. Record what survives, especially **how `<img>` is resolved** (does RemNote fetch/host it, or leave a broken ref?) and whether math needs manual `richText.latex` mapping.
- **P3 — Media reachability.** Set an image element with (a) a `data:` URI and (b) a daemon-served URL (`http://127.0.0.1:8766/media/<sha>`). Read back, confirm which renders. This decides the media strategy in §3.5.
- **P4 — Deck-as-Document.** Confirm whether a deck path can terminate in a **Document** containing cards (not a folder). If `ensurePath` has no `finalAsDocument`, that is the concrete gap for §3.6.

Write probe results into `docs/anki-migration-probes.md` so the build decisions are traceable.

---

## 3. Build items (each gated on its probe)

### 3.1 AnkiConnect ingest orchestrator — new `scripts/anki-migrate.mjs`
- Read-only from Anki via AnkiConnect `:8765`: `deckNames`, `deckNamesAndIds`, `findNotes "deck:*"`, `notesInfo`, `findCards`, `cardsInfo`, `modelNames`, `modelFieldNames`, `modelTemplates`, `retrieveMediaFile`.
- Drive RemNoteConnect **only through the durable async path** (`importAsync`/`createFlashcardsAsync` + `jobWait`). Never per-card sync `runJob`.
- Idempotent: key every card by its Anki **note GUID** → `externalId` (the daemon's `externalId → existingRemId` index already dedupes, `server.ts:329`). A second run creates zero duplicates.
- Configurable, dry-run-first, resumable (persist a cursor of processed GUIDs so a crash resumes, mirroring `jobStore`).

### 3.2 Note-type → RemNote card-type mapping (table-driven, overridable)
| Anki note type | RemNote mapping |
|---|---|
| Basic | forward card (`practiceDirection:"forward"`) |
| Basic (and reversed) / (optional reversed) | **both** (`practiceDirection:"both"`) |
| Cloze | cloze card(s) via §3.4 |
| Custom multi-field | first field = front, second = back; **remaining fields → child Rems or Rem properties** (§3.2 uses `setPowerupProperty`), never silently dropped |
- Expose the mapping as a JSON table the prompt can override per note type. Unknown note types fall back to "concatenate fields as labeled child rems" and are **reported**, not dropped.

### 3.3 HTML fields → rich text (use the native path)
- Feed each Anki field's **HTML** to `richText.parseAndInsertHtml(html, rem)` rather than hand-rolling a converter. Pre-rewrite media `src` (see §3.5) before insertion.
- Strip Anki-specific noise (card-template conditionals `{{#Field}}`, `{{FrontSide}}`) before insert.

### 3.4 Cloze conversion
- Transform Anki `{{c1::answer::hint}}` markers: insert the plain text, then apply `'cloze'` format over each answer span via `applyTextFormatToRange`; carry the hint into `CLOZE_HINT` if P1 shows it is honored.
- Map Anki cloze **grouping** (c1/c2/c3 = separate cards) to whatever P1 proved RemNote does. If RemNote can't replicate per-group cards on one Rem, split into one Rem per cloze group and **document the divergence**.

### 3.5 Media pipeline (decision tree from P2/P3)
- For each referenced asset: `retrieveMediaFile` (base64) → write to a content-addressed store → rewrite the `<img>/<audio>` `src` before HTML insert.
- **Preferred host:** the daemon (already Fastify) serves `GET /media/<sha>` from that store; rich text references `http://127.0.0.1:8766/media/<sha>`.
- **Caveat to state in output:** a daemon-local URL **404s on any other device** the RemNote graph syncs to. If P3 shows `data:` URIs render, prefer them for portability (accept graph-size cost); otherwise document that media is host-local and offer a re-host step.

### 3.6 Deck structure materialization (implements Part B)
- Add a `finalAsDocument` option to `ensurePath` (or a sibling helper) so a card-bearing leaf deck terminates in a **Document**, while grouping-only decks stay **Folders**. This is the concrete change behind Part B.

### 3.7 Safety posture for the migration
- This is **real user data**, not test data: **no `__codex_*` names, no cleanup deletes.** Verification is by count reconciliation, not teardown.
- All bulk creation is dry-run-first (`shouldDefaultDryRun`); the prompt passes `confirm:true` + `confirmCount` after reviewing the dry-run. Additive-only — nothing in Anki is modified or deleted.

**Acceptance (Part A):** for each card type (basic, reversed, cloze, multi-field, media, math) a round-trip fidelity check passes; per-deck card counts match Anki; a second full run adds **zero** rems; structure matches Part B.

---

## 4. Part B — Recommended structure mapping (grounded in RemNote's model)

RemNote's primitives: **Folder** (organizational container, `isFolder`), **Document** (the unit you open and study, `isDocument`), **Rem** (bullet / flashcard), **Tag** (itself a Rem), **Property/Powerup** (structured fields). You can practice a single Document *or* any Folder subtree.

**Recommendation — mirror the deck tree onto folders; leaf decks become Documents:**

- **Card-bearing leaf deck → a single Document** named after the deck, holding that deck's cards. (Matches your NATO example exactly: `NATO` → one Document of NATO-alphabet flashcards.)
- **Grouping-only deck (has sub-decks, no cards of its own) → a Folder**, nesting its children. `Languages::Spanish::Verbs` → Folder `Languages` › Folder `Spanish` › Document `Verbs`.
- **Deck with both its own cards and sub-decks → a Folder** named after the deck, containing a Document (`<deck>` cards) for its own cards **plus** the child Folders/Documents. Nothing is orphaned.
- **Top-level container:** one Folder (default `Anki Import`, configurable) so the whole migration is reviewable and reversible as a unit.
- **Tags:** Anki note tags → RemNote **Tags** (deduped; nested Anki tags `a::b` → nested tag rems).
- **Fields:** extra note-type fields → **Rem properties / labeled child rems**, never flattened away.

Why this and not flat documents: it preserves the hierarchy's meaning, lets you study one deck or a whole branch, and keeps organization (Folders) separate from study units (Documents) — the idiomatic RemNote split. It costs one small code change (§3.6).

---

## 5. Part C — The migration prompt (paste into Codex once §0's chain is satisfied)

> Copy everything in the block below. It is generic across any Anki collection; the NATO deck is the built-in smoke test.

```text
TASK: Migrate my entire Anki collection into RemNote via the RemNoteConnect plugin, full fidelity, additive-only.

PRECONDITIONS — verify all before touching data; abort with a clear message if any fails:
1. Anki is open with the AnkiConnect add-on responding on http://127.0.0.1:8765
   (POST {"action":"version","version":6} returns >= 6).
2. The RemNoteConnect daemon is running and `doctor` returns ok:true AND scopeProbe.ok:true
   (whole-KB scope is actually granted, not just requested).
3. `describe` confirms the plugin build includes: parseAndInsertHtml wiring, cloze write,
   media pipeline, note-type mapping, and finalAsDocument. If any is missing, STOP and say which —
   do not attempt a degraded migration.

READ FROM ANKI (read-only, never modify Anki):
- Enumerate decks (deckNamesAndIds), note types (modelNames + modelFieldNames + modelTemplates),
  all notes (findNotes "deck:*" -> notesInfo), and all referenced media.
- Preserve each note's GUID as the migration key.

STRUCTURE (mirror the deck tree):
- Card-bearing leaf deck  -> one RemNote Document named after the deck, holding its cards.
- Grouping-only deck      -> a Folder nesting its children.
- Deck with cards + subdecks -> a Folder named after the deck, containing a Document for its own
  cards plus the child folders/documents.
- Put everything under a top-level Folder "Anki Import" (tell me if you want a different root).
- Nested Anki tags (a::b) -> nested RemNote tags. Anki note tags -> RemNote tags on each card.

CARD-TYPE MAPPING (full fidelity, nothing dropped):
- Basic                         -> forward card.
- Basic (and reversed) / optional reversed -> bidirectional (practiceDirection "both").
- Cloze ({{cN::text::hint}})    -> RemNote cloze cards; preserve cloze grouping (c1/c2/c3 as
  separate cards) and hints; if RemNote can't replicate a grouping exactly, split into one Rem per
  group and note the divergence in the report.
- Custom multi-field note types -> front = primary field, back = answer field, every remaining field
  -> a labeled child Rem or Rem property. Never flatten a field away.
- Field HTML (bold, lists, tables, links, <img>, MathJax/LaTeX) -> insert via the native HTML path;
  map math to RemNote LaTeX; embed media per the media rule below.

MEDIA:
- For each image/audio asset, retrieve it from Anki, store it, and reference it so it renders in
  RemNote. If media is served from the local daemon, WARN me that those assets are host-local and
  will not render on other synced devices, and offer a portable (data-URI or re-host) option.

EXECUTION DISCIPLINE (this is a large job — do it resumably):
- Use ONLY the durable async path (importAsync / createFlashcardsAsync + jobWait/jobStatus).
  Never create cards one-by-one on the synchronous path.
- Idempotent: key every card by Anki GUID -> externalId so re-running creates ZERO duplicates.
- Dry-run first: show me per-deck counts and a sample of 5 converted cards (including one cloze, one
  media, one reversed, one multi-field). Wait for my "go" before passing confirm:true + confirmCount.
- Stream progress. On any bridge drop, resume from the cursor — do not restart from zero.
- Additive only: never modify or delete anything in Anki or pre-existing RemNote content.

VERIFY (reconciliation, not teardown — this is real data):
- After completion, report: decks migrated, documents/folders created, cards created per deck,
  cards by type (forward/both/cloze/multi-field), media embedded, and any notes that fell back or
  diverged (with reasons).
- Assert per-deck RemNote card counts match Anki note/card counts; list any mismatch explicitly.
- Re-run the whole migration once and confirm it adds 0 new rems (idempotency proof).

SMOKE TEST FIRST (do this before the full run):
- Migrate ONLY the "NATO" deck. Confirm it becomes a single RemNote Document containing the full
  NATO alphabet as well-formed forward flashcards, correctly tagged, zero duplicates on re-run.
  Show me the result. Only after I approve, run the full collection.

If anything is ambiguous or a card can't be mapped without loss, STOP and ask — do not guess and do
not silently drop content.
```

---

## 6. Build order (gates, not suggestions)

1. **§0 chain check** — reliability plan merged; migration will use the async path.
2. **Gate-0 probes (§2)** — cloze-write, HTML fidelity, media reachability, deck-as-document. Results written to `docs/anki-migration-probes.md`.
3. **Build §3.1–3.6** in that order; each gated on its probe.
4. **§3 acceptance** — round-trip fidelity per card type + count reconciliation + zero-dup re-run.
5. **Part C smoke test (NATO)** → full-collection run.

Do not hand the user the Part C prompt until steps 1–4 pass. The prompt promises "flawless"; that promise is only true once the capability build is real.
