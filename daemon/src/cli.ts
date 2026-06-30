#!/usr/bin/env node
import { loadConfig } from "./config.js";

const command = process.argv[2];
const config = loadConfig();

if (command === "token") {
  console.log(config.token);
} else if (command === "paths") {
  console.log(JSON.stringify({ appDir: config.appDir, backupDir: config.backupDir, logDir: config.logDir, tokenFile: config.tokenFile }, null, 2));
} else {
  console.error("Usage: remnote-connect-daemon token|paths");
  process.exit(1);
}
