import assert from "node:assert/strict";
import test from "node:test";
import { disposableTag } from "./live-fixture-names.mjs";

test("makes live-test tags discoverable through the unique run ID", () => {
  const runId = "__rnc_bench__-mrxr84m0";
  assert.equal(disposableTag("rnc-bench", runId), `rnc-bench-${runId}`);
});

test("rejects non-disposable run IDs", () => {
  assert.throws(() => disposableTag("rnc-bench", "production"), /disposable RemNoteConnect run ID/);
});
