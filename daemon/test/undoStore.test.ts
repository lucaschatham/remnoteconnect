import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUndoRecord, updateUndoRecordState, writeUndoRecord } from "../src/undoStore.js";

describe("undo store", () => {
  it("creates records exclusively with mode 0600 and records state transitions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "remnote-connect-undo-"));
    const record = {
      schemaVersion: 1 as const,
      opId: "exclusive-op",
      action: "deleteRem",
      createdAt: new Date().toISOString(),
      targets: [{ id: "rem-1", richText: "private content" }],
    };
    try {
      const written = await writeUndoRecord(dir, record);
      expect(statSync(written.path).mode & 0o777).toBe(0o600);
      await expect(writeUndoRecord(dir, record)).rejects.toMatchObject({ code: "EEXIST" });
      expect((await readUndoRecord(dir, record.opId)).state).toBe("prepared");
      await updateUndoRecordState(dir, record.opId, "committed");
      expect((await readUndoRecord(dir, record.opId)).state).toBe("committed");
      expect(readFileSync(written.path, "utf8")).toContain("private content");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
