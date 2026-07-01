#!/usr/bin/env node
import { loadConfig } from "./config.js";

const command = process.argv[2];
const config = loadConfig();

if (command === "token" && process.argv.includes("--unsafe-print")) {
  console.log(config.token);
} else if (command === "token") {
  console.error(`Token file: ${config.tokenFile}`);
  console.error("Refusing to print the daemon token. Re-run with `token --unsafe-print` only for manual recovery.");
  process.exit(1);
} else if (command === "paths") {
  console.log(JSON.stringify({ appDir: config.appDir, backupDir: config.backupDir, logDir: config.logDir, tokenFile: config.tokenFile }, null, 2));
} else {
  console.error("Usage: remnote-connect-daemon token --unsafe-print|paths");
  process.exit(1);
}
