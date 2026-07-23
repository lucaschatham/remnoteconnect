import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("daemon config", () => {
  it("uses the collision-free RemNote localhost development port", () => {
    const config = loadConfig({
      appDir: "/tmp/remnoteconnect-config-test",
      backupDir: "/tmp/remnoteconnect-config-test/backups",
      logDir: "/tmp/remnoteconnect-config-test/logs",
      tokenFile: "/tmp/remnoteconnect-config-test/token",
      token: "test-token-do-not-use",
    });

    expect(config.pluginHost).toBe("127.0.0.1");
    expect(config.pluginPort).toBe(8081);
    expect(config.allowedOrigins).toContain("http://localhost:8081");
    expect(config.allowedOrigins).toContain("http://127.0.0.1:8081");
  });
});
