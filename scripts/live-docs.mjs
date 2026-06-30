#!/usr/bin/env node
import { assert, call, cleanupByText, requireBridge } from "./live-helpers.mjs";

const runId = `__codex_docs__-${Date.now().toString(36)}`;

try {
  await requireBridge();
  const markdown = `- ${runId} Document\n  - Reference candidate ${runId}\n  - Formula $x^2 + y^2$`;
  const created = await call("createDocument", { markdown, parentPath: runId, confirm: true });
  assert(created.count >= 1 && created.id, "createDocument did not return a root id.");

  const read = await call("getDocument", { id: created.id });
  assert(read.markdown.includes(runId), "getDocument markdown did not include created content.");
  assert(read.markdown.includes("Formula"), "getDocument markdown did not include formula line.");

  const docSpec = await call("createDocument", {
    parentPath: runId,
    confirm: true,
    docSpec: {
      richText: {
        segments: [
          { type: "text", text: `${runId} Spec Root `, formats: ["bold"] },
          { type: "latex", text: "a^2+b^2=c^2" },
        ],
      },
      backText: { markdown: `Back side with [link](https://example.com/${runId})` },
      properties: [{ powerupCode: "b", slot: "URL", value: `https://example.com/${runId}` }],
      children: [
        { text: `${runId} Spec Child` },
        { richText: { table: [["Metric", "Value"], ["run", runId]] } },
      ],
    },
  });
  assert(docSpec.count === 3 && docSpec.id, "docSpec createDocument did not create the expected tree.");
  const properties = await call("getProperties", { id: docSpec.id, powerupCode: "b", slot: "URL" });
  assert(properties.properties?.[0]?.value?.includes(runId), "getProperties did not return the docSpec property.");

  await cleanupByText(runId);
  const residue = await call("searchGraph", { query: `text:"${runId}"` });
  assert(residue.count === 0, "Docs test residue remains.");

  console.log(JSON.stringify({ status: "PASS", runId, rootId: created.id, docSpecRootId: docSpec.id }, null, 2));
} catch (error) {
  await cleanupByText(runId);
  console.error(JSON.stringify({ status: "FAIL", runId, message: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
}
