import {
  ANKI_CONNECT_ACTION_SET_SHA256,
  ANKI_CONNECT_SOURCE_COMMIT,
  ankiConnectActionManifest,
  ankiConnectActionNames,
} from "../shared/dist/index.js";
import { createHash } from "node:crypto";

const expectedCommit = "de6e6e1b8aaf4ae195eb1d1ff6db5409b99b2a3e";
const failures = [];

if (ANKI_CONNECT_SOURCE_COMMIT !== expectedCommit) failures.push("unexpected source commit");
if (ankiConnectActionManifest.length !== 122) failures.push(`expected 122 actions, found ${ankiConnectActionManifest.length}`);
if (new Set(ankiConnectActionNames).size !== ankiConnectActionNames.length) failures.push("duplicate action names");
const actionSetHash = createHash("sha256").update([...ankiConnectActionNames].sort().join("\n")).digest("hex");
if (actionSetHash !== ANKI_CONNECT_ACTION_SET_SHA256) failures.push("pinned action set hash mismatch");
for (const action of ankiConnectActionManifest) {
  if (!action.name || !action.family || !action.status || !action.summary) failures.push(`incomplete metadata: ${action.name || "<unnamed>"}`);
  if (action.status === "blocked" && !action.limitation) failures.push(`blocked action lacks limitation: ${action.name}`);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

const counts = Object.fromEntries(
  ["native", "translated", "sidecar", "blocked"].map((status) => [
    status,
    ankiConnectActionManifest.filter((action) => action.status === status).length,
  ]),
);
console.log(JSON.stringify({ sourceCommit: ANKI_CONNECT_SOURCE_COMMIT, actions: 122, counts }, null, 2));
