import Fastify from "fastify";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  ANKI_CONNECT_API_VERSION,
  AnkiConnectRequestSchema,
  formatAnkiConnectError,
  formatAnkiConnectSuccess,
  type AnkiConnectRequest,
} from "@remnoteconnect/shared";
import type { DaemonConfig } from "./config.js";
import { AnkiCompatDispatcher } from "./ankiCompatDispatcher.js";

type ServerOptions = {
  config: DaemonConfig;
  dispatcher: AnkiCompatDispatcher;
};

function allowedHost(host: string | undefined, _config: DaemonConfig): boolean {
  if (!host) return false;
  const hostname = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0];
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function allowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  return (
    origin === "http://localhost" ||
    origin.startsWith("http://localhost:") ||
    origin.startsWith("http://127.0.0.1:") ||
    origin.startsWith("https://127.0.0.1:") ||
    origin.startsWith("chrome-extension://") ||
    origin.startsWith("moz-extension://") ||
    origin.startsWith("safari-web-extension://")
  );
}

function cors(reply: FastifyReply, origin?: string): void {
  reply.header("Access-Control-Allow-Origin", origin ?? "http://localhost");
  reply.header("Access-Control-Allow-Headers", "*");
  reply.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

export function buildAnkiCompatServer({ config, dispatcher }: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 50 * 1024 * 1024 });

  app.addHook("onRequest", async (request, reply) => {
    if (!allowedHost(request.headers.host, config)) {
      reply.code(403).send();
      return;
    }
    if (!allowedOrigin(request.headers.origin)) {
      reply.code(403).send();
      return;
    }
    cors(reply, request.headers.origin);
  });

  app.options("*", async (_request, reply) => reply.code(200).send(""));
  app.get("/", async () => ({ apiVersion: `AnkiConnect v.${ANKI_CONNECT_API_VERSION}` }));

  app.setErrorHandler((error, _request, reply) => {
    const candidate = error as { statusCode?: number; message?: string };
    reply
      .code(candidate.statusCode && candidate.statusCode !== 400 ? candidate.statusCode : 200)
      .send(formatAnkiConnectError(candidate.message ?? String(error)));
  });

  const handle = async (input: unknown): Promise<unknown> => {
    const parsed = AnkiConnectRequestSchema.safeParse(input);
    if (!parsed.success) return formatAnkiConnectError(parsed.error.message);
    const request = parsed.data;
    try {
      if (request.action === "multi") {
        if (!Array.isArray(request.params.actions)) throw new Error("multi requires actions");
        const actions = request.params.actions;
        const nested = [];
        for (const action of actions) nested.push(await handle(action));
        return formatAnkiConnectSuccess(request.version, nested);
      }
      const result = await dispatcher.dispatch(request as AnkiConnectRequest);
      return formatAnkiConnectSuccess(request.version, result);
    } catch (error) {
      return formatAnkiConnectError(error instanceof Error ? error.message : String(error));
    }
  };

  app.post("/", async (request) => handle(request.body));
  return app;
}
