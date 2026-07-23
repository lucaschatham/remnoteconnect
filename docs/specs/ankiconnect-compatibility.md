# RemNoteConnect AnkiConnect Compatibility Mode

**Status:** Product specification

**Target:** RemNoteConnect v0.5

**Compatibility reference:** AnkiConnect API v6, official source commit `de6e6e1b8aaf4ae195eb1d1ff6db5409b99b2a3e`

**License posture:** Clean-room protocol implementation; no AnkiConnect GPL source code is copied.

## Product outcome

An application written for AnkiConnect can point at a local RemNoteConnect compatibility endpoint and use the same JSON request envelope, action names, parameter names, response envelope, batching behavior, and error convention without application-specific adapter code.

The mode prioritizes honest interoperability. It provides exact behavior when RemNote and Anki share a concept, a documented RemNote-backed approximation when their data models differ, and a deterministic capability error when RemNote cannot represent the requested behavior. It never returns false success for an operation it did not perform.

## Why this exists

RemNoteConnect already implements a small “AnkiConnect-inspired” adapter, but that adapter deliberately changes result shapes, authentication, identifiers, queries, safety semantics, and action coverage. That is useful for native RemNote automation but is not a drop-in AnkiConnect implementation.

Compatibility Mode makes AnkiConnect the external contract and RemNote the backing system. The native RemNoteConnect API remains intact and independently versioned.

## Non-negotiable principles

1. **Wire compatibility first.** Requests and responses follow AnkiConnect v6, including legacy version behavior, `multi`, string errors, HTTP/CORS behavior, and the default local endpoint shape.
2. **No invented success.** Unsupported scheduler, package, profile, or GUI behavior returns a stable capability error naming the missing RemNote capability.
3. **Persistent identity.** RemNote string IDs are translated to stable, collision-free signed 53-bit integers and survive daemon restarts.
4. **Local and explicit.** The compatibility listener binds only to loopback. Direct Anki-style writes require Compatibility Mode to be enabled and native read-only mode to be off.
5. **One source of truth.** Card and note content lives in RemNote. The daemon sidecar stores only compatibility metadata that RemNote cannot represent directly.

## What “100% compatible” means

Compatibility is measured on four independent axes rather than collapsed into a misleading yes/no label.

| Axis | Requirement |
| --- | --- |
| Action-surface coverage | Every one of the 122 public actions in the pinned official source is recognized and reported by `apiReflect`. |
| Protocol parity | Request validation, API versions, success/error envelopes, `multi`, CORS, port, and API-key behavior match AnkiConnect. |
| Schema parity | Supported actions accept official parameter names and return official field names and primitive types. |
| Semantic parity | The operation produces the same externally observable outcome when RemNote exposes an equivalent capability. |

An action receives one implementation status:

- `native`: faithful RemNote-backed behavior.
- `translated`: faithful public behavior backed by explicit ID, query, deck, tag, or field translation.
- `sidecar`: the behavior is persisted by RemNoteConnect because RemNote has no equivalent metadata field.
- `blocked`: the action is recognized but cannot be performed faithfully with the current RemNote SDK.

“122/122 actions recognized” is mandatory. “122/122 actions return success” is expressly not a goal because that would require lying about Anki-only behavior.

## User journeys

### Existing AnkiConnect client

1. The user enables Compatibility Mode and disables RemNoteConnect read-only mode if writes are needed.
2. The client sends its existing request to `http://127.0.0.1:8765/`.
3. The gateway validates the AnkiConnect envelope and optional API key.
4. The gateway translates the action into one or more RemNote operations.
5. The client receives an AnkiConnect-shaped result or a deterministic string error.

### Compatibility diagnosis

1. The user calls `apiReflect` to inspect the complete action surface.
2. The user calls the RemNoteConnect-native compatibility report to see each action’s status and limitation.
3. Blocked actions explain which RemNote capability is absent and do not mutate data.

## External protocol

### Listener

- Default address: `127.0.0.1`
- Default port: `8765`
- Default path: `/`
- Optional API key: `REMNOTE_CONNECT_ANKI_API_KEY`
- Feature gate: `REMNOTE_CONNECT_ANKI_COMPAT=on`
- The native RemNoteConnect listener remains at `127.0.0.1:8766`.

### Request

- Required: `action`, a non-empty string.
- Optional: `version`, an integer defaulting to `4`.
- Optional: `params`, an object defaulting to `{}`.
- Optional: `key`, compared with the configured compatibility API key.
- Unknown top-level properties are ignored, matching AnkiConnect.

### Response

- Version 5 and later: `{ "result": <value-or-null>, "error": <string-or-null> }`.
- Version 4 and earlier success: the action result without an envelope.
- Any error: `{ "result": null, "error": "<message>" }`.
- Action failures normally return HTTP 200; malformed JSON and disallowed origins follow the official listener behavior.
- `multi` returns one nested response per nested request, preserving order and isolating individual failures.

## Data model translation

### Notes and cards

- One Rem with practice enabled is the Anki note analogue.
- Its generated RemNote cards are Anki card analogues.
- Basic note fields map to the Rem text and back text.
- Extra model fields are stored as managed child Rem and indexed in sidecar metadata.
- HTML source is retained in managed metadata when RemNote rich text conversion is lossy.
- Note type, template, deck, tags, and compatibility metadata remain addressable through official result fields.

### Identifiers

- The sidecar maintains bidirectional maps for note, card, deck, model, and deck-config IDs.
- Public IDs are positive safe integers and never recycled.
- Deleting content leaves tombstoned mappings so a former ID cannot silently point to different content.
- Missing or externally deleted RemNote objects produce the same not-found class of error as AnkiConnect.

### Decks

- A RemNote folder or document path is a deck.
- `::` hierarchy is translated to the RemNote managed path hierarchy.
- Deck IDs and configuration IDs are sidecar identities.
- Deck statistics use observable RemNote card state only; unavailable Anki-specific buckets are not fabricated.

### Models and templates

- The daemon sidecar stores model names, ordered fields, templates, CSS, fonts, descriptions, and cloze status.
- The default `Basic` and `Cloze` models are bootstrapped deterministically.
- Model changes affect future compatibility writes and retained compatibility metadata. They do not claim to rewrite native RemNote rendering semantics that the SDK cannot control.

### Tags

- Anki tags map to RemNote tags.
- Tag list and mutation actions operate on visible RemNote tags.
- Tag names are normalized only where AnkiConnect itself normalizes them.

### Media

- Media files are stored in the daemon application directory with filename validation, content hashing, and atomic replacement.
- Base64, local path, and URL inputs follow AnkiConnect precedence and validation.
- Note-level media directives are resolved before the note is created.
- The gateway never exposes arbitrary filesystem paths through retrieval actions.

### Scheduler and review state

- Card lookup and observable state are translated when the SDK exposes them.
- Exact Anki ease, interval, due-date, queue, lapse, review-log, and FSRS semantics are blocked unless a RemNote SDK capability is proven equivalent.
- Sidecar-only scheduler simulation is prohibited because it would diverge from what the learner actually reviews in RemNote.

## Action families

The pinned contract contains 122 actions across these families:

- Core, permission, profile, sync, reflection, and batching
- Collection statistics
- Decks and deck configurations
- Media
- Notes, fields, and tags
- Cards and scheduling
- Models, fields, templates, and styling
- Review history
- Graphical Anki desktop controls
- Package import/export

The canonical list and per-action status live in the typed compatibility manifest. Documentation is generated from that manifest so runtime behavior, tests, and the published matrix cannot drift.

## Security and safety

- The compatibility listener refuses non-loopback hosts and non-approved browser origins.
- Compatibility Mode is off unless explicitly enabled.
- Native read-only mode remains the final write gate.
- Enabling Compatibility Mode does not expose the native bearer token.
- Anki-style mutations intentionally bypass native dry-run handshakes only after both gates are satisfied; they remain audited and use existing undo preparation where available.
- File and URL media inputs enforce size, scheme, timeout, filename, and directory-boundary limits.
- Logs omit API keys, bearer tokens, field contents, and media payloads.

## Performance objectives

Measured on localhost with a connected RemNote plugin and excluding RemNote materialization time:

- Gateway-only actions (`version`, `apiReflect`): p95 under 5 ms.
- Translation overhead above the equivalent native RemNoteConnect action: p95 under 10 ms for warm reads.
- Persistent identity append: p95 under 10 ms at 2,000 mapped objects and under 40 ms at 10,000 mapped objects; larger graphs trigger a storage-engine review before claiming parity.
- Single note/card metadata reads: p95 under 150 ms for a warm plugin connection.
- Single note field or tag mutation: p95 under 250 ms for a warm plugin connection.
- `multi`: no artificial per-item delay; results remain ordered.
- Bulk note creation: at least 50 notes/second when card materialization waiting is disabled, matching the existing bridge’s demonstrated range.

The benchmark suite reports transport overhead separately from RemNote SDK execution time. “Lightning fast” is verified by percentiles, not asserted from architecture.

## Product acceptance criteria

1. A contract test proves all 122 pinned official action names are present exactly once.
2. An unmodified AnkiConnect client can call `version`, `apiReflect`, `multi`, note CRUD, card lookup, deck CRUD, tag operations, model metadata, and media operations against the default compatibility endpoint.
3. Successful v6 and legacy v4 responses match official envelope behavior.
4. Public IDs are integers, stable across restart, bidirectional, and collision-free under concurrency.
5. Every action has an explicit status, owner, test disposition, and limitation text when not native.
6. Blocked actions return deterministic string errors and produce no state change.
7. Compatibility writes are impossible while native read-only mode is on.
8. Native RemNoteConnect behavior and authentication remain unchanged.
9. Contract, integration, security, persistence, and performance tests pass without touching a real user knowledge base.
10. The compatibility matrix is generated from the same manifest used by runtime dispatch.

## Deliberate non-goals

- Copying or linking AnkiConnect’s GPL implementation.
- Reimplementing Anki’s scheduler inside RemNoteConnect.
- Pretending RemNote is the Anki desktop GUI.
- Silently flattening unsupported fields or review history.
- Weakening the native RemNoteConnect bearer-token API.
- Using a real personal RemNote graph for automated compatibility tests.

## Source of contract truth

The action surface and protocol rules are derived from the public interface of the [official AnkiConnect repository](https://git.sr.ht/~foosoft/anki-connect), pinned to commit `de6e6e1b8aaf4ae195eb1d1ff6db5409b99b2a3e`. The implementation is independently authored in TypeScript under RemNoteConnect’s MIT license.
