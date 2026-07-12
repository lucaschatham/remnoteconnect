import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { pluginActions } from "@remnoteconnect/shared";
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
  it("syncs an Atlas batch in parent order, preserves personal children, and skips unchanged items", async () => {
    const graph = new FakeRemGraph();
    const hash = (letter: string) => `sha256:${letter.repeat(64)}`;
    const first = (await executeAction(graph.plugin, "syncAtlasBatch", {
      mode: "fast-local",
      batchId: "atlas-test-001",
      rootId: graph.root._id,
      namespace: "learning-atlas",
      sourceRevision: "test-v1",
      documents: [
        {
          externalId: "atlas:algebra",
          parentExternalId: "atlas:math",
          contentHash: hash("a"),
          markdown: "Algebra [Math]",
          links: [{ token: "[Math]", targetExternalId: "atlas:math" }],
        },
        { externalId: "atlas:math", contentHash: hash("b"), markdown: "Mathematics" },
      ],
      flashcards: [
        { externalId: "atlas:algebra:card:01", parentExternalId: "atlas:algebra", contentHash: hash("c"), front: "What is x?", back: "A variable." },
      ],
    })) as { created: number; indexEntries: Array<{ externalId: string; remId: string }>; unchanged: number };

    expect(first.created).toBe(3);
    const ids = new Map(first.indexEntries.map((entry) => [entry.externalId, entry.remId]));
    const math = graph.rems.get(ids.get("atlas:math")!);
    const algebra = graph.rems.get(ids.get("atlas:algebra")!);
    const card = graph.rems.get(ids.get("atlas:algebra:card:01")!);
    expect(algebra?.parent).toBe(math?._id);
    expect(card?.parent).toBe(algebra?._id);
    expect(String(algebra?.text)).toContain(`[[${math?._id}]]`);
    expect(card?.practiceEnabled).toBe(true);

    const personal = await graph.createChild(algebra!, "Personal proof note");
    const second = (await executeAction(graph.plugin, "syncAtlasBatch", {
      mode: "fast-local",
      batchId: "atlas-test-002",
      rootId: graph.root._id,
      namespace: "learning-atlas",
      sourceRevision: "test-v1",
      index: first.indexEntries,
      documents: [
        { externalId: "atlas:math", contentHash: hash("b"), markdown: "Mathematics" },
        { externalId: "atlas:algebra", parentExternalId: "atlas:math", contentHash: hash("d"), markdown: "Updated algebra" },
      ],
      flashcards: [
        { externalId: "atlas:algebra:card:01", parentExternalId: "atlas:algebra", contentHash: hash("c"), front: "What is x?", back: "A variable." },
      ],
    })) as { created: number; updated: number; unchanged: number };

    expect(second).toMatchObject({ created: 0, updated: 1, unchanged: 2 });
    expect(graph.rems.get(personal._id)?.parent).toBe(algebra?._id);
    expect(graph.rems.get(algebra!._id)?.powerupProperties.get("remnoteconnect-local-v3:atlasSync")).toContain("atlas:algebra");

    const reconciled = (await executeAction(graph.plugin, "syncAtlasBatch", {
      mode: "fast-local", batchId: "atlas-test-003", rootId: graph.root._id, namespace: "learning-atlas", sourceRevision: "test-v1", reconcile: true,
      documents: [
        { externalId: "atlas:math", contentHash: hash("b"), markdown: "Mathematics" },
        { externalId: "atlas:algebra", parentExternalId: "atlas:math", contentHash: hash("d"), markdown: "Updated algebra" },
      ],
      flashcards: [{ externalId: "atlas:algebra:card:01", parentExternalId: "atlas:algebra", contentHash: hash("c"), front: "What is x?", back: "A variable." }],
    })) as { created: number; updated: number; unchanged: number };
    expect(reconciled).toMatchObject({ created: 0, updated: 0, unchanged: 3 });
  });

  it("rejects an indexed Atlas Rem outside the configured root", async () => {
    const graph = new FakeRemGraph();
    const foreignRoot = graph.createTopLevel("Foreign Atlas");
    const hash = `sha256:${"f".repeat(64)}`;
    const foreign = (await executeAction(graph.plugin, "syncAtlasBatch", {
      mode: "fast-local", batchId: "foreign-1", rootId: foreignRoot._id, namespace: "learning-atlas", sourceRevision: "test",
      documents: [{ externalId: "atlas:foreign", contentHash: hash, markdown: "Foreign" }], flashcards: [],
    })) as { indexEntries: unknown[] };

    await expect(executeAction(graph.plugin, "syncAtlasBatch", {
      mode: "fast-local", batchId: "local-1", rootId: graph.root._id, namespace: "learning-atlas", sourceRevision: "test",
      index: foreign.indexEntries,
      documents: [{ externalId: "atlas:foreign", contentHash: hash, markdown: "Foreign" }], flashcards: [],
    })).rejects.toMatchObject({ code: "forbidden_target" });
  });

  it("keeps registry plugin actions in one-to-one parity with executor cases", () => {
    const source = readFileSync(new URL("../src/executor.ts", import.meta.url), "utf8");
    const cases = new Set([...source.matchAll(/case\s+"([^"]+)"/g)].map((match) => match[1]));
    expect(pluginActions.filter((action) => !cases.has(action))).toEqual([]);
  });

  it("keeps representative dry-run handlers mutation-free", async () => {
    const graph = new FakeRemGraph();
    const movable = await graph.createChild(graph.root, "Movable");
    const before = [...graph.rems.keys()];
    await executeAction(graph.plugin, "createFolder", { path: "Would Not Exist", dryRun: true });
    await executeAction(graph.plugin, "createDocument", { markdown: "- Preview", parentPath: "Would Not Exist", dryRun: true });
    await executeAction(graph.plugin, "moveRem", { id: movable._id, targetPath: "Would Not Exist", dryRun: true });
    await executeAction(graph.plugin, "capabilityProbes", { dryRun: true });
    await executeAction(graph.plugin, "ankiMigrationProbes", { dryRun: true });
    expect([...graph.rems.keys()]).toEqual(before);
    expect(movable.parent).toBe(graph.root._id);
  });

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
    const dryRun = (await executeAction(graph.plugin, "capabilityProbes", { runId: "__rnc_probe__unit" })) as {
      dryRun: boolean;
      probes: string[];
    };
    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.probes).toContain("image occlusion scriptability");

    const result = (await executeAction(graph.plugin, "capabilityProbes", {
      runId: "__rnc_probe__unit",
      confirm: true,
      materializeTimeoutMs: 0,
    })) as {
      runId: string;
      capabilities: Array<{ capability: string; status: string }>;
      cleanup: { opId: string; tombstoneParentId: string };
      undoRecord: unknown;
    };

    expect(result.runId).toBe("__rnc_probe__unit");
    expect(result.capabilities.map((row) => row.capability)).toEqual(
      expect.arrayContaining(["frontBackCard", "imageOcclusion", "orderedInsertion", "driftPrimitives"]),
    );
    expect(result.capabilities.find((row) => row.capability === "imageOcclusion")?.status).toBe("UNSUPPORTED");
    expect(result.cleanup.opId).toBe("__rnc_probe__unit-tombstone");
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

    await expect(executeAction(graph.plugin, "answerCard", { cardId: card.cards[0].id, score: 2 })).rejects.toMatchObject({
      code: "experimental_disabled",
    });
    await expect(executeAction(graph.plugin, "deleteFlashcards", { cardIds: [card.cards[0].id], confirm: true })).rejects.toMatchObject({
      code: "experimental_disabled",
    });
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
    const emptyDryRun = (await executeAction(graph.plugin, "emptyTrash", {})) as { dryRun: boolean; count: number; remIds: string[] };
    expect(emptyDryRun.dryRun).toBe(true);
    expect(emptyDryRun.count).toBeGreaterThan(1);
    expect(emptyDryRun.remIds).toEqual(expect.arrayContaining([createdDoc.id, docChildId]));
    const emptied = (await executeAction(graph.plugin, "emptyTrash", {
      confirm: true,
      irreversibleVerified: true,
      expectedTargetIds: emptyDryRun.remIds,
    })) as { count: number };
    expect(emptied.count).toBe(emptyDryRun.count);
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

  it("merges non-destructively by default and keeps structural merge disabled", async () => {
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

    await expect(
      executeAction(graph.plugin, "mergeRems", {
        keepId: keeper._id,
        mergeIds: [loser._id],
        structural: true,
        confirm: true,
      }),
    ).rejects.toMatchObject({ code: "experimental_disabled" });
    expect(child.parent).toBe(loser._id);
    expect(graph.richTextToString(ref.text)).toContain(graph.reference(loser._id));
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
    expect(graph.richTextToString(source.text)).toBe(`Read ${graph.reference(target._id)} today`);

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
    })) as { count: number; undoRecord: unknown };

    expect(rewritten).toMatchObject({ count: 1 });
    expect(rewritten.undoRecord).toBeTruthy();
    expect(graph.richTextToString(source.text)).toBe(`Read ${graph.reference(target._id)} today`);
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

  it("prepares undo before mutation and rejects changed prepared targets", async () => {
    const graph = new FakeRemGraph();
    const target = await graph.createChild(graph.root, "Prepared target");
    const prepared = (await executeAction(graph.plugin, "prepareMutation", {
      action: "deleteRem",
      opId: "prepared-op",
      params: { id: target._id },
    })) as { targetIds: string[]; fingerprints: unknown[]; undoRecord: { targets: unknown[] } };

    expect(prepared.targetIds).toEqual([target._id]);
    expect(prepared.undoRecord.targets).toHaveLength(1);
    expect(target.parent).toBe(graph.root._id);

    await expect(
      executeAction(graph.plugin, "deleteRem", {
        id: target._id,
        confirm: true,
        opId: "prepared-op",
        undoPrepared: true,
        expectedTargetIds: ["different-id"],
      }),
    ).rejects.toMatchObject({ code: "dry_run_mismatch" });
    expect(target.parent).toBe(graph.root._id);

    target.updatedAt += 100;
    await expect(
      executeAction(graph.plugin, "deleteRem", {
        id: target._id,
        confirm: true,
        opId: "prepared-op",
        undoPrepared: true,
        expectedTargetIds: prepared.targetIds,
        expectedFingerprints: prepared.fingerprints,
      }),
    ).rejects.toMatchObject({ code: "dry_run_mismatch" });
  });

  it("normalizes text leaves without flattening rich-text nodes", async () => {
    const graph = new FakeRemGraph();
    const target = await graph.createChild(graph.root, "");
    const referenceNode = { i: "q", _id: "referenced-rem" };
    const unsupportedNode = { type: "cloze", text: "  preserve   this  " };
    target.text = [{ i: "m", text: "  Bold   words  ", b: true }, referenceNode, unsupportedNode];

    const preview = (await executeAction(graph.plugin, "normalizeText", { id: target._id })) as {
      remIds: string[];
      changes: Array<{ beforeHash: string; afterHash: string; skipReasons: string[] }>;
    };
    expect(preview.changes[0].beforeHash).not.toBe(preview.changes[0].afterHash);
    expect(preview.changes[0].skipReasons).toEqual(["unsupported_text_node:cloze"]);
    await executeAction(graph.plugin, "normalizeText", {
      id: target._id,
      confirm: true,
      expectedTargetIds: preview.remIds,
      opId: "normalize-rich",
    });

    expect(target.text).toEqual([{ i: "m", text: "Bold words ", b: true }, referenceNode, unsupportedNode]);
  });

  it("restores snapshot tag associations when the tag still exists", async () => {
    const graph = new FakeRemGraph();
    const tag = graph.createTopLevel("Snapshot Tag");
    const source = await graph.createChild(graph.root, "Tagged source");
    await source.addTag(tag);
    const snapshot = (await executeAction(graph.plugin, "exportSubtree", { id: source._id })) as {
      nodes: Array<Record<string, unknown>>;
    };
    snapshot.nodes[0].powerupProperties = [{ powerupCode: "test-powerup", slot: "status", richText: "restored powerup" }];
    snapshot.nodes[0].tagProperties = [{ propertyId: "property-1", richText: "restored tag property" }];
    const restored = (await executeAction(graph.plugin, "importSnapshot", { snapshot, parentPath: "Restored tags" })) as { remIds: string[] };
    const copy = graph.rems.get(restored.remIds[0]);
    expect((await copy?.getTagRems())?.map((item) => item._id)).toContain(tag._id);
    expect(copy?.powerupProperties.get("test-powerup:status")).toBe("restored powerup");
    expect(copy?.tagProperties.get("property-1")).toBe("restored tag property");
  });

  it("rejects emptyTrash execution when descendants changed after preview", async () => {
    const graph = new FakeRemGraph();
    const target = await graph.createChild(graph.root, "Disposable");
    await executeAction(graph.plugin, "deleteRem", { id: target._id, confirm: true, opId: "trash-race" });
    const preview = (await executeAction(graph.plugin, "emptyTrash", { tombstoneOpId: "trash-race" })) as { remIds: string[] };
    await graph.createChild(target, "Late descendant");

    await expect(
      executeAction(graph.plugin, "emptyTrash", {
        tombstoneOpId: "trash-race",
        confirm: true,
        irreversibleVerified: true,
        expectedTargetIds: preview.remIds,
      }),
    ).rejects.toMatchObject({ code: "dry_run_mismatch" });
    expect(graph.rems.has(target._id)).toBe(true);
  });

  it("requires force before hard-deleting a tombstone with inbound references", async () => {
    const graph = new FakeRemGraph();
    const target = await graph.createChild(graph.root, "Referenced disposable");
    await graph.createChild(graph.root, `See ${graph.reference(target._id)}`);
    await executeAction(graph.plugin, "deleteRem", { id: target._id, confirm: true, opId: "trash-ref" });
    const preview = (await executeAction(graph.plugin, "emptyTrash", { tombstoneOpId: "trash-ref" })) as {
      remIds: string[];
      inboundReferenceIds: string[];
    };
    expect(preview.inboundReferenceIds).toHaveLength(1);
    await expect(
      executeAction(graph.plugin, "emptyTrash", {
        tombstoneOpId: "trash-ref",
        confirm: true,
        irreversibleVerified: true,
        expectedTargetIds: preview.remIds,
      }),
    ).rejects.toMatchObject({ code: "forbidden_target" });
    await executeAction(graph.plugin, "emptyTrash", {
      tombstoneOpId: "trash-ref",
      confirm: true,
      irreversibleVerified: true,
      expectedTargetIds: preview.remIds,
      force: true,
    });
    expect(graph.rems.has(target._id)).toBe(false);
  });
});
