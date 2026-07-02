# RemNoteConnect Invariants

RemNoteConnect is local-only, but it is still security-sensitive: the daemon token authorizes whole-knowledge-base reads and writes through a RemNote plugin.

## Safety Model

The plugin requests `All / ReadCreateModifyDelete`. Managed-root containment is no longer the safety boundary.

The load-bearing invariant is reversibility before capability:

- Reversible operations mutate stable Rem IDs and can be undone through the daemon undo store.
- Soft delete means moving Rem to `RemNoteConnect/Trash/<opId>/`, not calling `rem.remove()`.
- Undo restores the original parent and sibling index using `setParent(parent, positionAmongstSiblings)`.
- Snapshot restore is disaster recovery only. It recreates copies with new IDs and does not preserve inbound references, portals, or scheduling history.

The operational root `RemNoteConnect` still exists for bridge-owned folders such as `Trash` and `Tags`, but graph operations may target Rem outside that root.

Read-only mode is daemon-enforced. When `readonly` is on, every action marked `mutates:true` in shared action metadata must fail with `readonly_mode` before it reaches the plugin or durable job queue. Read-only mode is for audit, mapping, and LLM inspection sessions; it is not a substitute for undo on write sessions.

## Audit And Undo

Audit and undo are separate artifacts.

- `~/Library/Logs/RemNoteConnect/audit.jsonl` is content-free and safe to retain. It records action, opId, target IDs, counts, status, and duration.
- `~/Library/Application Support/RemNoteConnect/undo/<opId>.json` stores full local prior state needed to undo. Files must be written mode `0600`.

Never put note/card text, rich text bodies, or the daemon token into the audit log.

## Destructive And Irreversible Operations

Destructive, bulk, and graph-wide operations are dry-run-first. Execution requires `confirm:true`.

If an operation resolves more than 50 targets, execution requires `confirmCount:<exactCount>`.

Irreversible operations, currently `emptyTrash` and future structural merges, require `fromDryRun:<hash>` from a prior dry run. The daemon enforces an in-memory irreversible session budget of 3 operations.

When that budget is exhausted, the only valid reset path is `reconfirmIrreversibleBudget` with `confirm:true` and the exact human confirmation phrase. Do not raise the default budget or restart the daemon to bypass this gate during testing.

No code path may call `rem.remove()` except the `emptyTrash` implementation.

## Scope Proving

Do not assume RemNote approved the expanded scope. `doctor` must run `scopeProbe`, which uses `plugin.rem.getAll()` and verifies that the plugin can see at least one Rem outside the operational root.

If the user has not approved `All / ReadCreateModifyDelete`, `doctor` must report the failed scope probe clearly.

Do not assume the connected plugin is the currently built plugin. The plugin must report `pluginBuildHash` during the bridge handshake, and `doctor` must warn when it differs from the daemon build hash.

## Token Handling

Never serve the daemon token with wildcard CORS, bake it into build artifacts, log it, or commit it. The CLI reads the token from the local token file; it is not accepted as a command-line argument.

Built artifacts and test fixtures must not contain 64-character hex tokens.

## Interchange Formats

Use compact outputs by default:

- Mutations return `{id}` or `{count, ids}`.
- Graph maps return TSV.
- Documents use Markdown in and out.
- Full Rem summaries require `verbose:true`.

## Tests

Definition of done includes happy paths, negative paths, and idempotent cleanup. Live tests must use disposable `__codex_*` names and leave the RemNote graph as they found it.

Live operations must gate on `status.bridge.connected === true`, not daemon health alone. Exactly one plugin bridge connection is expected; reconnects cancel in-flight jobs.
