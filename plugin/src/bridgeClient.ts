import type { ReactRNPlugin } from "@remnote/plugin-sdk";
import { DEFAULT_BRIDGE_URL } from "@remnoteconnect/shared";
import { capabilityMatrix, executeAction } from "./executor.js";
import { PluginActionError } from "./errors.js";

const DAEMON_URL_SETTING = "daemonUrl";
const TOKEN_SETTING = "daemonToken";

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
const ENV_DAEMON_URL = env.VITE_REMNOTE_CONNECT_DAEMON_URL;
const ENV_TOKEN = env.VITE_REMNOTE_CONNECT_TOKEN;

export class BridgeClient {
  private socket?: WebSocket;
  private stopped = false;
  private reconnectTimer?: number;

  constructor(private readonly plugin: ReactRNPlugin) {}

  async registerSettings(): Promise<void> {
    await this.plugin.settings.registerStringSetting({
      id: DAEMON_URL_SETTING,
      title: "Daemon WebSocket URL",
      description: "Local RemNoteConnect daemon bridge URL.",
      defaultValue: DEFAULT_BRIDGE_URL,
    });
    await this.plugin.settings.registerStringSetting({
      id: TOKEN_SETTING,
      title: "Daemon token",
      description: "Paste the token printed by `pnpm token`.",
      defaultValue: "",
    });
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.socket?.close();
  }

  private async connect(): Promise<void> {
    const url = (await this.plugin.settings.getSetting<string>(DAEMON_URL_SETTING)) || ENV_DAEMON_URL || DEFAULT_BRIDGE_URL;
    const token = (await this.plugin.settings.getSetting<string>(TOKEN_SETTING)) || ENV_TOKEN || "";
    if (!token) {
      await this.plugin.app.toast("RemNoteConnect token is missing. Paste the daemon token in plugin settings.");
      this.scheduleReconnect();
      return;
    }

    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          type: "hello",
          token,
          pluginVersion: "0.1.0",
          transport: "websocket",
          capabilities: capabilityMatrix(),
        }),
      );
    });

    socket.addEventListener("message", (event) => {
      void this.handleMessage(String(event.data));
    });

    socket.addEventListener("close", () => this.scheduleReconnect());
    socket.addEventListener("error", () => this.scheduleReconnect());
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => void this.connect(), 2000);
  }

  private async handleMessage(raw: string): Promise<void> {
    let message: { type?: string; jobId?: string; action?: string; params?: Record<string, unknown> };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.type !== "job" || !message.jobId || !message.action) return;

    try {
      const result = await executeAction(this.plugin, message.action, message.params ?? {}, (completed, total, progressMessage) => {
        this.socket?.send(
          JSON.stringify({
            type: "progress",
            jobId: message.jobId,
            completed,
            total,
            message: progressMessage,
          }),
        );
      });
      this.socket?.send(JSON.stringify({ type: "result", jobId: message.jobId, result, error: null }));
    } catch (error) {
      const code = error instanceof PluginActionError ? error.code : "plugin_error";
      this.socket?.send(
        JSON.stringify({
          type: "result",
          jobId: message.jobId,
          result: null,
          error: {
            code,
            message: error instanceof Error ? error.message : String(error),
            details: error instanceof PluginActionError ? error.details : undefined,
          },
        }),
      );
    }
  }
}
