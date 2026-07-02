# RemNoteConnect Execution Log

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
