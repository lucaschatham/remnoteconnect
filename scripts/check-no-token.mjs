#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const roots = [
  "daemon/src",
  "daemon/test",
  "plugin/src",
  "plugin/test",
  "plugin/public",
  "plugin/dist",
  "shared/src",
  "scripts",
  "docs",
];
const files = ["package.json", "daemon/package.json", "plugin/package.json", "shared/package.json"];
const tokenPattern = /(?<![a-fA-F0-9])[a-fA-F0-9]{64}(?![a-fA-F0-9])/;
const rootDir = new URL("..", import.meta.url).pathname;
const ignoredGeneratedArtifacts = new Set([
  "docs/obsidian-census.json",
  "docs/obsidian-census.md",
  "docs/obsidian-flashcards.json",
  "docs/obsidian-flashcards.md",
  "docs/obsidian-flashcard-review-plan.json",
  "docs/obsidian-flashcard-review-plan.md",
  "docs/obsidian-flashcard-review-import-candidates.json",
  "docs/obsidian-flashcard-review-import-execution.json",
  "docs/obsidian-attachments.json",
  "docs/obsidian-attachments.md",
  "docs/obsidian-attachment-manifest.json",
  "docs/obsidian-attachment-manifest.md",
  "docs/obsidian-attachment-capability-probe.json",
  "docs/obsidian-attachment-capability-probe.md",
  "docs/obsidian-attachment-transfer-plan.json",
  "docs/obsidian-attachment-transfer-plan.md",
  "docs/obsidian-attachment-manual-upload-queue.jsonl",
  "docs/obsidian-link-normalization.json",
  "docs/obsidian-link-normalization.md",
  "docs/obsidian-link-conversion-batch.json",
  "docs/obsidian-link-conversion-batch.jsonl",
  "docs/obsidian-link-conversion-batch.md",
  "docs/obsidian-child-map-audit.json",
  "docs/obsidian-child-map-audit.md",
  "docs/obsidian-link-execution-plan.json",
  "docs/obsidian-link-execution-plan.jsonl",
  "docs/obsidian-link-execution-plan.md",
  "docs/obsidian-link-rewrite-result.json",
  "docs/obsidian-content-completeness.json",
  "docs/obsidian-content-completeness.md",
  "docs/obsidian-needs-review-triage.json",
  "docs/obsidian-needs-review-triage.md",
  "docs/obsidian-needs-review-cleanup-plan.json",
  "docs/obsidian-needs-review-cleanup-plan.md",
  "docs/obsidian-empty-placeholder-plan.json",
  "docs/obsidian-empty-placeholder-plan.md",
  "docs/obsidian-empty-placeholder-import-documents.jsonl",
  "docs/obsidian-empty-placeholder-import-execution.json",
  "docs/obsidian-empty-placeholder-import-verification.json",
  "docs/obsidian-approval-packet.json",
  "docs/obsidian-approval-packet.md",
  "docs/obsidian-approved-write-window-last.json",
  "docs/obsidian-backup-audit.json",
  "docs/obsidian-backup-audit.md",
  "docs/obsidian-write-preflight.json",
  "docs/obsidian-write-preflight.md",
  "docs/obsidian-search-index.jsonl",
  "docs/obsidian-search-index-manifest.json",
  "docs/obsidian-search-index.md",
  "docs/obsidian-migration-completion.json",
  "docs/obsidian-migration-completion.md",
  "docs/obsidian-wrapup-audit.json",
  "docs/obsidian-wrapup-audit.md",
  "docs/obsidian-review-plan.json",
  "docs/obsidian-review-plan.md",
  "docs/obsidian-import-plan.json",
  "docs/obsidian-import-plan.md",
  "docs/obsidian-import-documents.jsonl",
  "docs/obsidian-import-flashcards.json",
  "docs/obsidian-import-review.json",
  "docs/obsidian-import-clean-plan.json",
  "docs/obsidian-import-clean-plan.md",
  "docs/obsidian-import-clean-documents.jsonl",
  "docs/obsidian-import-clean-flashcards.json",
  "docs/obsidian-import-clean-review.json",
  "docs/obsidian-import-strict-plan.json",
  "docs/obsidian-import-strict-plan.md",
  "docs/obsidian-import-strict-documents.jsonl",
  "docs/obsidian-import-strict-flashcards.json",
  "docs/obsidian-import-strict-review.json",
  "docs/obsidian-import-approval-plan.json",
  "docs/obsidian-import-approval-plan.md",
  "docs/obsidian-import-approval-documents.jsonl",
  "docs/obsidian-import-approval-flashcards.json",
  "docs/obsidian-import-approval-review.json",
  "docs/obsidian-import-approval-execution.json",
  "docs/obsidian-import-approval-execution-verification.json",
  "docs/obsidian-import-execution.json",
  "docs/obsidian-import-execution-verification.json",
  "docs/obsidian-import-verification.json",
  "docs/obsidian-import-clean-verification.json",
  "docs/obsidian-import-strict-verification.json",
  "docs/obsidian-import-approval-verification.json",
]);
const ignoredGeneratedPrefixes = [
  "docs/pilot-audits/",
  "docs/obsidian-content-repair",
  "docs/obsidian-link-rewrite-recovery-",
  "docs/obsidian-link-rewrite-chunked-",
  "docs/obsidian-approved-write-window-recovery-",
];

function projectPath(path) {
  return relative(rootDir, path).split("/").join("/");
}

function shouldScan(path) {
  const rel = projectPath(path);
  if (ignoredGeneratedArtifacts.has(rel)) return false;
  return !ignoredGeneratedPrefixes.some((prefix) => rel.startsWith(prefix));
}

function walk(path) {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((entry) => walk(join(path, entry)));
}

for (const root of roots) {
  try {
    files.push(...walk(join(rootDir, root)));
  } catch {
    // Missing optional dirs are fine.
  }
}

const matches = [];
for (const file of files) {
  const path = file.startsWith("/") ? file : join(rootDir, file);
  try {
    if (!shouldScan(path)) continue;
    if (statSync(path).isDirectory()) continue;
    const body = readFileSync(path, "utf8");
    if (tokenPattern.test(body)) matches.push(projectPath(path));
  } catch {
    // Ignore binary or deleted files.
  }
}

if (matches.length > 0) {
  console.error(`Potential 64-hex token found in:\n${matches.join("\n")}`);
  process.exit(1);
}

console.log("No standalone 64-hex tokens found in checked project files.");
