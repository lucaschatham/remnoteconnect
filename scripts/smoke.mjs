#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const tokenPath =
  process.env.REMNOTE_CONNECT_TOKEN_FILE ??
  join(homedir(), "Library", "Application Support", "RemNoteConnect", "token");
const token = process.env.REMNOTE_CONNECT_TOKEN ?? readFileSync(tokenPath, "utf8").trim();
const url = process.env.REMNOTE_CONNECT_URL ?? "http://127.0.0.1:8766";

async function call(action, params = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ action, version: 1, params }),
  });
  const body = await response.json();
  console.log(action, JSON.stringify(body, null, 2));
  return body;
}

await call("version");
await call("status");
await call("capabilities");
