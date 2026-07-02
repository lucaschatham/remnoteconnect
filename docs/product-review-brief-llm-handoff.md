# RemNoteConnect Product Review Brief For A Stronger LLM

Use this brief to review the current RemNoteConnect implementation and propose the next architecture for an LLM-swappable, clean, searchable RemNote learning system.

Repository: `/Users/HQ/Documents/Codex/RemNoteConnect`

Current known repo state:

- Branch: `main`
- Latest hardening commit: `f5f5638 feat: harden RemNoteConnect live bridge`
- Tag: `remnoteconnect-wrapup-20260701`
- At wrap-up, the working tree was clean.
- Runtime daemon: `http://127.0.0.1:8766`
- Runtime plugin bundle: `http://127.0.0.1:8080`
- LaunchAgent label: `com.local.remnoteconnect.daemon`
- App dir: `~/Library/Application Support/RemNoteConnect`
- Logs: `~/Library/Logs/RemNoteConnect`
- Backups: `~/Documents/RemNoteConnect/Backups`

Do not print, paste, log, or commit the daemon token. The token authorizes whole-knowledge-base RemNote access.

## 1. User Product Goal

The user wants RemNote to become a flexible personal learning graph controlled by any competent LLM through a stable local interface.

Product intent:

- Make it hyper-easy to swap the LLM that interacts with RemNote.
- Keep RemNote as the canonical knowledge graph, not a pile of generated artifacts.
- Maintain a clean database: few empty notes, misspelled titles, duplicates, partial imports, orphaned cards, and stale "edit later" flashcards.
- Prefer a unified graph over rigid top-level domain folders.
- Preserve intentional naming choices; only suggest likely typos or cleanup candidates for human approval.
- Support bidirectional linking, aliases, source context, study guides, atomic concepts, and flashcard-heavy pages.
- Add a simple semantic/vector-search layer similar in spirit to vector search over an Obsidian markdown vault, but adapted to RemNote's API and graph model.
- Help the user retain knowledge, connect ideas, and write/research faster across domains.

The user wants all major LLM workflows:

- Add notes and documents.
- Create flashcards when explicitly asked.
- Search and summarize the whole graph.
- Map relationships and suggest links.
- Clean up notes/cards in bulk.
- Track learning progress.
- Recommend what to study or connect next.

Authority model:

- The bridge may have read and write access.
- The LLM should not run broad cleanup autonomously without approval.
- Target operating mode is "approval-gated autonomy": the LLM can inspect, draft, dry-run, and propose exact changes, then the user signs off before writes or cleanup.

Primary interface:

- CLI-first, because a CLI works from Codex, terminal, local scripts, cloud runners, and future tool wrappers.
- HTTP remains underneath.
- MCP or other tool schemas can be thin shims later, but the stable CLI/HTTP contract should be the base for LLM-agnostic operation.

## 2. User Knowledge Model

The user does not yet know their ideal top-level domains. Do not impose a rigid folder taxonomy up front.

Preferred structure:

- One unified graph.
- Strong bidirectional links.
- Aliases for concepts with multiple names.
- Source notes linked to concepts.
- Study guides that collect and explain concepts.
- Flashcards linked back to source context and parent documents.

Good RemNote documents:

- Outline notes with meaningful hierarchy.
- Atomic concepts.
- Source notes.
- Study guides.
- Flashcard-heavy pages when useful.
- Strong bidirectional links.
- Aliases for equivalent names or common variants.

Bad or ugly RemNote content:

- Empty titles.
- Clearly misspelled titles.
- Duplicate titles or duplicate concepts.
- Orphaned Rem with no useful relationship.
- Flashcards or notes sent to "edit later" and never cleaned up.
- Partial generated notes or cards that are hard to review.

Naming convention policy:

- Do not mass-edit names merely to make them uniform.
- Preserve intentional user naming.
- Detect high-confidence typos, for example `htoel` likely intended as `hotel`, but present changes for sign-off before renaming.
- Prefer "suggested cleanup queue" over automatic rewrite.

## 3. Flashcard Policy

The flashcard policy should align with RemNote's native flashcard model, not invent a separate Anki-style policy layer.

Current policy:

- The LLM should create flashcards only when asked.
- Default to simple front/back cards.
- Prefer RemNote-native Concept and Descriptor cards where they make the surrounding note clearer.
- Use cloze cards when the thing being learned is naturally a missing phrase, quote component, formula part, sequence marker, or other context-dependent blank.
- Use multi-line, list-answer, or set-style cards only when the answer is genuinely a short set/list and the list itself is worth practicing.
- Use image occlusion where visual recall is the natural task: diagrams, anatomy, maps, charts, UI screenshots, workflows, architecture diagrams, formulas-as-layouts, or other image-heavy concepts.
- Keep each card focused on one atomic idea.
- Flashcards should preserve source context and links back to documents.
- Nest cards under their source concept or source note when that improves context.
- Avoid overlong backs. Put nonessential examples, caveats, source context, related links, and synonyms into RemNote-native supporting context such as child bullets or Extra Card Detail when available, rather than bloating the tested answer.
- Weak cards should be merged or deleted only with confirmation.
- Duplicate flashcards should be found, reviewed, merged, and then tombstoned/deleted through the safety path.
- The system should support card quality audits before generating or modifying cards.

RemNote-native card structure to follow:

- Basic/front-back cards for ordinary Q&A.
- Concept cards for terms and definitions.
- Descriptor cards for attributes of a parent concept.
- Cloze cards for fill-in-the-blank practice.
- Multi-line/list/set cards for short answer sets.
- Image occlusion cards for visual subjects where the image itself carries the thing being tested.
- Direction should follow the learning goal: forward by default, bidirectional only when both directions are genuinely useful.

Obsidian context:

- The user's Obsidian flashcard convention emphasized fast `Question::Answer` capture, nested under `[[Concept]]` headings, with tags and links for context.
- The only Obsidian flashcard plugin in use is Obsidian_to_Anki.
- This matters for migration, but RemNote should be the destination model. When moving or recreating cards in RemNote, map Obsidian-style `::` captures into RemNote-native card types rather than preserving Obsidian formatting as an implementation constraint.

Official RemNote references for the reviewer:

- RemNote's Basic, Concept, Descriptor, and Cloze cards are described in [Creating Flashcards](https://help.remnote.com/en/articles/6025481-creating-flashcards).
- RemNote's text-import syntax supports Basic, Cloze, Multi-line, List-answer, Multiple-choice, Concept, and Descriptor cards. Source: [How to Import Flashcards from Text](https://help.remnote.com/en/articles/9252072-how-to-import-flashcards-from-text).
- Multi-line/list/set cards are useful for short sets or ordered lists, but RemNote's docs warn that long lists are difficult to remember and should be used deliberately. Source: [Multi-Line Flashcards](https://help.remnote.com/en/articles/9216774-multi-line-list-set-flashcards).
- Extra Card Detail can hold supplementary context, examples, misconceptions, synonyms, or related material without making the tested answer too large. Source: [Extra Card Detail Power-Up](https://help.remnote.com/en/articles/6751966-extra-card-detail-power-up).
- Image occlusion can turn diagrams, maps, and other visual material into cards by hiding parts of an image. Treat it as an appropriate visual-learning tool, not a general default. Source: [Image Occlusion Cards](https://help.remnote.com/en/articles/6511625-image-occlusion-cards).

## 4. What RemNote Is

Ground this section in official RemNote docs rather than assumptions.

RemNote is an outliner and spaced-repetition knowledge base built around "Rem" objects. A Rem can be a bullet, document, folder, concept, tag, property, source, card-bearing item, or other graph object depending on metadata and relationships.

Key official concepts:

- RemNote organizes content as hierarchies of Rem. Official docs say each top-level Rem creates a hierarchy, and hierarchies can be connected by references, tags, and portals. Source: [Outlines and Terminology](https://help.remnote.com/en/articles/8196578-outlines-and-terminology).
- References create bidirectional links and are used for RemNote's knowledge graph and related-card behavior. Renaming a Rem updates its references. Source: [Rem References](https://help.remnote.com/en/articles/6030714-rem-references).
- Tags, references, and portals are distinct graph mechanisms: references link to another Rem, tags categorize a Rem as a type/category, and portals show another Rem's content in a different context. Source: [What's the difference between References, Tags, and Portals?](https://help.remnote.com/en/articles/6634227-what-s-the-difference-between-references-tags-and-portals).
- Backlinks show where a Rem is referenced. Text references can find mentions without explicit links, but official docs note a 100-result limit for that text-reference search due to performance. Source: [Backlinks](https://help.remnote.com/en/articles/6030776-backlinks).
- RemNote flashcards can be controlled by document priority, individual enable/disable state, and descendant-card settings. Source: [Setting Priorities and Disabling Flashcards](https://help.remnote.com/en/articles/7950982-setting-priorities-and-disabling-flashcards).
- Properties define structured information for tagged Rem and table columns. Source: [Properties](https://help.remnote.com/en/articles/8126585-properties).

Plugin/API constraints:

- RemNote currently says it does not host a backend API; plugins should use the frontend API. Source: [Backend Plugins](https://plugins.remnote.com/advanced/backend_plugins).
- Local plugin development loads from `http://localhost:8080`. Source: [Quick Start Guide](https://plugins.remnote.com/getting-started/quick_start_guide).
- The plugin API provides Rem creation and lookup methods such as `createRem`, `findOne`, and `findMany`. It also rate-limits creation; official docs say creating 1,000 Rem takes roughly 25 seconds. Source: [The Rem API](https://plugins.remnote.com/advanced/rem_api).
- Plugin permissions are scoped; sandboxed plugins can only access private user data through the API and granted permission scopes. Source: [Permissions](https://plugins.remnote.com/advanced/permissions).
- The plugin search API supports ID/name/text search through methods such as `findOne`, `findMany`, `findByName`, and `plugin.search.search`. Source: [Search](https://plugins.remnote.com/advanced/search).

Database model caveat:

- Do not assume direct access to RemNote's private local database. Treat the official plugin SDK as the supported contract.
- RemNote is not like Obsidian's folder of markdown files. A sidecar vector index must be built by exporting or traversing Rem via RemNoteConnect, then mapping index entries back to stable Rem IDs.
- RemNote object IDs, rich text, properties, tags, portals, references, and card scheduling are application data. Some can be accessed through the SDK; some behavior is only partially exposed or must be probed live.

## 5. What RemNoteConnect Does

RemNoteConnect is a private local Mac bridge that gives terminal tools and LLMs an AnkiConnect-inspired control surface for RemNote.

It ships two layers:

- A local Node daemon bound to `127.0.0.1:8766`.
- A RemNote frontend plugin loaded from `http://127.0.0.1:8080`.

Why this shape exists:

- RemNote does not offer a hosted/backend API for direct external mutation.
- The plugin must execute SDK reads/writes inside RemNote.
- The daemon provides stable local HTTP, token auth, job queueing, logs, backup/undo storage, CLI access, and safety gates.

Major implemented capabilities:

- Whole-KB RemNote plugin scope: `All / ReadCreateModifyDelete`.
- Token-authenticated HTTP envelope: `{ action, version, params } -> { result, error }`.
- CLI-first interface in `scripts/rnc.mjs`.
- Agent discovery through `describe`.
- Runtime checks through `doctor`, `status`, `metrics`, and `scopeProbe`.
- Whole-graph map/search/get primitives: `map`, `searchGraph`, `getRem`, `findByTag`.
- Markdown-first document authoring: `createDocument`, `getDocument`, `appendToDocument`.
- Flashcard actions: `createFlashcard`, `createFlashcards`, `updateFlashcard`, `searchFlashcards`, Anki-inspired `addNote` and `addNotes`.
- Cleanup actions: `findDuplicates`, `findEmpty`, `findOrphans`, `normalizeText`, `bulkMove`, `bulkRetag`, `bulkDelete`, `mergeRems`.
- Safety actions: `deleteRem`, `dryRunDelete`, `listTombstones`, `emptyTrash`, `undo`, `undoClear`, `journalTail`, `backupGraph`.
- Durable async jobs: `createFlashcardsAsync`, `importAsync`, `jobWait`, `confirmMaterialized`.
- Daemon-side external ID index to avoid graph pollution from idempotency tags.

Current plugin identity:

- Manifest ID: `remnoteconnect-codex-local-v3`
- Name: `RemNoteConnect Codex Bridge`
- Version: `0.2.0`
- Expected RemNote local plugin URL: `http://127.0.0.1:8080`

## 6. Safety Model

This tool has whole-KB write authority after RemNote grants the plugin scope. Safety cannot rely on "only under one folder" anymore.

Core invariant:

- Reversibility before capability.

Implemented safety model:

- Soft delete means move Rem to `RemNoteConnect/Trash/<opId>/`, preserving Rem IDs.
- `rem.remove()` is reserved for `emptyTrash`.
- Destructive, bulk, and graph-wide actions are dry-run-first.
- Operations resolving more than 50 targets require exact `confirmCount`.
- Irreversible operations require `fromDryRun:<hash>` from a prior dry run.
- Irreversible operations consume an in-memory session budget of 3.
- Resetting that budget requires `reconfirmIrreversibleBudget` with the exact phrase `I understand irreversible RemNote operations cannot be undone`.
- Audit logs are content-free.
- Undo records are local, mode `0600`, and hold full prior state needed for undo.
- Snapshot restore is disaster recovery only: it recreates copies with new IDs and does not preserve inbound references, portals, or scheduling history.

Reviewer task:

- Audit whether every write path obeys this model.
- Verify no hidden path can hard-delete Rem outside `emptyTrash`.
- Verify undo restores parent, sibling order, rich text, tags, properties, children, and reference rewrites where applicable.

## 7. What Worked

Final wrap-up validation reported:

- Bridge connected: `true`
- Active plugin connections: `1`
- Pending jobs: `0`
- Visible tombstones: `0`
- Disposable `__codex_*` residue count: `0`
- No token-shaped secrets found in source/build/test artifacts by `check-no-token`

Live/static checks run during hardening:

- TypeScript checks for shared, daemon, and plugin.
- Plugin unit tests.
- Daemon unit tests.
- Build.
- Token scan.
- `doctor`
- `live-security`
- `live-scope`
- `live-softdelete`
- `live-docs`
- `live-cleanup`
- `live-idempotent`
- `live-restore`
- `scheduler-smoke`
- `job-retention 520`
- `chaos-daemon`
- `chaos-async-job`
- `e2e`
- `bench 500`
- Three-pass determinism loop across E2E, benchmark, and async chaos.

Important caveat:

- The local pnpm/npx wrapper in this desktop shell repeatedly tried production-install behavior. Some final static checks were run through direct package-local tools instead of the exact README commands. Re-run checks in a normal terminal before relying on release status.

## 8. Known Limitations

Product limitations:

- Top-level domain taxonomy is not defined yet and should be discovered from the graph, not imposed.
- Semantic/vector search is not implemented yet.
- Cross-device free search is unresolved. A local Mac sidecar index is easy; free, fresh, usable search across Mac/iPad/iPhone is a product architecture decision.
- Approval UX is CLI-based now; there is no polished review dashboard for proposed cleanup changes.

Technical limitations:

- The plugin SDK is the access boundary. Direct DB access is unsupported and should not be used as the primary integration path.
- Whole-graph search currently relies on graph traversal/API search rather than a persistent semantic index.
- Some rich-text/portal/table/image/property behavior depends on SDK support and live probes.
- Scheduler mutation is only smoke-tested; direct review-log parity with Anki is not the goal.
- RemNote sync timing across devices is outside this repo's control.
- The daily driver runs on the Mac. RemNote iOS cannot run the local Mac daemon unless the product adds a syncable sidecar interface.

## 9. Desired Semantic Search Direction

The user wants "a simple version" of Obsidian-like vector search over the bidirectional graph, but RemNote is not markdown files.

Recommended architecture to review:

- Keep RemNote canonical.
- Add a local sidecar index generated by RemNoteConnect graph traversal.
- Store one record per meaningful Rem/document/card/chunk:
  - stable Rem ID
  - title/text excerpt
  - parent path
  - aliases
  - tags
  - references/backlinks if accessible
  - source document
  - card status/priority where accessible
  - updated timestamp or content hash
  - embedding vector
- Use free/local embeddings only.
- Store sidecar data outside RemNote to avoid graph pollution.
- Rebuild on demand and/or background sync.
- Expose search through the CLI:
  - `rnc semantic-search "query"`
  - `rnc related <remId>`
  - `rnc suggest-links <remId>`
  - `rnc cleanup-candidates`
- All write suggestions from semantic search must be dry-run proposals until user approval.

Cross-device problem to solve:

- If the index lives only on the Mac, Mac CLI/Codex can use it, but iPhone/iPad RemNote cannot.
- If the index is stored in iCloud Drive, devices can sync files, but iOS still needs a reader UI or app shortcut to query it.
- If the index is embedded back into RemNote, it pollutes the graph and adds sync/load overhead.
- The reviewer should propose a free architecture that is honest about these tradeoffs.

## 10. Cleanup Product Requirements

The user wants a clean database without erasing intentional structure.

Recommended cleanup workflow:

1. Scan.
2. Group issues.
3. Explain why each item is likely a problem.
4. Dry-run exact proposed changes.
5. Ask for sign-off.
6. Apply reversible changes.
7. Provide an audit summary.
8. Leave zero test/generated residue.

Cleanup categories:

- Empty titles.
- Misspelled titles with high confidence.
- Duplicate titles.
- Duplicate concepts with different names.
- Duplicate flashcards.
- Stale "edit later" items.
- Orphaned Rem.
- Weak cards.
- Unlinked source notes.
- Overly broad generated documents.
- Imported Anki/Obsidian artifacts that should be normalized.

Never do:

- Mass rename based on style preference alone.
- Delete or merge concepts without a dry-run and approval.
- Hide broad changes inside a generic "cleanup" command.
- Write idempotency/search metadata as visible tags unless the user explicitly chooses graph-visible metadata.

## 11. Instructions The User Still Needs To Provide

Ask the user for these before designing the next major phase:

- Whether RemNote or Obsidian is the source of truth for each learning domain.
- Whether sidecar indexes can live in iCloud Drive.
- Whether any RemNote areas should be private/read-only forever.
- How much cleanup should be reviewed at once: 10, 25, 50, or 100 proposed changes.
- What a weekly learning review should contain.
- Whether the user wants a visual review UI, or CLI-only approval is enough.
- Whether local-only embeddings are acceptable if iOS can only see search results after Mac sync or through a separate file/report.
- Which metrics define "clean database": duplicate rate, orphan count, empty-title count, stale-edit-later count, weak-card count, average review load, graph-link density, or something else.
- Whether flashcards should prioritize retention, writing/research reuse, exams, career skills, behavior change, or all of those with adjustable weights.

Sane defaults if the user does not answer:

- RemNote is canonical for active learning.
- Obsidian remains a source and archive, not the main runtime graph.
- Approval batch size: 25 proposed changes.
- Sidecar index lives under `~/Library/Application Support/RemNoteConnect/index` with optional export to iCloud Drive.
- Free local embeddings only.
- Cleanup is suggestion-first and dry-run-first.
- No broad autonomous edits without human sign-off.

## 12. Review Tasks For The Stronger LLM

Review the current implementation for:

1. Security
   - Token leakage.
   - CORS/Origin/Host handling.
   - Plugin WebSocket auth.
   - Whole-KB permission risk.

2. Safety
   - Reversibility of every mutating path.
   - Hard-delete isolation.
   - Dry-run and confirm-count enforcement.
   - Undo record completeness.

3. Reliability
   - Bridge reconnect behavior.
   - Durable job resume semantics.
   - Failure modes when RemNote restarts.
   - Failure modes when the daemon restarts.

4. Product fit
   - Whether the CLI/API contract is actually LLM-agnostic.
   - Whether outputs are token-cheap enough.
   - Whether approval gates are ergonomic.
   - Whether the current cleanup primitives map to the user's real goals.

5. RemNote fidelity
   - References.
   - Tags.
   - Portals.
   - Properties.
   - Flashcard direction/practice state.
   - Source context.
   - Markdown round-trip limitations.

6. Semantic search design
   - Free local embeddings.
   - Index freshness.
   - Cross-device story.
   - Rem ID mapping.
   - Graph-aware retrieval.
   - No graph pollution.

7. Database hygiene
   - Naming suggestions without mass rewriting.
   - Duplicate detection.
   - Orphan detection.
   - Weak-card audit.
   - Stale generated/imported artifact detection.

## 13. Concrete Next Build Proposal

The next phase should not start with more write actions. It should start with read-only intelligence and approval UX:

1. Add `rnc export-index --format jsonl`
   - Exports normalized graph chunks without modifying RemNote.

2. Add local embeddings
   - Free/local model.
   - Store vectors sidecar.
   - No visible RemNote tags.

3. Add `rnc semantic-search`
   - Query local sidecar.
   - Return Rem IDs, titles, paths, snippets, and why each matched.

4. Add `rnc suggest-links`
   - Given a Rem/document, suggest possible references/aliases.
   - Dry-run only at first.

5. Add `rnc cleanup-report`
   - Finds empty titles, likely typos, duplicates, orphan candidates, weak-card candidates.
   - Produces a reviewable report, not edits.

6. Add `rnc apply-cleanup-plan`
   - Applies only an approved plan file.
   - Uses existing soft-delete/undo/magnitude/audit machinery.

7. Add weekly learning report
   - New/changed Rem.
   - Cards created.
   - Weak cards found.
   - High-value unlinked concepts.
   - Suggested next study/writing tasks.

Definition of done for this next phase:

- Zero writes during indexing/search/report generation.
- Search is useful on the real graph.
- Search output includes Rem IDs and enough context for the LLM to act through RemNoteConnect.
- Cleanup reports are precise enough for the user to approve or reject quickly.
- Any applied cleanup leaves undo records and a content-free audit trail.

## 14. Non-Negotiables

- Do not leak the daemon token.
- Do not bypass approval gates.
- Do not hard-delete real Rem outside `emptyTrash`.
- Do not mass-rename intentional user notes.
- Do not use RemNote visible tags for sidecar implementation details unless explicitly approved.
- Do not claim snapshot restore is true undo.
- Do not rely on RemNote private database internals as the primary integration contract.
- Do not let generated test data remain in the user's graph.
