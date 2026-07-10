import type { ReactRNPlugin } from "@remnote/plugin-sdk";
import { BUILD_HASH, DEFAULT_BRIDGE_URL, PLUGIN_VERSION } from "@remnoteconnect/shared";
import { capabilityMatrix, executeAction } from "./executor.js";
import { PluginActionError } from "./errors.js";

const DAEMON_URL_SETTING = "daemonUrl";
const TOKEN_SETTING = "daemonToken";
const TOKEN_STORAGE_KEY = "remnoteconnect.daemonToken";

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
const ENV_DAEMON_URL = env.VITE_REMNOTE_CONNECT_DAEMON_URL;

type HealthState = {
  connected: boolean;
  tokenPresent: boolean;
  scopeApproved: "unknown" | "checking" | "yes" | "no";
  activeJobs: number;
  daemonVersion?: string;
  daemonBuildHash?: string;
  lastHeartbeatAt?: number;
  lastError?: string;
};

export class BridgeClient {
  private socket?: WebSocket;
  private stopped = false;
  private reconnectTimer?: number;
  private heartbeatTimer?: number;
  private reconnectDelayMs = 500;
  private bridgeGeneration?: number;
  private health: HealthState = {
    connected: false,
    tokenPresent: false,
    scopeApproved: "unknown",
    activeJobs: 0,
  };

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
    this.renderHealth();
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.socket?.close();
    this.socket = undefined;
    this.health.connected = false;
    this.renderHealth();
  }

  private async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;
    this.clearReconnectTimer();
    const url = (await this.plugin.settings.getSetting<string>(DAEMON_URL_SETTING)) || ENV_DAEMON_URL || DEFAULT_BRIDGE_URL;
    const storage = window.localStorage as Storage | undefined;
    const storedToken = typeof storage?.getItem === "function" ? storage.getItem(TOKEN_STORAGE_KEY) || "" : "";
    const token = storedToken || (await this.plugin.settings.getSetting<string>(TOKEN_SETTING)) || "";
    this.health.tokenPresent = Boolean(token);
    this.health.lastError = undefined;
    this.renderHealth();
    if (!token) {
      this.health.connected = false;
      this.health.lastError = "Daemon token missing.";
      this.renderHealth();
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
          pluginBuildHash: BUILD_HASH,
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
      this.health.connected = false;
      this.renderHealth();
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
    this.health.connected = false;
    this.health.lastError = "WebSocket connection failed.";
    this.renderHealth();
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
    let message: {
      type?: string;
      jobId?: string;
      action?: string;
      params?: Record<string, unknown>;
      bridgeGeneration?: number;
      daemonVersion?: string;
      daemonBuildHash?: string;
      pairedToken?: string;
    };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.type === "hello_ack") {
      if (message.pairedToken) {
        const storage = window.localStorage as Storage | undefined;
        if (typeof storage?.setItem === "function") storage.setItem(TOKEN_STORAGE_KEY, message.pairedToken);
        this.health.tokenPresent = true;
        this.health.lastError = "Pairing complete; reconnecting with the stored daemon token.";
        this.renderHealth();
        return;
      }
      this.health.connected = true;
      this.health.daemonVersion = message.daemonVersion;
      this.health.daemonBuildHash = message.daemonBuildHash;
      this.bridgeGeneration = message.bridgeGeneration;
      this.health.lastError = undefined;
      this.renderHealth();
      void this.checkScopeApproval();
      return;
    }
    if (message.type === "pong") {
      this.health.lastHeartbeatAt = Date.now();
      this.renderHealth();
      return;
    }
    if (message.type !== "job" || !message.jobId || !message.action) return;

    const responseSocket = this.socket;
    const responseGeneration = message.bridgeGeneration;
    if (!responseSocket || responseGeneration !== this.bridgeGeneration) return;

    this.health.activeJobs += 1;
    this.renderHealth();
    try {
      const result = await executeAction(this.plugin, message.action, message.params ?? {}, (completed, total, progressMessage) => {
        if (this.socket === responseSocket && this.bridgeGeneration === responseGeneration) responseSocket.send(
          JSON.stringify({
            type: "progress",
            jobId: message.jobId,
            bridgeGeneration: responseGeneration,
            completed,
            total,
            message: progressMessage,
          }),
        );
      });
      if (this.socket === responseSocket && this.bridgeGeneration === responseGeneration) {
        responseSocket.send(JSON.stringify({ type: "result", jobId: message.jobId, bridgeGeneration: responseGeneration, result, error: null }));
      }
    } catch (error) {
      const code = error instanceof PluginActionError ? error.code : "plugin_error";
      if (this.socket === responseSocket && this.bridgeGeneration === responseGeneration) responseSocket.send(
        JSON.stringify({
          type: "result",
          jobId: message.jobId,
          bridgeGeneration: responseGeneration,
          result: null,
          error: {
            code,
            message: error instanceof Error ? error.message : String(error),
            details: error instanceof PluginActionError ? error.details : undefined,
          },
        }),
      );
    } finally {
      this.health.activeJobs = Math.max(0, this.health.activeJobs - 1);
      this.renderHealth();
    }
  }

  private async checkScopeApproval(): Promise<void> {
    this.health.scopeApproved = "checking";
    this.renderHealth();
    try {
      const result = await executeAction(this.plugin, "scopeProbe", {});
      this.health.scopeApproved =
        result && typeof result === "object" && !Array.isArray(result) && (result as Record<string, unknown>).ok === true ? "yes" : "no";
    } catch (error) {
      this.health.scopeApproved = "no";
      this.health.lastError = error instanceof Error ? error.message : String(error);
    }
    this.renderHealth();
  }

  private renderHealth(): void {
    const root = document.getElementById("root");
    if (!root) return;
    const buildMatches = this.health.daemonBuildHash ? this.health.daemonBuildHash === BUILD_HASH : undefined;
    const rows: Array<[string, string, "ok" | "warn" | "bad" | "idle"]> = [
      ["Bridge", this.health.connected ? "Connected" : "Disconnected", this.health.connected ? "ok" : "bad"],
      ["Token", this.health.tokenPresent ? "Present" : "Missing", this.health.tokenPresent ? "ok" : "bad"],
      ["All scope", this.scopeLabel(), this.health.scopeApproved === "yes" ? "ok" : this.health.scopeApproved === "checking" ? "warn" : "bad"],
      ["Jobs", String(this.health.activeJobs), this.health.activeJobs === 0 ? "ok" : "warn"],
      [
        "Build",
        this.health.daemonBuildHash ? (buildMatches ? "Daemon and plugin match" : "Mismatch, reload plugin") : "Waiting for daemon",
        buildMatches === undefined ? "idle" : buildMatches ? "ok" : "bad",
      ],
      ["Heartbeat", this.health.lastHeartbeatAt ? new Date(this.health.lastHeartbeatAt).toLocaleTimeString() : "Waiting", this.health.lastHeartbeatAt ? "ok" : "idle"],
    ];
    root.innerHTML = `
      <main class="rnc-panel">
        <section class="rnc-header">
          <div>
            <h1>RemNoteConnect</h1>
            <p>Plugin ${PLUGIN_VERSION} · ${BUILD_HASH}</p>
          </div>
          <span class="rnc-dot ${this.health.connected ? "ok" : "bad"}"></span>
        </section>
        <dl>
          ${rows
            .map(
              ([label, value, state]) => `
                <div class="rnc-row">
                  <dt>${escapeHtml(label)}</dt>
                  <dd><span class="rnc-pill ${state}">${escapeHtml(value)}</span></dd>
                </div>
              `,
            )
            .join("")}
        </dl>
        ${
          this.health.lastError
            ? `<p class="rnc-error">${escapeHtml(this.health.lastError)}</p>`
            : `<p class="rnc-note">Daemon ${escapeHtml(this.health.daemonVersion ?? "unknown")} · ${escapeHtml(this.health.daemonBuildHash ?? "no daemon build yet")}</p>`
        }
      </main>
      <style>
        :root { color-scheme: dark light; }
        body { margin: 0; background: transparent; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        .rnc-panel { box-sizing: border-box; min-height: 100vh; padding: 16px; color: #f7f7f8; background: #111318; }
        .rnc-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
        h1 { margin: 0 0 4px; font-size: 17px; line-height: 1.2; letter-spacing: 0; }
        p { margin: 0; color: #a7adba; font-size: 12px; line-height: 1.4; letter-spacing: 0; }
        dl { margin: 0; display: grid; gap: 8px; }
        .rnc-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 0; border-top: 1px solid rgba(255,255,255,.08); }
        dt { color: #c4c9d4; font-size: 12px; letter-spacing: 0; }
        dd { margin: 0; text-align: right; }
        .rnc-pill { display: inline-flex; align-items: center; max-width: 180px; min-height: 22px; padding: 3px 8px; border-radius: 999px; font-size: 12px; line-height: 1.2; color: #f7f7f8; background: #2a2f3a; overflow-wrap: anywhere; }
        .rnc-pill.ok { background: #155d45; color: #d8fff0; }
        .rnc-pill.warn { background: #70501a; color: #fff1c2; }
        .rnc-pill.bad { background: #742f34; color: #ffe1e4; }
        .rnc-pill.idle { background: #303542; color: #d7dbe5; }
        .rnc-dot { width: 11px; height: 11px; border-radius: 999px; margin-top: 4px; background: #8a3340; box-shadow: 0 0 0 4px rgba(138,51,64,.18); flex: 0 0 auto; }
        .rnc-dot.ok { background: #31bd86; box-shadow: 0 0 0 4px rgba(49,189,134,.16); }
        .rnc-error { margin-top: 12px; color: #ffc9ce; }
        .rnc-note { margin-top: 12px; }
        @media (prefers-color-scheme: light) {
          .rnc-panel { color: #14161b; background: #fafafa; }
          p, dt { color: #555d6b; }
          .rnc-row { border-top-color: rgba(20,22,27,.1); }
          .rnc-pill.idle { background: #e7eaf0; color: #303542; }
        }
      </style>
    `;
  }

  private scopeLabel(): string {
    if (this.health.scopeApproved === "checking") return "Checking";
    if (this.health.scopeApproved === "yes") return "Approved";
    if (this.health.scopeApproved === "no") return "Denied or blocked";
    return "Unknown";
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    if (char === '"') return "&quot;";
    return "&#39;";
  });
}
