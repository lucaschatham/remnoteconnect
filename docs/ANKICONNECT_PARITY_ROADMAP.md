# AnkiConnect parity roadmap

## Decision

RemNoteConnect should target **drop-in AnkiConnect compatibility for knowledge authoring**, not claim that RemNote is Anki.

The useful promise is:

> Existing AnkiConnect clients can create, find, update, organize, tag, and attach media to RemNote knowledge through the familiar local API, with stable IDs and explicit errors for semantics RemNote cannot provide.

“Every action returns success” is not an acceptable parity definition. It would require fabricating scheduler, review-log, GUI, profile, sync, and package behavior that did not occur in RemNote.

## Current contract

The compatibility surface is pinned to the current official AnkiConnect HEAD, commit `de6e6e1b8aaf4ae195eb1d1ff6db5409b99b2a3e`.

| Status | Actions | Meaning |
| --- | ---: | --- |
| Recognized | 122/122 | Every official public action name is present and reflected. |
| Native protocol | 3 | Implemented directly by the compatibility gateway. |
| RemNote-translated | 31 | Routed to observable RemNote behavior with schema translation. |
| Sidecar-backed | 37 | Persisted locally where RemNote lacks equivalent metadata. |
| Capability-blocked | 51 | Returns a deterministic limitation instead of false success. |

The 71 executable actions are not all semantically equal:

- Media sidecar operations have direct observable behavior.
- Model and template metadata round-trip for client compatibility but do not change RemNote’s native renderer.
- Deck configuration metadata round-trips but does not change RemNote’s scheduler.
- Profile actions expose the single logical `RemNote` profile rather than reproducing Anki’s profile manager.

## Parity levels

| Level | Definition | Current state |
| --- | --- | --- |
| Surface parity | All official action names are recognized. | Complete: 122/122. |
| Wire parity | Envelope, versions, errors, batching, authentication, listener, and CORS behavior match. | Implemented; differential testing against real Anki remains required. |
| Schema parity | Supported actions accept official parameters and return official primitive and field shapes. | Partial; representative tests exist, but every executable action needs a golden fixture. |
| Authoring parity | Common clients can perform note, card-identity, deck, tag, model-metadata, search, and media workflows. | Substantially implemented; real-client certification remains required. |
| Anki semantic parity | Scheduler, review log, GUI, profiles, sync, and APKG behavior are externally equivalent to Anki. | Not achievable with the current RemNote SDK and product model. |

## The 51 blocked actions

| Dependency | Count | Actions | What would be required |
| --- | ---: | --- | --- |
| Locally implementable candidates | 3 | `deleteDecks`, `clearUnusedTags`, `removeEmptyNotes` | Define reversible RemNote semantics, add native bridge actions, and validate destructive behavior in a disposable profile. Exact Anki deletion semantics may still remain intentionally different. |
| Missing RemNote state/API | 25 | `sync`, `reloadCollection`; three statistics actions; `getDeckStats`; fifteen scheduler/card actions; four review-log actions | RemNote must expose verified sync completion, scheduler fields and mutations, due state, suspension, intervals, review events, and review history. Add capability probes before implementing any adapter. |
| Anki desktop GUI | 21 | All `gui*` actions | A RemNote UI automation API with equivalent selection, reviewer, browser, audio, undo, import, navigation, database-check, and shutdown controls. Even with an API, several actions should remain platform-specific rather than pretending to be Anki. |
| APKG packages | 2 | `exportPackage`, `importPackage` | An independently implemented APKG reader/writer, media mapping, model conversion, scheduler-loss policy, security limits, and round-trip fixtures. This must remain clean-room and must not copy GPL implementation code. |

## Work required for credible authoring parity

1. **Golden protocol corpus**
   - Capture request and response fixtures from a disposable real Anki profile for every official action.
   - Compare envelopes, required parameters, default values, result shapes, ordering, missing-object behavior, and exact error classes.
   - Store only synthetic fixture content.

2. **One executable-action test per manifest row**
   - Give every native, translated, and sidecar action at least one valid request and expected result schema.
   - Add invalid-parameter, missing-object, read-only, persistence/restart, and no-false-success cases where applicable.
   - Generate a coverage report from the runtime manifest so a status change cannot merge without its test disposition changing.

3. **Real-client certification**
   - Run representative clients unmodified against both AnkiConnect and RemNoteConnect.
   - Record which actions each client calls and compare externally visible outcomes.
   - Certify clients individually; do not infer ecosystem compatibility from action counts.

4. **Failure and persistence testing**
   - Kill the daemon and disconnect the RemNote plugin before dispatch, after RemNote mutation, and before sidecar persistence.
   - Prove retries do not create duplicate notes or recycle IDs.
   - Test state-file corruption, torn writes, disk-full failures, permission failures, concurrent requests, restart recovery, and backup restoration.

5. **Security testing**
   - Fuzz malformed JSON, nested `multi`, oversized bodies, hostile origins/hosts, filename encodings, symlinks, and base64 boundaries.
   - Decide and document the media-URL policy for redirects, DNS rebinding, loopback, link-local, RFC1918, and cloud-metadata addresses.
   - Treat optional API-key mode as lower assurance; recommend an API key whenever compatibility mode is enabled.

6. **Performance certification**
   - Measure p50/p95/p99 gateway overhead, sidecar writes at increasing graph sizes, concurrent bulk creation, and warm/cold plugin calls.
   - Compare equivalent operations to real AnkiConnect on the same machine.
   - Set regression budgets in CI only for deterministic gateway/store benchmarks; keep live RemNote measurements in a disposable-profile release runbook.

## Recommended implementation sequence

1. Finish wire and schema conformance for the existing 71 executable actions.
2. Certify the note/deck/tag/search/media workflows used by actual clients.
3. Add the three locally implementable cleanup actions only after reversible semantics and live destructive tests exist.
4. Build APKG support only if a real client journey requires it.
5. Keep scheduler, review, sync, and GUI actions blocked until RemNote exposes capabilities that can be probed and verified.

## Release gates

An action may move from `blocked` only when:

- the RemNote capability is observed through a repeatable probe;
- the official request/result schema has a synthetic golden fixture;
- success changes observable RemNote state or returns observable RemNote state;
- failure cannot leave an undetectable duplicate or misleading sidecar state;
- restart, read-only, malformed-input, and missing-object tests pass;
- documentation names any deliberate semantic difference.

The compatibility release may claim **authoring parity** only after the golden corpus and at least one real client pass. It must not claim full Anki semantic parity while any scheduler, review-log, GUI, profile, sync, or APKG behavior is emulated or blocked.
