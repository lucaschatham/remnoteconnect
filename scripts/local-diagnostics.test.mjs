import assert from "node:assert/strict";
import test from "node:test";
import { probePluginBundle } from "./local-diagnostics.mjs";

const manifest = {
  id: "remnoteconnect-local-dev",
  name: "RemNoteConnect (Local Development)",
  version: { major: 0, minor: 5, patch: 0 },
};

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test("accepts the exact 127.0.0.1 plugin bundle", async () => {
  const fetchImpl = async (url) => {
    if (String(url).startsWith("http://127.0.0.1:8081")) return response(200, manifest);
    return response(200, manifest);
  };
  const result = await probePluginBundle({
    expectedId: manifest.id,
    expectedVersion: "0.5.0",
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.url, "http://127.0.0.1:8081/manifest.json");
  assert.equal(result.localhost.sameBundle, true);
});

test("uses a local-only plugin identity that cannot collide with the marketplace build", async () => {
  const fetchImpl = async () => response(200, manifest);
  const result = await probePluginBundle({
    expectedVersion: "0.5.0",
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.expectedId, "remnoteconnect-local-dev");
});

test("fails when localhost does not serve the exact bundle RemNote will load", async () => {
  const fetchImpl = async (url) => {
    if (String(url).startsWith("http://127.0.0.1:8081")) return response(200, manifest);
    return response(404, { error: "other service" });
  };
  const result = await probePluginBundle({
    expectedId: manifest.id,
    expectedVersion: "0.5.0",
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.localhost.sameBundle, false);
  assert.match(result.error, /localhost:8081/);
});

test("fails when the exact listener serves the wrong plugin build", async () => {
  const result = await probePluginBundle({
    expectedId: manifest.id,
    expectedVersion: "0.5.0",
    fetchImpl: async () => response(200, { ...manifest, id: "wrong-plugin" }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /wrong-plugin/);
});
