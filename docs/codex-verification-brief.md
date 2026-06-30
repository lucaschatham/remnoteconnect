# Archived Verification Brief

This file previously described the managed-root containment hardening plan. That model has been superseded by the whole-KB safety model in [INVARIANTS.md](./INVARIANTS.md).

Current implementation rules:

- Whole-KB scope is requested through `All / ReadCreateModifyDelete`.
- Reversible delete is tombstone-by-move under `RemNoteConnect/Trash/<opId>`.
- Undo uses daemon-stored prior state, not snapshot restore.
- `emptyTrash` is the only hard-delete path and requires a prior dry-run hash.
- Snapshot import/restore remains copy-only disaster recovery.
