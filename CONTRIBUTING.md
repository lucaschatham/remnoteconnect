# Contributing

RemNoteConnect is experimental local-first tooling for RemNote automation.

## Development Setup

```sh
npx pnpm@11.7.0 install
npx pnpm@11.7.0 build
```

Run the daemon:

```sh
npx pnpm@11.7.0 --filter @remnoteconnect/daemon start
```

Load the plugin in RemNote desktop from:

```text
http://127.0.0.1:8080
```

## Before Opening A PR

Run:

```sh
npx pnpm@11.7.0 -r typecheck
npx pnpm@11.7.0 --filter @remnoteconnect/plugin test
npx pnpm@11.7.0 --filter @remnoteconnect/daemon test
npx pnpm@11.7.0 check:no-token
```

For changes that touch live RemNote behavior, also run the relevant live scripts against a disposable test graph.

## Guardrails

- Do not commit tokens.
- Do not commit private RemNote exports.
- Do not commit local migration reports.
- Keep destructive actions dry-run-first.
- Keep read-only enforcement in the daemon before plugin dispatch.
- Prefer compact CLI/API output by default.

## Code Style

Follow the existing TypeScript style. Keep safety checks explicit and test negative paths, especially for bulk or graph-wide mutations.
