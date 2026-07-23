import { describe, expect, it } from "vitest";
import { normalizePairingCode, storePairingCode } from "../src/pairing.js";

describe("pairing input", () => {
  it("accepts daemon-issued pairing codes and trims pasted whitespace", () => {
    expect(normalizePairingCode(`  pair-${"a".repeat(32)}\n`)).toBe(`pair-${"a".repeat(32)}`);
  });

  it("rejects tokens and malformed input", () => {
    expect(() => normalizePairingCode("not-a-pairing-code")).toThrow(/pair-/);
    expect(() => normalizePairingCode("b".repeat(64))).toThrow(/pair-/);
  });

  it("stores only a validated short-lived pairing code", () => {
    const values = new Map<string, string>();
    const storage = {
      setItem: (key: string, value: string) => values.set(key, value),
    } as Storage;
    storePairingCode(storage, `pair-${"c".repeat(32)}`);
    expect(values.get("remnoteconnect.daemonToken")).toBe(`pair-${"c".repeat(32)}`);
  });
});
