import type { ReactRNPlugin } from "@remnote/plugin-sdk";
import { BridgeClient } from "./bridgeClient.js";

let client: BridgeClient | undefined;

export async function activatePlugin(plugin: ReactRNPlugin): Promise<void> {
  client = new BridgeClient(plugin);
  const warnings: string[] = [];

  try {
    await client.registerControls();
  } catch (error) {
    warnings.push(`pairing controls failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await client.registerSettings();
  } catch (error) {
    warnings.push(`settings registration failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  await client.start();
  void plugin.app.waitForInitialSync().catch(() => undefined);

  if (warnings.length > 0) {
    await plugin.app.toast(`RemNoteConnect loaded with a warning: ${warnings.join("; ")}`);
  } else {
    await plugin.app.toast("RemNoteConnect plugin loaded.");
  }
}

export function deactivatePlugin(): void {
  client?.stop();
  client = undefined;
}
