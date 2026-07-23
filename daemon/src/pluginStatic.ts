import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, relative } from "node:path";
import type { DaemonConfig } from "./config.js";

export const LOCAL_PLUGIN_ID = "remnoteconnect-local-dev";
export const LOCAL_PLUGIN_NAME = "RemNoteConnect (Local Development)";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

function safePath(root: string, urlPath: string): string | undefined {
  const pathname = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const absolute = normalize(join(root, requested));
  if (relative(root, absolute).startsWith("..")) return undefined;
  return absolute;
}

export function localPluginManifest(manifest: unknown): Record<string, unknown> {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Plugin manifest must be a JSON object.");
  }
  return {
    ...(manifest as Record<string, unknown>),
    id: LOCAL_PLUGIN_ID,
    name: LOCAL_PLUGIN_NAME,
  };
}

export async function startPluginStaticServer(config: DaemonConfig): Promise<Server | undefined> {
  if (!existsSync(config.pluginDistDir)) return undefined;
  const server = createServer(async (request, response) => {
    const file = safePath(config.pluginDistDir, request.url ?? "/");
    if (!file) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    try {
      const info = await stat(file);
      const path = info.isDirectory() ? join(file, "index.html") : file;
      const fileBody = await readFile(path);
      const body =
        relative(config.pluginDistDir, path) === "manifest.json"
          ? `${JSON.stringify(localPluginManifest(JSON.parse(fileBody.toString("utf8"))), null, 2)}\n`
          : fileBody;
      response.writeHead(200, {
        "Content-Type": CONTENT_TYPES[extname(path)] ?? "application/octet-stream",
        "Cache-Control": "no-store",
      });
      response.end(body);
    } catch {
      response.writeHead(404).end("Not found");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.pluginPort, config.pluginHost, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}
