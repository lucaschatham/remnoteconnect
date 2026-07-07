# Public Repo Checklist

Use this before pushing RemNoteConnect to a public GitHub repository.

## Must Pass

- `npm run check:no-token`
- `npx pnpm@11.7.0 -r typecheck`
- `npx pnpm@11.7.0 --filter @remnoteconnect/plugin test`
- `npx pnpm@11.7.0 --filter @remnoteconnect/daemon test`
- `npx pnpm@11.7.0 -r build`

## Do Not Publish

- daemon token files
- `~/Library/Application Support/RemNoteConnect`
- `~/Library/Logs/RemNoteConnect`
- `~/Documents/RemNoteConnect/Backups`
- plugin-local token config
- private RemNote exports
- Obsidian migration reports
- generated JSONL imports
- graph maps containing personal note titles
- logs containing local file paths or personal source snippets

## Current Public-Readiness Notes

This working tree currently contains local migration tooling and generated artifacts. Treat the repo as not ready for public push until the private migration surface is either removed, ignored, or moved to a private branch.

Recommended public shape:

- keep `daemon/`
- keep `plugin/`
- keep `shared/`
- keep generic live/security scripts
- keep `README.md`, `docs/INVARIANTS.md`, and public docs
- move private migration scripts and reports out of the public branch

Private/local-only examples include files named:

- `docs/obsidian-*`
- `scripts/obsidian-*`
- `.wrapup/*`

## Metadata To Decide Before Publishing

- repository URL
- package name
- license
- author/maintainer policy
- whether the RemNote plugin should remain local/dev-only or become an unlisted/published plugin

## Security Language

The public repo should be clear that RemNoteConnect can control a whole RemNote knowledge base after permission approval. Avoid marketing language that makes it sound safe by default. It is powerful because it is local, token-gated, dry-run-first, and reversible where possible.

## Release Checklist

1. Start from a clean branch.
2. Remove or ignore private migration artifacts.
3. Run token scan.
4. Run static tests.
5. Run a local live smoke test with disposable Rem.
6. Confirm `readonly on` blocks mutations.
7. Confirm the README quickstart works from a fresh clone.
8. Add a license or explicitly keep all rights reserved.
9. Push to the public repository.
