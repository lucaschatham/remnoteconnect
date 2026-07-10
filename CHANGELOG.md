# Changelog

## 0.4.0

Safety and reliability release.

- Centralized registry-driven parameter validation, read-only enforcement, and machine-readable action schemas.
- Added write-ahead undo with exclusive mode-`0600` records and explicit committed/outcome-unknown states.
- Made hard-delete previews enumerate every descendant and inbound-reference risk.
- Added five-minute, single-use irreversible approval nonces and an atomic three-operation session budget.
- Disabled scheduler mutation, generated-card deletion, and structural merge until they can be proven reversible.
- Prevented uncertain durable jobs from replaying after disconnects or restarts.
- Added bridge generations, torn-JSONL recovery, local token pairing, and token-free plugin builds.
- Preserved rich-text structure during normalization and restored available snapshot tag associations.
- Added `rnc init`, registry help, irreversible approval commands, and universal `rnc call` coverage.

## 0.3.2

Marketplace packaging release.

- Added a marketplace README to the plugin bundle so RemNote upload validation accepts the ZIP package.

## 0.3.1

Maintenance release.

- Updated TypeScript to 6.0.3.
- Updated RemNoteConnect's direct Zod dependency to 4.4.3 and adjusted shared schemas for Zod 4.
- Reverted incompatible Vite 8 and React DOM 19 dependency bumps to keep the public install compatible with the current RemNote SDK peer dependency graph.

## 0.3.0

Initial public release.

- MIT-licensed public repo.
- Local daemon and RemNote desktop plugin bridge.
- CLI-first control surface through `scripts/rnc.mjs`.
- Read-only mode, dry-runs, exact-count confirmations, soft delete, undo, and token-gated local access.
- Basic document, flashcard, graph map, search, cleanup, backup, and live verification workflows.
- Public safety docs, troubleshooting docs, contribution templates, and examples.

Known limitations:

- Local Mac workflow only.
- Plugin remains local/unlisted.
- Mobile RemNote apps do not run the local bridge.
- Advanced media, image occlusion, scheduler mutation, semantic search, and marketplace packaging are experimental or planned.
