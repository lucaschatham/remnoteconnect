# RemNoteConnect Execution Log

## 2026-07-02 - M1 Ready-Pilot Safety And Visibility

Shipped:

- Bumped RemNoteConnect local build identity to `0.3.0` with build hash `ready-pilot-m1-20260702`.
- Added daemon-enforced `readonly` mode plus CLI support: `node scripts/rnc.mjs readonly on|off|status`.
- Added `readonly_mode` error handling and tests proving mutating plugin actions and daemon durable jobs are rejected before dispatch.
- Added daemon/plugin build-hash handshake and `doctor` warnings for stale connected plugin bundles.
- Added a visible plugin health panel showing bridge status, token presence, All-scope probe state, active jobs, heartbeat, and build match.
- Added `scripts/static-redteam.mjs` and `check:redteam` for hard-delete path, read-only metadata, build-handshake, manifest-scope, token-scan, and externalId graph-pollution regressions.
- Added `scripts/live-readonly.mjs` to verify read-only mode against the live RemNote bridge.
- Updated `README.md` and `docs/INVARIANTS.md` for read-only mode, build mismatch warnings, and new verification gates.
- Made daemon/plugin test scripts rebuild `shared` first so protocol-shape tests cannot accidentally run against stale shared dist output.

Gate results so far:

- `CI=true npx pnpm@11.7.0 -r typecheck` passed.
- `CI=true npx pnpm@11.7.0 --filter @remnoteconnect/daemon test` passed: 27 daemon tests.
- `CI=true npx pnpm@11.7.0 --filter @remnoteconnect/plugin test` passed: 16 plugin tests.
- `CI=true npx pnpm@11.7.0 -r build` passed.
- `CI=true npx pnpm@11.7.0 check:no-token` passed against rebuilt `plugin/dist`.
- `CI=true npx pnpm@11.7.0 check:redteam` passed.

Open validation before final ready-pilot tag:

- Done: redeployed the rebuilt daemon/shared/plugin runtime into `~/Library/Application Support/RemNoteConnect/runtime`.
- Done: restarted the LaunchAgent and restarted RemNote so the plugin reloaded from the served `0.3.0` bundle.
- Done: `doctor` passed with daemon/plugin build hash match and no warnings.
- Done: `live-readonly.mjs` passed; mutation failed with `readonly_mode` while read actions still worked.
- Done: `live-scope.mjs`, `live-security.mjs`, `live-softdelete.mjs`, `live-docs.mjs`, `live-idempotent.mjs`, and `live-cleanup.mjs` passed.
- Done: `chaos:daemon` passed in LaunchAgent mode after reconnect.
- Done: residue sweep returned zero for `__codex_*` live-test markers and zero visible tombstones.
- Done: final status reported `pluginVersion: 0.3.0`, matching build hash, `activeConnections: 1`, `pendingJobs: 0`, `readonlyMode: false`.
- Done: irreversible session budget reset to 3 after live cleanup gates.
- Done: LaunchAgent installer now prefers the stable `command -v node` path; current plist uses `/opt/homebrew/bin/node` instead of a versioned Cellar path.
- Done: final `doctor` after reinstall/restart passed with no warnings.

Validation caveat:

- In this Codex non-interactive shell, pnpm's dependency verification attempted to purge/reinstall modules before some `pnpm run` commands. Restored the dev install with `CI=true npx pnpm@11.7.0 --config.confirmModulesPurge=false install --frozen-lockfile --prod=false`. Prefer direct `node scripts/*.mjs` for live gates when dependencies are already installed.

## 2026-07-02 - M0 Capability Probes

Shipped:

- Added `capabilityProbes` action to the shared registry and plugin executor.
- Added CLI support: `rnc capability-probes` and `rnc list-tombstones`.
- Added `scripts/probe-capabilities.mjs` to run disposable live SDK probes and generate `docs/capability-report.md`.
- Added `scripts/live-cardtypes.mjs` as the standing live gate for required card primitives.
- Added reusable `emptyTrashOpId` helper for live test cleanup.
- Added plugin unit coverage for capability probe dry-run/report/tombstone behavior.

Live capability results:

- PASS: front/back cards, Concept cards, Descriptor cards, cloze cards, multi-line cards, list-answer cards, properties, portals, ordered insertion, and drift primitive introspection.
- UNSUPPORTED: scriptable image occlusion and native ID-preserving trash/restore.
- FAIL: data-URI image rich text. The live SDK serialized it to an unusable `about:blank` S3 URL with no retained external URLs.

Gate results:

- Initial orientation passed: `status` connected, `doctor` ok, `bench 500` passed at 500 created in 6312ms and search in 1579ms on about 58k accessible Rems.
- `npx pnpm@11.7.0 --config.verifyDepsBeforeRun=false -r typecheck` passed.
- Plugin tests passed: 16 tests.
- Daemon tests passed: 25 tests.
- `npx pnpm@11.7.0 --config.verifyDepsBeforeRun=false -r build` passed.
- `check:no-token` passed.
- Final `doctor` passed.
- `probe-capabilities.mjs` passed and wrote `docs/capability-report.md`.
- `live-cardtypes.mjs` passed required probes and reported optional support.
- Residue retry gate passed: `__codex_probe__` 0, `__codex_cardtypes__` 0, visible tombstones 0.
- Final status settled at bridge connected, `activeConnections: 1`, `pendingJobs: 0`.

Open assumptions / downstream constraints:

- Image occlusion should remain user-assisted or RemNote-UI-driven until the SDK exposes a scriptable API.
- M2 mirror sync should not rely solely on `updatedAt`; the live probe found `updatedAt` fields but did not observe an immediate change after `setText`.
- If M2 needs image/media import, prefer daemon-local file URLs or RemNote-supported uploaded media URLs over data URIs.
- Tombstone-by-move remains the only verified reversible delete path; no native trash/restore support was found.
