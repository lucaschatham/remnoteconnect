# Security Policy

RemNoteConnect is local-first software that can read and mutate a RemNote knowledge base after the user grants plugin permissions. Treat it as sensitive tooling.

## Supported Use

Run RemNoteConnect only on a machine you control.

The daemon is designed to bind to `127.0.0.1` and require a bearer token for HTTP calls. Do not expose the daemon to a public network.

## Token Handling

- Do not commit the daemon token.
- Do not paste the token into issue reports.
- Do not pass the token as a CLI argument.
- Use the local token file and the provided CLI.
- Run `npm run check:no-token` before publishing.

## Permission Model

The RemNote plugin may request `All / ReadCreateModifyDelete`. This is intentionally powerful and should be approved only if you understand the risk.

Use `readonly on` when you want LLMs or scripts to inspect the graph without mutating it.

## Reporting Security Issues

Open a private security advisory or contact the maintainer directly. Do not file public issues with exploit details, daemon tokens, private note content, or RemNote exports.

## Known Risk Areas

- local daemon exposure if host binding is changed
- token leakage in logs or generated artifacts
- accidental broad graph operations
- hard delete through `emptyTrash`
- generated backups containing private knowledge-base content

The project favors dry-runs, exact-count confirmations, soft delete, and read-only mode to reduce accidental damage.
