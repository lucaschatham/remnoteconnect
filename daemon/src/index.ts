#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";
import { startPluginStaticServer } from "./pluginStatic.js";
import { compactDurableJobs } from "./jobStore.js";

const config = loadConfig();
await compactDurableJobs(config.appDir);
const { app, ankiApp } = buildServer(config);

try {
  await app.listen({ host: config.host, port: config.port });
  if (config.ankiCompatEnabled) {
    await ankiApp.listen({ host: config.ankiCompatHost, port: config.ankiCompatPort });
  }
  const pluginServer = await startPluginStaticServer(config);
  console.log(`RemNoteConnect daemon listening on http://${config.host}:${config.port}`);
  console.log(
    config.ankiCompatEnabled
      ? `AnkiConnect compatibility listening on http://${config.ankiCompatHost}:${config.ankiCompatPort}`
      : "AnkiConnect compatibility disabled; set REMNOTE_CONNECT_ANKI_COMPAT=on to enable it.",
  );
  if (pluginServer) {
    console.log(`Plugin bundle listening on http://${config.pluginHost}:${config.pluginPort}`);
  } else {
    console.log(`Plugin bundle not served; build plugin/dist or set REMNOTE_CONNECT_PLUGIN_DIST.`);
  }
  console.log(`Token file: ${config.tokenFile}`);
  console.log(`Backup dir: ${config.backupDir}`);
  console.log(`Log dir: ${config.logDir}`);
} catch (error) {
  console.error("Failed to start RemNoteConnect daemon:", error);
  await Promise.allSettled([ankiApp.close(), app.close()]);
  process.exitCode = 1;
}
