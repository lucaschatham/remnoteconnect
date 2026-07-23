import assert from "node:assert/strict";
import test from "node:test";
import { chooseNodeRuntime, pnpmInvocation, validateBuildPair } from "./install-utils.mjs";

test("chooses Node 24 LTS ahead of Node 22 and rejects EOL or Current lines", () => {
  const selected = chooseNodeRuntime([
    { path: "/node-25", version: "v25.5.0" },
    { path: "/node-22", version: "v22.23.1" },
    { path: "/node-24", version: "v24.18.0" },
    { path: "/node-20", version: "v20.19.4" },
  ]);
  assert.deepEqual(selected, { path: "/node-24", version: "v24.18.0", major: 24 });
});

test("uses explicit pnpm, installed pnpm, then pinned npx fallback", () => {
  assert.deepEqual(
    pnpmInvocation({ explicit: "/custom/pnpm", pnpmPath: "/found/pnpm", npxPath: "/found/npx" }),
    { command: "/custom/pnpm", prefix: [] },
  );
  assert.deepEqual(
    pnpmInvocation({ pnpmPath: "/found/pnpm", npxPath: "/found/npx" }),
    { command: "/found/pnpm", prefix: [] },
  );
  assert.deepEqual(
    pnpmInvocation({ npxPath: "/found/npx" }),
    { command: "/found/npx", prefix: ["--yes", "pnpm@11.7.0"] },
  );
});

test("requires matching clean daemon and plugin build identities", () => {
  const build = {
    version: "0.5.0",
    buildHash: "v0.5.0+git.1234567890ab",
    commit: "1234567890abcdef1234567890abcdef12345678",
    clean: true,
  };
  assert.deepEqual(validateBuildPair(build, { ...build }, "0.5.0"), build);
  assert.throws(
    () => validateBuildPair(build, { ...build, buildHash: "different" }, "0.5.0"),
    /do not match/,
  );
  assert.throws(
    () => validateBuildPair({ ...build, clean: false }, build, "0.5.0"),
    /clean/,
  );
});
