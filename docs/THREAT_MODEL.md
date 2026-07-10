# Threat Model

RemNoteConnect is local-first automation for RemNote. The main risk is not a remote cloud service; it is granting a local tool broad authority over a personal knowledge base.

## Trust Boundary

- The daemon binds to `127.0.0.1` by default.
- HTTP requests require a bearer token from the local token file.
- The RemNote plugin executes RemNote SDK reads and writes after the user approves plugin permissions.
- The bridge is intended for a machine the user controls. Do not expose the daemon to a public network.

## Primary Risks

- Token leakage through logs, screenshots, shell history, or issue reports.
- A malicious local process calling the daemon if it obtains the token.
- Browser-origin or localhost abuse if host/origin checks are weakened.
- Broad graph operations caused by a bad query or an overconfident automation agent.
- Irreversible hard delete through `emptyTrash`.
- Backups or graph maps leaking private knowledge-base content.

## Safety Controls

- `readonly on` blocks mutating actions before plugin dispatch.
- Dry-runs show what broad or destructive operations would affect.
- Exact-count confirmations reduce accidental wide writes.
- Soft delete moves Rem to a tombstone container and preserves Rem IDs.
- `undo` reverses journaled operations where the underlying Rem IDs still exist.
- `backupGraph` is explicit disaster recovery, not normal undo.
- `emptyTrash` is intentionally separate from soft delete.
- Write-ahead undo is persisted before reversible writes.
- Irreversible plans are bound to a short-lived, single-use approval nonce.
- Bridge generations prevent late results from an old socket being accepted by a new connection.

## Limits Of The Controls

- Read-only mode does not protect against someone who can turn it off with a valid token.
- Dry-runs do not prove the user intended the targets; they only expose the target set.
- The TTY approval challenge reduces accidental automation but is not an adversarial boundary against software controlling the entire Mac.
- An in-flight timeout cannot prove whether RemNote applied a write, so durable jobs stop in `outcome_unknown` instead of replaying.
- Backups restore copies with new IDs, so inbound references and scheduling history are not preserved.
- A local attacker with user-level access may be able to read local app-support files.

## Mobile Limitation

The local bridge depends on a desktop RemNote plugin and a local daemon. iOS and iPadOS RemNote apps do not run this local bridge.
