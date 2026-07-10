# Troubleshooting

Use this when the daemon, plugin, or CLI does not behave as expected.

## Plugin Not Connected

Check:

```sh
node scripts/rnc.mjs status
```

If `bridge.connected` is false:

- Confirm the daemon is running.
- Confirm RemNote desktop loaded `http://127.0.0.1:8080` from Plugins -> Build -> Develop from localhost.
- Confirm the plugin is enabled.
- Reload the plugin after rebuilding.
- Check for a build mismatch in `doctor`.

## Token Mismatch

Symptoms:

- plugin shows unauthorized
- CLI returns HTTP authorization errors

Fix:

```sh
node scripts/rnc.mjs pair
```

Paste the short-lived pairing code into the local plugin setting. Direct token printing is an unsafe recovery-only path. Do not paste tokens into public issues.

## Operational Root Missing

If `doctor` reports that `RemNoteConnect` or its Trash hierarchy is missing, temporarily disable read-only mode and initialize it explicitly:

```sh
node scripts/rnc.mjs readonly off
node scripts/rnc.mjs init
node scripts/rnc.mjs readonly on
```

## Durable Job Is Outcome Unknown

This means the daemon lost contact after dispatch and cannot prove whether RemNote applied the write. Do not resubmit blindly. Reconcile using the item's `externalId` or inspect the intended parent in RemNote, then create a new job only for items proven absent.

## Port Conflicts

Defaults:

- daemon: `127.0.0.1:8766`
- plugin bundle: `127.0.0.1:8080`

If either port is busy, run the daemon with alternate environment variables:

```sh
REMNOTE_CONNECT_PORT=18766 REMNOTE_CONNECT_PLUGIN_PORT=18080 npx pnpm@11.7.0 --filter @remnoteconnect/daemon start
```

Load the matching plugin URL in RemNote.

## Permission Approval

The plugin may request whole-knowledge-base permissions. If RemNote has not approved the expanded scope, graph-wide reads and writes can fail or appear incomplete.

Run:

```sh
node scripts/rnc.mjs doctor
node scripts/rnc.mjs scope-probe
```

Reload the local plugin and approve the permission prompt if needed.

## Read-Only Blocks Writes

This is expected. Check mode:

```sh
node scripts/rnc.mjs readonly status
```

Temporarily allow writes only for a deliberate write window:

```sh
node scripts/rnc.mjs readonly off
```

Turn it back on afterward.

## Live Scripts Fail

Live scripts require:

- RemNote desktop running
- local daemon running
- plugin connected
- disposable test content allowed

They are not CI tests. CI runs static tests, typechecks, builds, leak scans, and unit tests only.
