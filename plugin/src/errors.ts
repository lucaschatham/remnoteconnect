import type { ErrorCode } from "@remnoteconnect/shared";

export class PluginActionError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "PluginActionError";
  }
}

export function forbiddenTarget(message: string, details?: unknown): PluginActionError {
  return new PluginActionError("forbidden_target", message, details);
}
