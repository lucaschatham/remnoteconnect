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
npx pnpm@11.7.0 token:unsafe
```

Paste the current token into the local plugin settings. Do not paste tokens into public issues.

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
