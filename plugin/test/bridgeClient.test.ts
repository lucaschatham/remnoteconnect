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
    app: {
      registerCommand: vi.fn(),
      registerSidebarButton: vi.fn(),
      registerWidget: vi.fn(),
      toast: vi.fn(),
    },
    widget: { openPopup: vi.fn() },
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
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("document", { getElementById: () => ({ innerHTML: "" }) });
  });

  it("registers a discoverable pairing popup without relying on plugin settings", async () => {
    const fakePlugin = plugin();
    const client = new BridgeClient(fakePlugin);
    await client.registerControls();

    expect(fakePlugin.app.registerWidget).toHaveBeenCalledWith(
      "pair",
      "Popup",
      expect.objectContaining({ dimensions: expect.objectContaining({ width: 440 }) }),
    );
    expect(fakePlugin.app.registerSidebarButton).not.toHaveBeenCalled();
    expect(fakePlugin.app.registerCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "remnoteconnect.pair",
        name: "RemNoteConnect: Pair with local daemon",
        action: expect.any(Function),
      }),
    );

    const command = vi.mocked(fakePlugin.app.registerCommand).mock.calls[0]?.[0];
    expect(command).toBeTruthy();
    await (command?.action as () => Promise<void>)();
    expect(fakePlugin.widget.openPopup).toHaveBeenCalledWith("pair", undefined, false);
  });

  it("falls back to a validated prompt when the popup API is unavailable", async () => {
    const fakePlugin = plugin();
    vi.mocked(fakePlugin.app.registerWidget).mockRejectedValue(new Error("popup registration unavailable"));
    vi.mocked(fakePlugin.widget.openPopup).mockRejectedValue(new Error("popup unavailable"));
    Object.assign(window, { prompt: vi.fn(() => `pair-${"d".repeat(32)}`) });
    const client = new BridgeClient(fakePlugin);

    await expect(client.registerControls()).resolves.toBeUndefined();
    const command = vi.mocked(fakePlugin.app.registerCommand).mock.calls[0]?.[0];
    await (command?.action as () => Promise<void>)();

    expect(window.localStorage.getItem("remnoteconnect.daemonToken")).toBe(`pair-${"d".repeat(32)}`);
    expect(fakePlugin.app.toast).toHaveBeenCalledWith(expect.stringContaining("Pairing code saved"));
  });

  it("keeps retrying with an actionable error when settings reads fail", async () => {
    const fakePlugin = plugin();
    vi.mocked(fakePlugin.settings.getSetting).mockRejectedValue(new Error("settings unavailable"));
    const client = new BridgeClient(fakePlugin);

    await expect(client.start()).resolves.toBeUndefined();
    expect(fakePlugin.app.toast).toHaveBeenCalledWith(
      expect.stringContaining("RemNoteConnect: Pair with local daemon"),
    );
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
