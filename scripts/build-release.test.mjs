import assert from "node:assert/strict";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIdentity, npxCommand, releaseRoot, replaceBuildMarker } from "./build-release.mjs";

test("resolves the release root through the platform-aware file URL converter", () => {
  assert.equal(releaseRoot(import.meta.url), resolve(dirname(fileURLToPath(import.meta.url)), ".."));
});

test("uses the Windows command shim when launching npx without a shell", () => {
  assert.equal(npxCommand("win32"), "npx.cmd");
  assert.equal(npxCommand("darwin"), "npx");
  assert.equal(npxCommand("win32", "C:\\tools\\npx-custom.cmd"), "C:\\tools\\npx-custom.cmd");
});

test("derives a stable release identity from the version and full commit", () => {
  assert.equal(
    buildIdentity("0.5.0", "1234567890abcdef1234567890abcdef12345678"),
    "v0.5.0+git.1234567890ab",
  );
});

test("replaces every build marker and reports the replacement count", () => {
  const result = replaceBuildMarker(
    'const a="__REMNOTE_CONNECT_BUILD_HASH__";const b="__REMNOTE_CONNECT_BUILD_HASH__";',
    "v0.5.0+git.1234567890ab",
  );
  assert.equal(result.count, 2);
  assert.doesNotMatch(result.content, /__REMNOTE_CONNECT_BUILD_HASH__/);
  assert.match(result.content, /v0\.5\.0\+git\.1234567890ab/);
});
