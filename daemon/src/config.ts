import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  DEFAULT_ANKI_CONNECT_HOST,
  DEFAULT_ANKI_CONNECT_PORT,
  DEFAULT_DAEMON_HOST,
  DEFAULT_DAEMON_PORT,
} from "@remnoteconnect/shared";

export type DaemonConfig = {
  host: string;
  port: number;
  pluginHost: string;
  pluginPort: number;
  pluginDistDir: string;
  appDir: string;
  backupDir: string;
  logDir: string;
  tokenFile: string;
  token: string;
  allowedOrigins: string[];
  readonlyMode: boolean;
  ankiCompatEnabled: boolean;
  ankiCompatHost: string;
  ankiCompatPort: number;
  ankiCompatApiKey?: string;
};

export function defaultAppDir(): string {
  return join(homedir(), "Library", "Application Support", "RemNoteConnect");
}

export function defaultBackupDir(): string {
  return join(homedir(), "Documents", "RemNoteConnect", "Backups");
}

export function defaultLogDir(): string {
  return join(homedir(), "Library", "Logs", "RemNoteConnect");
}

export function defaultPluginDistDir(): string {
  const fromRepoRoot = join(process.cwd(), "plugin", "dist");
  if (existsSync(fromRepoRoot)) return fromRepoRoot;
  return join(process.cwd(), "..", "plugin", "dist");
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function loadOrCreateToken(tokenFile: string): string {
  ensureDir(dirname(tokenFile));
  if (existsSync(tokenFile)) {
    const token = readFileSync(tokenFile, "utf8").trim();
    if (token.length >= 16) return token;
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  return token;
}

export function loadConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  const appDir = overrides.appDir ?? process.env.REMNOTE_CONNECT_APP_DIR ?? defaultAppDir();
  const backupDir =
    overrides.backupDir ?? process.env.REMNOTE_CONNECT_BACKUP_DIR ?? defaultBackupDir();
  const logDir = overrides.logDir ?? process.env.REMNOTE_CONNECT_LOG_DIR ?? defaultLogDir();
  const tokenFile = overrides.tokenFile ?? join(appDir, "token");
  ensureDir(appDir);
  ensureDir(backupDir);
  ensureDir(logDir);
  const ankiCompatEnabled = overrides.ankiCompatEnabled ?? process.env.REMNOTE_CONNECT_ANKI_COMPAT === "on";
  const ankiCompatHost = overrides.ankiCompatHost ?? process.env.REMNOTE_CONNECT_ANKI_HOST ?? DEFAULT_ANKI_CONNECT_HOST;
  if (ankiCompatEnabled && !["127.0.0.1", "localhost", "::1"].includes(ankiCompatHost)) {
    throw new Error("AnkiConnect compatibility must bind to a loopback host.");
  }

  return {
    host: overrides.host ?? process.env.REMNOTE_CONNECT_HOST ?? DEFAULT_DAEMON_HOST,
    port: Number(overrides.port ?? process.env.REMNOTE_CONNECT_PORT ?? DEFAULT_DAEMON_PORT),
    pluginHost: overrides.pluginHost ?? process.env.REMNOTE_CONNECT_PLUGIN_HOST ?? DEFAULT_DAEMON_HOST,
    pluginPort: Number(overrides.pluginPort ?? process.env.REMNOTE_CONNECT_PLUGIN_PORT ?? 8080),
    pluginDistDir: overrides.pluginDistDir ?? process.env.REMNOTE_CONNECT_PLUGIN_DIST ?? defaultPluginDistDir(),
    appDir,
    backupDir,
    logDir,
    tokenFile,
    token: overrides.token ?? process.env.REMNOTE_CONNECT_TOKEN ?? loadOrCreateToken(tokenFile),
    readonlyMode: overrides.readonlyMode ?? process.env.REMNOTE_CONNECT_READONLY_MODE !== "off",
    ankiCompatEnabled,
    ankiCompatHost,
    ankiCompatPort: Number(overrides.ankiCompatPort ?? process.env.REMNOTE_CONNECT_ANKI_PORT ?? DEFAULT_ANKI_CONNECT_PORT),
    ankiCompatApiKey: overrides.ankiCompatApiKey ?? process.env.REMNOTE_CONNECT_ANKI_API_KEY,
    allowedOrigins: overrides.allowedOrigins ?? [
      "http://localhost:8080",
      "http://127.0.0.1:8080",
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "app://remnote",
      "remnote://plugins",
    ],
  };
}
