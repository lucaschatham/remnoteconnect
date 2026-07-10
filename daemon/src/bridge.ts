import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import {
  BUILD_HASH,
  DAEMON_VERSION,
  fail,
  type ApiError,
  type ApiResponse,
  type PluginHello,
  PluginHelloSchema,
  PluginResultSchema,
} from "@remnoteconnect/shared";
import type { DaemonConfig } from "./config.js";
import { isAllowedOrigin, safeTokenEqual } from "./security.js";
import type { PairingStore } from "./pairing.js";

type PendingJob = {
  jobId: string;
  action: string;
  params: Record<string, unknown>;
  createdAt: number;
  timeout: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (error: ApiError) => void;
  progress: Array<{ completed: number; total: number; message?: string; at: number }>;
  bridgeGeneration: number;
  socket: WebSocket;
};

type JobRecord = {
  status: string;
  action: string;
  progress: PendingJob["progress"];
  updatedAt: number;
};

type BridgeJobSummary = {
  jobId: string;
  status: string;
  action: string;
  createdAt?: number;
  updatedAt: number;
  progressCount: number;
  lastProgress?: PendingJob["progress"][number];
};

export type BridgeStatus = {
  connected: boolean;
  connectedAt?: string;
  pluginVersion?: string;
  pluginBuildHash?: string;
  transport?: "websocket";
  capabilities?: Record<string, unknown>;
  pendingJobs: number;
  activeConnections: number;
  retainedJobs: number;
  pendingJobSummaries: BridgeJobSummary[];
  retainedJobSummaries: BridgeJobSummary[];
};

const MAX_JOB_HISTORY = 500;
const JOB_HISTORY_TTL_MS = 30 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 12_000;
export const BRIDGE_MAX_PAYLOAD_BYTES = 512 * 1024 * 1024;

type RunJobOptions = {
  signal?: AbortSignal;
};

export class PluginBridge {
  private ws?: WebSocket;
  private hello?: PluginHello;
  private connectedAt?: Date;
  private pending = new Map<string, PendingJob>();
  private jobs = new Map<string, JobRecord>();
  private bridgeGeneration = 0;
  private readonly connectedListeners = new Set<() => void>();

  constructor(
    private readonly config: DaemonConfig,
    private readonly pairing?: PairingStore,
  ) {}

  onConnected(listener: () => void): () => void {
    this.connectedListeners.add(listener);
    return () => this.connectedListeners.delete(listener);
  }

  createWebSocketServer(): WebSocketServer {
    const wss = new WebSocketServer({ noServer: true, maxPayload: BRIDGE_MAX_PAYLOAD_BYTES });
    wss.on("connection", (ws, request) => {
      const origin = request.headers.origin;
      if (!isAllowedOrigin(origin, this.config)) {
        ws.close(1008, "forbidden origin");
        return;
      }
      this.attach(ws);
    });
    return wss;
  }

  status(): BridgeStatus {
    return {
      connected: this.ws?.readyState === WebSocket.OPEN && Boolean(this.hello),
      connectedAt: this.connectedAt?.toISOString(),
      pluginVersion: this.hello?.pluginVersion,
      pluginBuildHash: this.hello?.pluginBuildHash,
      transport: this.hello?.transport,
      capabilities: this.hello?.capabilities,
      pendingJobs: this.pending.size,
      activeConnections: this.ws?.readyState === WebSocket.OPEN && Boolean(this.hello) ? 1 : 0,
      retainedJobs: this.jobs.size,
      pendingJobSummaries: [...this.pending.values()].map((job) =>
        this.publicJobSummary(job.jobId, {
          status: "pending",
          action: job.action,
          progress: job.progress,
          createdAt: job.createdAt,
          updatedAt: Date.now(),
        }),
      ),
      retainedJobSummaries: [...this.jobs.entries()]
        .slice(-10)
        .map(([jobId, job]) => this.publicJobSummary(jobId, job)),
    };
  }

  jobStatus(jobId: string): ApiResponse {
    this.pruneJobs();
    const job = this.jobs.get(jobId);
    if (!job) return fail("not_found", `No job found for ${jobId}`);
    return { result: job, error: null };
  }

  async runJob(action: string, params: Record<string, unknown>, timeoutMs = 30_000, options: RunJobOptions = {}): Promise<unknown> {
    if (action === "rewriteNativeLinks") timeoutMs = Math.max(timeoutMs, 10 * 60_000);
    if (action === "rewriteNativeLinks") {
      const count = Array.isArray(params.candidates)
        ? params.candidates.length
        : Array.isArray(params.links)
          ? params.links.length
          : Array.isArray(params.rewrites)
            ? params.rewrites.length
            : undefined;
      console.error(JSON.stringify({ at: new Date().toISOString(), action, timeoutMs, count, dryRun: params.dryRun === true, confirm: params.confirm === true }));
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.hello) {
      throw {
        code: "plugin_disconnected",
        message: "RemNote plugin is not connected to the local daemon.",
        details: { dispatched: false },
      } satisfies ApiError;
    }
    if (options.signal?.aborted === true) {
      throw {
        code: "aborted",
        message: "Plugin job aborted before dispatch.",
      } satisfies ApiError;
    }

    const jobId = randomUUID();
    const socket = this.ws;
    const generation = this.bridgeGeneration;
    const message = { type: "job", jobId, action, params, bridgeGeneration: generation };
    const result = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(jobId);
        this.setJob(jobId, {
          status: "timeout",
          action,
          progress: this.jobs.get(jobId)?.progress ?? [],
          updatedAt: Date.now(),
        });
        reject({ code: "timeout", message: `Timed out waiting for plugin job ${jobId}`, details: { dispatched: true, outcomeUnknown: true } });
      }, timeoutMs);

      const pendingJob: PendingJob = {
        jobId,
        action,
        params,
        createdAt: Date.now(),
        timeout,
        resolve,
        reject,
        progress: [],
        bridgeGeneration: generation,
        socket,
      };
      this.pending.set(jobId, pendingJob);
      this.setJob(jobId, { status: "pending", action, progress: pendingJob.progress, updatedAt: Date.now() });
      options.signal?.addEventListener(
        "abort",
        () => {
          if (!this.pending.has(jobId)) return;
          clearTimeout(timeout);
          this.pending.delete(jobId);
          this.setJob(jobId, { status: "aborted", action, progress: pendingJob.progress, updatedAt: Date.now() });
          reject({ code: "aborted", message: `Aborted plugin job ${jobId}`, details: { dispatched: true, outcomeUnknown: true } });
        },
        { once: true },
      );
    });

    socket.send(JSON.stringify(message));
    return result;
  }

  private attach(ws: WebSocket): void {
    let authenticated = false;
    let connectionGeneration = 0;
    let alive = true;
    const heartbeat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, HEARTBEAT_INTERVAL_MS);

    ws.on("pong", () => {
      alive = true;
    });

    ws.on("error", () => {
      clearInterval(heartbeat);
      if (this.ws === ws) {
        this.ws = undefined;
        this.hello = undefined;
        this.connectedAt = undefined;
        this.rejectPending("plugin_error", "RemNote plugin bridge socket failed before pending jobs completed.");
      }
    });

    ws.on("message", (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch {
        ws.close(1003, "invalid json");
        return;
      }

      if (!authenticated) {
        const hello = PluginHelloSchema.safeParse(parsed);
        if (!hello.success) {
          ws.close(1008, "unauthorized");
          return;
        }
        if (!safeTokenEqual(hello.data.token, this.config.token)) {
          if (this.pairing?.consume(hello.data.token)) {
            ws.send(JSON.stringify({ type: "hello_ack", pairedToken: this.config.token, daemonVersion: DAEMON_VERSION, daemonBuildHash: BUILD_HASH }));
            ws.close(1000, "pairing complete");
            return;
          }
          ws.close(1008, "unauthorized");
          return;
        }
        if (!this.replaceConnection(ws, hello.data)) return;
        connectionGeneration = this.bridgeGeneration;
        authenticated = true;
        ws.send(JSON.stringify({ type: "hello_ack", daemonVersion: DAEMON_VERSION, daemonBuildHash: BUILD_HASH, bridgeGeneration: connectionGeneration }));
        for (const listener of this.connectedListeners) queueMicrotask(listener);
        return;
      }

      const heartbeatMessage = parsed as { type?: string };
      if (heartbeatMessage.type === "ping") {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "pong", at: Date.now() }));
        return;
      }

      const result = PluginResultSchema.safeParse(parsed);
      if (result.success) {
        this.completeJob(result.data.jobId, result.data.result, result.data.error ?? null, ws, connectionGeneration, result.data.bridgeGeneration ?? connectionGeneration);
        return;
      }

      const progress = parsed as {
        type?: string;
        jobId?: string;
        bridgeGeneration?: number;
        completed?: number;
        total?: number;
        message?: string;
      };
      if (progress.type === "progress" && progress.jobId) {
        const job = this.pending.get(progress.jobId);
        if (!job || job.socket !== ws || job.bridgeGeneration !== connectionGeneration || (progress.bridgeGeneration ?? connectionGeneration) !== connectionGeneration) return;
        job.progress.push({
          completed: Number(progress.completed ?? 0),
          total: Number(progress.total ?? 0),
          message: progress.message,
          at: Date.now(),
        });
        return;
      }
    });

    ws.on("close", () => {
      clearInterval(heartbeat);
      if (this.ws === ws) {
        this.ws = undefined;
        this.hello = undefined;
        this.connectedAt = undefined;
        this.rejectPending("plugin_disconnected", "RemNote plugin disconnected before pending jobs completed.");
      }
    });
  }

  private replaceConnection(ws: WebSocket, hello: PluginHello): boolean {
    if (this.ws && this.ws !== ws) {
      if (this.ws.readyState === WebSocket.OPEN && this.pending.size > 0) {
        ws.close(1013, "already connected, in-flight jobs");
        return false;
      }
      if (this.ws.readyState !== WebSocket.OPEN && this.pending.size > 0) {
        this.rejectPending("plugin_disconnected", "RemNote plugin connection was replaced after disconnect.");
      }
      this.ws.close(1012, "replaced by a new plugin connection");
    }
    this.ws = ws;
    this.hello = hello;
    this.connectedAt = new Date();
    this.bridgeGeneration += 1;
    return true;
  }

  private completeJob(
    jobId: string,
    result: unknown,
    error: { code: string; message: string; details?: unknown } | null,
    socket: WebSocket,
    connectionGeneration: number,
    resultGeneration: number,
  ): void {
    const job = this.pending.get(jobId);
    if (!job) return;
    if (job.socket !== socket || job.bridgeGeneration !== connectionGeneration || resultGeneration !== connectionGeneration) return;
    clearTimeout(job.timeout);
    this.pending.delete(jobId);
    if (error) {
      this.setJob(jobId, { status: "error", action: job.action, progress: job.progress, updatedAt: Date.now() });
      job.reject({
        code: this.publicErrorCode(error.code),
        message: error.message,
        details: error.details,
      });
    } else {
      this.setJob(jobId, { status: "complete", action: job.action, progress: job.progress, updatedAt: Date.now() });
      job.resolve(result);
    }
  }

  private publicErrorCode(code: string): ApiError["code"] {
    if (
      code === "bad_request" ||
      code === "unauthorized" ||
      code === "forbidden_origin" ||
      code === "plugin_disconnected" ||
      code === "plugin_reconnected" ||
      code === "timeout" ||
      code === "aborted" ||
      code === "unsupported" ||
      code === "not_implemented" ||
      code === "not_found" ||
      code === "confirm_required" ||
      code === "dry_run_required" ||
      code === "dry_run_mismatch" ||
      code === "magnitude_guard" ||
      code === "readonly_mode" ||
      code === "approval_required" ||
      code === "approval_invalid" ||
      code === "experimental_disabled" ||
      code === "outcome_unknown" ||
      code === "unsafe_parameter" ||
      code === "irreversible_budget_exceeded" ||
      code === "forbidden_target" ||
      code === "backup_failed" ||
      code === "plugin_error" ||
      code === "internal_error"
    ) {
      return code;
    }
    return "plugin_error";
  }

  private rejectPending(code: ApiError["code"], message: string): void {
    for (const [jobId, job] of this.pending) {
      clearTimeout(job.timeout);
      this.pending.delete(jobId);
      this.setJob(jobId, { status: "error", action: job.action, progress: job.progress, updatedAt: Date.now() });
      job.reject({ code, message, details: { dispatched: true, outcomeUnknown: true } });
    }
  }

  private setJob(jobId: string, record: JobRecord): void {
    this.jobs.set(jobId, record);
    this.pruneJobs();
  }

  private publicJobSummary(
    jobId: string,
    record: JobRecord & { createdAt?: number },
  ): BridgeJobSummary {
    return {
      jobId,
      status: record.status,
      action: record.action,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      progressCount: record.progress.length,
      lastProgress: record.progress.at(-1),
    };
  }

  private pruneJobs(): void {
    const cutoff = Date.now() - JOB_HISTORY_TTL_MS;
    for (const [jobId, job] of this.jobs) {
      if (job.status !== "pending" && job.updatedAt < cutoff) this.jobs.delete(jobId);
    }
    while (this.jobs.size > MAX_JOB_HISTORY) {
      const oldestDone = [...this.jobs.entries()].find(([, job]) => job.status !== "pending");
      if (!oldestDone) return;
      this.jobs.delete(oldestDone[0]);
    }
  }
}
