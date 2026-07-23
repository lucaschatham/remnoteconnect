import type { ReactRNPlugin, RichTextInterface } from "@remnote/plugin-sdk";
import {
  ATLAS_METADATA_POWERUP_CODE,
  ATLAS_SYNC_CHUNK_SIZE,
  MANAGED_ROOT_NAME,
  parseQuery,
  pluginActions,
  type AtlasFlashcard,
  type AtlasDocument,
  type AtlasIndexEntry,
  type CreateFlashcardParams,
} from "@remnoteconnect/shared";
import type { RemObject } from "./sdkTypes.js";
import { PluginActionError } from "./errors.js";
import {
  addTags,
  allAccessibleRems,
  buildSnapshot,
  ensureManagedRoot,
  ensurePath,
  findFlashcardRems,
  findGraphRems,
  getManagedRoot,
  mapBounded,
  managedRems,
  requireAccessibleRem,
  resolveTargets,
  restoreSnapshotNode,
  richTextToString,
  summarizeCard,
  summarizeRem,
  toRichText,
  yieldToEventLoop,
} from "./remnoteHelpers.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const DAEMON_TOKEN_SETTING = "daemonToken";
const DAEMON_TOKEN_STORAGE_KEY = "remnoteconnect.daemonToken";

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function newOpId(): string {
  const randomUUID = globalThis.crypto && "randomUUID" in globalThis.crypto ? globalThis.crypto.randomUUID.bind(globalThis.crypto) : undefined;
  return randomUUID ? randomUUID() : `op-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function compactRem(rem: RemObject): Record<string, unknown> {
  return { id: rem._id };
}

function compactRems(rems: RemObject[]): Record<string, unknown> {
  return { count: rems.length, ids: rems.map((rem) => rem._id), remIds: rems.map((rem) => rem._id) };
}

async function mutationReturn(plugin: ReactRNPlugin, rem: RemObject, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  return params.verbose === true ? summarizeRem(plugin, rem) : compactRem(rem);
}

async function mutationListReturn(plugin: ReactRNPlugin, rems: RemObject[], params: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (params.verbose === true) return { count: rems.length, items: await Promise.all(rems.map((rem) => summarizeRem(plugin, rem))) };
  return compactRems(rems);
}

function snapshotNodeCount(nodes: unknown[] | undefined): number {
  return (nodes ?? []).reduce<number>((count, node) => {
    const record = asRecord(node);
    const children = Array.isArray(record.children) ? record.children : [];
    return count + 1 + snapshotNodeCount(children);
  }, 0);
}

function validSnapshotNode(node: unknown): boolean {
  const record = asRecord(node);
  return typeof record.id === "string" && typeof record.text === "string" && Array.isArray(record.children);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCards(rem: RemObject, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    if ((await rem.getCards()).length > 0) return;
    await sleep(250);
  }
}

type UndoTarget = {
  id: string;
  parentId: string | null;
  siblingIndex?: number;
  richText?: RichTextInterface;
  richBackText?: RichTextInterface;
  tagIds: string[];
  practiceDirection?: "forward" | "backward" | "none" | "both";
  powerupProperties?: Array<{ powerupCode: string; slot: string; richText?: RichTextInterface }>;
  tagProperties?: Array<{ propertyId: string; richText?: RichTextInterface }>;
};

type UndoRecord = {
  schemaVersion: 1;
  opId: string;
  action: string;
  createdAt: string;
  targets: UndoTarget[];
  mergeInverseReferences?: Array<{
    referencingRemId: string;
    fromRemId: string;
    toRemId: string;
    richTextBefore?: RichTextInterface;
    richBackTextBefore?: RichTextInterface;
  }>;
};

type RichTextNormalization = {
  value: RichTextInterface | undefined;
  changed: boolean;
  skipReasons: string[];
};

function stableJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function richTextHash(value: unknown): string {
  const input = stableJson(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function normalizeRichTextTree(value: RichTextInterface | undefined): RichTextNormalization {
  let changed = false;
  const skipReasons = new Set<string>();
  const normalizeLeaf = (text: string): string => text.replace(/\s+/g, " ");
  const visit = (node: unknown): unknown => {
    if (typeof node === "string") {
      const next = normalizeLeaf(node);
      if (next !== node) changed = true;
      return next;
    }
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== "object") return node;
    const record = node as Record<string, unknown>;
    const next: Record<string, unknown> = { ...record };
    const isTextNode = record.type === "text" || record.i === "m" || record.i === "n" || (record.type === undefined && record.i === undefined);
    if (isTextNode && typeof record.text === "string") {
      const text = normalizeLeaf(record.text);
      if (text !== record.text) changed = true;
      next.text = text;
    } else if (typeof record.text === "string") {
      skipReasons.add(`unsupported_text_node:${String(record.type ?? record.i ?? "unknown")}`);
    }
    for (const key of ["content", "children", "segments", "richText"]) {
      if (Array.isArray(record[key])) next[key] = (record[key] as unknown[]).map(visit);
    }
    return next;
  };
  const trimEdge = (node: unknown, start: boolean): { value: unknown; found: boolean } => {
    if (typeof node === "string") {
      const next = start ? node.trimStart() : node.trimEnd();
      if (next !== node) changed = true;
      return { value: next, found: true };
    }
    if (Array.isArray(node)) {
      const next = [...node];
      const indexes = start ? [...next.keys()] : [...next.keys()].reverse();
      for (const index of indexes) {
        const trimmed = trimEdge(next[index], start);
        next[index] = trimmed.value;
        if (trimmed.found) return { value: next, found: true };
      }
      return { value: next, found: false };
    }
    if (!node || typeof node !== "object") return { value: node, found: false };
    const record = node as Record<string, unknown>;
    const isTextNode = record.type === "text" || record.i === "m" || record.i === "n" || (record.type === undefined && record.i === undefined);
    if (isTextNode && typeof record.text === "string") {
      const text = start ? record.text.trimStart() : record.text.trimEnd();
      if (text !== record.text) changed = true;
      return { value: { ...record, text }, found: true };
    }
    const keys = ["content", "children", "segments", "richText"].filter((key) => Array.isArray(record[key]));
    const ordered = start ? keys : [...keys].reverse();
    let next = record;
    for (const key of ordered) {
      const trimmed = trimEdge(next[key], start);
      if (!trimmed.found) continue;
      next = { ...next, [key]: trimmed.value };
      return { value: next, found: true };
    }
    if (typeof record.i === "string" || typeof record.type === "string") return { value: next, found: true };
    return { value: next, found: false };
  };
  const normalized = visit(value);
  const startTrimmed = trimEdge(normalized, true).value;
  const endTrimmed = trimEdge(startTrimmed, false).value;
  return { value: endTrimmed as RichTextInterface | undefined, changed, skipReasons: [...skipReasons].sort() };
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (index < haystack.length) {
    const found = haystack.indexOf(needle, index);
    if (found === -1) break;
    count += 1;
    index = found + Math.max(1, needle.length);
  }
  return count;
}

function firstMarkdownTitle(markdown: string): string {
  const line = markdown
    .split("\n")
    .map((item) => item.trim())
    .find(Boolean);
  return (line ?? "Untitled").replace(/^(#{1,6}\s+|[-*+]\s+|\d+\.\s+)/, "").trim() || "Untitled";
}

function uniqueRems(rems: RemObject[]): RemObject[] {
  const seen = new Set<string>();
  const unique: RemObject[] = [];
  for (const rem of rems) {
    if (seen.has(rem._id)) continue;
    seen.add(rem._id);
    unique.push(rem);
  }
  return unique;
}

async function siblingIndex(rem: RemObject): Promise<number | undefined> {
  const parent = await rem.getParentRem();
  if (!parent) return undefined;
  const children = await parent.getChildrenRem();
  const index = children.findIndex((child) => child._id === rem._id);
  return index >= 0 ? index : undefined;
}

async function captureUndoTarget(rem: RemObject): Promise<UndoTarget> {
  const tags = await rem.getTagRems();
  return {
    id: rem._id,
    parentId: rem.parent,
    siblingIndex: await siblingIndex(rem),
    richText: rem.text,
    richBackText: rem.backText,
    tagIds: tags.map((tag) => tag._id),
    practiceDirection: await rem.getPracticeDirection(),
  };
}

async function captureUndoRecord(action: string, opId: string, rems: RemObject[]): Promise<UndoRecord> {
  return {
    schemaVersion: 1,
    opId,
    action,
    createdAt: new Date().toISOString(),
    targets: await Promise.all(rems.map(captureUndoTarget)),
  };
}

async function normalizableTargets(plugin: ReactRNPlugin, params: Record<string, unknown>): Promise<RemObject[]> {
  const { rems } = await resolveTargets(plugin, params);
  const includeBackText = params.includeBackText === true;
  const targets: RemObject[] = [];
  for (const rem of rems) {
    const front = normalizeRichTextTree(rem.text);
    const back = normalizeRichTextTree(rem.backText);
    if (front.changed || (includeBackText && back.changed)) targets.push(rem);
  }
  return targets;
}

async function mutationTargets(plugin: ReactRNPlugin, action: string, params: Record<string, unknown>): Promise<RemObject[]> {
  if (action === "normalizeText") return normalizableTargets(plugin, params);
  if (action === "rewriteNativeLinks") {
    const input = Array.isArray(params.candidates)
      ? params.candidates
      : Array.isArray(params.links)
        ? params.links
        : Array.isArray(params.rewrites)
          ? params.rewrites
          : [];
    const evaluated = await evaluateNativeLinkCandidates(plugin, input);
    return uniqueRems(evaluated.filter((item): item is NativeLinkReady => item.ok).map((item) => item.source));
  }
  if (action === "mergeRems") {
    const keepId = str(params.keepId) ?? str(params.keeperId);
    const mergeIds = new Set<string>();
    for (const key of ["mergeIds", "remIds", "ids"]) {
      const value = params[key];
      if (Array.isArray(value)) value.forEach((id) => typeof id === "string" && id !== keepId && mergeIds.add(id));
    }
    if (typeof params.mergeId === "string" && params.mergeId !== keepId) mergeIds.add(params.mergeId);
    return (await Promise.all([...mergeIds].map((id) => plugin.rem.findOne(id)))).filter((rem): rem is RemObject => Boolean(rem));
  }
  const { rems } = await resolveTargets(plugin, params);
  return uniqueRems(rems);
}

function assertExpectedTargetIds(actual: RemObject[], expected: unknown): void {
  if (!Array.isArray(expected)) return;
  const actualIds = actual.map((rem) => rem._id).sort();
  const expectedIds = expected.filter((id): id is string => typeof id === "string").sort();
  if (actualIds.length !== expectedIds.length || actualIds.some((id, index) => id !== expectedIds[index])) {
    throw new PluginActionError("dry_run_mismatch", "Mutation targets changed after preparation.", { expectedIds, actualIds });
  }
}

async function assertExpectedFingerprints(actual: RemObject[], expected: unknown): Promise<void> {
  if (!Array.isArray(expected)) return;
  const expectedById = new Map(
    expected
      .map(asRecord)
      .filter((item) => typeof item.id === "string")
      .map((item) => [item.id as string, item]),
  );
  for (const rem of actual) {
    const fingerprint = expectedById.get(rem._id);
    if (!fingerprint) continue;
    const actualSiblingIndex = await siblingIndex(rem);
    if (
      fingerprint.parentId !== rem.parent ||
      (fingerprint.siblingIndex !== undefined && Number(fingerprint.siblingIndex) !== actualSiblingIndex) ||
      (fingerprint.updatedAt !== undefined && Number(fingerprint.updatedAt) !== Number(rem.updatedAt))
    ) {
      throw new PluginActionError("dry_run_mismatch", `Rem ${rem._id} changed after preparation.`, {
        expected: fingerprint,
        actual: { id: rem._id, parentId: rem.parent, siblingIndex: actualSiblingIndex, updatedAt: rem.updatedAt },
      });
    }
  }
}

async function assertPreparedTargets(actual: RemObject[], params: Record<string, unknown>): Promise<void> {
  assertExpectedTargetIds(actual, params.expectedTargetIds);
  await assertExpectedFingerprints(actual, params.expectedFingerprints);
}

async function prepareMutation(plugin: ReactRNPlugin, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const action = str(params.action);
  const opId = str(params.opId);
  const actionParams = asRecord(params.params);
  if (!action || !opId) throw new Error("prepareMutation requires daemon-generated action and opId.");
  const targets = await mutationTargets(plugin, action, actionParams);
  const undoRecord = await captureUndoRecord(action, opId, targets);
  return {
    opId,
    action,
    count: targets.length,
    targetIds: targets.map((rem) => rem._id).sort(),
    fingerprints: await Promise.all(
      targets.map(async (rem) => ({ id: rem._id, parentId: rem.parent, siblingIndex: await siblingIndex(rem), updatedAt: rem.updatedAt })),
    ),
    undoRecord,
  };
}

async function captureMergeUndoRecord(
  action: string,
  opId: string,
  rems: RemObject[],
  mergeInverseReferences: UndoRecord["mergeInverseReferences"] = [],
): Promise<UndoRecord> {
  return {
    ...(await captureUndoRecord(action, opId, uniqueRems(rems))),
    mergeInverseReferences,
  };
}

async function restoreUndoTarget(plugin: ReactRNPlugin, target: UndoTarget): Promise<string | undefined> {
  const rem = await plugin.rem.findOne(target.id);
  if (!rem) return undefined;
  const parent = target.parentId ? (await plugin.rem.findOne(target.parentId)) ?? null : null;
  await rem.setParent(parent, target.siblingIndex);
  if (target.richText) await rem.setText(target.richText);
  await rem.setBackText(target.richBackText ?? (await toRichText(plugin, "")));
  const currentTags = await rem.getTagRems();
  const wantedTags = new Set(target.tagIds);
  for (const tag of currentTags) {
    if (!wantedTags.has(tag._id)) await rem.removeTag(tag._id);
  }
  for (const tagId of target.tagIds) {
    const tag = await plugin.rem.findOne(tagId);
    if (tag) await rem.addTag(tag);
  }
  if (target.practiceDirection) {
    await rem.setEnablePractice(target.practiceDirection !== "none");
    await rem.setPracticeDirection(target.practiceDirection);
  }
  for (const property of target.powerupProperties ?? []) {
    await rem.addPowerup(property.powerupCode);
    await rem.setPowerupProperty(property.powerupCode, property.slot, property.richText ?? (await toRichText(plugin, "")));
  }
  for (const property of target.tagProperties ?? []) {
    await rem.setTagPropertyValue(property.propertyId, property.richText);
  }
  return rem._id;
}

async function trashFolder(plugin: ReactRNPlugin, opId?: string): Promise<RemObject> {
  return ensurePath(plugin, opId ? `Trash::${opId}` : "Trash", MANAGED_ROOT_NAME, { finalAsFolder: true });
}

const TRASH_METADATA_CHILD_TEXT = new Set(["Bullet Icon", "Is Folder", "Status"]);

async function trashChildInfo(plugin: ReactRNPlugin, rem: RemObject): Promise<{ rem: RemObject; text: string; childCount: number; visibleChildCount: number }> {
  const children = await rem.getChildrenRem();
  const childInfos = await Promise.all(
    children.map(async (child) => ({
      text: await richTextToString(plugin, child.text),
      childCount: (await child.getChildrenRem()).length,
    })),
  );
  return {
    rem,
    text: await richTextToString(plugin, rem.text),
    childCount: children.length,
    visibleChildCount: childInfos.filter((info) => !isTrashMetadataChild(info)).length,
  };
}

function isTrashMetadataChild(info: { text: string; childCount: number }): boolean {
  return info.childCount === 0 && (TRASH_METADATA_CHILD_TEXT.has(info.text) || /^\[\[[A-Za-z0-9]{17}\]\]$/.test(info.text));
}

function isEmptyTrashMetadataContainer(info: { childCount: number; visibleChildCount: number }): boolean {
  return info.childCount > 0 && info.visibleChildCount === 0;
}

async function softDeleteRems(plugin: ReactRNPlugin, action: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { rems } = await resolveTargets(plugin, params);
  await assertPreparedTargets(rems, params);
  const opId = str(params.opId) ?? newOpId();
  const remIds = rems.map((rem) => rem._id);
  if (params.dryRun === true || params.confirm !== true) {
    return {
      dryRun: true,
      opId,
      count: rems.length,
      remIds,
      warning: params.confirm === true ? undefined : `${action} defaults to dry-run. Pass confirm:true to tombstone targets.`,
    };
  }
  const undoRecord = params.undoPrepared === true ? undefined : await captureUndoRecord(action, opId, rems);
  const trash = await trashFolder(plugin, opId);
  for (const rem of rems) await rem.setParent(trash);
  return { opId, count: rems.length, remIds, undoRecord, tombstoneParentId: trash._id };
}

async function bulkMoveRems(plugin: ReactRNPlugin, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const targetPath = str(params.targetPath) ?? str(params.parentPath) ?? str(params.deck) ?? str(params.deckName);
  if (!targetPath) throw new Error("bulkMove requires targetPath/parentPath/deck.");
  const { rems } = await resolveTargets(plugin, params);
  await assertPreparedTargets(rems, params);
  const opId = str(params.opId) ?? newOpId();
  if (params.dryRun === true || params.confirm !== true) {
    return {
      dryRun: true,
      opId,
      count: rems.length,
      remIds: rems.map((rem) => rem._id),
      targetPath,
      warning: params.confirm === true ? undefined : "bulkMove defaults to dry-run. Pass confirm:true to move targets.",
    };
  }
  const undoRecord = params.undoPrepared === true ? undefined : await captureUndoRecord("bulkMove", opId, rems);
  const target = await ensurePath(plugin, targetPath, MANAGED_ROOT_NAME, { finalAsFolder: true });
  for (const rem of rems) await rem.setParent(target);
  return { opId, count: rems.length, remIds: rems.map((rem) => rem._id), targetPath, undoRecord };
}

async function bulkRetagRems(plugin: ReactRNPlugin, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { rems } = await resolveTargets(plugin, params);
  await assertPreparedTargets(rems, params);
  const opId = str(params.opId) ?? newOpId();
  const add = [...stringArray(params.addTags), ...stringArray(params.tags)];
  const remove = new Set([...stringArray(params.removeTags), ...stringArray(params.remove)].map((tag) => tag.trim().toLowerCase()).filter(Boolean));
  if (add.length === 0 && remove.size === 0) throw new Error("bulkRetag requires tags/addTags or removeTags/remove.");
  if (params.dryRun === true || params.confirm !== true) {
    return {
      dryRun: true,
      opId,
      count: rems.length,
      remIds: rems.map((rem) => rem._id),
      addTags: add,
      removeTags: [...remove],
      warning: params.confirm === true ? undefined : "bulkRetag defaults to dry-run. Pass confirm:true to retag targets.",
    };
  }
  const undoRecord = params.undoPrepared === true ? undefined : await captureUndoRecord("bulkRetag", opId, rems);
  for (const rem of rems) {
    if (remove.size > 0) {
      for (const tag of await rem.getTagRems()) {
        const tagText = (await richTextToString(plugin, tag.text)).trim().toLowerCase();
        if (remove.has(tagText)) await rem.removeTag(tag._id);
      }
    }
    await addTags(plugin, rem, add);
  }
  return { opId, count: rems.length, remIds: rems.map((rem) => rem._id), undoRecord };
}

async function normalizeTextRems(plugin: ReactRNPlugin, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const targets = await normalizableTargets(plugin, params);
  await assertPreparedTargets(targets, params);
  const includeBackText = params.includeBackText === true;
  const opId = str(params.opId) ?? newOpId();
  const changes = targets.map((rem) => {
    const front = normalizeRichTextTree(rem.text);
    const back = normalizeRichTextTree(rem.backText);
    return {
      id: rem._id,
      beforeHash: richTextHash({ text: rem.text, backText: includeBackText ? rem.backText : undefined }),
      afterHash: richTextHash({ text: front.value, backText: includeBackText ? back.value : undefined }),
      skipReasons: [...new Set([...front.skipReasons, ...(includeBackText ? back.skipReasons : [])])].sort(),
    };
  });
  if (params.dryRun === true || params.confirm !== true) {
    return {
      dryRun: true,
      opId,
      count: targets.length,
      remIds: targets.map((rem) => rem._id),
      includeBackText,
      changes,
      warning: params.confirm === true ? undefined : "normalizeText defaults to dry-run. Pass confirm:true to normalize targets.",
    };
  }
  const undoRecord = params.undoPrepared === true ? undefined : await captureUndoRecord("normalizeText", opId, targets);
  for (const rem of targets) {
    const front = normalizeRichTextTree(rem.text);
    const back = normalizeRichTextTree(rem.backText);
    if (front.changed && front.value !== undefined) await rem.setText(front.value);
    if (includeBackText && back.changed && back.value !== undefined) await rem.setBackText(back.value);
  }
  return { opId, count: targets.length, remIds: targets.map((rem) => rem._id), changes, undoRecord };
}

type NativeLinkCandidate = {
  sourceNodeId?: string;
  nodeId?: string;
  targetRemId?: string;
  raw?: string;
  sourcePath?: string;
  targetPath?: string;
  line?: number;
};

type NativeLinkReady = {
  ok: true;
  source: RemObject;
  target: RemObject;
  raw: string;
  field: "text" | "backText";
  sourceNodeId: string;
  targetRemId: string;
  sourcePath?: string;
  targetPath?: string;
  line?: number;
};

type NativeLinkBlocked = {
  ok: false;
  reason: string;
  sourceNodeId?: string;
  targetRemId?: string;
  raw?: string;
  sourcePath?: string;
  targetPath?: string;
  line?: number;
};

function richTextParts(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function replaceInTextNode(
  text: string,
  raw: string,
  replacement: RichTextInterface,
  makeTextPart: (text: string) => unknown,
): { parts: unknown[]; count: number } {
  const parts: unknown[] = [];
  let count = 0;
  let cursor = 0;
  while (true) {
    const index = text.indexOf(raw, cursor);
    if (index === -1) break;
    const before = text.slice(cursor, index);
    if (before) parts.push(makeTextPart(before));
    parts.push(...richTextParts(replacement));
    count += 1;
    cursor = index + raw.length;
  }
  if (count === 0) return { parts: [makeTextPart(text)], count: 0 };
  const after = text.slice(cursor);
  if (after) parts.push(makeTextPart(after));
  return { parts, count };
}

function replaceRawTextDirect(input: RichTextInterface, raw: string, replacement: RichTextInterface): { value: RichTextInterface; count: number } {
  let count = 0;
  const visit = (node: unknown): unknown[] => {
    if (typeof node === "string") {
      const replaced = replaceInTextNode(node, raw, replacement, (text) => text);
      count += replaced.count;
      return replaced.parts;
    }
    if (Array.isArray(node)) {
      const parts: unknown[] = [];
      for (const child of node) parts.push(...visit(child));
      return parts;
    }
    if (!node || typeof node !== "object") return [node];

    const record = node as Record<string, unknown>;
    for (const key of ["text", "plainText", "value"]) {
      if (typeof record[key] === "string" && record[key].includes(raw)) {
        const replaced = replaceInTextNode(record[key] as string, raw, replacement, (text) => ({ ...record, [key]: text }));
        count += replaced.count;
        return replaced.parts;
      }
    }
    for (const key of ["content", "children", "segments", "richText"]) {
      if (Array.isArray(record[key])) {
        const before = count;
        const children: unknown[] = [];
        for (const child of record[key] as unknown[]) children.push(...visit(child));
        if (count !== before) return [{ ...record, [key]: children }];
      }
    }
    return [node];
  };

  const output = visit(input);
  return {
    value: (Array.isArray(input) ? output : output.length === 1 ? output[0] : output) as RichTextInterface,
    count,
  };
}

async function replaceRawLinkRichText(
  plugin: ReactRNPlugin,
  input: RichTextInterface,
  raw: string,
  replacement: RichTextInterface,
): Promise<RichTextInterface> {
  const direct = replaceRawTextDirect(input, raw, replacement);
  if (direct.count === 1) return direct.value;
  const from = await plugin.richText.text(raw).value();
  return plugin.richText.replaceAllRichText(input, from, replacement);
}

function nativeLinkCandidateCommon(value: unknown): NativeLinkBlocked & {
  sourceNodeId?: string;
  targetRemId?: string;
  raw?: string;
} {
  const candidate = asRecord(value) as NativeLinkCandidate;
  const sourceNodeId = str(candidate.sourceNodeId) ?? str(candidate.nodeId);
  const targetRemId = str(candidate.targetRemId);
  const raw = str(candidate.raw);
  return {
    ok: false,
    reason: "",
    sourceNodeId,
    targetRemId,
    raw,
    sourcePath: str(candidate.sourcePath),
    targetPath: str(candidate.targetPath),
    line: typeof candidate.line === "number" ? candidate.line : undefined,
  };
}

async function evaluateNativeLinkCandidates(plugin: ReactRNPlugin, input: unknown[]): Promise<Array<NativeLinkReady | NativeLinkBlocked>> {
  const parsed = input.map(nativeLinkCandidateCommon);
  const immediate: NativeLinkBlocked[] = parsed
    .filter((candidate) => !candidate.sourceNodeId || !candidate.targetRemId || !candidate.raw)
    .map((candidate) => ({ ...candidate, reason: "missing-required-field" }));
  const valid = parsed.filter(
    (candidate): candidate is NativeLinkBlocked & { sourceNodeId: string; targetRemId: string; raw: string } =>
      Boolean(candidate.sourceNodeId && candidate.targetRemId && candidate.raw),
  );
  const sourceIds = [...new Set(valid.map((candidate) => candidate.sourceNodeId))];
  const targetIds = [...new Set(valid.map((candidate) => candidate.targetRemId))];
  const sources = new Map<string, RemObject | undefined>();
  const targets = new Map<string, RemObject | undefined>();
  for (const id of sourceIds) sources.set(id, await plugin.rem.findOne(id));
  for (const id of targetIds) targets.set(id, await plugin.rem.findOne(id));

  const bySource = new Map<string, Array<NativeLinkBlocked & { sourceNodeId: string; targetRemId: string; raw: string }>>();
  for (const candidate of valid) {
    const source = sources.get(candidate.sourceNodeId);
    const target = targets.get(candidate.targetRemId);
    if (!source) {
      immediate.push({ ...candidate, reason: "source-node-not-found" });
    } else if (!target) {
      immediate.push({ ...candidate, reason: "target-rem-not-found" });
    } else {
      const group = bySource.get(candidate.sourceNodeId) ?? [];
      group.push(candidate);
      bySource.set(candidate.sourceNodeId, group);
    }
  }

  const evaluated: Array<NativeLinkReady | NativeLinkBlocked> = [...immediate];
  let sourceIndex = 0;
  for (const [sourceNodeId, candidates] of bySource) {
    const source = sources.get(sourceNodeId);
    if (!source) continue;
    const text = await richTextToString(plugin, source.text);
    const backText = await richTextToString(plugin, source.backText);
    for (const candidate of candidates) {
      const target = targets.get(candidate.targetRemId);
      if (!target) {
        evaluated.push({ ...candidate, reason: "target-rem-not-found" });
        continue;
      }
      const textCount = countOccurrences(text, candidate.raw);
      const backTextCount = countOccurrences(backText, candidate.raw);
      if (textCount + backTextCount !== 1) {
        evaluated.push({ ...candidate, reason: "raw-link-not-single-occurrence-in-current-rem" });
        continue;
      }
      evaluated.push({
        ok: true,
        source,
        target,
        raw: candidate.raw,
        field: textCount === 1 ? "text" : "backText",
        sourceNodeId: candidate.sourceNodeId,
        targetRemId: candidate.targetRemId,
        sourcePath: candidate.sourcePath,
        targetPath: candidate.targetPath,
        line: candidate.line,
      });
    }
    sourceIndex += 1;
    if (sourceIndex % 50 === 0) await yieldToEventLoop();
  }
  return evaluated;
}

async function rewriteNativeLinks(plugin: ReactRNPlugin, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const input = Array.isArray(params.candidates)
    ? params.candidates
    : Array.isArray(params.links)
      ? params.links
      : Array.isArray(params.rewrites)
        ? params.rewrites
        : [];
  if (input.length === 0) throw new Error("rewriteNativeLinks requires candidates.");
  const opId = str(params.opId) ?? newOpId();
  const evaluated = await evaluateNativeLinkCandidates(plugin, input);
  const ready = evaluated.filter((item): item is NativeLinkReady => item.ok);
  const blocked = evaluated.filter((item): item is NativeLinkBlocked => !item.ok);
  const affected = uniqueRems(ready.map((item) => item.source));
  await assertPreparedTargets(affected, params);
  const remIds = affected.map((rem) => rem._id);
  if (params.dryRun === true || params.confirm !== true) {
    return {
      dryRun: true,
      opId,
      count: ready.length,
      remIds,
      blockedCount: blocked.length,
      blocked: blocked.slice(0, 100),
      warning: params.confirm === true ? undefined : "rewriteNativeLinks defaults to dry-run. Pass confirm:true after reviewing count/remIds.",
    };
  }
  if (blocked.length > 0 && params.allowPartial !== true) {
    throw new Error(`rewriteNativeLinks has ${blocked.length} blocked candidates. Pass only ready candidates or allowPartial:true.`);
  }
  const undoRecord = params.undoPrepared === true ? undefined : await captureUndoRecord("rewriteNativeLinks", opId, affected);
  const rewritten: Array<Record<string, unknown>> = [];
  const readyBySource = new Map<string, NativeLinkReady[]>();
  for (const item of ready) {
    const group = readyBySource.get(item.source._id) ?? [];
    group.push(item);
    readyBySource.set(item.source._id, group);
  }
  let sourceIndex = 0;
  for (const items of readyBySource.values()) {
    const source = items[0].source;
    let nextText = source.text ?? (await toRichText(plugin, ""));
    let nextBackText = source.backText ?? (await toRichText(plugin, ""));
    let textChanged = false;
    let backTextChanged = false;
    for (const item of items) {
      const to = await plugin.richText.rem(item.target).value();
      if (item.field === "text") {
        nextText = await replaceRawLinkRichText(plugin, nextText, item.raw, to);
        textChanged = true;
      } else {
        nextBackText = await replaceRawLinkRichText(plugin, nextBackText, item.raw, to);
        backTextChanged = true;
      }
      rewritten.push({
        sourceNodeId: item.sourceNodeId,
        targetRemId: item.targetRemId,
        raw: item.raw,
        field: item.field,
        sourcePath: item.sourcePath,
        targetPath: item.targetPath,
        line: item.line,
      });
    }
    if (textChanged) await source.setText(nextText);
    if (backTextChanged) await source.setBackText(nextBackText);
    sourceIndex += 1;
    if (sourceIndex % 25 === 0) await yieldToEventLoop();
  }
  return {
    opId,
    count: rewritten.length,
    remIds,
    blockedCount: blocked.length,
    rewritten,
    undoRecord,
  };
}

async function mergedIntoRichText(plugin: ReactRNPlugin, keeper: RemObject): Promise<RichTextInterface> {
  try {
    return plugin.richText.text("Merged into ").rem(keeper).value();
  } catch {
    return toRichText(plugin, `Merged into ${keeper._id}`);
  }
}

async function replaceReference(
  plugin: ReactRNPlugin,
  richText: RichTextInterface | undefined,
  from: RemObject,
  to: RemObject,
): Promise<RichTextInterface | undefined> {
  if (!richText) return undefined;
  const fromRef = await plugin.richText.rem(from).value();
  const toRef = await plugin.richText.rem(to).value();
  return plugin.richText.replaceAllRichText(richText, fromRef, toRef);
}

async function mergeRems(plugin: ReactRNPlugin, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const keepId = str(params.keepId) ?? str(params.keeperId);
  if (!keepId) throw new Error("mergeRems requires keepId.");
  const keeper = await requireAccessibleRem(plugin, keepId, "Keeper Rem");
  const mergeIds = new Set<string>();
  for (const key of ["mergeIds", "remIds", "ids"]) {
    const value = params[key];
    if (Array.isArray(value)) value.forEach((id) => typeof id === "string" && id !== keeper._id && mergeIds.add(id));
  }
  if (typeof params.mergeId === "string" && params.mergeId !== keeper._id) mergeIds.add(params.mergeId);
  const losers = (await Promise.all([...mergeIds].map((id) => plugin.rem.findOne(id)))).filter((rem): rem is RemObject => Boolean(rem));
  const structural = params.structural === true;
  if (structural) {
    throw new PluginActionError(
      "experimental_disabled",
      "Structural merge is disabled until complete inbound-reference enumeration and merge-to-undo live verification are available.",
    );
  }
  const opId = str(params.opId) ?? newOpId();
  if (params.dryRun === true || params.confirm !== true) {
    let childCount = 0;
    let referenceCount = 0;
    for (const loser of losers) {
      childCount += (await loser.getChildrenRem()).length;
      referenceCount += (await loser.remsReferencingThis()).length;
    }
    return {
      dryRun: true,
      opId,
      structural,
      keepId: keeper._id,
      count: losers.length,
      remIds: losers.map((rem) => rem._id),
      childCount,
      referenceCount,
      warning:
        params.confirm === true
          ? undefined
          : structural
            ? "mergeRems structural mode requires confirm:true and daemon fromDryRun verification."
            : "mergeRems defaults to dry-run. Pass confirm:true for reversible tombstone merge.",
    };
  }

  if (!structural) {
    await assertPreparedTargets(losers, params);
    const undoRecord = params.undoPrepared === true ? undefined : await captureUndoRecord("mergeRems", opId, losers);
    const trash = await trashFolder(plugin, opId);
    for (const loser of losers) {
      await loser.setBackText(await mergedIntoRichText(plugin, keeper));
      await loser.setParent(trash);
    }
    return { opId, structural: false, keepId: keeper._id, count: losers.length, remIds: losers.map((rem) => rem._id), undoRecord };
  }

  throw new PluginActionError("experimental_disabled", "Structural merge is disabled in this build.");
}

async function setRemProperty(plugin: ReactRNPlugin, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const rem = await requireAccessibleRem(plugin, str(params.id) ?? str(params.remId), "Rem");
  await assertPreparedTargets([rem], params);
  const opId = str(params.opId) ?? newOpId();
  const powerupCode = str(params.powerupCode) ?? str(params.powerup);
  const slot = str(params.slot) ?? str(params.property);
  const propertyId = str(params.propertyId) ?? str(params.tagPropertyId);
  if (!propertyId && (!powerupCode || !slot)) throw new Error("setProperty requires propertyId or powerupCode + slot.");
  if (params.dryRun === true) return { dryRun: true, opId, id: rem._id, powerupCode, slot, propertyId };

  const target = params.undoPrepared === true ? undefined : await captureUndoTarget(rem);
  if (propertyId) {
    if (target) target.tagProperties = [{ propertyId, richText: await rem.getTagPropertyValue(propertyId) }];
    await rem.setTagPropertyValue(propertyId, params.value === undefined ? undefined : await toRichText(plugin, params.value as string | unknown[] | Record<string, unknown>));
  } else if (powerupCode && slot) {
    await rem.addPowerup(powerupCode);
    if (target) target.powerupProperties = [{ powerupCode, slot, richText: await rem.getPowerupPropertyAsRichText(powerupCode, slot) }];
    await rem.setPowerupProperty(powerupCode, slot, await toRichText(plugin, params.value as string | unknown[] | Record<string, unknown>));
  }
  return {
    opId,
    id: rem._id,
    undoRecord: target ? { schemaVersion: 1, opId, action: "setProperty", createdAt: new Date().toISOString(), targets: [target] } : undefined,
  };
}

async function getRemProperties(plugin: ReactRNPlugin, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const rem = await requireAccessibleRem(plugin, str(params.id) ?? str(params.remId), "Rem");
  const requested = Array.isArray(params.properties) ? params.properties : [params];
  const properties = [];
  for (const raw of requested) {
    const property = asRecord(raw);
    const powerupCode = str(property.powerupCode) ?? str(property.powerup);
    const slot = str(property.slot) ?? str(property.property);
    const propertyId = str(property.propertyId) ?? str(property.tagPropertyId);
    if (propertyId) {
      const richText = await rem.getTagPropertyValue(propertyId);
      properties.push({ propertyId, value: await richTextToString(plugin, richText), richText });
    } else if (powerupCode && slot) {
      const richText = await rem.getPowerupPropertyAsRichText(powerupCode, slot);
      properties.push({ powerupCode, slot, value: await richTextToString(plugin, richText), richText });
    }
  }
  return { id: rem._id, count: properties.length, properties };
}

async function applyDocSpecProperties(plugin: ReactRNPlugin, rem: RemObject, properties: unknown): Promise<number> {
  const entries = Array.isArray(properties) ? properties : [];
  let count = 0;
  for (const raw of entries) {
    const property = asRecord(raw);
    const propertyId = str(property.propertyId) ?? str(property.tagPropertyId);
    const powerupCode = str(property.powerupCode) ?? str(property.powerup);
    const slot = str(property.slot) ?? str(property.property);
    if (propertyId) {
      await rem.setTagPropertyValue(propertyId, property.value === undefined ? undefined : await toRichText(plugin, property.value as string | unknown[] | Record<string, unknown>));
      count += 1;
    } else if (powerupCode && slot) {
      await rem.addPowerup(powerupCode);
      await rem.setPowerupProperty(powerupCode, slot, await toRichText(plugin, property.value as string | unknown[] | Record<string, unknown>));
      count += 1;
    }
  }
  return count;
}

async function applyDocSpecToRem(plugin: ReactRNPlugin, rem: RemObject, spec: Record<string, unknown>): Promise<number> {
  const text = spec.richText ?? spec.text ?? spec.title ?? "";
  await rem.setText(await toRichText(plugin, text as string | unknown[] | Record<string, unknown>));
  if (spec.backText !== undefined || spec.back !== undefined) {
    await rem.setBackText(await toRichText(plugin, (spec.backText ?? spec.back) as string | unknown[] | Record<string, unknown>));
  }
  if (spec.folder === true || spec.isFolder === true) await rem.setIsFolder(true);
  if (spec.document === true || spec.isDocument === true) await rem.setIsDocument(true);
  if (spec.cardItem === true || spec.isCardItem === true) await rem.setIsCardItem(true);
  await addTags(plugin, rem, stringArray(spec.tags));
  return applyDocSpecProperties(plugin, rem, spec.properties);
}

function docSpecChildren(spec: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(spec.children) ? spec.children.map(asRecord) : [];
}

function docSpecNodeCount(spec: Record<string, unknown>): number {
  return 1 + docSpecChildren(spec).reduce((count, child) => count + docSpecNodeCount(child), 0);
}

async function createDocSpecTree(
  plugin: ReactRNPlugin,
  parent: RemObject,
  spec: Record<string, unknown>,
  created: RemObject[] = [],
): Promise<RemObject[]> {
  const rem = await plugin.rem.createRem();
  if (!rem) throw new Error("RemNote did not return a Rem from createRem.");
  await rem.setParent(parent);
  await applyDocSpecToRem(plugin, rem, spec);
  created.push(rem);
  for (const portalId of stringArray(spec.portalRemIds)) {
    const included = await plugin.rem.findOne(portalId);
    if (included) await included.addToPortal(rem);
  }
  for (const child of docSpecChildren(spec)) await createDocSpecTree(plugin, rem, child, created);
  return created;
}

async function outlineRows(plugin: ReactRNPlugin, rem: RemObject, depth: number, maxDepth: number, rows: string[]): Promise<void> {
  const title = await richTextToString(plugin, rem.text);
  rows.push(`${"  ".repeat(depth)}${rem._id}\t${title.replace(/\s+/g, " ").trim()}`);
  if (depth >= maxDepth) return;
  for (const child of await rem.getChildrenRem()) await outlineRows(plugin, child, depth + 1, maxDepth, rows);
}

async function remMarkdownTree(plugin: ReactRNPlugin, rem: RemObject, depth: number, maxDepth: number, lines: string[]): Promise<void> {
  const text = rem.text ? await plugin.richText.toMarkdown(rem.text) : "";
  lines.push(`${"  ".repeat(depth)}- ${text}`);
  const backText = rem.backText ? await plugin.richText.toMarkdown(rem.backText) : "";
  if (backText.trim()) lines.push(`${"  ".repeat(depth + 1)}- ${backText}`);
  if (depth >= maxDepth) return;
  for (const child of await rem.getChildrenRem()) await remMarkdownTree(plugin, child, depth + 1, maxDepth, lines);
}

export function ankiNoteToFlashcard(note: Record<string, unknown>): CreateFlashcardParams {
  const fields = asRecord(note.fields);
  const fieldValues = Object.entries(fields).map(([name, raw]) => {
    if (raw && typeof raw === "object" && "value" in raw) return [name, String((raw as { value?: unknown }).value ?? "")] as const;
    return [name, String(raw ?? "")] as const;
  });
  const fieldMap = new Map(fieldValues.map(([name, value]) => [name.toLowerCase(), value]));
  const front = fieldMap.get("front") ?? fieldMap.get("question") ?? fieldValues[0]?.[1] ?? "";
  const back = fieldMap.get("back") ?? fieldMap.get("answer") ?? fieldValues[1]?.[1] ?? "";
  return {
    front,
    back,
    deckPath: str(note.deckName) ?? str(note.deck) ?? undefined,
    tags: stringArray(note.tags),
    externalId: str(note.externalId),
    batchId: str(note.batchId),
  };
}

function stripHtml(html: string | undefined): string {
  if (!html) return "";
  return html
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
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

async function addHtmlFieldChild(plugin: ReactRNPlugin, parent: RemObject, label: string, html: string, existing?: RemObject): Promise<RemObject | undefined> {
  if (!html.trim()) return undefined;
  const child = existing ?? (await plugin.rem.createRem());
  if (!child) throw new Error("RemNote did not return a Rem from createRem.");
  await child.setParent(parent);
  await child.setText(await toRichText(plugin, label));
  if (existing) {
    await child.setBackText(await toRichText(plugin, stripHtml(html)));
    return child;
  }
  try {
    await plugin.richText.parseAndInsertHtml(html, child);
  } catch {
    await child.setBackText(await toRichText(plugin, stripHtml(html)));
  }
  return child;
}

function clozeSpanRecords(value: unknown): Array<{ start: number; end: number; group?: number; hint?: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .map(asRecord)
    .map((record) => ({
      start: Number(record.start),
      end: Number(record.end),
      group: typeof record.group === "number" ? record.group : undefined,
      hint: str(record.hint),
    }))
    .filter((span) => Number.isFinite(span.start) && Number.isFinite(span.end) && span.end > span.start);
}

async function clozeRichText(plugin: ReactRNPlugin, text: string, spans: Array<{ start: number; end: number }>): Promise<RichTextInterface> {
  let richText = await toRichText(plugin, text);
  for (const span of spans) {
    richText = await plugin.richText.applyTextFormatToRange(richText, span.start, span.end, "cloze");
  }
  return richText;
}

async function addExtraFields(plugin: ReactRNPlugin, rem: RemObject, fields: unknown, reusableChildren: RemObject[] = []): Promise<number> {
  const entries = Array.isArray(fields) ? fields.map(asRecord) : [];
  let count = 0;
  for (const field of entries) {
    const name = str(field.name) ?? "Field";
    const html = str(field.html);
    const value = str(field.value) ?? stripHtml(html);
    const existing = reusableChildren[count];
    if (html) {
      await addHtmlFieldChild(plugin, rem, name, html, existing);
      count += 1;
    } else if (value) {
      const child = existing ?? (await plugin.rem.createRem());
      if (!child) throw new Error("RemNote did not return a Rem from createRem.");
      await child.setParent(rem);
      await child.setText(await toRichText(plugin, name));
      await child.setBackText(await toRichText(plugin, value));
      count += 1;
    }
  }
  return count;
}

async function removeRemTree(rem: RemObject): Promise<void> {
  for (const child of await rem.getChildrenRem()) await removeRemTree(child);
  await rem.remove();
}

async function collectRemTree(rem: RemObject): Promise<RemObject[]> {
  const descendants: RemObject[] = [rem];
  for (const child of await rem.getChildrenRem()) descendants.push(...(await collectRemTree(child)));
  return descendants;
}

async function exactTrashTargets(
  plugin: ReactRNPlugin,
  tombstoneOpId?: string,
): Promise<{ roots: RemObject[]; rems: RemObject[]; inboundReferenceIds: string[] }> {
  const trash = await trashFolder(plugin);
  const children = await Promise.all((await trash.getChildrenRem()).map((rem) => trashChildInfo(plugin, rem)));
  const roots: RemObject[] = [];
  for (const info of children) {
    if (isEmptyTrashMetadataContainer(info)) continue;
    if (tombstoneOpId ? info.text === tombstoneOpId : !isTrashMetadataChild(info)) roots.push(info.rem);
  }
  const rems = uniqueRems((await Promise.all(roots.map(collectRemTree))).flat());
  const targetIds = new Set(rems.map((rem) => rem._id));
  const inboundReferenceIds = new Set<string>();
  for (const rem of rems) {
    for (const reference of await rem.remsReferencingThis()) {
      if (!targetIds.has(reference._id)) inboundReferenceIds.add(reference._id);
    }
  }
  return { roots, rems, inboundReferenceIds: [...inboundReferenceIds].sort() };
}

async function isUnderTrash(plugin: ReactRNPlugin, rem: RemObject): Promise<boolean> {
  const trash = await trashFolder(plugin);
  let current: RemObject | undefined = rem;
  const seen = new Set<string>();
  while (current) {
    if (current._id === trash._id) return true;
    if (seen.has(current._id)) return false;
    seen.add(current._id);
    current = await current.getParentRem();
  }
  return false;
}

async function createFlashcard(
  plugin: ReactRNPlugin,
  params: Record<string, unknown>,
  options: { defaultMaterializeTimeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  const deckPath = str(params.deckPath) ?? str(params.deckName);
  const frontHtml = str(params.frontHtml);
  const backHtml = str(params.backHtml);
  const clozeText = str(params.clozeText);
  const clozeSpans = clozeSpanRecords(params.clozeSpans);
  if (params.dryRun === true) {
    return {
      dryRun: true,
      wouldCreate: "flashcard",
      deckPath: deckPath ?? "",
      front: params.front ?? stripHtml(frontHtml),
      back: params.back ?? stripHtml(backHtml),
      cloze: Boolean(clozeText && clozeSpans.length > 0),
      tags: stringArray(params.tags),
      externalId: str(params.externalId),
      batchId: str(params.batchId),
    };
  }
  const plainDeckPath = params.plainDeckPath === true;
  const parent = await ensurePath(plugin, deckPath, MANAGED_ROOT_NAME, {
    finalAsDocument: params.deckAsDocument === true,
    finalAsFolder: !plainDeckPath && params.deckAsDocument !== true,
    plain: plainDeckPath,
  });
  const existingRemId = str(params.existingRemId);
  const existing = existingRemId ? await plugin.rem.findOne(existingRemId) : undefined;
  const rem = existing ?? (await plugin.rem.createRem());
  if (!rem) throw new Error("RemNote did not return a Rem from createRem.");
  const reusableChildren = existing && params.replaceChildrenOnUpdate === true ? await existing.getChildrenRem() : [];
  await rem.setParent(parent);
  if (clozeText && clozeSpans.length > 0) {
    await rem.setText(await clozeRichText(plugin, clozeText, clozeSpans));
    await rem.setBackText(await toRichText(plugin, str(params.back) ?? ""));
  } else {
    await rem.setText(await toRichText(plugin, (params.front as string | unknown[]) ?? stripHtml(frontHtml)));
    await rem.setBackText(await toRichText(plugin, (params.back as string | unknown[]) ?? stripHtml(backHtml)));
  }
  await rem.setEnablePractice(true);
  await rem.setPracticeDirection((str(params.practiceDirection) as "forward" | "backward" | "none" | "both" | undefined) ?? "forward");
  await addTags(plugin, rem, stringArray(params.tags));
  let extraFieldCount = 0;
  let reusableIndex = 0;
  if (frontHtml) {
    await addHtmlFieldChild(plugin, rem, "Anki Front HTML", frontHtml, reusableChildren[reusableIndex]);
    reusableIndex += 1;
    extraFieldCount += 1;
  }
  if (backHtml) {
    await addHtmlFieldChild(plugin, rem, "Anki Back HTML", backHtml, reusableChildren[reusableIndex]);
    reusableIndex += 1;
    extraFieldCount += 1;
  }
  const extraFieldsAdded = await addExtraFields(plugin, rem, params.extraFields, reusableChildren.slice(reusableIndex));
  reusableIndex += extraFieldsAdded;
  extraFieldCount += extraFieldsAdded;
  for (const staleChild of reusableChildren.slice(reusableIndex)) {
    await staleChild.setText(await toRichText(plugin, "Superseded imported field"));
    await staleChild.setBackText(await toRichText(plugin, ""));
  }
  await waitForCards(rem, Number(params.materializeTimeoutMs ?? options.defaultMaterializeTimeoutMs ?? 3500));
  if (params.verbose === true) return summarizeRem(plugin, rem);
  return { id: rem._id, externalId: str(params.externalId), batchId: str(params.batchId), extraFieldCount };
}

async function createFlashcards(plugin: ReactRNPlugin, params: Record<string, unknown>, progress?: ProgressFn): Promise<Record<string, unknown>> {
  const cards = Array.isArray(params.cards) ? params.cards : Array.isArray(params.notes) ? params.notes : [];
  if (params.dryRun === true) return { dryRun: true, wouldCreate: "flashcards", count: cards.length };
  const created: unknown[] = [];
  const ids: string[] = [];
  for (let i = 0; i < cards.length; i += 1) {
    const cardParams = asRecord(cards[i]);
    const inheritedParams = {
      deckPath: params.deckPath ?? params.deckName ?? cardParams.deckPath ?? cardParams.deckName,
      tags: cardParams.tags ?? params.tags,
      batchId: cardParams.batchId ?? params.batchId,
    };
    const createdCard = await createFlashcard(plugin, { ...inheritedParams, ...cardParams, materializeTimeoutMs: params.materializeTimeoutMs ?? cardParams.materializeTimeoutMs, verbose: params.verbose }, {
        defaultMaterializeTimeoutMs: params.waitForCards === true ? 3500 : 0,
      });
    created.push(createdCard);
    if (typeof createdCard.id === "string") ids.push(createdCard.id);
    progress?.(i + 1, cards.length, `Created ${i + 1}/${cards.length}`);
    await new Promise((resolve) => setTimeout(resolve, Number(params.throttleMs ?? 30)));
  }
  return params.verbose === true ? { count: created.length, created } : { count: created.length, ids, remIds: ids };
}

const ATLAS_METADATA_SLOT = "atlasSync";

type AtlasManagedMetadata = {
  externalId: string;
  contentHash: string;
  namespace: string;
  batchId: string;
  parentRemId?: string;
  kind: "document" | "flashcard";
};

type AtlasIndexedRem = AtlasIndexEntry & { kind: "document" | "flashcard" };

function atlasItems(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function atlasIndex(value: unknown): Map<string, AtlasIndexedRem> {
  const map = new Map<string, AtlasIndexedRem>();
  for (const raw of atlasItems(value)) {
    const externalId = str(raw.externalId);
    const remId = str(raw.remId);
    const kind = raw.kind === "flashcard" ? "flashcard" : raw.kind === "document" ? "document" : undefined;
    if (externalId && remId && kind) map.set(externalId, { ...raw, externalId, remId, kind } as AtlasIndexedRem);
  }
  return map;
}

async function atlasMetadata(plugin: ReactRNPlugin, rem: RemObject): Promise<AtlasManagedMetadata | undefined> {
  const rich = await rem.getPowerupPropertyAsRichText(ATLAS_METADATA_POWERUP_CODE, ATLAS_METADATA_SLOT);
  const value = await richTextToString(plugin, rich);
  try {
    const parsed = JSON.parse(value) as Partial<AtlasManagedMetadata>;
    if (
      typeof parsed.externalId === "string" &&
      typeof parsed.contentHash === "string" &&
      typeof parsed.namespace === "string" &&
      typeof parsed.batchId === "string" &&
      (parsed.kind === "document" || parsed.kind === "flashcard")
    ) return parsed as AtlasManagedMetadata;
  } catch {
    // Unmanaged Rems must never be adopted by a batch sync.
  }
  return undefined;
}

async function setAtlasMetadata(plugin: ReactRNPlugin, rem: RemObject, metadata: AtlasManagedMetadata): Promise<void> {
  await rem.addPowerup(ATLAS_METADATA_POWERUP_CODE);
  await rem.setPowerupProperty(ATLAS_METADATA_POWERUP_CODE, ATLAS_METADATA_SLOT, await toRichText(plugin, JSON.stringify(metadata)));
}

async function isUnderAtlasRoot(plugin: ReactRNPlugin, rem: RemObject, root: RemObject): Promise<boolean> {
  let current: RemObject | undefined = rem;
  const seen = new Set<string>();
  while (current && !seen.has(current._id)) {
    if (current._id === root._id) return true;
    seen.add(current._id);
    current = current.parent ? await plugin.rem.findOne(current.parent) ?? undefined : undefined;
  }
  return false;
}

async function reconcileAtlasIndex(plugin: ReactRNPlugin, root: RemObject, namespace: string): Promise<Map<string, AtlasIndexedRem>> {
  const map = new Map<string, AtlasIndexedRem>();
  for (const rem of [root, ...(await root.getDescendants())]) {
    const metadata = await atlasMetadata(plugin, rem);
    if (!metadata || metadata.namespace !== namespace) continue;
    map.set(metadata.externalId, {
      externalId: metadata.externalId,
      remId: rem._id,
      parentRemId: metadata.parentRemId,
      contentHash: metadata.contentHash,
      namespace: metadata.namespace,
      lastBatchId: metadata.batchId,
      kind: metadata.kind,
    });
  }
  return map;
}

function atlasDocument(raw: Record<string, unknown>): AtlasDocument {
  return {
    externalId: String(raw.externalId),
    contentHash: String(raw.contentHash),
    parentExternalId: str(raw.parentExternalId),
    markdown: String(raw.markdown ?? ""),
    links: Array.isArray(raw.links)
      ? raw.links.map(asRecord).map((link) => ({ token: String(link.token ?? ""), targetExternalId: String(link.targetExternalId ?? ""), field: link.field === "back" ? "back" : "text" }))
      : undefined,
  };
}

function atlasFlashcard(raw: Record<string, unknown>): AtlasFlashcard {
  return {
    externalId: String(raw.externalId),
    contentHash: String(raw.contentHash),
    parentExternalId: str(raw.parentExternalId),
    front: String(raw.front ?? ""),
    back: String(raw.back ?? ""),
    tags: stringArray(raw.tags),
    practiceDirection: raw.practiceDirection === "backward" || raw.practiceDirection === "both" || raw.practiceDirection === "none" ? raw.practiceDirection : "forward",
  };
}

async function syncAtlasBatch(plugin: ReactRNPlugin, params: Record<string, unknown>, progress?: ProgressFn): Promise<Record<string, unknown>> {
  if (params.mode !== "fast-local") throw new PluginActionError("forbidden_target", "syncAtlasBatch only accepts mode:fast-local.");
  const rootId = str(params.rootId);
  const batchId = str(params.batchId);
  const namespace = str(params.namespace) ?? "learning-atlas";
  if (!rootId || !batchId) throw new PluginActionError("bad_request", "syncAtlasBatch requires rootId and batchId.");
  const root = await plugin.rem.findOne(rootId);
  if (!root) throw new PluginActionError("forbidden_target", "Configured fast-local root is not accessible in RemNote.");

  const documents = atlasItems(params.documents).map(atlasDocument);
  const flashcards = atlasItems(params.flashcards).map(atlasFlashcard);
  const externalIds = new Set<string>();
  for (const item of [...documents, ...flashcards]) {
    if (!item.externalId || !item.contentHash || externalIds.has(item.externalId)) {
      throw new PluginActionError("bad_request", `Atlas batch has a missing or duplicate externalId: ${item.externalId || "<empty>"}.`);
    }
    externalIds.add(item.externalId);
  }

  const indexed = atlasIndex(params.index);
  if (params.reconcile === true) {
    const reconciled = await reconcileAtlasIndex(plugin, root, namespace);
    for (const [externalId, entry] of reconciled) indexed.set(externalId, entry);
  }
  const remByExternalId = new Map<string, RemObject>();
  for (const [externalId, entry] of indexed) {
    const rem = await plugin.rem.findOne(entry.remId);
    if (!rem) continue;
    if (!(await isUnderAtlasRoot(plugin, rem, root))) throw new PluginActionError("forbidden_target", `Indexed Atlas item ${externalId} is outside the configured root.`);
    const metadata = await atlasMetadata(plugin, rem);
    if (!metadata || metadata.externalId !== externalId || metadata.namespace !== namespace || metadata.kind !== entry.kind) {
      throw new PluginActionError("forbidden_target", `Indexed Atlas item ${externalId} is not a matching managed Rem.`);
    }
    remByExternalId.set(externalId, rem);
  }

  const total = documents.length + flashcards.length;
  let completed = 0;
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  const indexEntries: AtlasIndexedRem[] = [];
  const changedSinceCheckpoint: AtlasIndexedRem[] = [];
  const checkpoint = async (message: string): Promise<void> => {
    if (changedSinceCheckpoint.length > 0 || completed === total) {
      progress?.(completed, total, message, changedSinceCheckpoint.splice(0));
      await yieldToEventLoop();
    }
  };
  const processDocument = async (item: AtlasDocument): Promise<void> => {
    const parent = item.parentExternalId ? remByExternalId.get(item.parentExternalId) : root;
    if (!parent) throw new PluginActionError("bad_request", `Document ${item.externalId} has an unresolved parentExternalId.`);
    const entry = indexed.get(item.externalId);
    if (entry && entry.kind !== "document") throw new PluginActionError("bad_request", `Atlas ID ${item.externalId} changes item kind.`);
    const existing = entry ? remByExternalId.get(item.externalId) : undefined;
    if (existing && entry?.contentHash === item.contentHash && entry.parentRemId === parent._id) {
      unchanged += 1;
      completed += 1;
      return;
    }
    const rem = existing ?? (await plugin.rem.createRem());
    if (!rem) throw new Error("RemNote did not return a Rem from createRem.");
    if (existing && existing.parent !== parent._id) throw new PluginActionError("forbidden_target", `Atlas sync refuses to move ${item.externalId}.`);
    if (!existing) await rem.setParent(parent);
    await rem.setText(await toRichText(plugin, { markdown: item.markdown }));
    await setAtlasMetadata(plugin, rem, { externalId: item.externalId, contentHash: item.contentHash, namespace, batchId, parentRemId: parent._id, kind: "document" });
    const next = { externalId: item.externalId, remId: rem._id, parentRemId: parent._id, contentHash: item.contentHash, namespace, lastBatchId: batchId, kind: "document" as const };
    indexed.set(item.externalId, next);
    remByExternalId.set(item.externalId, rem);
    indexEntries.push(next);
    changedSinceCheckpoint.push(next);
    existing ? updated += 1 : created += 1;
    completed += 1;
  };
  const pending = new Map(documents.map((item) => [item.externalId, item]));
  while (pending.size > 0) {
    let advanced = false;
    for (const item of [...pending.values()]) {
      if (item.parentExternalId && pending.has(item.parentExternalId)) continue;
      await processDocument(item);
      pending.delete(item.externalId);
      advanced = true;
      if (completed % ATLAS_SYNC_CHUNK_SIZE === 0) await checkpoint(`Synced ${completed}/${total} Atlas items`);
    }
    if (!advanced) throw new PluginActionError("bad_request", "Atlas document parents contain a cycle.");
  }
  for (const item of flashcards) {
    const parent = item.parentExternalId ? remByExternalId.get(item.parentExternalId) : root;
    if (!parent) throw new PluginActionError("bad_request", `Flashcard ${item.externalId} has an unresolved parentExternalId.`);
    const parentEntry = item.parentExternalId ? indexed.get(item.parentExternalId) : undefined;
    if (parentEntry?.kind === "flashcard") throw new PluginActionError("bad_request", `Flashcard ${item.externalId} cannot have a flashcard parent.`);
    const entry = indexed.get(item.externalId);
    if (entry && entry.kind !== "flashcard") throw new PluginActionError("bad_request", `Atlas ID ${item.externalId} changes item kind.`);
    const existing = entry ? remByExternalId.get(item.externalId) : undefined;
    if (existing && entry?.contentHash === item.contentHash && entry.parentRemId === parent._id) {
      unchanged += 1;
      completed += 1;
    } else {
      const rem = existing ?? (await plugin.rem.createRem());
      if (!rem) throw new Error("RemNote did not return a Rem from createRem.");
      if (existing && existing.parent !== parent._id) throw new PluginActionError("forbidden_target", `Atlas sync refuses to move ${item.externalId}.`);
      if (!existing) await rem.setParent(parent);
      await rem.setText(await toRichText(plugin, item.front));
      await rem.setBackText(await toRichText(plugin, item.back));
      await rem.setEnablePractice(true);
      await rem.setPracticeDirection(item.practiceDirection ?? "forward");
      await addTags(plugin, rem, item.tags ?? []);
      await setAtlasMetadata(plugin, rem, { externalId: item.externalId, contentHash: item.contentHash, namespace, batchId, parentRemId: parent._id, kind: "flashcard" });
      const next = { externalId: item.externalId, remId: rem._id, parentRemId: parent._id, contentHash: item.contentHash, namespace, lastBatchId: batchId, kind: "flashcard" as const };
      indexed.set(item.externalId, next);
      remByExternalId.set(item.externalId, rem);
      indexEntries.push(next);
      changedSinceCheckpoint.push(next);
      existing ? updated += 1 : created += 1;
      completed += 1;
    }
    if (completed % ATLAS_SYNC_CHUNK_SIZE === 0) await checkpoint(`Synced ${completed}/${total} Atlas items`);
  }

  const unresolvedReferences: Array<{ externalId: string; token: string; targetExternalId: string }> = [];
  for (const item of documents) {
    const source = remByExternalId.get(item.externalId);
    if (!source) continue;
    for (const link of item.links ?? []) {
      const target = remByExternalId.get(link.targetExternalId);
      if (!target) {
        unresolvedReferences.push({ externalId: item.externalId, token: link.token, targetExternalId: link.targetExternalId });
        continue;
      }
      const field = link.field === "back" ? "backText" : "text";
      const current = (field === "text" ? source.text : source.backText) ?? (await toRichText(plugin, ""));
      const currentText = await richTextToString(plugin, current);
      if (countOccurrences(currentText, link.token) !== 1) {
        unresolvedReferences.push({ externalId: item.externalId, token: link.token, targetExternalId: link.targetExternalId });
        continue;
      }
      const reference = await plugin.richText.rem(target).value();
      const next = await replaceRawLinkRichText(plugin, current, link.token, reference);
      if (field === "text") await source.setText(next);
      else await source.setBackText(next);
    }
  }
  await checkpoint(`Synced ${completed}/${total} Atlas items`);
  return { batchId, status: "completed", created, updated, unchanged, errors: [], unresolvedReferences, indexEntries };
}

type ProgressFn = (completed: number, total: number, message?: string, checkpoint?: Array<Record<string, unknown>>) => void;

function publicError(error: unknown): Record<string, unknown> {
  return {
    message: error instanceof Error ? error.message : String(error),
  };
}

function isClozeCardType(type: unknown): boolean {
  return type !== "forward" && type !== "backward";
}

type CapabilityStatus = "PASS" | "FAIL" | "UNSUPPORTED";

type CapabilityProbeRow = {
  capability: string;
  status: CapabilityStatus;
  method: string;
  details?: unknown;
  workaround?: string;
  error?: Record<string, unknown>;
};

function probeRow(
  capability: string,
  status: CapabilityStatus,
  method: string,
  extras: Omit<CapabilityProbeRow, "capability" | "status" | "method"> = {},
): CapabilityProbeRow {
  return { capability, status, method, ...extras };
}

async function probeCards(rem: RemObject, timeoutMs = 5000): Promise<Awaited<ReturnType<typeof summarizeCard>>[]> {
  await waitForCards(rem, timeoutMs);
  return Promise.all((await rem.getCards()).map(summarizeCard));
}

async function probeMarkdownCardSyntax(
  plugin: ReactRNPlugin,
  parent: RemObject,
  capability: string,
  method: string,
  markdown: string,
  timeoutMs = 5000,
): Promise<CapabilityProbeRow> {
  try {
    const rems = await plugin.rem.createTreeWithMarkdown(markdown, parent._id);
    const nested = await Promise.all(rems.map((rem) => rem.getDescendants()));
    const created = [...rems, ...nested.flat()];
    const cardRows = await Promise.all(
      created.map(async (rem) => ({
        remId: rem._id,
        text: await richTextToString(plugin, rem.text),
        cards: await probeCards(rem, timeoutMs),
        isCardItem: await rem.isCardItem(),
      })),
    );
    const cardCount = cardRows.reduce((count, row) => count + row.cards.length, 0);
    return probeRow(capability, cardCount > 0 ? "PASS" : "FAIL", method, {
      details: {
        createdCount: created.length,
        cardCount,
        cardTypes: cardRows.flatMap((row) => row.cards.map((card) => card.type)),
        cardItemCount: cardRows.filter((row) => row.isCardItem).length,
        rows: cardRows,
      },
      workaround: cardCount > 0 ? undefined : "Fallback to explicit Rem SDK calls or user-assisted RemNote paste/import syntax.",
    });
  } catch (error) {
    return probeRow(capability, "FAIL", method, { error: publicError(error) });
  }
}

function methodNames(value: unknown, pattern?: RegExp): string[] {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return [];
  const names = new Set<string>();
  let current: unknown = value;
  while (current && (typeof current === "object" || typeof current === "function")) {
    for (const key of Object.getOwnPropertyNames(current)) {
      if (key === "constructor") continue;
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      const member = descriptor?.value;
      if (typeof member === "function" && (!pattern || pattern.test(key))) names.add(key);
    }
    current = Object.getPrototypeOf(current);
  }
  return [...names].sort();
}

async function createProbeRem(plugin: ReactRNPlugin, parent: RemObject, text: string): Promise<RemObject> {
  const rem = await plugin.rem.createRem();
  if (!rem) throw new Error("RemNote did not return a Rem from createRem.");
  await rem.setParent(parent);
  await rem.setText(await toRichText(plugin, text));
  return rem;
}

async function richTextProbeRead(plugin: ReactRNPlugin, rem: RemObject): Promise<Record<string, unknown>> {
  const descendants = await rem.getDescendants();
  const rems = [rem, ...descendants];
  return {
    descendantCount: descendants.length,
    rems: await Promise.all(
      rems.map(async (item) => ({
        id: item._id,
        text: await richTextToString(plugin, item.text),
        html: item.text ? await plugin.richText.toHTML(item.text).catch((error: unknown) => `toHTML error: ${publicError(error).message}`) : "",
        markdown: item.text ? await plugin.richText.toMarkdown(item.text).catch((error: unknown) => `toMarkdown error: ${publicError(error).message}`) : "",
      })),
    ),
  };
}

async function runCapabilityProbes(plugin: ReactRNPlugin, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const runId = str(params.runId) ?? `__rnc_probe__-${Date.now().toString(36)}`;
  if (params.dryRun === true || params.confirm !== true) {
    return {
      dryRun: true,
      runId,
      probes: [
        "front/back card",
        "concept card",
        "descriptor card",
        "cloze card",
        "multi-line/list card",
        "image occlusion scriptability",
        "properties",
        "portals",
        "ordered insertion",
        "native trash",
        "drift primitives",
        "media data URI",
      ],
      warning: "capabilityProbes creates disposable __rnc_probe__ Rems and tombstones them. Pass confirm:true to execute.",
    };
  }

  const parent = await ensurePath(plugin, runId, MANAGED_ROOT_NAME, { finalAsFolder: true });
  const capabilities: CapabilityProbeRow[] = [];
  const materializeTimeoutMs = Math.max(0, Number(params.materializeTimeoutMs ?? 5000));

  try {
    const rem = await createProbeRem(plugin, parent, `${runId} front/back prompt`);
    await rem.setBackText(await toRichText(plugin, `${runId} front/back answer`));
    await rem.setEnablePractice(true);
    await rem.setPracticeDirection("forward");
    const cards = await probeCards(rem, materializeTimeoutMs);
    capabilities.push(
      probeRow("frontBackCard", cards.length > 0 ? "PASS" : "FAIL", "rem.setText + rem.setBackText + rem.setEnablePractice + rem.setPracticeDirection", {
        details: { remId: rem._id, cardCount: cards.length, cardTypes: cards.map((card) => card.type), cards },
      }),
    );
  } catch (error) {
    capabilities.push(probeRow("frontBackCard", "FAIL", "rem.setText + rem.setBackText", { error: publicError(error) }));
  }

  capabilities.push(
    await probeMarkdownCardSyntax(
      plugin,
      parent,
      "conceptCard",
      "plugin.rem.createTreeWithMarkdown using RemNote concept delimiter ::",
      `- ${runId} Concept :: ${runId} definition`,
      materializeTimeoutMs,
    ),
  );

  capabilities.push(
    await probeMarkdownCardSyntax(
      plugin,
      parent,
      "descriptorCard",
      "plugin.rem.createTreeWithMarkdown using RemNote descriptor delimiter ;;",
      `- ${runId} Parent Concept\n  - attribute ;; ${runId} descriptor answer`,
      materializeTimeoutMs,
    ),
  );

  try {
    const cloze = await createProbeRem(plugin, parent, `${runId} cloze alpha beta gamma`);
    const plain = `${runId} cloze alpha beta gamma`;
    let richText = await toRichText(plugin, plain);
    const start = plain.indexOf("alpha");
    richText = await plugin.richText.applyTextFormatToRange(richText, start, start + "alpha".length, "cloze");
    await cloze.setText(richText);
    await cloze.setEnablePractice(true);
    const cards = await probeCards(cloze, materializeTimeoutMs);
    const clozeCards = cards.filter((card) => isClozeCardType(card.type));
    capabilities.push(
      probeRow("clozeCard", clozeCards.length > 0 ? "PASS" : "FAIL", "richText.applyTextFormatToRange(..., 'cloze') + rem.setEnablePractice", {
        details: { remId: cloze._id, cardCount: cards.length, clozeCount: clozeCards.length, cardTypes: cards.map((card) => card.type), cards },
      }),
    );
  } catch (error) {
    capabilities.push(probeRow("clozeCard", "FAIL", "richText.applyTextFormatToRange(..., 'cloze')", { error: publicError(error) }));
  }

  capabilities.push(
    await probeMarkdownCardSyntax(
      plugin,
      parent,
      "multiLineCard",
      "plugin.rem.createTreeWithMarkdown using RemNote multi-line delimiter >>>",
      `- ${runId} multi-line prompt >>>\n  - ${runId} item one\n  - ${runId} item two`,
      materializeTimeoutMs,
    ),
  );

  capabilities.push(
    await probeMarkdownCardSyntax(
      plugin,
      parent,
      "listAnswerCard",
      "plugin.rem.createTreeWithMarkdown using RemNote list-answer delimiter >>1.",
      `- ${runId} list prompt >>1.\n  - ${runId} first\n  - ${runId} second`,
      materializeTimeoutMs,
    ),
  );

  const pluginAny = plugin as unknown as Record<string, unknown>;
  const imageOcclusionMethods = [
    ...methodNames(pluginAny, /occlusion|imageOcclusion/i),
    ...methodNames(pluginAny.richText, /occlusion|imageOcclusion/i),
    ...methodNames(pluginAny.app, /occlusion|imageOcclusion/i),
  ];
  capabilities.push(
    imageOcclusionMethods.length > 0
      ? probeRow("imageOcclusion", "PASS", imageOcclusionMethods.join(", "), {
          details: { methods: imageOcclusionMethods },
          workaround: "Presence of a method does not prove full card authoring; add a dedicated visual probe before using on real content.",
        })
      : probeRow("imageOcclusion", "UNSUPPORTED", "SDK method introspection", {
          details: { methods: [] },
          workaround: "Use RemNote's native UI for image occlusion or store images/context for user-assisted occlusion until the SDK exposes a scriptable API.",
        }),
  );

  try {
    const rem = await createProbeRem(plugin, parent, `${runId} property probe`);
    await rem.addPowerup("b");
    await rem.setPowerupProperty("b", "URL", await toRichText(plugin, `https://example.com/${runId}`));
    const value = await richTextToString(plugin, await rem.getPowerupPropertyAsRichText("b", "URL"));
    capabilities.push(
      probeRow("properties", value.includes(runId) ? "PASS" : "FAIL", "rem.addPowerup + rem.setPowerupProperty + rem.getPowerupPropertyAsRichText", {
        details: { remId: rem._id, value },
      }),
    );
  } catch (error) {
    capabilities.push(probeRow("properties", "FAIL", "rem.addPowerup + powerup property methods", { error: publicError(error) }));
  }

  try {
    const included = await createProbeRem(plugin, parent, `${runId} portal included`);
    const host = await createProbeRem(plugin, parent, `${runId} portal host`);
    await included.addToPortal(host);
    capabilities.push(
      probeRow("portals", "PASS", "rem.addToPortal", {
        details: { includedRemId: included._id, portalHostRemId: host._id, caveat: "Probe verifies SDK call succeeds, not visual portal rendering." },
      }),
    );
  } catch (error) {
    capabilities.push(probeRow("portals", "FAIL", "rem.addToPortal", { error: publicError(error) }));
  }

  try {
    const orderParent = await createProbeRem(plugin, parent, `${runId} ordered parent`);
    const first = await createProbeRem(plugin, orderParent, `${runId} first`);
    const second = await createProbeRem(plugin, orderParent, `${runId} second`);
    const moved = await createProbeRem(plugin, orderParent, `${runId} moved`);
    await moved.setParent(orderParent, 1);
    const order = (await orderParent.getChildrenRem()).map((rem) => rem._id);
    capabilities.push(
      probeRow("orderedInsertion", order[0] === first._id && order[1] === moved._id && order[2] === second._id ? "PASS" : "FAIL", "rem.setParent(parent, positionAmongstSiblings)", {
        details: { expected: [first._id, moved._id, second._id], observed: order },
      }),
    );
  } catch (error) {
    capabilities.push(probeRow("orderedInsertion", "FAIL", "rem.setParent(parent, positionAmongstSiblings)", { error: publicError(error) }));
  }

  const nativeTrashMethods = [
    ...methodNames(parent, /trash|restore/i),
    ...methodNames(pluginAny.rem, /trash|restore/i),
    ...methodNames(pluginAny.app, /trash|restore/i),
  ];
  capabilities.push(
    nativeTrashMethods.length > 0
      ? probeRow("nativeTrashRestore", "PASS", nativeTrashMethods.join(", "), {
          details: { methods: nativeTrashMethods },
          workaround: "Verify ID-preserving behavior before using; tombstone-by-move remains the safe default.",
        })
      : probeRow("nativeTrashRestore", "UNSUPPORTED", "SDK method introspection", {
          details: { methods: nativeTrashMethods },
          workaround: "Continue tombstone-by-move; snapshot restore is copy-only and not true undo.",
        }),
  );

  try {
    const driftRem = await createProbeRem(plugin, parent, `${runId} drift probe`);
    const before = driftRem.updatedAt;
    await sleep(5);
    await driftRem.setText(await toRichText(plugin, `${runId} drift changed`));
    const after = driftRem.updatedAt;
    const changeFeedMethods = [
      ...methodNames(pluginAny.rem, /change|event|listen|subscribe|watch|sync/i),
      ...methodNames(pluginAny.app, /change|event|listen|subscribe|watch|sync/i),
      ...methodNames(pluginAny, /change|event|listen|subscribe|watch|sync/i),
    ];
    capabilities.push(
      probeRow("driftPrimitives", before !== undefined && after !== undefined ? "PASS" : "FAIL", "rem.updatedAt + SDK method introspection", {
        details: {
          createdAtType: typeof driftRem.createdAt,
          updatedAtType: typeof driftRem.updatedAt,
          updatedAtChanged: before !== after,
          contentHashField: "contentHash" in (driftRem as unknown as Record<string, unknown>),
          changeFeedMethods,
        },
        workaround: changeFeedMethods.length > 0 ? undefined : "Use chunked getAll snapshot sweeps and content hashes for drift detection.",
      }),
    );
  } catch (error) {
    capabilities.push(probeRow("driftPrimitives", "FAIL", "rem.updatedAt + SDK method introspection", { error: publicError(error) }));
  }

  try {
    const dataUri =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
    const richText = await plugin.richText.image(dataUri).value();
    const rem = await createProbeRem(plugin, parent, `${runId} media probe`);
    await rem.setText(richText);
    const richTextApi = plugin.richText as unknown as {
      toHTML?: (richText: RichTextInterface) => Promise<string>;
      findAllExternalURLs?: (richText: RichTextInterface) => Promise<string[]>;
    };
    const html = richTextApi.toHTML ? await richTextApi.toHTML(richText) : undefined;
    const urls = richTextApi.findAllExternalURLs ? await richTextApi.findAllExternalURLs(richText) : undefined;
    const text = await richTextToString(plugin, rem.text);
    capabilities.push(
      probeRow("mediaDataUriImage", text.includes("data:image") || html?.includes("data:image") || urls?.some((url) => url.includes("data:image")) ? "PASS" : "FAIL", "richText.image(dataUri) + setText + optional toHTML/findAllExternalURLs", {
        details: { remId: rem._id, text, html, urls },
      }),
    );
  } catch (error) {
    capabilities.push(probeRow("mediaDataUriImage", "FAIL", "richText.image(dataUri)", { error: publicError(error) }));
  }

  const opId = `${runId}-tombstone`;
  const undoRecord = await captureUndoRecord("capabilityProbes", opId, [parent]);
  const trash = await trashFolder(plugin, opId);
  await parent.setParent(trash);
  const failures = capabilities.filter((row) => row.status === "FAIL");

  return {
    ok: failures.length === 0,
    runId,
    generatedAt: new Date().toISOString(),
    sdkVersion: "@remnote/plugin-sdk@0.0.46",
    capabilities,
    summary: {
      pass: capabilities.filter((row) => row.status === "PASS").length,
      fail: failures.length,
      unsupported: capabilities.filter((row) => row.status === "UNSUPPORTED").length,
    },
    cleanup: {
      mode: "soft-delete",
      opId,
      tombstoneParentId: trash._id,
    },
    undoRecord,
  };
}

async function runAnkiMigrationProbes(plugin: ReactRNPlugin, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const runId = str(params.runId) ?? `__rnc_anki_probe__-${Date.now().toString(36)}`;
  if (params.dryRun === true || params.confirm !== true) {
    return {
      dryRun: true,
      runId,
      probes: ["cloze materialization", "parseAndInsertHtml", "media rich text serialization", "deck leaf as document"],
      warning: "ankiMigrationProbes creates disposable __rnc_ Rems and tombstones them. Pass confirm:true to execute.",
    };
  }

  const parent = await ensurePath(plugin, runId, MANAGED_ROOT_NAME, { finalAsFolder: true });
  const probes: Record<string, unknown> = {};
  let ok = true;

  try {
    const single = await createProbeRem(plugin, parent, "alpha beta gamma");
    let singleText = await toRichText(plugin, "alpha beta gamma");
    singleText = await plugin.richText.applyTextFormatToRange(singleText, 6, 10, "cloze");
    await single.setText(singleText);
    await single.setEnablePractice(true);
    await waitForCards(single, 5000);
    const singleCards = await Promise.all((await single.getCards()).map(summarizeCard));

    const multi = await createProbeRem(plugin, parent, "one two three four");
    let multiText = await toRichText(plugin, "one two three four");
    multiText = await plugin.richText.applyTextFormatToRange(multiText, 0, 3, "cloze");
    multiText = await plugin.richText.applyTextFormatToRange(multiText, 8, 13, "cloze");
    await multi.setText(multiText);
    await multi.setEnablePractice(true);
    await waitForCards(multi, 5000);
    const multiCards = await Promise.all((await multi.getCards()).map(summarizeCard));

    probes.cloze = {
      ok: singleCards.some((card) => isClozeCardType(card.type)),
      singleCardTypes: singleCards.map((card) => card.type),
      singleClozeCount: singleCards.filter((card) => isClozeCardType(card.type)).length,
      multiCardTypes: multiCards.map((card) => card.type),
      multiClozeCount: multiCards.filter((card) => isClozeCardType(card.type)).length,
      groupingObservation:
        multiCards.filter((card) => isClozeCardType(card.type)).length >= 2
          ? "multiple cloze spans materialized as multiple cards"
          : "multiple cloze spans did not materialize as separate cards in this probe",
    };
    ok = ok && (probes.cloze as { ok: boolean }).ok;
  } catch (error) {
    probes.cloze = { ok: false, error: publicError(error) };
    ok = false;
  }

  try {
    const htmlRem = await createProbeRem(plugin, parent, "HTML fidelity probe");
    const html =
      '<b>bold</b><ul><li>one</li><li>two</li></ul><img src="x.jpg"><anki-mathjax>\\\\frac{1}{2}</anki-mathjax>\\\\(x^2\\\\)[sound:a.mp3]';
    await plugin.richText.parseAndInsertHtml(html, htmlRem);
    probes.html = {
      ok: true,
      input: html,
      readback: await richTextProbeRead(plugin, htmlRem),
    };
  } catch (error) {
    probes.html = { ok: false, error: publicError(error) };
    ok = false;
  }

  try {
    const dataUri =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
    const daemonUrl = str(params.mediaUrl) ?? "http://127.0.0.1:8766/media/probe-image.png";
    const dataRem = await createProbeRem(plugin, parent, "data uri image");
    const dataRichText = await plugin.richText.image(dataUri).value();
    await dataRem.setText(dataRichText);
    const daemonRem = await createProbeRem(plugin, parent, "daemon url image");
    const daemonRichText = await plugin.richText.image(daemonUrl).value();
    await daemonRem.setText(daemonRichText);
    probes.media = {
      ok: true,
      dataUri: {
        html: await plugin.richText.toHTML(dataRichText),
        urls: await plugin.richText.findAllExternalURLs(dataRichText),
      },
      daemonUrl: {
        url: daemonUrl,
        html: await plugin.richText.toHTML(daemonRichText),
        urls: await plugin.richText.findAllExternalURLs(daemonRichText),
      },
      caveat: "SDK probe verifies rich-text serialization and URL retention, not visual rendering in every RemNote surface.",
    };
  } catch (error) {
    probes.media = { ok: false, error: publicError(error) };
    ok = false;
  }

  try {
    const deckDocument = await ensurePath(plugin, `${runId}::Leaf Deck`, MANAGED_ROOT_NAME, { finalAsDocument: true });
    const card = await createProbeRem(plugin, deckDocument, "Deck document card?");
    await card.setBackText(await toRichText(plugin, "Yes."));
    await card.setEnablePractice(true);
    await card.setPracticeDirection("forward");
    await waitForCards(card, 5000);
    probes.deckAsDocument = {
      ok: (await deckDocument.isDocument()) && (await card.getCards()).length > 0,
      documentId: deckDocument._id,
      isDocument: await deckDocument.isDocument(),
      cardCount: (await card.getCards()).length,
    };
    ok = ok && (probes.deckAsDocument as { ok: boolean }).ok;
  } catch (error) {
    probes.deckAsDocument = { ok: false, error: publicError(error) };
    ok = false;
  }

  const opId = `${runId}-tombstone`;
  const undoRecord = await captureUndoRecord("ankiMigrationProbes", opId, [parent]);
  const trash = await trashFolder(plugin, opId);
  await parent.setParent(trash);

  return {
    ok,
    runId,
    probes,
    cleanup: {
      mode: "soft-delete",
      opId,
      tombstoneParentId: trash._id,
    },
    undoRecord,
  };
}

export async function executeAction(
  plugin: ReactRNPlugin,
  action: string,
  params: Record<string, unknown> = {},
  progress?: ProgressFn,
): Promise<unknown> {
  switch (action) {
    case "prepareMutation":
      return prepareMutation(plugin, params);
    case "setDaemonToken": {
      const token = str(params.token);
      if (!token || token.length < 16) throw new Error("setDaemonToken requires a token.");
      const storage = globalThis.localStorage as Storage | undefined;
      if (typeof storage?.setItem === "function") {
        storage.setItem(DAEMON_TOKEN_STORAGE_KEY, token);
      } else {
        const settingsWithSetter = plugin.settings as unknown as { setSetting?: (key: string, value: string) => Promise<void> };
        if (!settingsWithSetter.setSetting) throw new Error("No plugin-local token storage is available.");
        await settingsWithSetter.setSetting(DAEMON_TOKEN_SETTING, token);
      }
      return { stored: true };
    }
    case "scopeProbe": {
      const rems = await allAccessibleRems(plugin);
      const root = await getManagedRoot(plugin);
      let outOfRoot: RemObject | undefined;
      for (const rem of rems) {
        if (rem._id === root._id) continue;
        let current: RemObject | undefined = rem;
        const seen = new Set<string>();
        let insideRoot = false;
        while (current) {
          if (current._id === root._id) {
            insideRoot = true;
            break;
          }
          if (seen.has(current._id)) break;
          seen.add(current._id);
          current = await current.getParentRem();
        }
        if (!insideRoot) {
          outOfRoot = rem;
          break;
        }
      }
      return {
        ok: rems.length > 0 && Boolean(outOfRoot),
        totalRems: rems.length,
        managedRootId: root._id,
        outOfRootSampleId: outOfRoot?._id,
        sdk: {
          nativeTrashRestore: false,
          orderedInsertion: true,
          wholeKbEnumeration: true,
        },
      };
    }
    case "init": {
      if (params.dryRun === true) return { dryRun: true, wouldCreate: `${MANAGED_ROOT_NAME}/Trash` };
      const root = await ensureManagedRoot(plugin);
      const trash = await trashFolder(plugin);
      return { rootId: root._id, trashId: trash._id, count: 2 };
    }
    case "capabilityProbes":
      if (params.dryRun === true) return { dryRun: true, count: 0, wouldRun: "capabilityProbes" };
      return runCapabilityProbes(plugin, params);
    case "ankiMigrationProbes":
      if (params.dryRun === true) return { dryRun: true, count: 0, wouldRun: "ankiMigrationProbes" };
      return runAnkiMigrationProbes(plugin, params);
    case "listRoots": {
      const root = await getManagedRoot(plugin);
      return params.verbose === true ? summarizeRem(plugin, root, root) : compactRem(root);
    }
    case "createRem": {
      if (params.dryRun === true) {
        return {
          dryRun: true,
          wouldCreate: "rem",
          parentPath: str(params.parentPath) ?? "",
          text: str(params.text) ?? "",
          backText: params.backText,
        };
      }
      const parent = await ensurePath(plugin, str(params.parentPath), MANAGED_ROOT_NAME, { finalAsFolder: true });
      const rem = await plugin.rem.createRem();
      if (!rem) throw new Error("RemNote did not return a Rem from createRem.");
      await rem.setParent(parent);
      await rem.setText(await toRichText(plugin, str(params.text) ?? ""));
      if (params.backText) await rem.setBackText(await toRichText(plugin, params.backText as string | unknown[]));
      return mutationReturn(plugin, rem, params);
    }
    case "createFolder":
    case "createDeck": {
      const path = str(params.path) ?? str(params.deck) ?? str(params.deckName);
      if (!path) throw new Error("createFolder requires path.");
      if (params.dryRun === true) return { dryRun: true, wouldCreatePath: path, count: 1 };
      const folder = await ensurePath(plugin, path, MANAGED_ROOT_NAME, {
        finalAsFolder: params.asDocument !== true,
        finalAsDocument: params.asDocument === true,
      });
      return mutationReturn(plugin, folder, params);
    }
    case "renameRem": {
      const rem = await requireAccessibleRem(plugin, str(params.remId) ?? str(params.id), "Rem");
      await assertPreparedTargets([rem], params);
      if (params.dryRun === true) return { dryRun: true, count: 1, remIds: [rem._id] };
      await rem.setText(await toRichText(plugin, str(params.text) ?? str(params.newName) ?? ""));
      return mutationReturn(plugin, rem, params);
    }
    case "moveRem":
    case "changeDeck": {
      const targetPath = str(params.targetPath) ?? str(params.deck) ?? str(params.deckName);
      if (!targetPath) throw new Error(`${action} requires targetPath/deck.`);
      const { rems } = await resolveTargets(plugin, params);
      await assertPreparedTargets(rems, params);
      if (params.dryRun === true || params.confirm !== true) {
        return {
          dryRun: true,
          count: rems.length,
          remIds: rems.map((rem) => rem._id),
          targetPath,
          warning: params.confirm === true ? undefined : `${action} defaults to dry-run. Pass confirm:true to move targets.`,
        };
      }
      const target = await ensurePath(plugin, targetPath, MANAGED_ROOT_NAME, { finalAsFolder: true });
      for (const rem of rems) await rem.setParent(target);
      return { ...(await mutationListReturn(plugin, rems, params)), targetPath };
    }
    case "bulkMove":
      return bulkMoveRems(plugin, params);
    case "createFlashcard":
      return createFlashcard(plugin, params);
    case "createFlashcards":
      return createFlashcards(plugin, params, progress);
    case "syncAtlasBatch":
      return syncAtlasBatch(plugin, params, progress);
    case "updateFlashcard": {
      const rem = await requireAccessibleRem(plugin, str(params.remId) ?? str(params.noteId) ?? str(params.id), "Flashcard Rem");
      await assertPreparedTargets([rem], params);
      if (params.dryRun === true) return { dryRun: true, count: 1, remIds: [rem._id] };
      if (params.front !== undefined) await rem.setText(await toRichText(plugin, params.front as string | unknown[]));
      if (params.back !== undefined) await rem.setBackText(await toRichText(plugin, params.back as string | unknown[]));
      if (params.practiceDirection) await rem.setPracticeDirection(params.practiceDirection as "forward" | "backward" | "none" | "both");
      if (params.tags) await addTags(plugin, rem, stringArray(params.tags));
      return mutationReturn(plugin, rem, params);
    }
    case "getFlashcard": {
      const rem = await requireAccessibleRem(plugin, str(params.remId) ?? str(params.noteId) ?? str(params.id), "Flashcard Rem");
      return summarizeRem(plugin, rem);
    }
    case "searchFlashcards": {
      const rems = await findFlashcardRems(plugin, str(params.query));
      return params.verbose === true ? Promise.all(rems.map((rem) => summarizeRem(plugin, rem))) : compactRems(rems);
    }
    case "recentReviews": {
      const since = Number(params.since);
      const limit = Math.min(Math.max(1, Number(params.limit ?? 250)), 1000);
      const reviewed = (await plugin.card.getAll())
        .filter((card) => typeof card.lastRepetitionTime === "number" && card.lastRepetitionTime >= since)
        .sort((a, b) => Number(b.lastRepetitionTime) - Number(a.lastRepetitionTime));
      const selected = reviewed.slice(0, limit);
      const items = await mapBounded(selected, 24, async (card) => {
        const rem = await plugin.rem.findOne(card.remId);
        if (!rem) return undefined;
        return {
          card: await summarizeCard(card),
          rem: await summarizeRem(plugin, rem),
        };
      });
      return {
        since,
        count: reviewed.length,
        truncated: reviewed.length > limit,
        items: items.filter(Boolean),
      };
    }
    case "searchGraph":
    case "searchRem": {
      const rems = await findGraphRems(plugin, str(params.query));
      return params.verbose === true ? Promise.all(rems.map((rem) => summarizeRem(plugin, rem))) : compactRems(rems);
    }
    case "findByTag": {
      const query = `tag:${str(params.tag) ?? ""}`;
      const rems = await findGraphRems(plugin, query);
      return params.verbose === true ? Promise.all(rems.map((rem) => summarizeRem(plugin, rem))) : compactRems(rems);
    }
    case "findOrphans": {
      const rems = await allAccessibleRems(plugin);
      const ids = new Set(rems.map((rem) => rem._id));
      const orphans = rems.filter((rem) => rem.parent !== null && !ids.has(rem.parent));
      return params.verbose === true ? { count: orphans.length, items: await Promise.all(orphans.map((rem) => summarizeRem(plugin, rem))) } : compactRems(orphans);
    }
    case "findEmpty": {
      const matches: RemObject[] = [];
      for (const rem of await allAccessibleRems(plugin)) {
        const text = (await richTextToString(plugin, rem.text)).trim();
        const backText = (await richTextToString(plugin, rem.backText)).trim();
        const children = await rem.getChildrenRem();
        if (!text && !backText && children.length === 0) matches.push(rem);
      }
      return params.verbose === true ? { count: matches.length, items: await Promise.all(matches.map((rem) => summarizeRem(plugin, rem))) } : compactRems(matches);
    }
    case "getRem": {
      const rem = await requireAccessibleRem(plugin, str(params.remId) ?? str(params.id), "Rem");
      return summarizeRem(plugin, rem);
    }
    case "map": {
      const maxDepth = Math.max(0, Number(params.depth ?? 3));
      const rows: string[] = [];
      const rootId = str(params.rootId) ?? str(params.id);
      if (rootId) {
        const root = await requireAccessibleRem(plugin, rootId, "Map root");
        await outlineRows(plugin, root, 0, maxDepth, rows);
      } else {
        const topLevel = (await allAccessibleRems(plugin)).filter((rem) => rem.parent === null);
        for (const rem of topLevel) await outlineRows(plugin, rem, 0, maxDepth, rows);
      }
      return { format: "tsv", rowCount: rows.length, tsv: rows.join("\n") };
    }
    case "auditManagedRoot": {
      const root = await getManagedRoot(plugin);
      const rems = await managedRems(plugin);
      let flashcardRems = 0;
      let folders = 0;
      for (const rem of rems) {
        if ((await rem.getCards()).length > 0) flashcardRems += 1;
        if (await rem.isFolder()) folders += 1;
      }
      return {
        root: await summarizeRem(plugin, root, root),
        remCount: rems.length,
        flashcardRems,
        folders,
      };
    }
    case "dryRunDelete": {
      const { rems, cards } = await resolveTargets(plugin, params);
      return { remIds: rems.map((rem) => rem._id), cardIds: cards.map((card) => card._id), count: rems.length + cards.length };
    }
    case "backupGraph": {
      const rems = await allAccessibleRems(plugin);
      const topLevel = rems.filter((rem) => rem.parent === null);
      progress?.(0, rems.length, `Preparing graph backup for ${rems.length} Rem`);
      return buildSnapshot(plugin, topLevel.length > 0 ? topLevel : rems, { total: rems.length, progress });
    }
    case "backupSubtree":
    case "exportSubtree": {
      const targets = await resolveTargets(plugin, params);
      const rems = targets.rems.length > 0 ? targets.rems : [await getManagedRoot(plugin)];
      return buildSnapshot(plugin, rems, { progress });
    }
    case "validateSnapshot": {
      const snapshot = asRecord(params.snapshot);
      const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
      const nodeCount = snapshotNodeCount(nodes);
      return {
        valid:
          snapshot.schemaVersion === 1 &&
          nodes.length > 0 &&
          nodes.every(validSnapshotNode) &&
          (snapshot.nodeCount === undefined || snapshot.nodeCount === nodeCount),
        nodeCount,
        warning: "Snapshot restores are copies and do not preserve original IDs, inbound references, portals, or scheduling history.",
      };
    }
    case "importSnapshot": {
      const snapshot = asRecord(params.snapshot) as { nodes?: unknown[] };
      if (!Array.isArray(snapshot.nodes)) throw new Error("importSnapshot requires snapshot.nodes.");
      const count = snapshotNodeCount(snapshot.nodes);
      if (params.dryRun === true) return { dryRun: true, wouldImport: count, count };
      const parent = await ensurePath(plugin, str(params.parentPath), MANAGED_ROOT_NAME, { finalAsFolder: true });
      const restored: string[] = [];
      for (const node of snapshot.nodes) {
        const rem = await restoreSnapshotNode(plugin, parent, node as Parameters<typeof restoreSnapshotNode>[2]);
        restored.push(rem._id);
      }
      return {
        count: restored.length,
        remIds: restored,
        warning: "Restored Rem are copies with new IDs. Inbound references, portals, and scheduling history were not preserved.",
      };
    }
    case "deleteRem":
    case "deleteNotes":
    case "bulkDelete":
      return softDeleteRems(plugin, action, params);
    case "bulkRetag":
      return bulkRetagRems(plugin, params);
    case "normalizeText":
      return normalizeTextRems(plugin, params);
    case "rewriteNativeLinks":
      return rewriteNativeLinks(plugin, params);
    case "mergeRems":
      return mergeRems(plugin, params);
    case "setProperty":
      return setRemProperty(plugin, params);
    case "getProperties":
      return getRemProperties(plugin, params);
    case "deleteFlashcards":
      throw new PluginActionError(
        "experimental_disabled",
        "deleteFlashcards is disabled until complete scheduler state can be captured, restored, and live-tested.",
      );
    case "addNote": {
      return createFlashcard(plugin, { ...ankiNoteToFlashcard(params.note ? asRecord(params.note) : params), existingRemId: params.existingRemId, verbose: params.verbose });
    }
    case "addNotes": {
      const notes = Array.isArray(params.notes) ? params.notes : [];
      const cards = notes.map((note) => ankiNoteToFlashcard(asRecord(note)));
      return createFlashcards(plugin, { cards, verbose: params.verbose }, progress);
    }
    case "canAddNote": {
      const candidate = ankiNoteToFlashcard(params.note ? asRecord(params.note) : params);
      return Boolean(String(candidate.front ?? "").trim() && String(candidate.back ?? "").trim());
    }
    case "findNotes": {
      const rems = await findGraphRems(plugin, str(params.query));
      return rems.map((rem) => rem._id);
    }
    case "notesInfo": {
      const ids = stringArray(params.notes);
      const rems: RemObject[] = [];
      for (const id of ids) {
        const rem = await requireAccessibleRem(plugin, id, "Note Rem");
        rems.push(rem);
      }
      return Promise.all(rems.map((rem) => summarizeRem(plugin, rem)));
    }
    case "deckNames": {
      const root = await getManagedRoot(plugin);
      const rems = await allAccessibleRems(plugin);
      const names: string[] = [];
      for (const rem of rems) {
        if (rem._id === root._id || (await rem.isFolder()) || (await rem.isDocument())) {
          const path = await summarizeRem(plugin, rem, root);
          names.push(path.path || MANAGED_ROOT_NAME);
        }
      }
      return [...new Set(names)].sort();
    }
    case "undo": {
      const undoRecord = asRecord(params.undoRecord) as Partial<UndoRecord>;
      if (undoRecord.schemaVersion !== 1 || !Array.isArray(undoRecord.targets) || typeof undoRecord.opId !== "string") {
        throw new Error("undo requires a daemon-provided undoRecord.");
      }
      const restored = (
        await Promise.all(undoRecord.targets.map((target) => restoreUndoTarget(plugin, target as UndoTarget)))
      ).filter((id): id is string => Boolean(id));
      return { opId: undoRecord.opId, restored, count: restored.length };
    }
    case "listTombstones": {
      const trash = await trashFolder(plugin);
      const tombstones = await Promise.all(
        (await trash.getChildrenRem()).map((rem) => trashChildInfo(plugin, rem)),
      );
      const visible = tombstones.filter((info) => !isTrashMetadataChild(info) && !isEmptyTrashMetadataContainer(info));
      return {
        count: visible.length,
        tombstones: visible.map((info) => ({
          id: info.rem._id,
          text: info.text,
          childCount: info.childCount,
          visibleChildCount: info.visibleChildCount,
        })),
      };
    }
    case "restoreTombstone": {
      const undoRecord = asRecord(params.undoRecord) as Partial<UndoRecord>;
      if (undoRecord.schemaVersion !== 1 || !Array.isArray(undoRecord.targets)) {
        throw new PluginActionError("bad_request", "restoreTombstone requires a daemon-loaded undo record.");
      }
      for (const target of undoRecord.targets) {
        const rem = await requireAccessibleRem(plugin, (target as UndoTarget).id, "Tombstone");
        if (!(await isUnderTrash(plugin, rem))) {
          throw new PluginActionError("forbidden_target", `Rem ${rem._id} is not currently under RemNoteConnect/Trash.`);
        }
      }
      return executeAction(plugin, "undo", { undoRecord }, progress);
    }
    case "emptyTrash": {
      const tombstoneOpId = str(params.tombstoneOpId);
      const targets = await exactTrashTargets(plugin, tombstoneOpId);
      const remIds = targets.rems.map((rem) => rem._id).sort();
      if (params.dryRun === true || params.confirm !== true) {
        return {
          dryRun: true,
          tombstoneOpId,
          count: targets.rems.length,
          remIds,
          rootIds: targets.roots.map((rem) => rem._id).sort(),
          inboundReferenceIds: targets.inboundReferenceIds,
          inboundReferenceCount: targets.inboundReferenceIds.length,
          fingerprints: await Promise.all(
            targets.rems.map(async (rem) => ({
              id: rem._id,
              parentId: rem.parent,
              siblingIndex: await siblingIndex(rem),
              updatedAt: rem.updatedAt,
            })),
          ),
          warning: "emptyTrash is irreversible. Execute only with daemon dry-run hash verification.",
        };
      }
      if (params.irreversibleVerified !== true) throw new Error("emptyTrash requires daemon irreversible verification.");
      const expected = stringArray(params.expectedTargetIds).sort();
      if (expected.length !== remIds.length || expected.some((id, index) => id !== remIds[index])) {
        throw new PluginActionError("dry_run_mismatch", "Trash contents changed after dry-run.", { expected, actual: remIds });
      }
      await assertExpectedFingerprints(targets.rems, params.expectedFingerprints);
      if (targets.inboundReferenceIds.length > 0 && params.force !== true) {
        throw new PluginActionError("forbidden_target", "Trash contains Rem with inbound references. Pass force:true only after reviewing them.", {
          inboundReferenceIds: targets.inboundReferenceIds,
        });
      }
      for (const rem of targets.roots) await removeRemTree(rem);
      return { tombstoneOpId, count: targets.rems.length, remIds, inboundReferenceIds: targets.inboundReferenceIds };
    }
    case "createDocument": {
      const markdown = str(params.markdown) ?? str(params.md) ?? "";
      const docSpec = asRecord(params.docSpec ?? params.document);
      const hasDocSpec = Object.keys(docSpec).length > 0;
      if (!markdown.trim() && !hasDocSpec) throw new Error("createDocument requires markdown/md or docSpec.");
      if (params.dryRun === true) {
        return {
          dryRun: true,
          parentPath: str(params.parentPath) ?? str(params.parent) ?? "",
          markdownBytes: markdown.length,
          docSpecNodes: hasDocSpec ? docSpecNodeCount(docSpec) : 0,
        };
      }
      const parent = await ensurePath(plugin, str(params.parentPath) ?? str(params.parent), MANAGED_ROOT_NAME, { finalAsFolder: true });
      const existingRemId = str(params.existingRemId);
      const existing = existingRemId ? await plugin.rem.findOne(existingRemId) : undefined;
      if (existing) {
        if (existing._id !== parent._id) await existing.setParent(parent);
        if (hasDocSpec) await applyDocSpecToRem(plugin, existing, docSpec);
        else await existing.setText(await toRichText(plugin, firstMarkdownTitle(markdown)));
        return params.verbose === true
          ? { updatedExisting: true, ...(await summarizeRem(plugin, existing)) }
          : { id: existing._id, count: 1, remIds: [existing._id], updatedExisting: true, childrenSkipped: hasDocSpec && docSpecChildren(docSpec).length > 0 };
      }
      if (hasDocSpec) {
        const rems = await createDocSpecTree(plugin, parent, docSpec);
        return params.verbose === true
          ? { count: rems.length, items: await Promise.all(rems.map((rem) => summarizeRem(plugin, rem))) }
          : { id: rems[0]?._id, count: rems.length, remIds: rems.map((rem) => rem._id) };
      }
      const rems = await plugin.rem.createTreeWithMarkdown(markdown, parent._id);
      const ids = rems.map((rem) => rem._id);
      return params.verbose === true ? { count: rems.length, items: await Promise.all(rems.map((rem) => summarizeRem(plugin, rem))) } : { id: ids[0], count: rems.length, remIds: ids };
    }
    case "appendToDocument": {
      const markdown = str(params.markdown) ?? str(params.md) ?? "";
      const docSpec = asRecord(params.docSpec ?? params.document);
      const hasDocSpec = Object.keys(docSpec).length > 0;
      if (!markdown.trim() && !hasDocSpec) throw new Error("appendToDocument requires markdown/md or docSpec.");
      const parent = await requireAccessibleRem(plugin, str(params.remId) ?? str(params.id), "Document");
      await assertPreparedTargets([parent], params);
      const directChildrenOnly =
        hasDocSpec && !("text" in docSpec) && !("title" in docSpec) && !("richText" in docSpec) && !("backText" in docSpec) && Array.isArray(docSpec.children);
      const docSpecsToAppend = hasDocSpec ? (directChildrenOnly ? docSpecChildren(docSpec) : [docSpec]) : [];
      if (params.dryRun === true) {
        return {
          dryRun: true,
          parentId: parent._id,
          markdownBytes: markdown.length,
          docSpecNodes: docSpecsToAppend.reduce((count, spec) => count + docSpecNodeCount(spec), 0),
        };
      }
      if (hasDocSpec) {
        const rems: RemObject[] = [];
        for (const spec of docSpecsToAppend) rems.push(...(await createDocSpecTree(plugin, parent, spec)));
        return { count: rems.length, remIds: rems.map((rem) => rem._id) };
      }
      const rems = await plugin.rem.createTreeWithMarkdown(markdown, parent._id);
      return { count: rems.length, remIds: rems.map((rem) => rem._id) };
    }
    case "getDocument": {
      const rem = await requireAccessibleRem(plugin, str(params.remId) ?? str(params.id), "Document");
      const format = str(params.format) ?? "markdown";
      if (format === "tree") return buildSnapshot(plugin, [rem]);
      const lines: string[] = [];
      await remMarkdownTree(plugin, rem, 0, Math.max(0, Number(params.depth ?? 99)), lines);
      return { format: "markdown", markdown: lines.join("\n") };
    }
    case "findDuplicates": {
      const by = str(params.by) ?? "text";
      if (by !== "text") throw new Error("findDuplicates currently supports by:\"text\" only.");
      const groups = new Map<string, RemObject[]>();
      const allRems = await allAccessibleRems(plugin);
      const chunkSize = Math.max(1, Number(params.chunkSize ?? 500));
      for (let offset = 0; offset < allRems.length; offset += chunkSize) {
        const chunk = allRems.slice(offset, offset + chunkSize);
        const entries = await mapBounded(chunk, 32, async (rem) => {
          const text = (await richTextToString(plugin, rem.text)).trim().replace(/\s+/g, " ").toLowerCase();
          return text ? { text, rem } : undefined;
        });
        for (const entry of entries) {
          if (!entry) continue;
          const existing = groups.get(entry.text) ?? [];
          existing.push(entry.rem);
          groups.set(entry.text, existing);
        }
        progress?.(Math.min(offset + chunk.length, allRems.length), allRems.length, `Scanned ${Math.min(offset + chunk.length, allRems.length)}/${allRems.length}`);
        await yieldToEventLoop();
      }
      const duplicates = [];
      for (const [text, rems] of groups.entries()) {
        if (rems.length > 1) duplicates.push({ text, count: rems.length, remIds: rems.map((rem) => rem._id) });
      }
      return { count: duplicates.length, groups: duplicates };
    }
    case "answerCard": {
      throw new PluginActionError(
        "experimental_disabled",
        "Scheduler mutation is disabled until complete scheduler state can be captured, restored, and live-tested.",
      );
    }
    default: {
      const terms = parseQuery(str(params.query));
      throw new Error(`Unsupported plugin action: ${action}${terms.length ? "" : ""}`);
    }
  }
}

export function capabilityMatrix(): Record<string, unknown> {
  return {
    actions: pluginActions,
    sdkMethods: {
      rem: [
        "createRem",
        "findByName",
        "findOne",
        "getAll",
        "getDescendants",
        "setParent",
        "setParent(positionAmongstSiblings)",
        "positionAmongstSiblings",
        "setText",
        "setBackText",
        "setIsCardItem",
        "setIsFolder",
        "setIsDocument",
        "getCards",
        "setPracticeDirection",
        "createTreeWithMarkdown",
        "remsReferencingThis",
        "addToPortal",
        "remove",
      ],
      card: ["findOne", "getAll", "remove", "updateCardRepetitionStatus"],
      richText: [
        "text",
        "toString",
        "toHTML",
        "parseAndInsertHtml",
        "applyTextFormatToRange",
        "parseFromMarkdown",
        "toMarkdown",
        "latex",
        "image",
        "audio",
        "code",
        "rem",
      ],
    },
    sdkLimitations: {
      nativeTrashRestore: "not found in @remnote/plugin-sdk@0.0.46 declarations",
      orderedUndo: "supported through setParent(parent, positionAmongstSiblings)",
      wholeKbScope: "supported through manifest All/ReadCreateModifyDelete and plugin.rem.getAll",
    },
    queryGrammar: ["deck:<path>", "tag:<tag>", "text:<text>", "id:<remId>"],
    operationalRoot: MANAGED_ROOT_NAME,
    safetyModel: "whole-kb with tombstone + daemon undo store",
    contentFeatures: {
      parseAndInsertHtml: true,
      clozeWrite: true,
      mediaPipeline: "daemon-local-url",
      noteTypeMapping: "native RemNote card actions",
      finalAsDocument: true,
    },
  };
}
