# Roadmap

## Stable In v0.5

- Local daemon on `127.0.0.1`.
- RemNote desktop plugin bridge.
- CLI and HTTP action envelope.
- Read-only mode.
- Registry-backed JSON parameter schemas and universal CLI invocation.
- Write-ahead undo, exact recursive delete plans, one-time irreversible approvals, and token pairing.
- Pairing popup and Omnibar command independent of RemNote's plugin settings UI.
- Durable-job pause and outcome-unknown handling.
- Git-derived release identity checked across daemon and plugin builds.
- Basic document, flashcard, map, search, backup, undo, and cleanup workflows.

## Disabled Or Experimental In v0.5

- Image occlusion and advanced media workflows.
- Scheduler mutation and generated-card deletion are disabled pending reversible SDK support.
- Structural merge is disabled pending complete inverse-reference validation.
- Pinned-root fast local Atlas sync remains opt-in pending large disposable-root benchmarks.
- Large graph cleanup beyond disposable test scenarios.
- Advanced RemNote properties, portals, and rich media coverage.

## Planned

- Semantic search sidecar that stays local-first.
- Better packaged CLI/daemon install.
- More complete media import and export.
- RemNote marketplace or unlisted plugin packaging if the permission model and review constraints are acceptable.
- Broader OS support after the Mac local workflow is stable.

## Not Planned For v0.5

- npm package publishing.
- Hosted cloud bridge.
- Mobile bridge execution.
- Automatic broad graph cleanup without dry-run and approval gates.
