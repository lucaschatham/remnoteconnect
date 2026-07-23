# Safe Usage

RemNoteConnect can operate on an entire RemNote knowledge base after the desktop plugin permission is approved. Treat it like a powerful local admin tool.

## Default Workflow

1. Start read-only:

   ```sh
   node scripts/rnc.mjs readonly on
   ```

2. Check the connection:

   ```sh
   node scripts/rnc.mjs doctor
   node scripts/rnc.mjs status
   ```

3. Inspect before writing:

   ```sh
   node scripts/rnc.mjs map --depth 2
   node scripts/rnc.mjs search "text:example"
   ```

4. For cleanup, run a dry-run first and read the exact target count.

5. Only execute broad operations with an explicit confirmation and exact count.

6. For irreversible work, issue a nonce from an interactive terminal:

   ```sh
   node scripts/rnc.mjs approve-irreversible --action emptyTrash --from-dry-run HASH --confirm-count COUNT
   ```

   Pass the returned nonce once as `--approval-nonce`. It expires after five minutes.

7. Turn read-only back on when the write window is done.

## Write Safety

- Prefer soft delete. `deleteRem` moves Rem into `RemNoteConnect/Trash/<opId>` and preserves IDs.
- Use `undo` for reversible mistakes.
- Treat `emptyTrash` as irreversible.
- `emptyTrash` counts every descendant, not only the visible tombstone folder.
- An `outcome_unknown` durable job requires reconciliation; do not resubmit it blindly.
- For `sync-atlas`, pin `REMNOTE_CONNECT_FAST_LOCAL_ROOT_ID` to one dedicated root and pass the same value through `--root-id`. The fast path never permits cross-root writes, moves, merges, or deletes.
- Atlas sync is experimental and not daemon-undoable. Run the preview first, back up the dedicated root, then pass `--confirm` and the exact `--confirm-count` when required.
- Keep personal notes and cards unmarked beneath the synced skill Rems. Atlas sync updates only Rems with its own metadata; clone a generated card before making personal edits you want to preserve.
- Use `node scripts/rnc.mjs sync-atlas --manifest FILE --root-id ROOT --fast-local --reconcile` after an Atlas job reports `outcome_unknown`.
- Scheduler mutation and structural merge are disabled in v0.5.
- Treat snapshot restore as disaster recovery, not true undo. Restored Rem are copies with new IDs.
- Do not run broad writes on a real graph until the dry-run output makes sense.

## Public Support Safety

Never paste these into public issues, pull requests, chat logs, or screenshots:

- daemon tokens
- private note/card text
- RemNote exports
- backup files
- generated graph maps containing private titles
- local app-support logs

Prefer sanitized `doctor`, `status`, and command output when reporting bugs.
