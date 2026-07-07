# Changelog

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
