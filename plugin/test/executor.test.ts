import { describe, expect, it, vi } from "vitest";
import { ankiNoteToFlashcard, executeAction } from "../src/executor.js";
import { FakeRemGraph } from "./fakeRemGraph.js";

async function createCard(graph: FakeRemGraph, front = "front", deckPath = "Deck", verbose = false): Promise<Record<string, unknown>> {
  return (await executeAction(graph.plugin, "createFlashcard", {
    deckPath,
    front,
    back: `${front} back`,
    tags: ["tag-a"],
    materializeTimeoutMs: 0,
    verbose,
  })) as Record<string, unknown>;
}

describe("plugin executor", () => {
  it("stores a rotated daemon token without returning it", async () => {
    const graph = new FakeRemGraph();
    const result = (await executeAction(graph.plugin, "setDaemonToken", { token: "replacement-token-value" })) as { stored: boolean; token?: string };

    expect(result).toEqual({ stored: true });
    expect(result.token).toBeUndefined();
    expect(graph.settings.get("daemonToken")).toBe("replacement-token-value");
  });

  it("creates flashcards compactly by default and returns summaries when verbose", async () => {
    const graph = new FakeRemGraph();
    const compact = (await createCard(graph, "Question", "Alpha::Beta")) as { id: string; text?: string };
    expect(compact.id).toMatch(/^rem-/);
    expect(compact.text).toBeUndefined();

    const summary = (await executeAction(graph.plugin, "getFlashcard", { id: compact.id })) as {
      id: string;
      text: string;
      backText: string;
      path: string;
      cards: unknown[];
      tags: Array<{ text: string }>;
    };
    expect(summary.text).toBe("Question");
    expect(summary.backText).toBe("Question back");
    expect(summary.path).toBe("Alpha::Beta::Question");
    expect(summary.cards).toHaveLength(1);
    expect(summary.tags.map((tag) => tag.text)).toContain("tag-a");
  });

  it("runs capability probes with explicit unsupported rows and tombstone cleanup metadata", async () => {
    const graph = new FakeRemGraph();
    const dryRun = (await executeAction(graph.plugin, "capabilityProbes", { runId: "__codex_probe__unit" })) as {
      dryRun: boolean;
      probes: string[];
    };
    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.probes).toContain("image occlusion scriptability");

    const result = (await executeAction(graph.plugin, "capabilityProbes", {
      runId: "__codex_probe__unit",
      confirm: true,
      materializeTimeoutMs: 0,
    })) as {
      runId: string;
      capabilities: Array<{ capability: string; status: string }>;
      cleanup: { opId: string; tombstoneParentId: string };
      undoRecord: unknown;
    };

    expect(result.runId).toBe("__codex_probe__unit");
    expect(result.capabilities.map((row) => row.capability)).toEqual(
      expect.arrayContaining(["frontBackCard", "imageOcclusion", "orderedInsertion", "driftPrimitives"]),
    );
    expect(result.capabilities.find((row) => row.capability === "imageOcclusion")?.status).toBe("UNSUPPORTED");
    expect(result.cleanup.opId).toBe("__codex_probe__unit-tombstone");
    const tombstones = (await executeAction(graph.plugin, "listTombstones", {})) as { count: number };
    expect(tombstones.count).toBe(1);
  });

  it("bulk create is compact by default but can return verbose materialization data", async () => {
    const graph = new FakeRemGraph();
    graph.cardMaterializeAfterReads = 10;
    const progress = vi.fn();
    const fast = (await executeAction(
      graph.plugin,
      "createFlashcards",
      { cards: [{ front: "A", back: "B" }], throttleMs: 0 },
      progress,
    )) as { count: number; ids: string[] };
    expect(fast.count).toBe(1);
    expect(fast.ids).toHaveLength(1);
    expect(progress).toHaveBeenCalledWith(1, 1, "Created 1/1");

    const waitingGraph = new FakeRemGraph();
    waitingGraph.cardMaterializeAfterReads = 1;
    const waited = (await executeAction(waitingGraph.plugin, "createFlashcards", {
      cards: [{ front: "C", back: "D" }],
      waitForCards: true,
      throttleMs: 0,
      verbose: true,
    })) as { created: Array<{ cards: unknown[] }> };
    expect(waited.created[0].cards).toHaveLength(1);
  });

  it("can replace imported child fields on idempotent flashcard updates", async () => {
    const graph = new FakeRemGraph();
    const first = (await executeAction(graph.plugin, "createFlashcard", {
      deckPath: "Anki Import::Deck",
      front: "Question",
      back: "Answer",
      extraFields: [{ name: "Extra", value: "old" }],
      materializeTimeoutMs: 0,
    })) as { id: string };
    const rem = graph.rems.get(first.id);
    expect((await rem?.getChildrenRem())?.map((child) => child.backText)).toEqual(["old"]);

    await executeAction(graph.plugin, "createFlashcard", {
      existingRemId: first.id,
      deckPath: "Anki Import::Deck",
      front: "Question",
      back: "Answer",
      extraFields: [{ name: "Extra", value: "new" }],
      replaceChildrenOnUpdate: true,
      materializeTimeoutMs: 0,
    });

    const children = await rem?.getChildrenRem();
    expect(children?.map((child) => child.backText)).toEqual(["new"]);
  });

  it("searches the whole graph by deck, tag, text, id, and AND-composed terms", async () => {
    const graph = new FakeRemGraph();
    const alpha = await createCard(graph, "Alpha prompt", "Deck A");
    const outside = graph.createTopLevel("Outside whole graph");

    expect((await executeAction(graph.plugin, "searchRem", { query: "deck:\"Deck A\"" })) as { count: number }).toMatchObject({ count: 2 });
    expect((await executeAction(graph.plugin, "searchFlashcards", { query: "tag:tag-a text:\"Alpha\"" })) as { count: number }).toMatchObject({
      count: 1,
    });
    expect((await executeAction(graph.plugin, "searchFlashcards", { query: `id:${alpha.id}` })) as { count: number }).toMatchObject({ count: 1 });
    expect((await executeAction(graph.plugin, "findByTag", { tag: "tag-a" })) as { count: number }).toMatchObject({ count: 1 });
    expect((await executeAction(graph.plugin, "searchGraph", { query: `id:${outside._id}` })) as { count: number }).toMatchObject({ count: 1 });
  });

  it("soft-deletes by tombstone and undo restores parent, sibling index, text, and tags", async () => {
    const graph = new FakeRemGraph();
    const parent = await graph.createChild(graph.root, "Parent");
    const before = await graph.createChild(parent, "Before");
    const target = await graph.createChild(parent, "Target");
    const after = await graph.createChild(parent, "After");
    const tag = await graph.createChild(graph.root, "Tag");
    await target.addTag(tag);
    await target.setBackText("back");

    const dryRun = (await executeAction(graph.plugin, "deleteRem", { id: target._id })) as { dryRun: boolean; remIds: string[] };
    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.remIds).toEqual([target._id]);

    const deleted = (await executeAction(graph.plugin, "deleteRem", {
      id: target._id,
      confirm: true,
      opId: "op-test",
    })) as { opId: string; undoRecord: unknown; tombstoneParentId: string };
    expect(deleted.opId).toBe("op-test");
    expect(target.parent).toBe(deleted.tombstoneParentId);

    await target.setText("Changed while deleted");
    const undo = (await executeAction(graph.plugin, "undo", { undoRecord: deleted.undoRecord })) as { restored: string[] };
    expect(undo.restored).toEqual([target._id]);
    expect((await parent.getChildrenRem()).map((rem) => rem._id)).toEqual([before._id, target._id, after._id]);
    expect(target.text).toBe("Target");
    expect(target.backText).toBe("back");
    expect((await target.getTagRems()).map((rem) => rem._id)).toEqual([tag._id]);
  });

  it("allows graph-capable mutation targets outside the operational root", async () => {
    const graph = new FakeRemGraph();
    const outside = graph.createTopLevel("Outside");

    const renamed = (await executeAction(graph.plugin, "renameRem", { id: outside._id, text: "Renamed", verbose: true })) as { text: string };
    expect(renamed.text).toBe("Renamed");

    const moved = (await executeAction(graph.plugin, "moveRem", {
      id: outside._id,
      targetPath: "Safe",
      confirm: true,
    })) as { remIds: string[] };
    expect(moved.remIds).toEqual([outside._id]);
    expect(outside.parent).not.toBeNull();
  });

  it("moves, updates, audits, lists decks, validates snapshots, restores copies, and answers cards", async () => {
    const graph = new FakeRemGraph();
    const card = (await createCard(graph, "Original", "Source", true)) as { id: string; cards: Array<{ id: string }> };

    const moved = (await executeAction(graph.plugin, "moveRem", {
      id: card.id,
      targetPath: "Target",
      confirm: true,
    })) as { remIds: string[]; targetPath: string };
    expect(moved.remIds).toEqual([card.id]);
    expect(moved.targetPath).toBe("Target");

    const updated = (await executeAction(graph.plugin, "updateFlashcard", {
      id: card.id,
      front: "Updated",
      back: "Updated back",
      tags: ["tag-b"],
      verbose: true,
    })) as { text: string; backText: string; tags: Array<{ text: string }> };
    expect(updated.text).toBe("Updated");
    expect(updated.backText).toBe("Updated back");
    expect(updated.tags.map((tag) => tag.text)).toContain("tag-b");

    const audit = (await executeAction(graph.plugin, "auditManagedRoot")) as { remCount: number; flashcardRems: number };
    expect(audit.remCount).toBeGreaterThan(1);
    expect(audit.flashcardRems).toBe(1);

    const deckNames = (await executeAction(graph.plugin, "deckNames")) as string[];
    expect(deckNames).toContain("Target");

    const snapshot = await executeAction(graph.plugin, "exportSubtree", { id: card.id });
    const validation = (await executeAction(graph.plugin, "validateSnapshot", { snapshot })) as { valid: boolean; nodeCount: number };
    expect(validation.valid).toBe(true);
    expect(validation.nodeCount).toBe(1);

    const restored = (await executeAction(graph.plugin, "importSnapshot", { snapshot, parentPath: "Restored" })) as { count: number; remIds: string[] };
    expect(restored.count).toBe(1);
    expect(restored.remIds[0]).not.toBe(card.id);

    const answer = (await executeAction(graph.plugin, "answerCard", { cardId: card.cards[0].id, score: 2 })) as { id: string };
    expect(answer.id).toBe(card.cards[0].id);
  });

  it("emits progress while building graph backups", async () => {
    const graph = new FakeRemGraph();
    await graph.createChild(graph.root, "Backup child");
    const progress = vi.fn();

    const snapshot = (await executeAction(graph.plugin, "backupGraph", {}, progress)) as { nodeCount: number };

    expect(snapshot.nodeCount).toBe(2);
    expect(progress).toHaveBeenCalledWith(0, 2, "Preparing graph backup for 2 Rem");
    expect(progress).toHaveBeenCalledWith(1, 2, "Snapshotted 1/2 Rem");
    expect(progress).toHaveBeenCalledWith(2, 2, "Snapshotted 2/2 Rem");
  });

  it("maps Anki-style notes and relies on daemon-injected existingRemId for idempotency", async () => {
    expect(
      ankiNoteToFlashcard({
        deckName: "Deck",
        fields: { Question: { value: "Q" }, Answer: "A" },
        tags: ["x"],
        externalId: "ext-1",
      }),
    ).toMatchObject({ front: "Q", back: "A", deckPath: "Deck", tags: ["x"], externalId: "ext-1" });

    expect(ankiNoteToFlashcard({ fields: { One: "first", Two: "second" } })).toMatchObject({ front: "first", back: "second" });

    const graph = new FakeRemGraph();
    const first = (await executeAction(graph.plugin, "addNote", {
      note: { deckName: "Deck", fields: { Front: "First", Back: "Back" }, externalId: "stable" },
    })) as { id: string; text?: string };
    const second = (await executeAction(graph.plugin, "addNote", {
      note: { deckName: "Deck", fields: { Front: "Second", Back: "Back 2" }, externalId: "stable" },
      existingRemId: first.id,
      verbose: true,
    })) as { id: string; text: string };

    expect(second.id).toBe(first.id);
    expect(second.text).toBe("Second");
    expect((await executeAction(graph.plugin, "searchFlashcards", { query: "tag:rnc:externalId:stable" })) as { count: number }).toMatchObject({
      count: 0,
    });
  });

  it("builds compact rich text specs and reads/writes undoable properties", async () => {
    const graph = new FakeRemGraph();
    const referenced = graph.createTopLevel("Referenced Rem");
    const created = (await executeAction(graph.plugin, "createFlashcard", {
      deckPath: "Rich",
      front: {
        segments: [
          { type: "text", text: "Important ", formats: ["bold"] },
          { type: "rem", id: referenced._id },
          { type: "latex", text: "x^2" },
          { type: "image", url: "https://example.test/image.png" },
          { type: "code", language: "ts", text: "const x = 1;" },
        ],
      },
      back: "Back",
      materializeTimeoutMs: 0,
    })) as { id: string };

    const read = (await executeAction(graph.plugin, "getFlashcard", { id: created.id })) as { text: string };
    expect(read.text).toContain("[bold]Important");
    expect(read.text).toContain(graph.reference(referenced._id));
    expect(read.text).toContain("$x^2$");
    expect(read.text).toContain("![image](https://example.test/image.png)");
    expect(read.text).toContain("const x = 1;");

    await executeAction(graph.plugin, "setProperty", {
      id: created.id,
      powerupCode: "test-powerup",
      slot: "Title",
      value: "Initial",
      opId: "op-property-initial",
    });
    const changed = (await executeAction(graph.plugin, "setProperty", {
      id: created.id,
      powerupCode: "test-powerup",
      slot: "Title",
      value: "Changed",
      opId: "op-property-change",
    })) as { undoRecord: unknown };
    expect(
      (await executeAction(graph.plugin, "getProperties", {
        id: created.id,
        properties: [{ powerupCode: "test-powerup", slot: "Title" }],
      })) as { properties: Array<{ value: string }> },
    ).toMatchObject({ properties: [{ value: "Changed" }] });

    await executeAction(graph.plugin, "undo", { undoRecord: changed.undoRecord });
    expect(
      (await executeAction(graph.plugin, "getProperties", {
        id: created.id,
        powerupCode: "test-powerup",
        slot: "Title",
      })) as { properties: Array<{ value: string }> },
    ).toMatchObject({ properties: [{ value: "Initial" }] });
  });

  it("creates structured docSpec trees with rich text, tags, properties, and portal includes", async () => {
    const graph = new FakeRemGraph();
    const included = graph.createTopLevel("Portal target");
    const created = (await executeAction(graph.plugin, "createDocument", {
      parentPath: "Specs",
      docSpec: {
        richText: { segments: [{ type: "text", text: "Spec Root", formats: ["bold"] }] },
        backText: { markdown: "**Back** text" },
        tags: ["spec-tag"],
        document: true,
        properties: [{ powerupCode: "spec-powerup", slot: "Summary", value: "Property value" }],
        portalRemIds: [included._id],
        children: [
          { text: "Child A", folder: true },
          { richText: { table: [["Metric", "Value"], ["Count", "2"]] } },
        ],
      },
    })) as { id: string; count: number; remIds: string[] };

    expect(created.count).toBe(3);
    const root = graph.rems.get(created.id);
    expect(root?.text).toContain("[bold]Spec Root");
    expect(root?.backText).toContain("**Back** text");
    expect(root?.document).toBe(true);
    expect(included.portalIds).toContain(created.id);
    expect((await root?.getTagRems())?.map((tag) => tag.text)).toEqual(["spec-tag"]);
    expect(root?.powerupProperties.get("spec-powerup:Summary")).toBe("Property value");

    const children = await root?.getChildrenRem();
    expect(children?.map((child) => child.text)).toEqual(["Child A", "| Metric | Value |\n| --- | --- |\n| Count | 2 |"]);
    expect(children?.[0].folder).toBe(true);

    const updated = (await executeAction(graph.plugin, "createDocument", {
      parentPath: "Specs",
      existingRemId: created.id,
      docSpec: { text: "Spec Root Updated", children: [{ text: "Skipped child" }] },
    })) as { id: string; updatedExisting: boolean; childrenSkipped: boolean };
    expect(updated).toMatchObject({ id: created.id, updatedExisting: true, childrenSkipped: true });
    expect(root?.text).toBe("Spec Root Updated");
    expect((await root?.getChildrenRem())?.map((child) => child.text)).toEqual(["Child A", "| Metric | Value |\n| --- | --- |\n| Count | 2 |"]);

    const appended = (await executeAction(graph.plugin, "appendToDocument", {
      id: created.id,
      docSpec: {
        children: [
          { text: "Recovered Content", children: [{ text: "Recovered child" }] },
          { text: "Second recovered child" },
        ],
      },
    })) as { count: number; remIds: string[] };
    expect(appended.count).toBe(3);
    expect((await root?.getChildrenRem())?.map((child) => child.text)).toEqual([
      "Child A",
      "| Metric | Value |\n| --- | --- |\n| Count | 2 |",
      "Recovered Content",
      "Second recovered child",
    ]);
  });

  it("supports map, markdown documents, tombstone listing, emptyTrash dry-run, and duplicate discovery", async () => {
    const graph = new FakeRemGraph();
    const createdDoc = (await executeAction(graph.plugin, "createDocument", { markdown: "- Doc\n  - Child", parentPath: "Docs" })) as {
      id: string;
    };
    const map = (await executeAction(graph.plugin, "map", { depth: 3 })) as { tsv: string };
    expect(map.tsv).toContain("Doc");
    expect(map.tsv).toContain("Child");

    const markdown = (await executeAction(graph.plugin, "getDocument", { id: createdDoc.id })) as { markdown: string };
    expect(markdown.markdown).toContain("Doc");

    const updatedDoc = (await executeAction(graph.plugin, "createDocument", {
      markdown: "- Updated Doc",
      parentPath: "Docs",
      existingRemId: createdDoc.id,
    })) as { id: string; updatedExisting: boolean };
    expect(updatedDoc).toMatchObject({ id: createdDoc.id, updatedExisting: true });
    expect(((await executeAction(graph.plugin, "getRem", { id: createdDoc.id })) as { text: string }).text).toBe("Updated Doc");

    await graph.createChild(graph.root, "Duplicate");
    await graph.createTopLevel("Duplicate");
    const duplicates = (await executeAction(graph.plugin, "findDuplicates", {})) as { count: number };
    expect(duplicates.count).toBeGreaterThan(0);

    const docChildId = (await graph.rems.get(createdDoc.id)?.getChildrenRem())?.[0]?._id;
    const deleted = (await executeAction(graph.plugin, "deleteRem", { id: createdDoc.id, confirm: true, opId: "op-doc" })) as { opId: string };
    expect(deleted.opId).toBe("op-doc");
    const tombstones = (await executeAction(graph.plugin, "listTombstones", {})) as { count: number };
    expect(tombstones.count).toBe(1);
    const emptyDryRun = (await executeAction(graph.plugin, "emptyTrash", {})) as { dryRun: boolean; count: number };
    expect(emptyDryRun.dryRun).toBe(true);
    expect(emptyDryRun.count).toBe(1);
    const emptied = (await executeAction(graph.plugin, "emptyTrash", { confirm: true, irreversibleVerified: true })) as { count: number };
    expect(emptied.count).toBe(1);
    expect((await executeAction(graph.plugin, "listTombstones", {})) as { count: number }).toMatchObject({ count: 0 });
    expect(graph.rems.has(createdDoc.id)).toBe(false);
    if (docChildId) expect(graph.rems.has(docChildId)).toBe(false);
  });

  it("ignores RemNote-generated reference-only trash metadata", async () => {
    const graph = new FakeRemGraph();
    const trash = await graph.createChild(graph.root, "Trash");
    await graph.createChild(trash, "[[W7W0owfbKSKfoP9cf]]");
    const emptyTombstoneContainer = await graph.createChild(trash, "3bb609ab-44b4-4491-b0ce-716558a4e796");
    await graph.createChild(emptyTombstoneContainer, "[[W7W0owfbKSKfoP9cf]]");
    await graph.createChild(emptyTombstoneContainer, "[[3PxmHFDpEohbWoMkS]]");
    await graph.createChild(emptyTombstoneContainer, "[[FQM0VPOFpT74PC02Q]]");

    const tombstones = (await executeAction(graph.plugin, "listTombstones", {})) as { count: number };
    expect(tombstones.count).toBe(0);

    const emptyDryRun = (await executeAction(graph.plugin, "emptyTrash", {})) as { dryRun: boolean; count: number };
    expect(emptyDryRun.dryRun).toBe(true);
    expect(emptyDryRun.count).toBe(0);
  });

  it("supports cleanup actions with dry-run defaults and undo records", async () => {
    const graph = new FakeRemGraph();
    const messy = await graph.createChild(graph.root, "  Messy   text  ");
    await messy.setBackText("  Back   text ");
    const target = await graph.createChild(graph.root, "Cleanup target");
    const tag = await graph.createChild(graph.root, "old-tag");
    await target.addTag(tag);

    const empty = graph.createTopLevel("");
    const orphan = graph.createTopLevel("Orphan");
    orphan.parent = "missing-parent";

    const emptyResult = (await executeAction(graph.plugin, "findEmpty", {})) as { remIds: string[] };
    expect(emptyResult.remIds).toContain(empty._id);
    const orphanResult = (await executeAction(graph.plugin, "findOrphans", {})) as { remIds: string[] };
    expect(orphanResult.remIds).toContain(orphan._id);

    const normalizeDry = (await executeAction(graph.plugin, "normalizeText", { query: "text:Messy", includeBackText: true })) as {
      dryRun: boolean;
      remIds: string[];
    };
    expect(normalizeDry.dryRun).toBe(true);
    expect(normalizeDry.remIds).toEqual([messy._id]);
    const normalized = (await executeAction(graph.plugin, "normalizeText", {
      query: "text:Messy",
      includeBackText: true,
      confirm: true,
      opId: "op-normalize",
    })) as { undoRecord: unknown };
    expect(messy.text).toBe("Messy text");
    expect(messy.backText).toBe("Back text");

    const retagged = (await executeAction(graph.plugin, "bulkRetag", {
      id: target._id,
      tags: ["new-tag"],
      removeTags: ["old-tag"],
      confirm: true,
      opId: "op-retag",
    })) as { undoRecord: unknown };
    expect((await target.getTagRems()).map((rem) => rem.text)).toEqual(["new-tag"]);

    const moved = (await executeAction(graph.plugin, "bulkMove", {
      id: target._id,
      targetPath: "Moved",
      confirm: true,
      opId: "op-move",
    })) as { undoRecord: unknown };
    expect(target.parent).not.toBe(graph.root._id);

    await executeAction(graph.plugin, "undo", { undoRecord: moved.undoRecord });
    expect(target.parent).toBe(graph.root._id);
    await executeAction(graph.plugin, "undo", { undoRecord: retagged.undoRecord });
    expect((await target.getTagRems()).map((rem) => rem.text)).toEqual(["old-tag"]);
    await executeAction(graph.plugin, "undo", { undoRecord: normalized.undoRecord });
    expect(messy.text).toBe("  Messy   text  ");
    expect(messy.backText).toBe("  Back   text ");
  });

  it("merges non-destructively by default and structurally with inverse-reference undo", async () => {
    const graph = new FakeRemGraph();
    const keeper = await graph.createChild(graph.root, "Keeper");
    const loser = await graph.createChild(graph.root, "Loser");
    const child = await graph.createChild(loser, "Loser child");
    const ref = await graph.createChild(graph.root, `See ${graph.reference(loser._id)}`);

    const dryRun = (await executeAction(graph.plugin, "mergeRems", { keepId: keeper._id, mergeIds: [loser._id] })) as {
      dryRun: boolean;
      referenceCount: number;
      childCount: number;
    };
    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.referenceCount).toBe(1);
    expect(dryRun.childCount).toBe(1);

    const nonStructural = (await executeAction(graph.plugin, "mergeRems", {
      keepId: keeper._id,
      mergeIds: [loser._id],
      confirm: true,
      opId: "op-merge-soft",
    })) as { undoRecord: unknown };
    expect(loser.parent).not.toBe(graph.root._id);
    await executeAction(graph.plugin, "undo", { undoRecord: nonStructural.undoRecord });
    expect(loser.parent).toBe(graph.root._id);

    const structural = (await executeAction(graph.plugin, "mergeRems", {
      keepId: keeper._id,
      mergeIds: [loser._id],
      structural: true,
      irreversibleVerified: true,
      confirm: true,
      opId: "op-merge-structural",
    })) as {
      undoRecord: { mergeInverseReferences: unknown[] };
      movedChildIds: string[];
      referenceRemIds: string[];
    };
    expect(child.parent).toBe(keeper._id);
    expect(ref.text).toContain(graph.reference(keeper._id));
    expect(ref.text).not.toContain(graph.reference(loser._id));
    expect(loser.parent).not.toBe(graph.root._id);
    expect(structural.movedChildIds).toEqual([child._id]);
    expect(structural.referenceRemIds).toEqual([ref._id]);
    expect(structural.undoRecord.mergeInverseReferences).toHaveLength(1);

    await executeAction(graph.plugin, "undo", { undoRecord: structural.undoRecord });
    expect(loser.parent).toBe(graph.root._id);
    expect(child.parent).toBe(loser._id);
    expect(ref.text).toContain(graph.reference(loser._id));
    expect(ref.text).not.toContain(graph.reference(keeper._id));
  });

  it("rewrites verified raw links into native Rem references with undo", async () => {
    const graph = new FakeRemGraph();
    const target = await graph.createChild(graph.root, "Target Concept");
    const source = await graph.createChild(graph.root, "Read Target Concept today");

    const candidate = {
      sourceNodeId: source._id,
      targetRemId: target._id,
      raw: "Target Concept",
      sourcePath: "Source.md",
      targetPath: "Target Concept.md",
      line: 1,
    };
    const dryRun = (await executeAction(graph.plugin, "rewriteNativeLinks", { candidates: [candidate] })) as {
      dryRun: boolean;
      count: number;
      remIds: string[];
      blockedCount: number;
    };
    expect(dryRun).toMatchObject({ dryRun: true, count: 1, remIds: [source._id], blockedCount: 0 });

    const rewritten = (await executeAction(graph.plugin, "rewriteNativeLinks", {
      candidates: [candidate],
      confirm: true,
      opId: "op-links",
    })) as { count: number; undoRecord: unknown };
    expect(rewritten.count).toBe(1);
    expect(source.text).toBe(`Read ${graph.reference(target._id)} today`);

    await executeAction(graph.plugin, "undo", { undoRecord: rewritten.undoRecord });
    expect(source.text).toBe("Read Target Concept today");
  });

  it("rewrites raw links directly inside structured rich-text nodes", async () => {
    const graph = new FakeRemGraph();
    const target = await graph.createChild(graph.root, "Target Concept");
    const source = await graph.createChild(graph.root, "");
    (source as unknown as { text: unknown }).text = [{ text: "Read Target Concept today" }];

    const rewritten = (await executeAction(graph.plugin, "rewriteNativeLinks", {
      candidates: [{ sourceNodeId: source._id, targetRemId: target._id, raw: "Target Concept" }],
      confirm: true,
      skipUndoRecord: true,
    })) as { count: number; undoSkipped: boolean };

    expect(rewritten).toMatchObject({ count: 1, undoSkipped: true });
    expect(source.text).toBe(`Read ${graph.reference(target._id)} today`);
    expect(graph.replaceAllRichTextCalls).toBe(0);
  });

  it("blocks native link rewrites unless the current raw occurrence is unique", async () => {
    const graph = new FakeRemGraph();
    const target = await graph.createChild(graph.root, "Target");
    const source = await graph.createChild(graph.root, "Target and Target");

    const dryRun = (await executeAction(graph.plugin, "rewriteNativeLinks", {
      candidates: [{ sourceNodeId: source._id, targetRemId: target._id, raw: "Target" }],
    })) as { count: number; blockedCount: number; blocked: Array<{ reason: string }> };

    expect(dryRun.count).toBe(0);
    expect(dryRun.blockedCount).toBe(1);
    expect(dryRun.blocked[0].reason).toBe("raw-link-not-single-occurrence-in-current-rem");
  });
});
