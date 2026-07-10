import { describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJobSnapshot, compactDurableJobs, createDurableJob, jobStorePath, readDurableJob } from "../src/jobStore.js";

describe("job store", () => {
  it("omits repeated large params from progress snapshots and compacts finished jobs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "remnote-connect-jobs-"));
    try {
      const cards = Array.from({ length: 2 }, (_, index) => ({
        externalId: `anki:${index}`,
        frontHtml: `<img src="media-${index}.png">`,
        backHtml: "x".repeat(10_000),
      }));
      const job = createDurableJob("createFlashcardsAsync", { batchId: "anki:Deck", deckPath: "Anki Import::Deck", cards }, cards.length);

      await appendJobSnapshot(dir, job);
      job.status = "running";
      job.cursor = 1;
      job.ids = ["rem-1"];
      job.progress.push({ completed: 1, total: 2, at: Date.now() });
      await appendJobSnapshot(dir, job);

      const running = await readDurableJob(dir, job.jobId);
      expect(running?.params.cards).toEqual(cards);

      job.status = "complete";
      job.cursor = 2;
      job.ids = ["rem-1", "rem-2"];
      job.result = { count: 2, ids: job.ids };
      job.progress.push({ completed: 2, total: 2, at: Date.now() });
      await appendJobSnapshot(dir, job);

      const complete = await readDurableJob(dir, job.jobId);
      expect(complete?.params).toEqual({ batchId: "anki:Deck", deckPath: "Anki Import::Deck" });
      expect(complete?.ids).toEqual(["rem-1", "rem-2"]);

      await compactDurableJobs(dir);
      const compacted = readFileSync(jobStorePath(dir), "utf8").trim().split("\n");
      expect(compacted).toHaveLength(1);
      expect(statSync(jobStorePath(dir)).size).toBeLessThan(50_000);
      expect(await readDurableJob(dir, job.jobId)).toMatchObject({
        status: "complete",
        params: { batchId: "anki:Deck", deckPath: "Anki Import::Deck" },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores a torn final JSONL record but rejects corruption before the final line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "remnote-connect-jobs-torn-"));
    try {
      const job = createDurableJob("createFlashcardsAsync", { cards: [{ front: "A" }] }, 1);
      await appendJobSnapshot(dir, job);
      appendFileSync(jobStorePath(dir), '{"schemaVersion":1,"jobId":"torn"', "utf8");
      expect(await readDurableJob(dir, job.jobId)).toMatchObject({ status: "queued", cursor: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
