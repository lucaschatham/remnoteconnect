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

    const deleted = (await executeAction(graph.plugin, "deleteRem", { id: createdDoc.id, confirm: true, opId: "op-doc" })) as { opId: string };
    expect(deleted.opId).toBe("op-doc");
    const tombstones = (await executeAction(graph.plugin, "listTombstones", {})) as { count: number };
    expect(tombstones.count).toBe(1);
    const emptyDryRun = (await executeAction(graph.plugin, "emptyTrash", {})) as { dryRun: boolean; count: number };
    expect(emptyDryRun.dryRun).toBe(true);
    expect(emptyDryRun.count).toBe(1);
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
});
