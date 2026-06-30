import type { QueueInteractionScore, ReactRNPlugin, RichTextInterface } from "@remnote/plugin-sdk";
import { MANAGED_ROOT_NAME, parseQuery, pluginActions, type CreateFlashcardParams } from "@remnoteconnect/shared";
import type { RemObject } from "./sdkTypes.js";
import {
  addTags,
  allAccessibleRems,
  buildSnapshot,
  ensurePath,
  findFlashcardRems,
  findGraphRems,
  getManagedRoot,
  managedRems,
  requireAccessibleRem,
  requireManagedRem,
  resolveTargets,
  restoreSnapshotNode,
  richTextToString,
  summarizeCard,
  summarizeRem,
  toRichText,
} from "./remnoteHelpers.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

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

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
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

async function trashChildInfo(plugin: ReactRNPlugin, rem: RemObject): Promise<{ rem: RemObject; text: string; childCount: number }> {
  return {
    rem,
    text: await richTextToString(plugin, rem.text),
    childCount: (await rem.getChildrenRem()).length,
  };
}

function isTrashMetadataChild(info: { text: string; childCount: number }): boolean {
  return info.childCount === 0 && TRASH_METADATA_CHILD_TEXT.has(info.text);
}

async function softDeleteRems(plugin: ReactRNPlugin, action: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { rems } = await resolveTargets(plugin, params);
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
  const undoRecord = await captureUndoRecord(action, opId, rems);
  const trash = await trashFolder(plugin, opId);
  for (const rem of rems) await rem.setParent(trash);
  return { opId, count: rems.length, remIds, undoRecord, tombstoneParentId: trash._id };
}

async function bulkMoveRems(plugin: ReactRNPlugin, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const targetPath = str(params.targetPath) ?? str(params.parentPath) ?? str(params.deck) ?? str(params.deckName);
  if (!targetPath) throw new Error("bulkMove requires targetPath/parentPath/deck.");
  const { rems } = await resolveTargets(plugin, params);
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
  const undoRecord = await captureUndoRecord("bulkMove", opId, rems);
  const target = await ensurePath(plugin, targetPath, MANAGED_ROOT_NAME, { finalAsFolder: true });
  for (const rem of rems) await rem.setParent(target);
  return { opId, count: rems.length, remIds: rems.map((rem) => rem._id), targetPath, undoRecord };
}

async function bulkRetagRems(plugin: ReactRNPlugin, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { rems } = await resolveTargets(plugin, params);
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
  const undoRecord = await captureUndoRecord("bulkRetag", opId, rems);
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
  const { rems } = await resolveTargets(plugin, params);
  const includeBackText = params.includeBackText === true;
  const targets: RemObject[] = [];
  for (const rem of rems) {
    const text = await richTextToString(plugin, rem.text);
    const backText = await richTextToString(plugin, rem.backText);
    if (normalizeWhitespace(text) !== text || (includeBackText && normalizeWhitespace(backText) !== backText)) targets.push(rem);
  }
  const opId = str(params.opId) ?? newOpId();
  if (params.dryRun === true || params.confirm !== true) {
    return {
      dryRun: true,
      opId,
      count: targets.length,
      remIds: targets.map((rem) => rem._id),
      includeBackText,
      warning: params.confirm === true ? undefined : "normalizeText defaults to dry-run. Pass confirm:true to normalize targets.",
    };
  }
  const undoRecord = await captureUndoRecord("normalizeText", opId, targets);
  for (const rem of targets) {
    await rem.setText(await toRichText(plugin, normalizeWhitespace(await richTextToString(plugin, rem.text))));
    if (includeBackText) await rem.setBackText(await toRichText(plugin, normalizeWhitespace(await richTextToString(plugin, rem.backText))));
  }
  return { opId, count: targets.length, remIds: targets.map((rem) => rem._id), undoRecord };
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

  if (structural && params.irreversibleVerified !== true) {
    throw new Error("mergeRems structural mode requires daemon irreversible verification.");
  }

  if (!structural) {
    const undoRecord = await captureUndoRecord("mergeRems", opId, losers);
    const trash = await trashFolder(plugin, opId);
    for (const loser of losers) {
      await loser.setBackText(await mergedIntoRichText(plugin, keeper));
      await loser.setParent(trash);
    }
    return { opId, structural: false, keepId: keeper._id, count: losers.length, remIds: losers.map((rem) => rem._id), undoRecord };
  }

  const movedChildren: RemObject[] = [];
  const referenceRms: RemObject[] = [];
  const inverseReferences: NonNullable<UndoRecord["mergeInverseReferences"]> = [];
  for (const loser of losers) {
    movedChildren.push(...(await loser.getChildrenRem()));
    const refs = await loser.remsReferencingThis();
    for (const ref of refs) {
      if (ref._id === loser._id || ref._id === keeper._id) continue;
      referenceRms.push(ref);
      inverseReferences.push({
        referencingRemId: ref._id,
        fromRemId: loser._id,
        toRemId: keeper._id,
        richTextBefore: ref.text,
        richBackTextBefore: ref.backText,
      });
    }
  }
  const affected = uniqueRems([...losers, ...movedChildren, ...referenceRms]);
  const undoRecord = await captureMergeUndoRecord("mergeRems", opId, affected, inverseReferences);
  for (const loser of losers) {
    for (const ref of await loser.remsReferencingThis()) {
      if (ref._id === loser._id || ref._id === keeper._id) continue;
      const text = await replaceReference(plugin, ref.text, loser, keeper);
      const backText = await replaceReference(plugin, ref.backText, loser, keeper);
      if (text) await ref.setText(text);
      if (backText) await ref.setBackText(backText);
    }
    for (const child of await loser.getChildrenRem()) await child.setParent(keeper);
  }
  const trash = await trashFolder(plugin, opId);
  for (const loser of losers) await loser.setParent(trash);
  return {
    opId,
    structural: true,
    keepId: keeper._id,
    count: losers.length,
    remIds: losers.map((rem) => rem._id),
    movedChildIds: movedChildren.map((rem) => rem._id),
    referenceRemIds: uniqueRems(referenceRms).map((rem) => rem._id),
    undoRecord,
  };
}

async function setRemProperty(plugin: ReactRNPlugin, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const rem = await requireAccessibleRem(plugin, str(params.id) ?? str(params.remId), "Rem");
  const opId = str(params.opId) ?? newOpId();
  const powerupCode = str(params.powerupCode) ?? str(params.powerup);
  const slot = str(params.slot) ?? str(params.property);
  const propertyId = str(params.propertyId) ?? str(params.tagPropertyId);
  if (!propertyId && (!powerupCode || !slot)) throw new Error("setProperty requires propertyId or powerupCode + slot.");
  if (params.dryRun === true) return { dryRun: true, opId, id: rem._id, powerupCode, slot, propertyId };

  const target = await captureUndoTarget(rem);
  if (propertyId) {
    target.tagProperties = [{ propertyId, richText: await rem.getTagPropertyValue(propertyId) }];
    await rem.setTagPropertyValue(propertyId, params.value === undefined ? undefined : await toRichText(plugin, params.value as string | unknown[] | Record<string, unknown>));
  } else if (powerupCode && slot) {
    await rem.addPowerup(powerupCode);
    target.powerupProperties = [{ powerupCode, slot, richText: await rem.getPowerupPropertyAsRichText(powerupCode, slot) }];
    await rem.setPowerupProperty(powerupCode, slot, await toRichText(plugin, params.value as string | unknown[] | Record<string, unknown>));
  }
  return {
    opId,
    id: rem._id,
    undoRecord: { schemaVersion: 1, opId, action: "setProperty", createdAt: new Date().toISOString(), targets: [target] },
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

async function createFlashcard(
  plugin: ReactRNPlugin,
  params: Record<string, unknown>,
  options: { defaultMaterializeTimeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  const deckPath = str(params.deckPath) ?? str(params.deckName);
  if (params.dryRun === true) {
    return {
      dryRun: true,
      wouldCreate: "flashcard",
      deckPath: deckPath ?? "",
      front: params.front,
      back: params.back,
      tags: stringArray(params.tags),
      externalId: str(params.externalId),
      batchId: str(params.batchId),
    };
  }
  const parent = await ensurePath(plugin, deckPath, MANAGED_ROOT_NAME, { finalAsFolder: true });
  const existingRemId = str(params.existingRemId);
  const existing = existingRemId ? await plugin.rem.findOne(existingRemId) : undefined;
  const rem = existing ?? (await plugin.rem.createRem());
  if (!rem) throw new Error("RemNote did not return a Rem from createRem.");
  await rem.setParent(parent);
  await rem.setText(await toRichText(plugin, params.front as string | unknown[]));
  await rem.setBackText(await toRichText(plugin, params.back as string | unknown[]));
  await rem.setEnablePractice(true);
  await rem.setPracticeDirection((str(params.practiceDirection) as "forward" | "backward" | "none" | "both" | undefined) ?? "forward");
  await addTags(plugin, rem, stringArray(params.tags));
  await waitForCards(rem, Number(params.materializeTimeoutMs ?? options.defaultMaterializeTimeoutMs ?? 3500));
  if (params.verbose === true) return summarizeRem(plugin, rem);
  return { id: rem._id, externalId: str(params.externalId), batchId: str(params.batchId) };
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

type ProgressFn = (completed: number, total: number, message?: string) => void;

export async function executeAction(
  plugin: ReactRNPlugin,
  action: string,
  params: Record<string, unknown> = {},
  progress?: ProgressFn,
): Promise<unknown> {
  switch (action) {
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
      const folder = await ensurePath(plugin, path, MANAGED_ROOT_NAME, {
        finalAsFolder: params.asDocument !== true,
        finalAsDocument: params.asDocument === true,
      });
      return mutationReturn(plugin, folder, params);
    }
    case "renameRem": {
      const rem = await requireManagedRem(plugin, str(params.remId) ?? str(params.id), "Rem");
      await rem.setText(await toRichText(plugin, str(params.text) ?? str(params.newName) ?? ""));
      return mutationReturn(plugin, rem, params);
    }
    case "moveRem":
    case "changeDeck": {
      const targetPath = str(params.targetPath) ?? str(params.deck) ?? str(params.deckName);
      if (!targetPath) throw new Error(`${action} requires targetPath/deck.`);
      const target = await ensurePath(plugin, targetPath, MANAGED_ROOT_NAME, { finalAsFolder: true });
      const { rems } = await resolveTargets(plugin, params);
      if (params.dryRun === true || params.confirm !== true) {
        return {
          dryRun: true,
          count: rems.length,
          remIds: rems.map((rem) => rem._id),
          targetPath,
          warning: params.confirm === true ? undefined : `${action} defaults to dry-run. Pass confirm:true to move targets.`,
        };
      }
      for (const rem of rems) await rem.setParent(target);
      return { ...(await mutationListReturn(plugin, rems, params)), targetPath };
    }
    case "bulkMove":
      return bulkMoveRems(plugin, params);
    case "createFlashcard":
      return createFlashcard(plugin, params);
    case "createFlashcards":
      return createFlashcards(plugin, params, progress);
    case "updateFlashcard": {
      const rem = await requireManagedRem(plugin, str(params.remId) ?? str(params.noteId) ?? str(params.id), "Flashcard Rem");
      if (params.front !== undefined) await rem.setText(await toRichText(plugin, params.front as string | unknown[]));
      if (params.back !== undefined) await rem.setBackText(await toRichText(plugin, params.back as string | unknown[]));
      if (params.practiceDirection) await rem.setPracticeDirection(params.practiceDirection as "forward" | "backward" | "none" | "both");
      if (params.tags) await addTags(plugin, rem, stringArray(params.tags));
      return mutationReturn(plugin, rem, params);
    }
    case "getFlashcard": {
      const rem = await requireManagedRem(plugin, str(params.remId) ?? str(params.noteId) ?? str(params.id), "Flashcard Rem");
      return summarizeRem(plugin, rem);
    }
    case "searchFlashcards": {
      const rems = await findFlashcardRems(plugin, str(params.query));
      return params.verbose === true ? Promise.all(rems.map((rem) => summarizeRem(plugin, rem))) : compactRems(rems);
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
      return buildSnapshot(plugin, topLevel.length > 0 ? topLevel : rems);
    }
    case "backupSubtree":
    case "exportSubtree": {
      const targets = await resolveTargets(plugin, params);
      const rems = targets.rems.length > 0 ? targets.rems : [await getManagedRoot(plugin)];
      return buildSnapshot(plugin, rems);
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
      if (params.dryRun === true) return { dryRun: true, wouldImport: snapshot.nodes.length };
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
    case "mergeRems":
      return mergeRems(plugin, params);
    case "setProperty":
      return setRemProperty(plugin, params);
    case "getProperties":
      return getRemProperties(plugin, params);
    case "deleteFlashcards": {
      const { cards } = await resolveTargets(plugin, params);
      if (params.dryRun === true || params.confirm !== true) {
        return {
          dryRun: true,
          count: cards.length,
          cardIds: cards.map((card) => card._id),
          warning: params.confirm === true ? undefined : "deleteFlashcards defaults to dry-run. Pass confirm:true after daemon gating.",
        };
      }
      if (params.irreversibleVerified !== true) throw new Error("deleteFlashcards requires daemon irreversible verification.");
      for (const card of cards) await card.remove();
      return { count: cards.length, cardIds: cards.map((card) => card._id) };
    }
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
        const rem = await requireManagedRem(plugin, id, "Note Rem");
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
      const visible = tombstones.filter((info) => !isTrashMetadataChild(info));
      return { count: visible.length, tombstones: visible.map((info) => ({ id: info.rem._id, text: info.text, childCount: info.childCount })) };
    }
    case "restoreTombstone": {
      if (params.undoRecord) return executeAction(plugin, "undo", params, progress);
      const target = await requireAccessibleRem(plugin, str(params.remId) ?? str(params.id), "Tombstone");
      const parent = await ensurePath(plugin, str(params.parentPath), MANAGED_ROOT_NAME, { finalAsFolder: true });
      await target.setParent(parent);
      return { count: 1, remIds: [target._id] };
    }
    case "emptyTrash": {
      const opId = str(params.opId);
      const trash = await trashFolder(plugin);
      const trashChildren = await Promise.all((await trash.getChildrenRem()).map((rem) => trashChildInfo(plugin, rem)));
      const targets: RemObject[] = [];
      for (const info of trashChildren) {
        if (opId ? info.text === opId : !isTrashMetadataChild(info)) targets.push(info.rem);
      }
      const remIds = targets.map((rem) => rem._id);
      if (params.dryRun === true || params.confirm !== true) {
        return {
          dryRun: true,
          opId,
          count: targets.length,
          remIds,
          warning: "emptyTrash is irreversible. Execute only with daemon dry-run hash verification.",
        };
      }
      if (params.irreversibleVerified !== true) throw new Error("emptyTrash requires daemon irreversible verification.");
      for (const rem of targets) await rem.remove();
      return { opId, count: targets.length, remIds };
    }
    case "createDocument": {
      const markdown = str(params.markdown) ?? str(params.md) ?? "";
      const docSpec = asRecord(params.docSpec ?? params.document);
      const hasDocSpec = Object.keys(docSpec).length > 0;
      if (!markdown.trim() && !hasDocSpec) throw new Error("createDocument requires markdown/md or docSpec.");
      const parent = await ensurePath(plugin, str(params.parentPath) ?? str(params.parent), MANAGED_ROOT_NAME, { finalAsFolder: true });
      if (params.dryRun === true) {
        return {
          dryRun: true,
          parentId: parent._id,
          markdownBytes: markdown.length,
          docSpecNodes: hasDocSpec ? docSpecNodeCount(docSpec) : 0,
        };
      }
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
      if (!markdown.trim()) throw new Error("appendToDocument requires markdown/md.");
      const parent = await requireAccessibleRem(plugin, str(params.remId) ?? str(params.id), "Document");
      if (params.dryRun === true) return { dryRun: true, parentId: parent._id, markdownBytes: markdown.length };
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
      for (const rem of await allAccessibleRems(plugin)) {
        const text = (await richTextToString(plugin, rem.text)).trim().replace(/\s+/g, " ").toLowerCase();
        if (!text) continue;
        const existing = groups.get(text) ?? [];
        existing.push(rem);
        groups.set(text, existing);
      }
      const duplicates = [];
      for (const [text, rems] of groups.entries()) {
        if (rems.length > 1) duplicates.push({ text, count: rems.length, remIds: rems.map((rem) => rem._id) });
      }
      return { count: duplicates.length, groups: duplicates };
    }
    case "answerCard": {
      const card = await plugin.card.findOne(str(params.cardId));
      if (!card) throw new Error("Card not found.");
      await card.updateCardRepetitionStatus(Number(params.score ?? 1) as QueueInteractionScore);
      return summarizeCard(card);
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
      richText: ["text", "toString", "parseFromMarkdown", "toMarkdown", "latex", "image", "code", "rem"],
    },
    sdkLimitations: {
      nativeTrashRestore: "not found in @remnote/plugin-sdk@0.0.46 declarations",
      orderedUndo: "supported through setParent(parent, positionAmongstSiblings)",
      wholeKbScope: "supported through manifest All/ReadCreateModifyDelete and plugin.rem.getAll",
    },
    queryGrammar: ["deck:<path>", "tag:<tag>", "text:<text>", "id:<remId>"],
    operationalRoot: MANAGED_ROOT_NAME,
    safetyModel: "whole-kb with tombstone + daemon undo store",
  };
}
