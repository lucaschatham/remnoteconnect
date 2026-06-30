import { declareIndexPlugin } from "@remnote/plugin-sdk";
import type { ReactRNPlugin } from "@remnote/plugin-sdk";
import { BridgeClient } from "./bridgeClient.js";

let client: BridgeClient | undefined;

declareIndexPlugin(
  async (plugin: ReactRNPlugin) => {
    client = new BridgeClient(plugin);
    await client.registerSettings();
    await client.start();
    void plugin.app.waitForInitialSync().catch(() => undefined);
    await plugin.app.toast("RemNoteConnect plugin loaded.");
  },
  async () => {
    client?.stop();
    client = undefined;
  },
);
