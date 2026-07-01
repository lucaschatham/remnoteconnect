#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { call, url } from "./live-helpers.mjs";

const ANKI_URL = process.env.ANKI_CONNECT_URL ?? "http://127.0.0.1:8765";
const APP_DIR =
  process.env.REMNOTE_CONNECT_APP_DIR ??
  join(homedir(), "Library", "Application Support", "RemNoteConnect");
const MEDIA_DIR = join(APP_DIR, "media");

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags[key] = true;
    else {
      flags[key] = next;
      i += 1;
    }
  }
  return flags;
}

function usage() {
  console.error(`Usage:
  node scripts/anki-migrate.mjs --dry-run [--deck "NATO"] [--root "Anki Import"]
  node scripts/anki-migrate.mjs --confirm --confirm-count N [--deck "NATO"] [--root "Anki Import"]

Options:
  --deck NAME             Migrate only one Anki deck.
  --smoke                 Shortcut for --deck NATO.
  --root NAME             RemNote import root. Default: Anki Import.
  --media-mode MODE       daemon or data-uri. Default: daemon.
  --mapping FILE          JSON note-type mapping overrides.
  --limit N               Convert at most N notes, for local validation.
  --batch-size N          Cards per durable RemNote job. Default: 25.
  --item-timeout-ms N     Per-card RemNote bridge timeout. Default: 600000.
  --deck-as-document      Make imported deck leaves RemNote Documents. Default: folders.
  --verbose               Include full Anki model fields/templates in output.
`);
  process.exit(2);
}

async function anki(action, params = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(ANKI_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, version: 6, params }),
      });
      const body = await response.json();
      if (body.error) throw new Error(`AnkiConnect ${action} failed: ${body.error}`);
      return body.result;
    } catch (error) {
      lastError = error;
      if (attempt === 5) break;
      await sleep(attempt * 500);
    }
  }
  throw new Error(`AnkiConnect ${action} fetch failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function daemonCall(action, params = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await call(action, params);
    } catch (error) {
      lastError = error;
      if (error?.details || attempt === 5) break;
      await sleep(attempt * 500);
    }
  }
  throw lastError;
}

function stripHtml(html = "") {
  return String(html)
    .replace(/\[sound:[^\]]+\]/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .trim();
}

function mimeFromName(name) {
  const ext = extname(name).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".ogg") return "audio/ogg";
  return "application/octet-stream";
}

async function storeMedia(filename, base64, mode) {
  if (!base64) return undefined;
  const bytes = Buffer.from(base64, "base64");
  const mime = mimeFromName(filename);
  if (mode === "data-uri") return `data:${mime};base64,${base64}`;
  await mkdir(MEDIA_DIR, { recursive: true });
  const sha = createHash("sha256").update(bytes).digest("hex");
  const safeExt = extname(filename).replace(/[^.A-Za-z0-9]/g, "") || "";
  const name = `${sha}${safeExt}`;
  await writeFile(join(MEDIA_DIR, name), bytes, { mode: 0o600 });
  return `${url}/media/${name}`;
}

async function rewriteMedia(html, mediaMode, mediaStats) {
  let output = String(html ?? "");
  const srcMatches = [...output.matchAll(/\bsrc=(["'])(.*?)\1/gi)];
  for (const match of srcMatches) {
    const original = match[2];
    if (!original || /^(https?:|data:)/i.test(original)) continue;
    const base64 = await anki("retrieveMediaFile", { filename: original });
    if (!base64) {
      mediaStats.missing.push(original);
      continue;
    }
    const rewritten = await storeMedia(original, base64, mediaMode);
    if (rewritten) {
      output = output.split(match[0]).join(`src="${rewritten}"`);
      mediaStats.embedded += 1;
    }
  }
  const soundMatches = [...output.matchAll(/\[sound:([^\]]+)\]/gi)];
  for (const match of soundMatches) {
    const filename = match[1];
    const base64 = await anki("retrieveMediaFile", { filename });
    if (!base64) {
      mediaStats.missing.push(filename);
      continue;
    }
    const rewritten = await storeMedia(filename, base64, mediaMode);
    if (rewritten) {
      output = output.replace(match[0], `<audio controls src="${rewritten}"></audio>`);
      mediaStats.embedded += 1;
    }
  }
  return output;
}

function fieldsOf(note) {
  const fields = note.fields ?? {};
  return Object.entries(fields).map(([name, raw]) => ({
    name,
    html: String(raw?.value ?? raw ?? ""),
    value: stripHtml(String(raw?.value ?? raw ?? "")),
  }));
}

function parseCloze(sourceHtml) {
  const re = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;
  let plain = "";
  let last = 0;
  const spans = [];
  for (const match of sourceHtml.matchAll(re)) {
    plain += stripHtml(sourceHtml.slice(last, match.index));
    const answer = stripHtml(match[2]);
    const start = plain.length;
    plain += answer;
    const end = plain.length;
    spans.push({ group: Number(match[1]), start, end, hint: stripHtml(match[3] ?? "") || undefined });
    last = match.index + match[0].length;
  }
  plain += stripHtml(sourceHtml.slice(last));
  return { text: plain, spans };
}

function mappingFor(modelName, fields, overrides) {
  const override = overrides[modelName];
  if (override) return override;
  const lower = modelName.toLowerCase();
  if (lower.includes("cloze") || fields.some((field) => /\{\{c\d+::/.test(field.html))) return { type: "cloze" };
  if (lower.includes("reverse")) return { type: "basic", practiceDirection: "both" };
  return { type: "basic", practiceDirection: "forward" };
}

function targetPathForDeck(root, deck, deckNames, hasOwnCards) {
  const hasChildren = deckNames.some((candidate) => candidate !== deck && candidate.startsWith(`${deck}::`));
  const normalizedDeck = deck.split("::").filter(Boolean).join("::");
  if (hasChildren && hasOwnCards) {
    const parts = normalizedDeck.split("::");
    return `${root}::${normalizedDeck}::${parts.at(-1)} cards`;
  }
  return `${root}::${normalizedDeck}`;
}

async function convertNote(note, context) {
  const fields = fieldsOf(note);
  const mapping = mappingFor(String(note.modelName ?? ""), fields, context.mapping);
  const rewritten = [];
  for (const field of fields) {
    rewritten.push({ ...field, html: await rewriteMedia(field.html, context.mediaMode, context.mediaStats) });
  }
  const tags = Array.isArray(note.tags) ? note.tags : [];
  const guid = String(note.guid ?? note.noteId);
  const first = rewritten[0] ?? { name: "Front", html: "", value: "" };
  const second = rewritten[1] ?? { name: "Back", html: "", value: "" };
  const extraFields = rewritten.slice(2);

  if (mapping.type === "cloze") {
    const cloze = parseCloze(rewritten.map((field) => field.html).join("\n"));
    const groups = new Map();
    for (const span of cloze.spans) {
      const list = groups.get(span.group) ?? [];
      list.push(span);
      groups.set(span.group, list);
    }
    if (groups.size === 0) context.fallbacks.push({ guid, modelName: note.modelName, reason: "cloze model without cloze markers" });
    return [...groups.entries()].map(([group, spans]) => ({
      externalId: `anki:${guid}:cloze:${group}`,
      deckPath: context.deckPath,
      deckAsDocument: context.deckAsDocument,
      plainDeckPath: context.plainDeckPath,
      replaceChildrenOnUpdate: true,
      clozeText: cloze.text,
      clozeSpans: spans,
      tags,
      extraFields,
      modelName: note.modelName,
      ankiGuid: guid,
    }));
  }

  return [
    {
      externalId: `anki:${guid}`,
      deckPath: context.deckPath,
      deckAsDocument: context.deckAsDocument,
      plainDeckPath: context.plainDeckPath,
      replaceChildrenOnUpdate: true,
      front: first.value,
      back: second.value,
      frontHtml: first.html,
      backHtml: second.html,
      practiceDirection: mapping.practiceDirection ?? "forward",
      tags,
      extraFields,
      modelName: note.modelName,
      ankiGuid: guid,
    },
  ];
}

async function chunks(items, size, fn) {
  const results = [];
  for (let offset = 0; offset < items.length; offset += size) {
    results.push(...(await fn(items.slice(offset, offset + size), offset)));
  }
  return results;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkItems(items, size) {
  const chunks = [];
  for (let offset = 0; offset < items.length; offset += size) {
    chunks.push({ index: chunks.length + 1, offset, items: items.slice(offset, offset + size) });
  }
  return chunks;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) usage();
  const root = String(flags.root ?? "Anki Import");
  const mediaMode = String(flags.mediaMode ?? "daemon");
  const deckFilter = flags.smoke ? "NATO" : flags.deck ? String(flags.deck) : undefined;
  const limit = flags.limit === undefined ? undefined : Number(flags.limit);
  const confirm = flags.confirm === true;
  const verbose = flags.verbose === true;
  const deckAsDocument = flags.deckAsDocument === true;
  const plainDeckPath = flags.deckAsDocument !== true;
  const batchSize = Math.max(1, Number(flags.batchSize ?? 25));
  const itemTimeoutMs = Math.max(30_000, Number(flags.itemTimeoutMs ?? 600_000));
  const mapping = flags.mapping ? JSON.parse(await readFile(String(flags.mapping), "utf8")) : {};

  const version = await anki("version");
  if (Number(version) < 6) throw new Error(`AnkiConnect version ${version} is too old; expected >= 6.`);
  const doctor = await daemonCall("doctor");
  if (doctor.ok !== true || doctor.checks?.scopeProbe?.ok !== true) throw new Error("RemNoteConnect doctor/scopeProbe is not green.");
  const describe = await daemonCall("describe");
  const features = describe.migrationFeatures ?? {};
  for (const key of ["durableAsync", "parseAndInsertHtml", "clozeWrite", "mediaPipeline", "noteTypeMapping", "finalAsDocument"]) {
    if (!features[key]) throw new Error(`RemNoteConnect migration feature missing: ${key}`);
  }

  const deckNames = (await anki("deckNames")).filter((deck) => !deckFilter || deck === deckFilter || deck.startsWith(`${deckFilter}::`));
  if (deckNames.length === 0) throw new Error(`No Anki decks matched ${deckFilter ?? "all decks"}.`);
  const modelNames = await anki("modelNames");
  let models;
  if (verbose) {
    models = [];
    for (const modelName of modelNames) {
      models.push({
        name: modelName,
        fields: await anki("modelFieldNames", { modelName }),
        templates: await anki("modelTemplates", { modelName }),
      });
    }
  }

  const mediaStats = { embedded: 0, missing: [] };
  const fallbacks = [];
  const perDeck = [];
  const allCards = [];

  for (const deck of deckNames) {
    const cardIds = await anki("findCards", { query: `deck:"${deck.replace(/"/g, '\\"')}"` });
    const cardInfos = await chunks(cardIds, 100, (cards) => anki("cardsInfo", { cards }));
    const exactCardInfos = cardInfos.filter((card) => !card.deckName || card.deckName === deck);
    const noteIds = [...new Set(exactCardInfos.map((card) => card.note ?? card.noteId).filter(Boolean))];
    const limitedIds = limit ? noteIds.slice(0, limit) : noteIds;
    const deckPath = targetPathForDeck(root, deck, deckNames, limitedIds.length > 0);
    const notes = await chunks(limitedIds, 100, (ids) => anki("notesInfo", { notes: ids }));
    const converted = [];
    for (const note of notes) {
      converted.push(...(await convertNote(note, { deckPath, deckAsDocument, plainDeckPath, mediaMode, mediaStats, mapping, fallbacks })));
    }
    perDeck.push({ deck, ankiCardCount: exactCardInfos.length, noteCount: notes.length, convertedCardCount: converted.length, deckPath });
    allCards.push(...converted);
  }

  const sample = allCards.slice(0, 5).map((card) => ({
    externalId: card.externalId,
    deckPath: card.deckPath,
    practiceDirection: card.practiceDirection,
    cloze: Boolean(card.clozeText),
    front: card.front,
    back: card.back,
    extraFieldCount: card.extraFields?.length ?? 0,
  }));

  if (!confirm) {
    const output = {
      status: "DRY_RUN",
      ankiVersion: version,
      root,
      mediaMode,
      deckAsDocument,
      plainDeckPath,
      batchSize,
      itemTimeoutMs,
      deckCount: perDeck.length,
      totalCards: allCards.length,
      estimatedJobs: perDeck.reduce((count, deck) => count + Math.ceil(deck.convertedCardCount / batchSize), 0),
      perDeck,
      sample,
      mediaStats,
      fallbacks,
      modelSummary: { count: modelNames.length, names: modelNames },
      next: `Re-run with --confirm --confirm-count ${allCards.length}`,
    };
    if (models) output.models = models;
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  if (Number(flags.confirmCount) !== allCards.length) {
    throw new Error(`confirmCount mismatch. Expected --confirm-count ${allCards.length}.`);
  }

  const jobs = [];
  async function waitForDurableJob(jobId, timeoutMs) {
    const attempts = 6;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await daemonCall("jobWait", { jobId, timeoutMs });
      } catch (error) {
        const details = error?.details;
        const job = details?.details;
        if (details?.code !== "timeout" || job?.status !== "queued" || attempt === attempts) throw error;
        await sleep(Math.min(10_000, attempt * 1_000));
      }
    }
    throw new Error(`Timed out waiting for durable job ${jobId}.`);
  }

  for (const deck of perDeck) {
    const cards = allCards.filter((card) => card.deckPath === deck.deckPath);
    if (cards.length === 0) continue;
    const batches = chunkItems(cards, batchSize);
    for (const batch of batches) {
      const queued = await daemonCall("createFlashcardsAsync", {
        confirm: true,
        deckPath: deck.deckPath,
        cards: batch.items,
        batchId: `anki:${deck.deck}`,
        waitForCards: false,
        itemTimeoutMs,
      });
      const completed = await waitForDurableJob(queued.jobId, Math.max(15 * 60_000, batch.items.length * 60_000));
      const count = completed.ids?.length ?? completed.count ?? 0;
      jobs.push({
        deck: deck.deck,
        chunk: batch.index,
        chunks: batches.length,
        jobId: queued.jobId,
        status: completed.status,
        count,
      });
      if (completed.status !== "complete") {
        throw new Error(`Job ${queued.jobId} for ${deck.deck} chunk ${batch.index}/${batches.length} finished with status ${completed.status}.`);
      }
    }
  }
  const migratedCount = jobs.reduce((count, job) => count + Number(job.count ?? 0), 0);
  if (migratedCount !== allCards.length) {
    throw new Error(`Migrated count mismatch. Expected ${allCards.length}, got ${migratedCount}.`);
  }

  const output = {
    status: "COMPLETE",
    root,
    deckAsDocument,
    plainDeckPath,
    batchSize,
    itemTimeoutMs,
    totalCards: allCards.length,
    migratedCount,
    perDeck,
    jobCount: jobs.length,
    jobs,
    mediaStats,
    fallbacks,
    modelSummary: { count: modelNames.length, names: modelNames },
    caveat: mediaMode === "daemon" ? "Media URLs are local to this Mac and will not render on other synced devices unless re-hosted." : undefined,
  };
  if (models) output.models = models;
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ status: "FAIL", message: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
});
