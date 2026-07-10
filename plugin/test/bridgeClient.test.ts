import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactRNPlugin } from "@remnote/plugin-sdk";
import { BridgeClient } from "../src/bridgeClient.js";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  } as Storage;
}

function plugin(): ReactRNPlugin {
  return {
    settings: {
      registerStringSetting: vi.fn(),
      getSetting: vi.fn(async () => ""),
    },
    app: { toast: vi.fn() },
  } as unknown as ReactRNPlugin;
}

describe("bridge client", () => {
  beforeEach(() => {
    const localStorage = storage();
    vi.stubGlobal("window", {
      localStorage,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    });
    vi.stubGlobal("document", { getElementById: () => ({ innerHTML: "" }) });
  });

  it("stores a token received through the local pairing acknowledgement", async () => {
    const client = new BridgeClient(plugin());
    await (client as unknown as { handleMessage(raw: string): Promise<void> }).handleMessage(
      JSON.stringify({ type: "hello_ack", pairedToken: "paired-token-paired-token" }),
    );
    expect(window.localStorage.getItem("remnoteconnect.daemonToken")).toBe("paired-token-paired-token");
  });

  it("ignores jobs from a stale bridge generation", async () => {
    const client = new BridgeClient(plugin());
    const send = vi.fn();
    Object.assign(client as object, { socket: { send }, bridgeGeneration: 2 });
    await (client as unknown as { handleMessage(raw: string): Promise<void> }).handleMessage(
      JSON.stringify({ type: "job", jobId: "old-job", bridgeGeneration: 1, action: "setDaemonToken", params: { token: "new-token-new-token" } }),
    );
    expect(send).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("remnoteconnect.daemonToken")).toBeNull();
  });
});
