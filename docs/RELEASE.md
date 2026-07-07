# Release Process

Use this checklist before tagging a public release.

## Version Bump

- Update package versions if the release changes runtime behavior.
- Update `plugin/public/manifest.json`.
- Update `CHANGELOG.md`.
- Keep `package.json` marked `"private": true` until npm publishing is intentionally supported.

## Required Local Checks

```sh
npm run check:no-token
npm run check:redteam
npx pnpm@11.7.0 -r typecheck
npx pnpm@11.7.0 --filter @remnoteconnect/plugin test
npx pnpm@11.7.0 --filter @remnoteconnect/daemon test
npx pnpm@11.7.0 -r build
```

Run the public leak scan:

```sh
git ls-files | rg '^(docs/obsidian-|scripts/obsidian-|\.wrapup/)'
npm run check:redteam
```

Both commands should return no results.

## Fresh Clone Smoke

Clone into a temporary directory and verify:

- install succeeds
- build succeeds
- token scan passes
- daemon starts on isolated ports
- plugin bundle is served
- `node scripts/rnc.mjs status` works with an isolated app dir

## Live RemNote Smoke

Against disposable RemNote content:

```sh
node scripts/live-security.mjs
node scripts/live-readonly.mjs
node scripts/live-scope.mjs
node scripts/live-softdelete.mjs
node scripts/live-docs.mjs
node scripts/live-cleanup.mjs
node scripts/live-idempotent.mjs
```

## Tag And Release

Only tag after GitHub Actions is green on `main`.

```sh
git tag v0.3.0
git push origin v0.3.0
```

Draft the GitHub release with:

- summary of stable features
- safety warning
- install steps
- known limitations
- link to `docs/SAFE_USAGE.md`
