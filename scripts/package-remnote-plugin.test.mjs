import assert from "node:assert/strict";
import test from "node:test";
import {
  PUBLIC_PLUGIN_ID,
  PUBLIC_PLUGIN_NAME,
  REQUIRED_PLUGIN_FILES,
  releaseArchiveName,
  validateReleaseInputs,
} from "./package-remnote-plugin.mjs";

const manifest = {
  id: PUBLIC_PLUGIN_ID,
  name: PUBLIC_PLUGIN_NAME,
  version: { major: 0, minor: 5, patch: 0 },
};

const buildInfo = {
  version: "0.5.0",
  buildHash: "v0.5.0+git.1234567890ab",
  commit: "1234567890abcdef1234567890abcdef12345678",
  clean: true,
};

test("defines the exact public plugin archive identity", () => {
  assert.equal(releaseArchiveName("0.5.0"), "RemNoteConnect-v0.5.0-remnote-plugin.zip");
  assert.deepEqual(REQUIRED_PLUGIN_FILES, ["index.html", "index.js", "README.md", "snippet.css", "manifest.json"]);
});

test("accepts a matching public manifest and clean release build", () => {
  assert.doesNotThrow(() =>
    validateReleaseInputs({
      manifest,
      buildInfo,
      packageVersion: "0.5.0",
      headCommit: buildInfo.commit,
      distFiles: REQUIRED_PLUGIN_FILES,
    }),
  );
});

test("rejects a development ID or stale release build", () => {
  assert.throws(
    () =>
      validateReleaseInputs({
        manifest: { ...manifest, id: "remnoteconnect-local-dev" },
        buildInfo,
        packageVersion: "0.5.0",
        headCommit: buildInfo.commit,
        distFiles: REQUIRED_PLUGIN_FILES,
      }),
    /public plugin id/i,
  );
  assert.throws(
    () =>
      validateReleaseInputs({
        manifest,
        buildInfo,
        packageVersion: "0.5.0",
        headCommit: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
        distFiles: REQUIRED_PLUGIN_FILES,
      }),
    /current git commit/i,
  );
});

test("rejects incomplete upload contents", () => {
  assert.throws(
    () =>
      validateReleaseInputs({
        manifest,
        buildInfo,
        packageVersion: "0.5.0",
        headCommit: buildInfo.commit,
        distFiles: REQUIRED_PLUGIN_FILES.filter((file) => file !== "README.md"),
      }),
    /README\.md/,
  );
});
