#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { WebSocket } = require("../daemon/node_modules/ws");

const tokenPath =
  process.env.REMNOTE_CONNECT_TOKEN_FILE ??
  join(homedir(), "Library", "Application Support", "RemNoteConnect", "token");
const token = process.env.REMNOTE_CONNECT_TOKEN ?? readFileSync(tokenPath, "utf8").trim();
const url = process.env.REMNOTE_CONNECT_URL ?? "http://127.0.0.1:8766";
const bridgeUrl = url.replace(/^http/, "ws").replace(/\/$/, "") + "/bridge";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function post(headers) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ action: "version", version: 1 }),
  });
}

async function badOriginCloseCode() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(bridgeUrl, { headers: { origin: "https://evil.example" } });
    ws.once("close", (code) => resolve(code));
    ws.once("error", reject);
  });
}

try {
  const missing = await post({});
  assert(missing.status === 401, `Missing token expected 401, got ${missing.status}.`);

  const wrong = await post({ Authorization: "Bearer wrong-token-wrong-token" });
  assert(wrong.status === 401, `Wrong token expected 401, got ${wrong.status}.`);

  const badOrigin = await post({ Authorization: `Bearer ${token}`, Origin: "https://evil.example" });
  assert(badOrigin.status === 403, `Bad HTTP Origin expected 403, got ${badOrigin.status}.`);

  const wsCode = await badOriginCloseCode();
  assert(wsCode === 1008, `Bad WebSocket Origin expected close 1008, got ${wsCode}.`);

  console.log(JSON.stringify({ status: "PASS", missingToken: 401, wrongToken: 401, badHttpOrigin: 403, badWsOriginClose: 1008 }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: "FAIL", message: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
}
