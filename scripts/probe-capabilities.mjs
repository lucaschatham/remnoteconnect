#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { call, cleanupByText, emptyTrashOpId, requireBridge } from "./live-helpers.mjs";

const runId = `__rnc_probe__-${Date.now().toString(36)}`;
const reportPath = join(process.cwd(), "docs", "capability-report.md");

function statusIcon(status) {
  if (status === "PASS") return "PASS";
  if (status === "UNSUPPORTED") return "UNSUPPORTED";
  return "FAIL";
}

function jsonBlock(value) {
  return `\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
}

function markdownReport(result, cleanupResult, status, scopeProbe) {
  const rows = Array.isArray(result.capabilities) ? result.capabilities : [];
  const lines = [
    "# RemNoteConnect Capability Report",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Run ID: \`${result.runId ?? runId}\``,
    `SDK target: \`${result.sdkVersion ?? "@remnote/plugin-sdk@0.0.46"}\``,
    `Bridge connected: \`${status.bridge?.connected === true}\``,
    `Plugin version: \`${status.bridge?.pluginVersion ?? "unknown"}\``,
    `Accessible Rem count at probe time: \`${scopeProbe?.totalRems ?? "unknown"}\``,
    "",
    "## Summary",
    "",
    `- PASS: ${result.summary?.pass ?? rows.filter((row) => row.status === "PASS").length}`,
    `- FAIL: ${result.summary?.fail ?? rows.filter((row) => row.status === "FAIL").length}`,
    `- UNSUPPORTED: ${result.summary?.unsupported ?? rows.filter((row) => row.status === "UNSUPPORTED").length}`,
    "",
    "## Capability Matrix",
    "",
    "| Capability | Status | SDK/API Method | Workaround / Notes |",
    "|---|---:|---|---|",
  ];
  for (const row of rows) {
    const note = row.workaround ?? row.error?.message ?? "";
    lines.push(`| \`${row.capability}\` | ${statusIcon(row.status)} | \`${String(row.method ?? "").replaceAll("|", "\\|")}\` | ${String(note).replaceAll("|", "\\|")} |`);
  }
  lines.push(
    "",
    "## Detailed Results",
    "",
    jsonBlock(rows),
    "## Cleanup",
    "",
    `- Probe content was created under \`${result.runId ?? runId}\`.`,
    `- Plugin soft-delete opId: \`${result.cleanup?.opId ?? "missing"}\`.`,
    `- Hard-delete cleanup: \`${cleanupResult.status}\` ${cleanupResult.message ? `(${cleanupResult.message})` : ""}`,
    "",
    "## Downstream Assumptions",
    "",
    "- If `imageOcclusion` is `UNSUPPORTED`, RemNoteConnect should not promise fully automated image occlusion authoring; use RemNote UI or a user-assisted workflow until the SDK exposes a scriptable API.",
    "- If imported Concept/Descriptor/Multi-line/List syntax is `FAIL`, generated cards should use explicit SDK front/back or cloze paths and document the divergence from RemNote paste/import syntax.",
    "- If no change-feed methods appear under `driftPrimitives`, M2 sync should use chunked `getAll` snapshot sweeps plus content hashes and a stale-index marker. In this probe, `updatedAt` existed but did not change immediately after `setText`, so do not treat it as sufficient by itself until a longer direct-edit probe proves it.",
    "- Data-URI images failed in the live rich-text image probe. Prefer daemon-local file URLs or RemNote-supported uploaded media URLs for generated/imported image content; media probes verify serialization and URL retention, not visual rendering in every RemNote surface.",
    "",
  );
  return lines.join("\n");
}

async function main() {
  const status = await requireBridge();
  const scopeProbe = await call("scopeProbe", {});
  let result;
  let cleanupResult = { status: "not_run" };
  try {
    result = await call("capabilityProbes", { runId, confirm: true });
    if (result.cleanup?.opId) {
      await emptyTrashOpId(result.cleanup.opId);
      cleanupResult = { status: "emptyTrash_ok" };
    }
  } finally {
    try {
      await cleanupByText(runId);
      if (cleanupResult.status === "not_run") cleanupResult = { status: "cleanupByText_ok" };
    } catch (error) {
      cleanupResult = { status: "cleanup_failed", message: error instanceof Error ? error.message : String(error) };
    }
  }

  if (!result) throw new Error("capabilityProbes did not return a result.");
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, markdownReport(result, cleanupResult, status, scopeProbe));
  console.log(JSON.stringify({ status: "PASS", runId, reportPath, summary: result.summary, cleanup: cleanupResult }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ status: "FAIL", runId, message: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exit(1);
});
