#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { call, requireBridge, url } from "./live-helpers.mjs";

const appDir =
  process.env.REMNOTE_CONNECT_APP_DIR ??
  join(homedir(), "Library", "Application Support", "RemNoteConnect");

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);
const sha = createHash("sha256").update(png).digest("hex");
const mediaName = `${sha}.png`;
const mediaDir = join(appDir, "media");
const mediaUrl = `${url}/media/${mediaName}`;

function checked(value) {
  return value ? "PASS" : "FAIL";
}

function redactSha(value) {
  return String(value).replace(/[a-f0-9]{64}/gi, "<sha256>");
}

function markdown(result) {
  const probes = result.probes ?? {};
  return `# Anki Migration Runtime Probes

Generated: ${new Date().toISOString()}

Run id: \`${result.runId}\`

Overall: **${checked(result.ok)}**

## P1 - Cloze Materialization

Status: **${checked(probes.cloze?.ok)}**

- Single cloze card count: ${probes.cloze?.singleClozeCount ?? "n/a"}
- Single card types: \`${JSON.stringify(probes.cloze?.singleCardTypes ?? [])}\`
- Multi-cloze card count: ${probes.cloze?.multiClozeCount ?? "n/a"}
- Multi card types: \`${JSON.stringify(probes.cloze?.multiCardTypes ?? [])}\`
- Grouping observation: ${probes.cloze?.groupingObservation ?? "n/a"}

## P2 - HTML Fidelity

Status: **${checked(probes.html?.ok)}**

- Descendant count after \`parseAndInsertHtml\`: ${probes.html?.readback?.descendantCount ?? "n/a"}
- Readback sample: \`${JSON.stringify((probes.html?.readback?.rems ?? []).slice(0, 3))}\`

## P3 - Media Reachability

Status: **${checked(probes.media?.ok)}**

- Data URI URLs retained: \`${JSON.stringify(probes.media?.dataUri?.urls ?? [])}\`
- Daemon URL: ${redactSha(probes.media?.daemonUrl?.url ?? mediaUrl)}
- Daemon URLs retained: \`${redactSha(JSON.stringify(probes.media?.daemonUrl?.urls ?? []))}\`
- Caveat: ${probes.media?.caveat ?? "n/a"}

## P4 - Deck As Document

Status: **${checked(probes.deckAsDocument?.ok)}**

- Document id: \`${probes.deckAsDocument?.documentId ?? "n/a"}\`
- isDocument: ${probes.deckAsDocument?.isDocument ?? "n/a"}
- Card count inside document: ${probes.deckAsDocument?.cardCount ?? "n/a"}

## Cleanup

- Mode: ${result.cleanup?.mode ?? "n/a"}
- Tombstone opId: \`${result.cleanup?.opId ?? "n/a"}\`

No hard delete was performed by this probe.
`;
}

try {
  await requireBridge();
  await mkdir(mediaDir, { recursive: true });
  await writeFile(join(mediaDir, mediaName), png, { mode: 0o600 });

  const dryRun = await call("ankiMigrationProbes", {});
  if (dryRun.dryRun !== true) throw new Error("ankiMigrationProbes did not return dryRun:true before confirm.");

  const result = await call("ankiMigrationProbes", { confirm: true, mediaUrl });
  await writeFile("docs/anki-migration-probes.md", markdown(result));
  console.log(JSON.stringify({ status: result.ok ? "PASS" : "FAIL", mediaUrl, doc: "docs/anki-migration-probes.md", result }, null, 2));
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ status: "FAIL", message: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
}
