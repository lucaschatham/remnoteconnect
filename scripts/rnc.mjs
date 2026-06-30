#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_URL = process.env.REMNOTE_CONNECT_URL ?? "http://127.0.0.1:8766";
const APP_DIR = process.env.REMNOTE_CONNECT_APP_DIR ?? join(homedir(), "Library", "Application Support", "RemNoteConnect");
const TOKEN_FILE = process.env.REMNOTE_CONNECT_TOKEN_FILE ?? join(APP_DIR, "token");

function usage() {
  console.error(`Usage:
  rnc describe
  rnc doctor
  rnc status
  rnc metrics
  rnc map --depth 3 [--root-id ID]
  rnc get ID
  rnc search "text:query"
  rnc create-document --md file.md [--parent "Inbox"]
  rnc create-document --doc-spec file.json [--parent "Inbox"]
  rnc set-property ID --powerup CODE --slot SLOT --value VALUE
  rnc get-properties ID --powerup CODE --slot SLOT
  rnc create-flashcards-async --file cards.json --confirm
  rnc import-async --md file.md --confirm
  rnc delete --query "text:old" [--confirm] [--confirm-count N]
  rnc find-duplicates [--by text]
  rnc find-empty
  rnc find-orphans
  rnc normalize-text --query "text:old" [--confirm]
  rnc bulk-retag --query "text:old" --tags tag-a,tag-b [--remove-tags old] [--confirm]
  rnc bulk-move --query "text:old" --target "Archive" [--confirm]
  rnc merge --keep-id ID --merge-ids ID,ID [--structural] [--confirm]
  rnc job-status JOB_ID
  rnc job-wait JOB_ID
  rnc confirm-materialized --job-id JOB_ID
  rnc undo OP_ID
  rnc journal-tail [N]
  rnc backup-graph
  rnc empty-trash [--from-dry-run HASH] [--confirm] [--confirm-count N]

Options:
  --json       Print JSON even for TSV/Markdown responses.
  --verbose    Request full Rem summaries where supported.
`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) {
      args.push(item);
      continue;
    }
    const key = item.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i += 1;
    }
  }
  return { args, flags };
}

function token() {
  if (!existsSync(TOKEN_FILE)) {
    console.error(`Token file not found: ${TOKEN_FILE}`);
    process.exit(1);
  }
  return readFileSync(TOKEN_FILE, "utf8").trim();
}

async function call(action, params = {}) {
  const response = await fetch(DEFAULT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action, version: 1, params }),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  const body = await response.json();
  if (body.error) {
    const error = new Error(body.error.message);
    error.details = body.error;
    throw error;
  }
  return body.result;
}

function print(result, flags) {
  if (!flags.json && result && typeof result === "object" && !Array.isArray(result)) {
    if (typeof result.tsv === "string") {
      console.log(result.tsv);
      return;
    }
    if (typeof result.markdown === "string") {
      console.log(result.markdown);
      return;
    }
  }
  console.log(flags.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
}

function commonParams(flags) {
  const params = {};
  if (flags.verbose) params.verbose = true;
  if (flags.confirm) params.confirm = true;
  if (flags.confirmCount !== undefined) params.confirmCount = Number(flags.confirmCount);
  if (flags.fromDryRun !== undefined) params.fromDryRun = String(flags.fromDryRun);
  return params;
}

function commaList(value) {
  return value === undefined ? undefined : String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

async function readJsonPayload(file) {
  const parsed = JSON.parse(await readFile(String(file), "utf8"));
  return Array.isArray(parsed) ? { cards: parsed } : parsed;
}

async function main() {
  const { args, flags } = parseArgs(process.argv.slice(2));
  const command = args[0];
  if (!command) usage();

  let result;
  if (command === "describe" || command === "doctor" || command === "status" || command === "metrics") {
    result = await call(command, commonParams(flags));
  } else if (command === "map") {
    result = await call("map", {
      ...commonParams(flags),
      depth: flags.depth === undefined ? undefined : Number(flags.depth),
      rootId: flags.rootId,
    });
  } else if (command === "get") {
    const id = args[1] ?? flags.id;
    if (!id) usage();
    result = await call("getRem", { ...commonParams(flags), id });
  } else if (command === "search") {
    const query = args[1] ?? flags.query;
    if (!query) usage();
    result = await call("searchGraph", { ...commonParams(flags), query });
  } else if (command === "create-document") {
    const file = flags.md ?? flags.file;
    if (!file && !flags.docSpec) usage();
    result = await call("createDocument", {
      ...commonParams(flags),
      markdown: file ? await readFile(String(file), "utf8") : undefined,
      docSpec: flags.docSpec ? JSON.parse(await readFile(String(flags.docSpec), "utf8")) : undefined,
      parentPath: flags.parent,
    });
  } else if (command === "set-property") {
    const id = args[1] ?? flags.id;
    if (!id) usage();
    result = await call("setProperty", {
      ...commonParams(flags),
      id,
      powerupCode: flags.powerupCode ?? flags.powerup,
      slot: flags.slot,
      propertyId: flags.propertyId,
      value: flags.value,
    });
  } else if (command === "get-properties") {
    const id = args[1] ?? flags.id;
    if (!id) usage();
    result = await call("getProperties", {
      id,
      powerupCode: flags.powerupCode ?? flags.powerup,
      slot: flags.slot,
      propertyId: flags.propertyId,
    });
  } else if (command === "create-flashcards-async") {
    const file = flags.file ?? flags.cards;
    if (!file) usage();
    result = await call("createFlashcardsAsync", {
      ...commonParams(flags),
      ...(await readJsonPayload(file)),
      deckPath: flags.deck ?? flags.deckPath,
      batchId: flags.batchId,
    });
  } else if (command === "import-async") {
    const params = { ...commonParams(flags), parentPath: flags.parent, batchId: flags.batchId, externalId: flags.externalId };
    if (flags.md) {
      result = await call("importAsync", { ...params, markdown: await readFile(String(flags.md), "utf8") });
    } else if (flags.file) {
      result = await call("importAsync", { ...params, ...(await readJsonPayload(flags.file)) });
    } else {
      usage();
    }
  } else if (command === "delete") {
    result = await call(flags.query ? "bulkDelete" : "deleteRem", {
      ...commonParams(flags),
      query: flags.query,
      id: args[1] ?? flags.id,
      remIds: flags.ids ? String(flags.ids).split(",").filter(Boolean) : undefined,
    });
  } else if (command === "find-duplicates") {
    result = await call("findDuplicates", { by: flags.by });
  } else if (command === "find-empty") {
    result = await call("findEmpty", {});
  } else if (command === "find-orphans") {
    result = await call("findOrphans", {});
  } else if (command === "normalize-text") {
    result = await call("normalizeText", {
      ...commonParams(flags),
      query: flags.query,
      id: args[1] ?? flags.id,
      includeBackText: flags.includeBackText === true,
    });
  } else if (command === "bulk-retag") {
    result = await call("bulkRetag", {
      ...commonParams(flags),
      query: flags.query,
      tags: commaList(flags.tags),
      removeTags: commaList(flags.removeTags),
    });
  } else if (command === "bulk-move") {
    result = await call("bulkMove", {
      ...commonParams(flags),
      query: flags.query,
      targetPath: flags.target ?? flags.targetPath ?? flags.parent,
    });
  } else if (command === "merge") {
    result = await call("mergeRems", {
      ...commonParams(flags),
      keepId: flags.keepId ?? args[1],
      mergeIds: commaList(flags.mergeIds ?? flags.ids ?? args[2]),
      structural: flags.structural === true,
    });
  } else if (command === "job-status") {
    const jobId = args[1] ?? flags.jobId;
    if (!jobId) usage();
    result = await call("jobStatus", { jobId });
  } else if (command === "job-wait") {
    const jobId = args[1] ?? flags.jobId;
    if (!jobId) usage();
    result = await call("jobWait", { jobId, timeoutMs: flags.timeoutMs === undefined ? undefined : Number(flags.timeoutMs) });
  } else if (command === "confirm-materialized") {
    result = await call("confirmMaterialized", { jobId: flags.jobId ?? args[1], batchId: flags.batchId });
  } else if (command === "undo") {
    const opId = args[1] ?? flags.opId;
    if (!opId) usage();
    result = await call("undo", { opId });
  } else if (command === "journal-tail") {
    result = await call("journalTail", { n: Number(args[1] ?? flags.n ?? 50) });
  } else if (command === "backup-graph") {
    result = await call("backupGraph", commonParams(flags));
  } else if (command === "empty-trash") {
    result = await call("emptyTrash", commonParams(flags));
  } else {
    usage();
  }
  print(result, flags);
}

main().catch((error) => {
  if (error.details) {
    console.error(JSON.stringify(error.details, null, 2));
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exit(1);
});
