#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assert, call, requireBridge } from "./live-helpers.mjs";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const now = new Date();
const stamp = now.toISOString().replace(/[:.]/g, "-");
const reportDir = join(repoRoot, "docs", "pilot-audits");
const reportPath = join(reportDir, `remnoteconnect-m15-pilot-audit-${stamp}.md`);

const max = {
  duplicateGroups: 12,
  idsPerDuplicateGroup: 4,
  emptySamples: 25,
  orphanSamples: 20,
  uglySamplesPerBucket: 12,
  flashcardSamples: 80,
};

async function timed(label, fn) {
  const started = Date.now();
  const result = await fn();
  return { label, result, durationMs: Date.now() - started };
}

function truncate(value, limit = 120) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

function md(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ")
    .trim();
}

function row(cells) {
  return `| ${cells.map((cell) => md(cell)).join(" | ")} |`;
}

function table(headers, rows) {
  if (rows.length === 0) return "_None found in this audit slice._";
  return [row(headers), row(headers.map(() => "---")), ...rows.map(row)].join("\n");
}

async function getRems(ids, limit) {
  const out = [];
  for (const id of ids.slice(0, limit)) {
    try {
      out.push(await call("getRem", { id }));
    } catch (error) {
      out.push({ id, text: "", path: "", error: error instanceof Error ? error.message : String(error) });
    }
  }
  return out;
}

function parseMapRows(tsv) {
  return String(tsv ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const leading = line.match(/^\s*/)?.[0] ?? "";
      const depth = Math.floor(leading.length / 2);
      const trimmed = line.trimStart();
      const [id, ...rest] = trimmed.split("\t");
      return { id, title: rest.join("\t"), depth };
    })
    .filter((item) => item.id);
}

function classifyUgly(row) {
  const title = row.title.trim();
  const reasons = [];
  if (!title) reasons.push("empty title in map");
  if (/^https?:\/\//i.test(title)) reasons.push("raw URL as title");
  if (/^query:|^contains:/i.test(title)) reasons.push("generated query/helper Rem");
  if (/[\[\(=]$/.test(title) || (title.includes("[") && !title.includes("]")) || (title.includes("(") && !title.includes(")"))) {
    reasons.push("dangling/unbalanced punctuation");
  }
  if (/\bEinsein\b/i.test(title)) reasons.push("likely typo: Einstein");
  if (title.length > 180) reasons.push("very long title");
  if (/^(todo|to do|fix|tbd|edit later)$/i.test(title)) reasons.push("staging/edit-later title");
  return reasons;
}

function groupUglyCandidates(rows) {
  const buckets = new Map();
  for (const item of rows) {
    for (const reason of classifyUgly(item)) {
      const list = buckets.get(reason) ?? [];
      list.push(item);
      buckets.set(reason, list);
    }
  }
  return [...buckets.entries()].map(([reason, items]) => ({
    reason,
    count: items.length,
    samples: items.slice(0, max.uglySamplesPerBucket),
  }));
}

function flashcardWeakReasons(summary) {
  const front = String(summary.text ?? "").trim();
  const back = String(summary.backText ?? "").trim();
  const reasons = [];
  if (!front) reasons.push("empty front");
  if (!back) reasons.push("empty back");
  if (front && back && front.toLowerCase() === back.toLowerCase()) reasons.push("front equals back");
  if (front.length > 280) reasons.push("front likely too long");
  if (back.length > 500) reasons.push("back likely too long");
  if (/\b(todo|tbd|edit later|rewrite|fix me)\b/i.test(`${front} ${back}`)) reasons.push("contains edit-later marker");
  const wrongInRow = Math.max(...(summary.cards ?? []).map((card) => Number(card.timesWrongInRow ?? 0)), 0);
  if (wrongInRow >= 3) reasons.push(`timesWrongInRow >= ${wrongInRow}`);
  return reasons;
}

async function main() {
  const initialStatus = await requireBridge();
  assert(initialStatus.daemonVersion === "0.3.0", `Expected daemon 0.3.0, got ${initialStatus.daemonVersion}`);
  assert(initialStatus.bridge?.pluginVersion === "0.3.0", `Expected plugin 0.3.0, got ${initialStatus.bridge?.pluginVersion}`);

  await call("readonly", { mode: "on" });
  const readonlyStatus = await call("status");
  assert(readonlyStatus.readonlyMode === true, "Failed to enable read-only mode before pilot audit.");

  const doctor = await timed("doctor", () => call("doctor"));
  const mapDepth = Number(process.env.REMNOTE_CONNECT_PILOT_MAP_DEPTH ?? 2);
  const graphMap = await timed(`map depth ${mapDepth}`, () => call("map", { depth: mapDepth }));
  const mapRows = parseMapRows(graphMap.result.tsv);
  const ugly = groupUglyCandidates(mapRows);

  const duplicates = await timed("findDuplicates", () => call("findDuplicates", {}));
  const duplicateGroups = [...(duplicates.result.groups ?? [])].sort((a, b) => b.count - a.count || String(a.text).localeCompare(String(b.text)));
  const duplicateSamples = [];
  for (const group of duplicateGroups.slice(0, max.duplicateGroups)) {
    duplicateSamples.push({
      text: group.text,
      count: group.count,
      items: await getRems(group.remIds ?? [], max.idsPerDuplicateGroup),
    });
  }

  const empty = await timed("findEmpty", () => call("findEmpty", {}));
  const emptySamples = await getRems(empty.result.remIds ?? empty.result.ids ?? [], max.emptySamples);

  const orphans = await timed("findOrphans verbose", () => call("findOrphans", { verbose: true }));
  const orphanItems = (orphans.result.items ?? []).slice(0, max.orphanSamples);

  const flashcards = await timed("searchFlashcards", () => call("searchFlashcards", {}));
  const flashcardIds = flashcards.result.remIds ?? flashcards.result.ids ?? [];
  const flashcardSummaries = await getRems(flashcardIds, max.flashcardSamples);
  const weakFlashcards = flashcardSummaries
    .map((summary) => ({ summary, reasons: flashcardWeakReasons(summary) }))
    .filter((item) => item.reasons.length > 0);

  const markerQueries = ["text:\"edit later\"", "text:TODO", "text:rewrite", "text:\"fix me\""];
  const markerResults = [];
  for (const query of markerQueries) {
    try {
      const result = await timed(`searchFlashcards ${query}`, () => call("searchFlashcards", { query }));
      markerResults.push({ query, count: result.result.count ?? 0, durationMs: result.durationMs });
    } catch (error) {
      markerResults.push({ query, count: "error", error: error instanceof Error ? error.message : String(error) });
    }
  }

  const finalStatus = await call("status");

  const duplicateRows = duplicateSamples.flatMap((group) =>
    group.items.map((item, index) => [
      index === 0 ? group.count : "",
      index === 0 ? truncate(group.text, 80) : "",
      item.id,
      truncate(item.text || "(empty)", 80),
      truncate(item.path, 100),
    ]),
  );
  const uglyRows = ugly.flatMap((bucket) =>
    bucket.samples.map((item, index) => [index === 0 ? bucket.reason : "", index === 0 ? bucket.count : "", item.id, truncate(item.title || "(empty)", 100)]),
  );
  const weakRows = weakFlashcards.slice(0, 25).map(({ summary, reasons }) => [
    summary.id,
    reasons.join(", "),
    truncate(summary.text || "(empty)", 80),
    truncate(summary.backText || "(empty)", 80),
    truncate(summary.path, 100),
  ]);

  const lines = [
    "# RemNoteConnect M1.5 Pilot Readiness Audit",
    "",
    `Generated: ${now.toISOString()}`,
    "",
    "## Safety State",
    "",
    "- RemNote writes were not performed by this audit.",
    "- Daemon read-only mode was enabled before collecting data.",
    `- Runtime: daemon ${readonlyStatus.daemonVersion}, plugin ${readonlyStatus.bridge?.pluginVersion}, build ${readonlyStatus.daemonBuildHash}.`,
    `- Final status: readonly=${finalStatus.readonlyMode}, connected=${finalStatus.bridge?.connected}, activeConnections=${finalStatus.bridge?.activeConnections}, pendingJobs=${finalStatus.bridge?.pendingJobs}.`,
    "",
    "## High-Level Findings",
    "",
    `- Whole-KB scope probe: ${doctor.result.checks?.scopeProbe?.ok ? "PASS" : "FAIL"} over ${doctor.result.checks?.scopeProbe?.totalRems ?? "unknown"} accessible Rems.`,
    `- Map depth ${mapDepth}: ${graphMap.result.rowCount} outline rows in ${graphMap.durationMs}ms.`,
    `- Exact duplicate text groups: ${duplicates.result.count} in ${duplicates.durationMs}ms.`,
    `- Empty leaf Rems: ${empty.result.count} in ${empty.durationMs}ms.`,
    `- Orphan-like Rems: ${orphans.result.count} in ${orphans.durationMs}ms.`,
    `- Flashcard Rems found: ${flashcards.result.count} in ${flashcards.durationMs}ms; weak-card heuristics sampled ${flashcardSummaries.length} cards.`,
    "",
    "## Cleanup Proposal Queue (No Writes)",
    "",
    "### 1. Empty Leaf Rems",
    "",
    "Do not bulk-delete these yet. The count is large enough that they should first be grouped by parent/path and separated into system/generated Rem vs user-created abandoned placeholders.",
    "",
    table(
      ["ID", "Title", "Path"],
      emptySamples.map((item) => [item.id, truncate(item.text || "(empty)", 80), truncate(item.path, 120)]),
    ),
    "",
    "### 2. Exact Duplicate Text Groups",
    "",
    "These are exact normalized-text duplicates. Many may be legitimate repeated answer fields, templates, generated query helpers, or imported Anki fields. Default action should be review, not merge.",
    "",
    table(["Group count", "Duplicate text", "Sample ID", "Sample title", "Sample path"], duplicateRows),
    "",
    "### 3. Orphan-Like Rems",
    "",
    "These have a non-null parent id that was not visible in the accessible graph snapshot. Inspect first; likely actions are move to an explicit review folder or tombstone with undo.",
    "",
    table(
      ["ID", "Title", "Parent ID", "Path"],
      orphanItems.map((item) => [item.id, truncate(item.text || "(empty)", 80), item.parentId ?? "(blank/undefined)", truncate(item.path, 120)]),
    ),
    "",
    "### 4. Ugly Title Candidates",
    "",
    `Sampled from map depth ${mapDepth}. This is a proposal list only; some generated query/helper Rems are expected RemNote internals and should not be renamed.`,
    "",
    table(["Reason", "Bucket count", "ID", "Title"], uglyRows),
    "",
    "### 5. Weak Flashcard Candidates",
    "",
    "Current RemNoteConnect does not yet have a first-class weak-card audit. This section uses a bounded sample plus edit-marker searches.",
    "",
    table(["ID", "Reason", "Front", "Back", "Path"], weakRows),
    "",
    table(["Marker query", "Count", "Duration/error"], markerResults.map((item) => [item.query, item.count, item.durationMs ?? item.error ?? ""])),
    "",
    "## Workflow Gaps Found During Pilot",
    "",
    "- Built-in read actions can return terminal-flooding payloads on this KB. `findEmpty` returned thousands of IDs and `map` can expose very large outlines.",
    "- `findEmpty` needs parent/path aggregation before it is useful for safe cleanup.",
    "- `findDuplicates` needs filters for system/generated Rems, minimum text length, parent grouping, and capped output.",
    "- Weak flashcard review needs a first-class read action that scores all cards without issuing one `getRem` per sampled card.",
    "- Ugly-title detection needs a deterministic candidate generator plus an approval queue; direct rename should not be autonomous.",
    "- `findOrphans` currently needs stricter parent semantics; this pilot surfaced blank/undefined parent IDs, so treat output as orphan-like until verified.",
    "- A local read-only mirror is justified by the observed graph size and repeated full-graph scans, but it should start as JSONL/TSV files and deterministic indexes before embeddings.",
    "",
    "## M2 Mirror/Index Decision",
    "",
    "Evidence supports a narrow M2 read-only mirror/index. The mirror should be used to make audits cheap and reviewable, not to bypass RemNoteConnect safety gates.",
    "",
    "Minimum M2 scope:",
    "",
    "- `rnc sync-local`: writes Rem IDs, parent IDs, titles, paths, tags, card metadata, and text/back-text hashes to local JSONL.",
    "- `rnc audit-local`: runs duplicate, empty, ugly-title, orphan-like, and weak-card heuristics against the mirror.",
    "- `rnc proposal`: emits a human-reviewable queue with action type, target IDs, rationale, confidence, and required approval.",
    "- Writes still go through live RemNoteConnect `confirm:true`, magnitude guard, tombstone/undo, and read-only off.",
    "- Embeddings remain deferred until deterministic local search/audit proves insufficient.",
    "",
    "## Approval Guidance",
    "",
    "No cleanup batch was executed because no explicit approval was provided. Good first approval candidates would be 5-10 orphan-like or empty leaf Rems after parent/path inspection, not duplicate merges.",
    "",
  ];

  await mkdir(reportDir, { recursive: true });
  await writeFile(reportPath, `${lines.join("\n")}\n`, "utf8");

  console.log(
    JSON.stringify(
      {
        status: "PASS",
        reportPath,
        readonlyMode: finalStatus.readonlyMode,
        totals: {
          rems: doctor.result.checks?.scopeProbe?.totalRems,
          duplicateGroups: duplicates.result.count,
          emptyLeafRems: empty.result.count,
          orphanLikeRems: orphans.result.count,
          flashcardRems: flashcards.result.count,
          weakFlashcardSampleCount: weakFlashcards.length,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(JSON.stringify({ status: "FAIL", message: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
});
