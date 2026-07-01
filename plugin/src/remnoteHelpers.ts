import type { ReactRNPlugin, RichTextFormatName, RichTextInterface } from "@remnote/plugin-sdk";
import { MANAGED_ROOT_NAME, normalizePath, parseQuery, unique, type RemSnapshot, type RemSnapshotNode } from "@remnoteconnect/shared";
import type { CardSummary, RemSummary, ResolvedTarget, RichTextish } from "./types.js";
import type { CardObject, RemObject } from "./sdkTypes.js";

type BuilderTextFormat = Exclude<RichTextFormatName, "cloze">;
const BUILDER_TEXT_FORMATS = new Set<string>([
  "quote",
  "underline",
  "bold",
  "italic",
  "Red",
  "Orange",
  "Yellow",
  "Green",
  "Blue",
  "Purple",
  "Gray",
  "Brown",
  "Pink",
]);

export async function yieldToEventLoop(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export async function mapBounded<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function toRichText(plugin: ReactRNPlugin, input: RichTextish): Promise<RichTextInterface> {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    if (typeof record.markdown === "string") return plugin.richText.parseFromMarkdown(record.markdown);
    if (Array.isArray(record.table)) return plugin.richText.parseFromMarkdown(markdownTable(record.table));
  }
  const segments = richTextSegments(input);
  if (segments) return buildRichText(plugin, segments);
  if (Array.isArray(input)) return input as RichTextInterface;
  return plugin.richText.text(String(input ?? "")).value();
}

function markdownTable(rows: unknown[]): string {
  const tableRows = rows
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) => row.map((cell) => String(cell ?? "").replace(/\|/g, "\\|")));
  if (tableRows.length === 0) return "";
  const width = Math.max(...tableRows.map((row) => row.length));
  const normalized = tableRows.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? ""));
  const header = normalized[0];
  const body = normalized.slice(1);
  return [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...body.map((row) => `| ${row.join(" | ")} |`)].join("\n");
}

function richTextSegments(input: RichTextish): Record<string, unknown>[] | undefined {
  if (Array.isArray(input)) {
    const records = input.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
    return records.length === input.length && records.some((item) => typeof item.type === "string") ? records : undefined;
  }
  if (input && typeof input === "object" && !Array.isArray(input) && Array.isArray(input.segments)) {
    return input.segments.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
  }
  return undefined;
}

function formats(value: unknown): BuilderTextFormat[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is BuilderTextFormat => typeof item === "string" && BUILDER_TEXT_FORMATS.has(item))
    : undefined;
}

async function findReferenceRem(plugin: ReactRNPlugin, segment: Record<string, unknown>): Promise<RemObject | string | undefined> {
  if (typeof segment.id === "string" && segment.id.trim()) return (await plugin.rem.findOne(segment.id.trim())) ?? segment.id.trim();
  if (typeof segment.name === "string" && segment.name.trim()) {
    return (await plugin.rem.findByName(await plugin.richText.text(segment.name.trim()).value(), null)) ?? undefined;
  }
  return undefined;
}

async function buildRichText(plugin: ReactRNPlugin, segments: Record<string, unknown>[]): Promise<RichTextInterface> {
  const builder = plugin.richText.text("");
  for (const segment of segments) {
    const type = typeof segment.type === "string" ? segment.type : "text";
    if (type === "text") {
      builder.text(String(segment.text ?? segment.value ?? ""), formats(segment.formats));
    } else if (type === "bold" || type === "italic" || type === "underline" || type === "quote") {
      builder.text(String(segment.text ?? segment.value ?? ""), [type]);
    } else if (type === "rem") {
      const rem = await findReferenceRem(plugin, segment);
      if (rem) builder.rem(rem);
      else builder.text(String(segment.fallback ?? segment.name ?? segment.id ?? ""));
    } else if (type === "latex") {
      builder.latex(String(segment.text ?? segment.value ?? ""), segment.block === true);
    } else if (type === "image") {
      builder.image(String(segment.url ?? ""), Number(segment.width) || undefined, Number(segment.height) || undefined);
    } else if (type === "code") {
      builder.code(String(segment.text ?? segment.value ?? ""), String(segment.language ?? ""));
    } else if (type === "table" && Array.isArray(segment.rows)) {
      builder.text(markdownTable(segment.rows));
    } else if (type === "link") {
      const label = String(segment.text ?? segment.label ?? segment.url ?? "");
      const url = String(segment.url ?? "");
      builder.text(url ? `[${label}](${url})` : label);
    } else if (type === "newline") {
      builder.newline();
    } else {
      builder.text(String(segment.text ?? segment.value ?? ""));
    }
  }
  return builder.value();
}

export async function richTextToString(plugin: ReactRNPlugin, input: RichTextInterface | undefined): Promise<string> {
  if (!input) return "";
  if (typeof input === "string") return input;
  const fallback = fallbackRichTextToString(input);
  if (fallback) return fallback;
  try {
    return await plugin.richText.toString(input);
  } catch {
    return fallback;
  }
}

function fallbackRichTextToString(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string" || typeof input === "number" || typeof input === "boolean") return String(input);
  if (Array.isArray(input)) return input.map((part) => fallbackRichTextToString(part)).join("");
  if (typeof input !== "object") return "";

  const record = input as Record<string, unknown>;
  if (record.i === "s") return record.delimiterCharacterForSerialization === ">>" ? ">>" : "::";
  if (record.i === "q") {
    const deletedText = fallbackRichTextToString(record.textOfDeletedRem);
    if (deletedText) return deletedText;
    const remId = String(record._id ?? record.remId ?? record.id ?? record.referenceId ?? "");
    return remId ? `[[${remId}]]` : "{unsupportedRichText:q}";
  }
  if (record.i === "i") return fallbackRichTextToString(record.label) || fallbackRichTextToString(record.frontLabel) || String(record.title ?? record.url ?? "");
  if (record.i === "a" || record.i === "p") return typeof record.url === "string" ? record.url : "";
  if (record.i === "n") return typeof record.text === "string" ? record.text : fallbackRichTextToString(record.highlighterSerialization);
  if (record.i === "g") return typeof record._id === "string" ? record._id : "";
  if (record.i === "fi" || record.i === "ai" || record.i === "di") {
    for (const key of ["url", "src", "source", "fileName", "name"]) {
      if (typeof record[key] === "string" && record[key]) return record[key] as string;
    }
    return `{unsupportedRichText:${record.i}}`;
  }
  for (const key of ["text", "value", "markdown", "name", "plainText"]) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  for (const key of ["content", "children", "segments", "richText"]) {
    if (Array.isArray(record[key])) return fallbackRichTextToString(record[key]);
  }
  if (typeof record.i === "string" && record.i) return `{unsupportedRichText:${record.i}}`;
  return "";
}

export async function getManagedRoot(plugin: ReactRNPlugin, rootName = MANAGED_ROOT_NAME): Promise<RemObject> {
  const root = await plugin.rem.findByName(await toRichText(plugin, rootName), null);
  if (!root) {
    throw new Error(`Managed root Rem "${rootName}" was not found. Create a top-level Rem with that exact name, then reload the plugin.`);
  }
  return root;
}

const childRemCacheByPlugin = new WeakMap<ReactRNPlugin, Map<string, string>>();
const childRemPendingByPlugin = new WeakMap<ReactRNPlugin, Map<string, Promise<RemObject>>>();

function childRemCacheKey(parent: RemObject, name: string): string {
  return `${parent._id}\u0000${name}`;
}

function childRemCache(plugin: ReactRNPlugin): Map<string, string> {
  const existing = childRemCacheByPlugin.get(plugin);
  if (existing) return existing;
  const created = new Map<string, string>();
  childRemCacheByPlugin.set(plugin, created);
  return created;
}

function childRemPending(plugin: ReactRNPlugin): Map<string, Promise<RemObject>> {
  const existing = childRemPendingByPlugin.get(plugin);
  if (existing) return existing;
  const created = new Map<string, Promise<RemObject>>();
  childRemPendingByPlugin.set(plugin, created);
  return created;
}

async function applyChildOptions(rem: RemObject, options: { folder?: boolean; document?: boolean }): Promise<void> {
  if (options.folder) await rem.setIsFolder(true);
  if (options.document) await rem.setIsDocument(true);
}

export async function ensureChildRem(
  plugin: ReactRNPlugin,
  parent: RemObject,
  name: string,
  options: { folder?: boolean; document?: boolean } = {},
): Promise<RemObject> {
  const cacheKey = childRemCacheKey(parent, name);
  const cache = childRemCache(plugin);
  const pendingByKey = childRemPending(plugin);
  const cachedId = cache.get(cacheKey);
  if (cachedId) {
    const cached = await plugin.rem.findOne(cachedId);
    if (cached && cached.parent === parent._id) {
      await applyChildOptions(cached, options);
      return cached;
    }
    cache.delete(cacheKey);
  }

  const pending = pendingByKey.get(cacheKey);
  if (pending) {
    const rem = await pending;
    await applyChildOptions(rem, options);
    return rem;
  }

  const created = (async () => {
    const richName = await toRichText(plugin, name);
    const existing = await plugin.rem.findByName(richName, parent._id);
    const rem = existing ?? (await plugin.rem.createRem());
    if (!rem) throw new Error(`Unable to create Rem "${name}".`);
    if (!existing) {
      await rem.setParent(parent);
      await rem.setText(richName);
    }
    cache.set(cacheKey, rem._id);
    await applyChildOptions(rem, options);
    return rem;
  })();
  pendingByKey.set(cacheKey, created);
  try {
    return await created;
  } finally {
    pendingByKey.delete(cacheKey);
  }
}

export async function ensurePath(
  plugin: ReactRNPlugin,
  path: string | undefined,
  rootName = MANAGED_ROOT_NAME,
  options: { finalAsDocument?: boolean; finalAsFolder?: boolean; plain?: boolean } = {},
): Promise<RemObject> {
  let parent = await getManagedRoot(plugin, rootName);
  const parts = normalizePath(path ?? "");
  for (let i = 0; i < parts.length; i += 1) {
    parent = await ensureChildRem(plugin, parent, parts[i], {
      folder: !options.plain && (options.finalAsFolder || i < parts.length - 1),
      document: !options.plain && options.finalAsDocument && i === parts.length - 1,
    });
  }
  return parent;
}

export async function ensureTag(plugin: ReactRNPlugin, name: string): Promise<RemObject> {
  const tagsRoot = await ensurePath(plugin, "Tags", MANAGED_ROOT_NAME, { finalAsFolder: true });
  return ensureChildRem(plugin, tagsRoot, name, { folder: false });
}

export async function addTags(plugin: ReactRNPlugin, rem: RemObject, tags: string[] | undefined): Promise<void> {
  for (const tagName of unique((tags ?? []).map((tag) => tag.trim()).filter(Boolean))) {
    const tag = await ensureTag(plugin, tagName);
    await rem.addTag(tag);
  }
}

export async function remPath(plugin: ReactRNPlugin, rem: RemObject, root: RemObject): Promise<string> {
  const parts: string[] = [];
  let current: RemObject | undefined = rem;
  while (current && current._id !== root._id) {
    parts.unshift(await richTextToString(plugin, current.text));
    current = await current.getParentRem();
  }
  return parts.join("::");
}

export async function isManagedRem(rem: RemObject, root: RemObject): Promise<boolean> {
  const seen = new Set<string>();
  let current: RemObject | undefined = rem;
  while (current) {
    if (current._id === root._id) return true;
    if (seen.has(current._id)) return false;
    seen.add(current._id);
    current = await current.getParentRem();
  }
  return false;
}

export async function requireManagedRem(plugin: ReactRNPlugin, remId: string | undefined, label = "Rem"): Promise<RemObject> {
  if (!remId) throw new Error(`${label} id is required.`);
  const rem = await plugin.rem.findOne(remId);
  if (!rem) throw new Error(`${label} not found.`);
  return rem;
}

export const requireAccessibleRem = requireManagedRem;

export async function summarizeCard(card: CardObject): Promise<CardSummary> {
  return {
    id: card._id,
    remId: card.remId,
    type: card.type,
    createdAt: card.createdAt,
    nextRepetitionTime: card.nextRepetitionTime,
    lastRepetitionTime: card.lastRepetitionTime,
    timesWrongInRow: card.timesWrongInRow,
    repetitionHistory: card.repetitionHistory,
  };
}

export async function summarizeRem(plugin: ReactRNPlugin, rem: RemObject, root?: RemObject): Promise<RemSummary> {
  const managedRoot = root ?? (await getManagedRoot(plugin));
  const tags = await Promise.all(
    (await rem.getTagRems()).map(async (tag) => ({
      id: tag._id,
      text: await richTextToString(plugin, tag.text),
    })),
  );
  const cards = await Promise.all((await rem.getCards()).map(summarizeCard));
  return {
    id: rem._id,
    parentId: rem.parent,
    text: await richTextToString(plugin, rem.text),
    backText: await richTextToString(plugin, rem.backText),
    path: await remPath(plugin, rem, managedRoot),
    tags,
    cards,
    isFolder: await rem.isFolder(),
    isDocument: await rem.isDocument(),
    isCardItem: await rem.isCardItem(),
    practiceDirection: await rem.getPracticeDirection(),
    createdAt: rem.createdAt,
    updatedAt: rem.updatedAt,
  };
}

export async function managedRems(plugin: ReactRNPlugin): Promise<RemObject[]> {
  const root = await getManagedRoot(plugin);
  return [root, ...(await root.getDescendants())];
}

export async function allAccessibleRems(plugin: ReactRNPlugin): Promise<RemObject[]> {
  const rems = await plugin.rem.getAll();
  return rems.filter((rem) => !("removed" in rem && rem.removed === true));
}

export async function findGraphRems(plugin: ReactRNPlugin, query: string | undefined): Promise<RemObject[]> {
  const root = await getManagedRoot(plugin);
  const terms = parseQuery(query);
  let rems: RemObject[] | undefined;
  let allRems: RemObject[] | undefined;
  const candidateRems = async () => {
    allRems ??= await allAccessibleRems(plugin);
    return rems ?? allRems;
  };
  for (const term of terms) {
    if (term.type === "id") {
      const rem = await plugin.rem.findOne(term.value);
      const directMatches = rem ? [rem] : [];
      rems = rems
        ? rems.filter((candidate) => directMatches.some((direct) => direct._id === candidate._id))
        : directMatches;
    } else if (term.type === "text") {
      const needle = term.value.toLowerCase();
      const checked = await mapBounded(await candidateRems(), 32, async (rem) => {
        const text = `${await richTextToString(plugin, rem.text)} ${await richTextToString(plugin, rem.backText)}`.toLowerCase();
        return text.includes(needle) ? rem : undefined;
      });
      rems = checked.filter((rem): rem is RemObject => Boolean(rem));
    } else if (term.type === "deck") {
      const wanted = normalizePath(term.value).join("::").toLowerCase();
      const checked = await mapBounded(await candidateRems(), 32, async (rem) => {
        const path = (await remPath(plugin, rem, root)).toLowerCase();
        return path === wanted || path.startsWith(`${wanted}::`) ? rem : undefined;
      });
      rems = checked.filter((rem): rem is RemObject => Boolean(rem));
    } else if (term.type === "tag") {
      const wanted = term.value.toLowerCase();
      const checked = await mapBounded(await candidateRems(), 32, async (rem) => {
        const tags = await rem.getTagRems();
        const tagNames = await mapBounded(tags, 8, (tag) => richTextToString(plugin, tag.text));
        return tagNames.some((tag) => tag.toLowerCase() === wanted) ? rem : undefined;
      });
      rems = checked.filter((rem): rem is RemObject => Boolean(rem));
    }
  }
  return rems ?? candidateRems();
}

export async function findManagedRems(plugin: ReactRNPlugin, query: string | undefined): Promise<RemObject[]> {
  return findGraphRems(plugin, query);
}

export async function findFlashcardRems(plugin: ReactRNPlugin, query: string | undefined): Promise<RemObject[]> {
  const rems = await findGraphRems(plugin, query);
  const checked = await Promise.all(rems.map(async (rem) => ((await rem.getCards()).length > 0 ? rem : undefined)));
  return checked.filter((rem): rem is RemObject => Boolean(rem));
}

export async function resolveTargets(plugin: ReactRNPlugin, params: Record<string, unknown>): Promise<ResolvedTarget> {
  const remIds = new Set<string>();
  const cardIds = new Set<string>();
  if (typeof params.query === "string" && params.query.trim()) {
    for (const rem of await findGraphRems(plugin, params.query)) remIds.add(rem._id);
  }
  for (const key of ["remId", "note", "id"]) {
    if (typeof params[key] === "string") remIds.add(params[key] as string);
  }
  for (const key of ["remIds", "notes"]) {
    const value = params[key];
    if (Array.isArray(value)) value.forEach((id) => typeof id === "string" && remIds.add(id));
  }
  for (const key of ["cardId"]) {
    if (typeof params[key] === "string") cardIds.add(params[key] as string);
  }
  for (const key of ["cardIds", "cards"]) {
    const value = params[key];
    if (Array.isArray(value)) value.forEach((id) => typeof id === "string" && cardIds.add(id));
  }

  const cards: CardObject[] = [];
  for (const cardId of cardIds) {
    const card = await plugin.card.findOne(cardId);
    if (card) {
      const cardRem = await plugin.rem.findOne(card.remId);
      if (!cardRem) throw new Error(`Card parent Rem not found for card ${cardId}.`);
      cards.push(card);
      remIds.add(card.remId);
    }
  }

  const rems: RemObject[] = [];
  for (const remId of remIds) {
    const rem = await plugin.rem.findOne(remId);
    if (rem) rems.push(rem);
  }
  return { rems, cards };
}

export async function snapshotNode(plugin: ReactRNPlugin, rem: RemObject): Promise<RemSnapshotNode> {
  const tags = await Promise.all(
    (await rem.getTagRems()).map(async (tag) => ({ id: tag._id, text: await richTextToString(plugin, tag.text) })),
  );
  const cards = await Promise.all((await rem.getCards()).map(summarizeCard));
  const children = await Promise.all((await rem.getChildrenRem()).map((child) => snapshotNode(plugin, child)));
  return {
    id: rem._id,
    text: await richTextToString(plugin, rem.text),
    richText: rem.text,
    backText: await richTextToString(plugin, rem.backText),
    richBackText: rem.backText,
    isFolder: await rem.isFolder(),
    isDocument: await rem.isDocument(),
    isCardItem: await rem.isCardItem(),
    practiceDirection: await rem.getPracticeDirection(),
    tags,
    cards: cards.map((card) => ({ ...card })),
    children,
  };
}

export async function buildSnapshot(plugin: ReactRNPlugin, rems: RemObject[]): Promise<RemSnapshot> {
  const root = await getManagedRoot(plugin);
  const nodes = await Promise.all(rems.map((rem) => snapshotNode(plugin, rem)));
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    rootId: root._id,
    rootName: await richTextToString(plugin, root.text),
    warning:
      "Snapshot restore recreates Rem as copies with new IDs. Inbound references, portals, and scheduling history are not preserved.",
    nodeCount: countSnapshotNodes(nodes),
    nodes,
  };
}

function countSnapshotNodes(nodes: RemSnapshotNode[]): number {
  return nodes.reduce((count, node) => count + 1 + countSnapshotNodes(node.children ?? []), 0);
}

export async function restoreSnapshotNode(plugin: ReactRNPlugin, parent: RemObject, node: RemSnapshotNode): Promise<RemObject> {
  const rem = await plugin.rem.createRem();
  if (!rem) throw new Error(`Unable to restore Rem "${node.text}".`);
  await rem.setParent(parent);
  await rem.setText(Array.isArray(node.richText) ? (node.richText as RichTextInterface) : await toRichText(plugin, node.text));
  if (node.richBackText || node.backText) {
    await rem.setBackText(
      Array.isArray(node.richBackText) ? (node.richBackText as RichTextInterface) : await toRichText(plugin, node.backText ?? ""),
    );
  }
  if (node.isFolder) await rem.setIsFolder(true);
  if (node.isDocument) await rem.setIsDocument(true);
  if (node.isCardItem) await rem.setIsCardItem(true);
  if (node.practiceDirection) {
    await rem.setEnablePractice(node.practiceDirection !== "none");
    await rem.setPracticeDirection(node.practiceDirection);
  }
  for (const child of node.children) await restoreSnapshotNode(plugin, rem, child);
  return rem;
}
