import { createHash } from "node:crypto";

const VOLATILE_KEYS = new Set(["opId", "warning", "fromDryRun", "generatedAt", "createdAt", "updatedAt", "expiresAt"]);

function stable(value: unknown, parentKey = ""): unknown {
  if (Array.isArray(value)) {
    const items = value.map((item) => stable(item));
    if ((parentKey.endsWith("Ids") || parentKey === "targetIds") && items.every((item) => typeof item === "string")) {
      return [...items].sort();
    }
    return items;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !VOLATILE_KEYS.has(key))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stable(item, key)]),
    );
  }
  return value;
}

export function dryRunHash(action: string, result: unknown): string {
  return createHash("sha256").update(JSON.stringify({ action, result: stable(result) })).digest("hex");
}
