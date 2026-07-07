# RemNoteConnect Readiness Checklist

Last updated: 2026-07-02

For the exact remaining approval phrases and write-window commands, see `docs/obsidian-remaining-write-runbook.md`.

For a one-command current-state audit, run `npm run obsidian:wrapup-audit`.

## Verified State

- RemNoteConnect is connected to RemNote through the local daemon/plugin bridge.
- Runtime status after the Obsidian transfer:
  - `readOnlyMode: true`
  - `bridge.connected: true`
  - `activeConnections: 1`
  - `pendingJobs: 0`
- Obsidian non-empty transfer is complete:
  - Strict pass: 1,219 documents and 10 flashcards.
  - Approval pass: 885 documents and 1 flashcard.
  - Combined live mirror: 2,104 documents and 11 strict flashcards.
  - Verification result: 2,115 planned external IDs mapped and live, 0 missing, 0 stale.
  - Content completeness result: 2,104 documents audited through live `getDocument(tree)`, 2,104 complete, 0 weak-source, 0 partial, 0 missing content, 0 missing Rem, 0 errors.
  - External-ID verification proves root identity/liveness; content completeness is the authoritative gate for source body preservation.
- Empty Obsidian placeholder notes are intentionally not mirrored:
  - Current clean plan skipped 591 empty Markdown files.
  - Empty-placeholder plan result: 414 linked graph anchors, 13 empty daily notes, and 164 orphan empty placeholders.
  - Optional linked-stub payload: 414 documents under `Obsidian Mirror/Empty Placeholders`; do not execute without explicit approval.
- Consolidated migration completion report:
  - Command: `npm run obsidian:completion`.
  - Current status: partial.
  - Gates complete: 2 of 7.
  - Complete gates: runtime and text transfer.
  - Open gates: flashcard review, native links, attachments, empty placeholder policy, and Needs Review cleanup.
- Consolidated review plan:
  - Command: `npm run obsidian:review-plan`.
  - Current status: PASS.
  - It turns the open gates into actionable samples and recommendations:
    - 99 flashcard candidates needing review.
    - 165 resolved attachments without verified native import.
    - 591 skipped empty placeholders, now split into linked anchors vs unlinked clutter by `npm run obsidian:empty-placeholders`.
    - 885 Needs Review documents.
    - 1,192 ambiguous links.
    - 5,233 unresolved links.
- Flashcard review plan:
  - Command: `npm run obsidian:flashcard-review-plan`.
  - Current status: PASS.
  - It classifies the 99 unimported card-like lines into 35 non-duplicate approval-payload cards, 6 duplicate candidate rows, 33 likely false positives, 15 rewrite/repair cases, and 10 manual-review rows.
  - Generated import payload: `docs/obsidian-flashcard-review-import-candidates.json`.
  - Do not import the payload without explicit approval, a fresh backup, and a read-only-off write window.
- Content repair was required after the first external-ID-only verifier proved too weak:
  - Initial content audit found many root-only documents whose source bodies had not materialized in RemNote.
  - Main repair appended recovered source content to 1,960 documents under `Recovered Obsidian Source`.
  - Follow-up repair appended recovered source content to 21 short-body documents that the earlier line-snippet audit missed.
  - Weak-source repair appended recovered source content to 71 tiny/low-signal documents so they can be verified by raw source-body presence.
  - All repair passes restored RemNoteConnect read-only mode afterward.
- Migration reports and payload files are local/private artifacts and are gitignored.
- Attachment inventory is complete and read-only:
  - 220 content attachment files found after excluding hidden/config folders.
  - 191 image attachments.
  - 173 real attachment references.
  - 166 resolved references.
  - 1 missing attachment reference: `3b3b0c6474f7ce7b3df05318d4a02d67.jpeg`.
  - 6 ambiguous image references involving duplicate `IMG_8804.jpeg`, `IMG_8806.jpeg`, and `IMG_8807.jpeg` paths.
  - 55 unreferenced content attachments.
- Attachment manifest is complete and read-only:
  - Command: `node scripts/obsidian-attachment-manifest.mjs`.
  - Resolved references hashed and mapped: 166.
  - Unique resolved attachments: 165.
  - Resolved attachment bytes: 295,986,531.
  - Source documents with resolved refs: 86.
  - Source documents mapped to live Rem IDs: 86.
  - Policy counts: 146 image refs, 13 PDF refs, 5 audio refs, 2 generic file refs.
  - Cross-device-safe native imports verified through SDK: 0.
  - Local daemon URL staging remains Mac-local only and is not suitable as the final iPhone/iPad-safe attachment answer.
- Attachment capability probe is complete and read-only:
  - Command: `npm run obsidian:attachment-capabilities`.
  - Current status: PASS.
  - URL media builders found in installed SDK: image, audio, video, parseAndInsertHtml, findAllExternalURLs.
  - Native file upload/attachment method candidates found: 0.
  - Image occlusion authoring method found: no.
  - Product implication: attachments cannot be called full-fidelity/cross-device migrated until a manual RemNote upload workflow or future native upload API is verified.
- Attachment transfer plan is complete and read-only:
  - Command: `npm run obsidian:attachment-transfer-plan`.
  - Current status: PASS.
  - Manual upload/source-reference queue items: 165.
  - Class split: 146 images, 12 PDFs, 5 audio files, 2 generic files.
  - Image occlusion candidates: 146.
  - High-priority manual items: 1.
  - Safety result: automated native upload is not currently supported; local daemon URLs are not valid final cross-device media.
- Link-normalization dry run is complete and read-only for the full imported mirror:
  - 2,104 imported source documents audited.
  - 1,408 imported documents contain Obsidian/Markdown links.
  - 12,974 link occurrences classified.
  - 4,252 ready native-reference candidates.
  - 5,233 unresolved links that need stub-or-plain-text policy.
  - 2,296 links resolved to source notes that were intentionally not imported, usually empty placeholders.
  - 1,192 ambiguous links that need approval.
  - 1 heading/block-level link that needs child-level mapping before exact conversion.
- Link-conversion batch planning is complete and guarded:
  - 4,252 high-confidence native-reference candidates exported.
  - 715 source documents represented.
  - 477 target documents represented.
  - 3,098 wikilink candidates.
  - 1,154 Markdown internal-link candidates.
  - 4,252 candidates have source line metadata.
  - `executableNow: 0` because root Rem IDs are known, but imported child Rem IDs and rich-text ranges are not mapped yet.
- Child-level mapping feasibility audit is complete and read-only:
  - 715 candidate source documents audited through live `getDocument(tree)` calls.
  - 4,252 conversion candidates checked.
  - 3,056 candidates uniquely matched to a current Rem child by raw/target/snippet text after source-body repair.
  - 715 candidates had ambiguous child matches.
  - 481 candidates did not match a current child with the current matcher.
  - 0 live read errors.
  - `executableNow: 0`; unique child mapping is still not enough for native-reference writes because the write path must prove a single raw occurrence, capture undo, and verify current rich text immediately before mutation.
- Native link execution plan is complete and read-only:
  - Command: `node scripts/obsidian-link-execution-plan.mjs`.
  - Total high-confidence candidates classified: 4,252.
  - Unique source-child candidates: 3,056.
  - Node-range-ready candidates: 840.
  - Not executable candidates: 3,412.
  - Source documents with node-range-ready candidates: 387.
  - Target documents represented by node-range-ready candidates: 316.
  - Blockers: 1,908 not-raw-link matches, 840 need write handler/undo/current-text verification, 715 ambiguous source child, 481 source child not found, 308 raw link not single occurrence in child.
  - `executableNow: 0` in the planner means no candidate bypasses the guarded write path.
- Guarded native link rewrite dry-run is complete and read-only:
  - Command: `npm run obsidian:link-rewrite`.
  - Result: PASS.
  - Selected node-range-ready candidates: 840.
  - Live current-text validation: 840 passed.
  - Blocked candidates: 0.
  - Mutations performed: 0, because the run was dry-run only.
  - Live execution is ready behind explicit approval with:
    - `node scripts/rnc.mjs readonly off`
    - `npm run obsidian:link-rewrite -- --execute --confirm --confirm-count 840`
  - The execution script refuses to run while read-only mode is still on and restores read-only mode afterward unless `--leave-writable` is passed.
- Needs Review triage queue is complete and read-only:
  - 885 `Obsidian Mirror/Needs Review` documents ranked.
  - 59 high-priority review notes.
  - 153 medium-priority review notes.
  - 673 low-priority review notes.
  - Queue includes per-note recommendations based on ambiguous links, unresolved links, target-not-imported links, attachment issues, large notes, embeds, duplicate titles, and preserved Markdown constructs.
- Needs Review cleanup plan is complete and read-only:
  - Command: `npm run obsidian:needs-review-cleanup`.
  - It classified all 885 Needs Review documents into cleanup lanes.
  - Current promotion candidates: 0.
  - Lanes: 247 unresolved-link policy, 171 empty-stub policy, 187 ambiguous-link review, 91 attachment-first, 74 title-cleanup, 115 manual-review.
  - Product implication: do not bulk-promote anything out of Needs Review until blockers are cleared.
- Migration completion report is complete and read-only:
  - Command: `npm run obsidian:completion`.
  - It consolidates runtime status, source census, content completeness, flashcards, attachments, native links, and Needs Review queues.
  - Current result: partial, 2/7 gates complete.
- Review-plan report is complete and read-only:
  - Command: `npm run obsidian:review-plan`.
  - It provides sample rows and recommended handling for flashcards, attachments, empty notes, Needs Review documents, ambiguous links, and unresolved links.
- Needs Review cleanup-plan report is complete and read-only:
  - Command: `npm run obsidian:needs-review-cleanup`.
  - It proves there are currently 0 blocker-free promotion candidates in Needs Review.
- Flashcard review-plan report is complete and read-only:
  - Command: `npm run obsidian:flashcard-review-plan`.
  - It creates an approval-ready cards-only payload while excluding duplicate rows and likely false positives.
- Attachment capability report is complete and read-only:
  - Command: `npm run obsidian:attachment-capabilities`.
  - It proves the current installed SDK surface has URL media builders but no native upload method.
- Attachment transfer-plan report is complete and read-only:
  - Command: `npm run obsidian:attachment-transfer-plan`.
  - It produces a manual upload/source-reference queue and confirms attachment migration cannot be marked cross-device complete yet.
- Empty-placeholder plan is complete and read-only:
  - Command: `npm run obsidian:empty-placeholders`.
  - It proves all 591 skipped placeholder source files still exist and remain empty.
  - It found 414 linked placeholders with 2,296 inbound links, 13 empty daily notes, and 164 orphan empty placeholders.
  - It generated a 414-document optional linked-stub payload but did not mutate RemNote.
- Approval packet is complete and read-only:
  - Command: `npm run obsidian:approval-packet`.
  - It consolidates exact remaining decisions and command windows.
  - Current ready decisions: 840 native-link rewrites, 35 reviewed flashcards, 414 linked empty-placeholder stubs, and 165 attachment manual/source-reference items.
  - Current blocked decision: Needs Review promotion, because 0 blocker-free candidates exist.
- Local search sidecar is complete and read-only:
  - Build command: `npm run obsidian:search-index`.
  - Query command: `npm run obsidian:search -- "query terms"`.
  - Current status: PASS.
  - Indexed documents: 2,104.
  - Documents mapped to live Rem IDs: 2,104.
  - Scope: local lexical search; no embeddings, no paid API, no RemNote mutation.
- Backup audit is complete and read-only:
  - Command: `npm run obsidian:backup-audit`.
  - Current status: PASS.
  - Usable graph backup: `/Users/HQ/Documents/RemNoteConnect/Backups/2026-07-02T11-10-47-607Z-graph-827856f61a.json`.
  - Latest graph backup exported at: 2026-07-02T11:10:44.346Z.
  - Latest known executed migration mutation: 2026-07-02T09:09:50.205Z.
  - Use this backup path only for the current reviewed-flashcard or empty-stub import execution window; create a new watched backup after any later mutation.
  - Fresh `backupGraph` attempt status: did not complete in the observed run, produced no new backup, left one pending bridge job, and required a daemon restart to clear it.
  - Follow-up hardening shipped: interrupted HTTP clients now clear daemon pending jobs as `aborted`, backup snapshot traversal emits plugin progress, and the local WebSocket bridge accepts large graph-backup payloads. A fresh watched backup completed successfully after this fix.
  - Current fresh-backup command: `node scripts/rnc.mjs backup-graph --watch --timeout-ms 900000`.
  - Watched abort test: PASS; a deliberate 5-second timeout left `pendingJobs: 0` and retained the backup job as `aborted`.
- Write-window preflight is complete and read-only:
  - Command: `npm run obsidian:write-preflight`.
  - Current status: PASS with the usable backup path.
  - Runtime safe for preflight: true.
  - Ready gates: 5.
  - Gates needing backup path: 0.
  - Blocked gates: 1.
  - Use `--backup-path /Users/HQ/Documents/RemNoteConnect/Backups/2026-07-02T11-10-47-607Z-graph-827856f61a.json` for the current reviewed-flashcard or empty-stub import preflight.

## Gates Passed

- Migration script syntax checks passed:
  - `scripts/obsidian-census.mjs`
  - `scripts/obsidian-flashcard-audit.mjs`
  - `scripts/obsidian-attachment-audit.mjs`
  - `scripts/obsidian-attachment-manifest.mjs`
  - `scripts/obsidian-attachment-capability-probe.mjs`
  - `scripts/obsidian-attachment-transfer-plan.mjs`
  - `scripts/obsidian-link-normalization-audit.mjs`
  - `scripts/obsidian-link-conversion-batch.mjs`
  - `scripts/obsidian-child-map-audit.mjs`
  - `scripts/obsidian-link-execution-plan.mjs`
  - `scripts/obsidian-content-completeness-audit.mjs`
  - `scripts/obsidian-content-repair.mjs`
  - `scripts/obsidian-needs-review-triage.mjs`
  - `scripts/obsidian-needs-review-cleanup-plan.mjs`
  - `scripts/obsidian-empty-placeholder-plan.mjs`
  - `scripts/obsidian-backup-audit.mjs`
  - `scripts/obsidian-write-preflight.mjs`
  - `scripts/obsidian-import-plan.mjs`
  - `scripts/obsidian-import-execute.mjs`
  - `scripts/obsidian-import-verify.mjs`
- Token scan passed: `node scripts/check-no-token.mjs`.
- Diff whitespace check passed: `git diff --check`.
- Shared package build passed.
- Plugin typecheck passed.
- Daemon typecheck passed.
- Plugin unit tests passed: 18 tests.
- Daemon unit tests passed: 27 tests.
- Workspace build passed.

## Ready To Use Now

- Use RemNoteConnect as a read-only query/audit bridge by default.
- Use the CLI/scripts to verify the imported Obsidian mirror by external ID.
- Use `npm run obsidian:completion` as the one-command status report before and after each remaining migration stage.
- Use `npm run obsidian:review-plan` as the one-command working queue for the remaining review decisions.
- Use `npm run obsidian:flashcard-review-plan` before considering any broader flashcard import.
- Use `npm run obsidian:attachment-capabilities` before making any attachment import claim.
- Use `npm run obsidian:attachment-transfer-plan` before any manual upload/source-reference attachment cleanup session.
- Use `npm run obsidian:empty-placeholders` before deciding whether to import linked empty-note stubs.
- Use `npm run obsidian:needs-review-cleanup` before moving anything out of Needs Review.
- Use `npm run obsidian:approval-packet` as the final review artifact before any write/manual cleanup session.
- Use `npm run obsidian:backup-audit` before any import gate to prove the backup is fresh enough for the current migrated state.
- Use `node scripts/rnc.mjs backup-graph --watch --timeout-ms 900000` for fresh graph-backup attempts so progress and abort behavior are visible.
- Use `npm run obsidian:write-preflight` before turning read-only mode off for any approval-gated write window.
- Use `npm run obsidian:search-index` and `npm run obsidian:search -- "query terms"` for local/free search over the transferred corpus.
- Review `Obsidian Mirror/Needs Review` inside RemNote for notes that were imported with unresolved links, ambiguous links, duplicate title risk, embeds, or other preserved Markdown constructs.
- Create new RemNote content through guarded RemNoteConnect write flows only after intentionally turning read-only mode off for that write window.

## Not Ready Yet

- Do not treat the mirror as continuous sync. Current idempotency prevents duplicate root documents, but it does not reconcile child Rem trees after source edits.
- Do not assume binary attachments were imported as native RemNote attachments. Images, PDFs, audio, and local embeds still need a dedicated attachment import/conversion pass.
- Do not assume Obsidian wikilinks were all converted to native RemNote references. Many were preserved as Markdown/plain text for review.
- Do not hard-delete real RemNote content. `emptyTrash` remains the only hard-delete path and should stay behind dry-run hash and confirm-count gates.
- Do not run broad cleanup mutations against the whole graph without reviewing dry-run target lists.
- Do not turn off read-only mode before the target gate's write preflight is ready; import gates also require a valid `backupGraph` path.
- Do not rely on whole-graph `backupGraph` for fast routine safety until the newly instrumented backup path completes a fresh live run. It produced a valid pre-import snapshot, but later post-import backup attempts did not complete reliably at current graph size.

## Next Work To Complete Before Heavy Daily Use

1. Attachment import policy and implementation.
   - Inventory referenced local attachments from the Obsidian vault. Completed by `node scripts/obsidian-attachment-audit.mjs`.
   - Build hashed attachment manifest tied to source Rem IDs. Completed by `node scripts/obsidian-attachment-manifest.mjs`.
   - Probe installed SDK attachment capabilities. Completed by `npm run obsidian:attachment-capabilities`; URL media is supported, native upload is not exposed.
   - Generate a concrete transfer/remediation queue. Completed by `npm run obsidian:attachment-transfer-plan`.
   - Decide whether each class should become manually uploaded native RemNote media, preserved source text, or skipped.
   - Do not claim cross-device native attachment import until a RemNote-native upload path is verified; SDK URL media primitives are not enough for iPhone/iPad because local daemon URLs are Mac-local.
   - Add a live test that imports one image, one PDF reference, and one missing attachment reference.

2. Link normalization pass.
   - Build a dry-run report for unresolved, ambiguous, and preserved Markdown links inside `Obsidian Mirror`. Completed by `node scripts/obsidian-link-normalization-audit.mjs --scope all`.
   - Generate the candidate batch for the 4,252 high-confidence native-reference candidates. Completed by `node scripts/obsidian-link-conversion-batch.mjs`.
   - Implement child-level imported document mapping before any write flow. Current candidate execution is intentionally blocked because replacing root-level Markdown without exact child/range mapping could corrupt the wrong Rem or overwrite local edits.
   - Run child-map feasibility. Completed by `node scripts/obsidian-child-map-audit.mjs`; current mapping uniquely matches 3,056 of 4,252 candidates after source-body repair.
   - Generate the native link execution plan. Completed by `node scripts/obsidian-link-execution-plan.mjs`; 840 candidates are node-range-ready.
   - Implement a confirm-gated write flow only after the rewrite handler supports dry-run, exact count confirmation, per-child undo, current-rich-text verification, and single-occurrence replacement. Completed.
   - Dry-run the confirm-gated write flow. Completed by `npm run obsidian:link-rewrite`; 840 selected and 0 blocked.
   - Execute the native link rewrite only after approving the exact mutation count:
     - `node scripts/rnc.mjs readonly off`
     - `npm run obsidian:link-rewrite -- --execute --confirm --confirm-count 840`
   - Require approval for the 1,192 ambiguous targets and for any likely misspellings.
   - Decide whether the 5,233 unresolved links should stay as Markdown, create stubs, or map to existing RemNote concepts.

3. Needs Review triage.
   - Generate a compact queue from `Obsidian Mirror/Needs Review`. Completed by `node scripts/obsidian-needs-review-triage.mjs`.
   - Group by reason: unresolved link, ambiguous link, duplicate title, embed, large note, Dataview/Mermaid/callout/LaTeX. Completed in the generated private report.
   - Generate cleanup lanes before promotion. Completed by `npm run obsidian:needs-review-cleanup`; current result says 0 documents are blocker-free today.
   - Move reviewed notes out of `Needs Review` only through a dry-run-plus-confirm flow after blockers are cleared.

4. Empty placeholder decision.
   - Classify the 591 empty Markdown files. Completed by `npm run obsidian:empty-placeholders`.
   - Current split: 414 linked graph anchors, 13 empty daily notes, 164 orphan empty placeholders.
   - Decide whether linked placeholders should become RemNote stubs to improve graph fidelity, while keeping unlinked clutter report-only by default.
   - If imported, require explicit approval, a backup, read-only-off execution window, and post-import verification.

5. Child-level reconciler.
   - Add a document diff/reconcile flow keyed by `externalId`. This now blocks native link-conversion execution.
   - Map imported Markdown source lines/ranges to exact child Rem IDs and rich-text ranges. Current feasibility audit shows the naive matcher is insufficient.
   - Update changed child Rems without duplicating or rewriting the entire subtree unnecessarily.
   - Preserve local RemNote edits unless the caller explicitly chooses source-of-truth overwrite.

6. Semantic search sidecar.
   - Build a local, free index from RemNoteConnect exports and/or the Obsidian mirror. Completed for lexical search by `npm run obsidian:search-index`.
   - Query it with `npm run obsidian:search -- "query terms"`.
   - Current limitation: lexical search only; embeddings/hybrid ranking can be added later without changing the RemNote data.
   - Support on-demand rebuild plus background refresh.

7. Backup scalability fix.
   - Measure why post-strict `backupGraph` failed.
   - Add chunking/progress/resume, or replace routine backups with narrower per-operation undo artifacts plus explicit disaster snapshots.
   - Add a live large-graph backup test.

8. Daily-driver acceptance run.
   - Cold restart daemon.
   - Relaunch RemNote.
   - Confirm exactly one bridge connection.
   - Run read-only status, map/search, and verifier commands.
   - Confirm read-only mode is restored after any intentional write test.

## Current Definition Of Done For The Migration

The migration is done for preserving non-empty Obsidian note text and strict flashcards in RemNote. It is not done for full native RemNote polish: native attachment import, executing the approved native link conversion, review-queue cleanup, continuous sync, or local semantic search remain open.
