import type { FastifyRequest } from "fastify";
import type { DaemonConfig } from "./config.js";
import { timingSafeEqual } from "node:crypto";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function isAllowedHost(hostHeader: string | undefined, config: DaemonConfig): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.split(":")[0]?.toLowerCase();
  return host === config.host || LOCAL_HOSTS.has(host);
}

export function isAllowedOrigin(origin: string | undefined, config: DaemonConfig): boolean {
  if (!origin) return true;
  if (config.allowedOrigins.includes(origin)) return true;
  return false;
}

export function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header) return undefined;
  const [scheme, token] = header.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== "bearer") return undefined;
  return token;
}

export function safeTokenEqual(candidate: string | undefined, expected: string): boolean {
  if (!candidate) return false;
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  if (candidateBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(candidateBuffer, expectedBuffer);
}
