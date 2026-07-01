import type { ReactRNPlugin } from "@remnote/plugin-sdk";
import { DEFAULT_BRIDGE_URL } from "@remnoteconnect/shared";
import { capabilityMatrix, executeAction } from "./executor.js";
import { PluginActionError } from "./errors.js";

const DAEMON_URL_SETTING = "daemonUrl";
const TOKEN_SETTING = "daemonToken";
const TOKEN_STORAGE_KEY = "remnoteconnect.daemonToken";
const PLUGIN_VERSION = "0.2.0";

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
const ENV_DAEMON_URL = env.VITE_REMNOTE_CONNECT_DAEMON_URL;
const ENV_TOKEN = env.VITE_REMNOTE_CONNECT_TOKEN;

export class BridgeClient {
  private socket?: WebSocket;
  private stopped = false;
  private reconnectTimer?: number;
  private heartbeatTimer?: number;
  private reconnectDelayMs = 500;

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
      description: "Paste the daemon token only during manual recovery; prefer token rotation/pairing.",
      defaultValue: "",
    });
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.socket?.close();
    this.socket = undefined;
  }

  private async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;
    this.clearReconnectTimer();
    const url = (await this.plugin.settings.getSetting<string>(DAEMON_URL_SETTING)) || ENV_DAEMON_URL || DEFAULT_BRIDGE_URL;
    const storage = window.localStorage as Storage | undefined;
    const storedToken = typeof storage?.getItem === "function" ? storage.getItem(TOKEN_STORAGE_KEY) || "" : "";
    const token = storedToken || (await this.plugin.settings.getSetting<string>(TOKEN_SETTING)) || ENV_TOKEN || "";
    if (!token) {
      await this.plugin.app.toast("RemNoteConnect token is missing. Paste the daemon token in plugin settings.");
      this.scheduleReconnect();
      return;
    }

    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.clearReconnectTimer();
      this.reconnectDelayMs = 500;
      this.startHeartbeat(socket);
      socket.send(
        JSON.stringify({
          type: "hello",
          token,
          pluginVersion: PLUGIN_VERSION,
          transport: "websocket",
          capabilities: capabilityMatrix(),
        }),
      );
    });

    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      void this.handleMessage(String(event.data));
    });

    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.stopHeartbeat();
      this.scheduleReconnect();
    });
    socket.addEventListener("error", () => this.handleSocketFailure(socket));
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.clearReconnectTimer();
    const jitter = Math.floor(Math.random() * Math.min(500, this.reconnectDelayMs));
    const delay = this.reconnectDelayMs + jitter;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 8000);
    this.reconnectTimer = window.setTimeout(() => void this.connect(), delay);
  }

  private handleSocketFailure(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.stopHeartbeat();
    try {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
    } catch {
      // Nothing to do; the reconnect timer below owns recovery.
    }
    this.scheduleReconnect();
  }

  private startHeartbeat(socket: WebSocket): void {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ type: "ping", at: Date.now() }));
    }, 10_000);
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    window.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
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
