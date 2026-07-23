import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactRNPlugin } from "@remnote/plugin-sdk";
import { activatePlugin, deactivatePlugin } from "../src/lifecycle.js";

describe("plugin lifecycle", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    });
    vi.stubGlobal("document", { getElementById: () => ({ innerHTML: "" }) });
  });

  it("starts the bridge even when RemNote settings registration fails", async () => {
    const plugin = {
      settings: {
        registerStringSetting: vi.fn().mockRejectedValue(new Error("settings registration failed")),
        getSetting: vi.fn(async () => ""),
      },
      app: {
        registerCommand: vi.fn(),
        registerSidebarButton: vi.fn(),
        registerWidget: vi.fn(),
        toast: vi.fn(),
        waitForInitialSync: vi.fn(async () => undefined),
      },
      widget: { openPopup: vi.fn() },
    } as unknown as ReactRNPlugin;

    await expect(activatePlugin(plugin)).resolves.toBeUndefined();
    expect(plugin.app.registerCommand).toHaveBeenCalledWith(
      expect.objectContaining({ id: "remnoteconnect.pair" }),
    );
    expect(plugin.app.toast).toHaveBeenCalledWith(
      expect.stringContaining("settings registration failed"),
    );

    deactivatePlugin();
  });
});
