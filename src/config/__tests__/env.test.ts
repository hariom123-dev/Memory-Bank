import { describe, it, expect } from "vitest";
import { EnvSchema, validateEnv, loadEnvFile } from "../env.js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

describe("Environment Validation & Configuration", () => {
  it("provides sensible defaults when optional environment variables are missing", () => {
    const config = EnvSchema.parse({});
    expect(config.NODE_ENV).toBe("development");
    expect(config.LOG_LEVEL).toBe("info");
    expect(config.MEMORY_BANK_DB_PATH).toBe("memory-bank.sqlite");
    expect(config.MEMORY_BANK_WORKSPACE_ROOT).toBe(".");
    expect(config.MEMORY_BANK_MODEL_NAME).toBe("Xenova/all-MiniLM-L6-v2");
    expect(config.MEMORY_BANK_SHUTDOWN_TIMEOUT_MS).toBe(5000);
  });

  it("parses valid custom environment variables successfully", () => {
    const custom = {
      NODE_ENV: "production",
      LOG_LEVEL: "warn",
      MEMORY_BANK_DB_PATH: "custom.sqlite",
      MEMORY_BANK_WORKSPACE_ROOT: "./my-project",
      MEMORY_BANK_MODEL_NAME: "custom-model",
      MEMORY_BANK_SHUTDOWN_TIMEOUT_MS: "8000",
    };

    const config = validateEnv(custom);
    expect(config.NODE_ENV).toBe("production");
    expect(config.LOG_LEVEL).toBe("warn");
    expect(config.MEMORY_BANK_DB_PATH).toBe("custom.sqlite");
    expect(config.MEMORY_BANK_WORKSPACE_ROOT).toBe("./my-project");
    expect(config.MEMORY_BANK_MODEL_NAME).toBe("custom-model");
    expect(config.MEMORY_BANK_SHUTDOWN_TIMEOUT_MS).toBe(8000);
  });

  it("throws a newcomer-friendly error message on invalid environment values", () => {
    expect(() => {
      validateEnv({
        NODE_ENV: "invalid-env",
        MEMORY_BANK_SHUTDOWN_TIMEOUT_MS: "-50",
      });
    }).toThrow(/Invalid Environment Configuration/);
  });

  it("verifies .env.example exists at project root and has required entries", () => {
    const envExamplePath = resolve(process.cwd(), ".env.example");
    expect(existsSync(envExamplePath)).toBe(true);

    const content = readFileSync(envExamplePath, "utf-8");
    expect(content).toContain("NODE_ENV");
    expect(content).toContain("LOG_LEVEL");
    expect(content).toContain("MEMORY_BANK_DB_PATH");
    expect(content).toContain("MEMORY_BANK_WORKSPACE_ROOT");
    expect(content).toContain("MEMORY_BANK_MODEL_NAME");
    expect(content).toContain("MEMORY_BANK_SHUTDOWN_TIMEOUT_MS");
  });
});

