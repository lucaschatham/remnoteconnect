import assert from "node:assert/strict";
import test from "node:test";
import { buildIdentity, replaceBuildMarker } from "./build-release.mjs";

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
