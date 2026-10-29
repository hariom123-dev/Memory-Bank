import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  MEMORY_BANK_DB_PATH: z.string().default("memory-bank.sqlite"),
  MEMORY_BANK_WORKSPACE_ROOT: z.string().default("."),
  MEMORY_BANK_MODEL_NAME: z.string().default("Xenova/all-MiniLM-L6-v2"),
  MEMORY_BANK_SHUTDOWN_TIMEOUT_MS: z.coerce.number().positive().default(5000),
});

export type EnvConfig = z.infer<typeof EnvSchema>;

/**
 * Loads key-value pairs from a .env file into process.env if not already set.
 * Uses native process.loadEnvFile when available (Node >= 20.6) with fallback parser.
 */
export function loadEnvFile(envPath = resolve(process.cwd(), ".env")): boolean {
  if (!existsSync(envPath)) {
    return false;
  }

  // Node 20.6.0+ native loader
  if (typeof (process as unknown as { loadEnvFile?: (path?: string) => void }).loadEnvFile === "function") {
    try {
      (process as unknown as { loadEnvFile: (path?: string) => void }).loadEnvFile(envPath);
      return true;
    } catch {
      // Fall through to manual parser if native loader fails
    }
  }

  try {
    const content = readFileSync(envPath, "utf-8");
    const lines = content.split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;

      const eqIdx = line.indexOf("=");
      if (eqIdx === -1) continue;

      const key = line.slice(0, eqIdx).trim();
      let val = line.slice(eqIdx + 1).trim();

      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }

      if (!(key in process.env)) {
        process.env[key] = val;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates the runtime environment against the Zod schema.
 * Throws a formatted, newcomer-friendly message if any required variable is invalid.
 */
export function validateEnv(customEnv?: Record<string, unknown>): EnvConfig {
  loadEnvFile();

  const target = customEnv ?? process.env;
  const result = EnvSchema.safeParse(target);

  if (!result.success) {
    const errorDetails = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");

    const message = [
      "❌ Invalid Environment Configuration:",
      errorDetails,
      "",
      "👉 Please check your .env file or copy .env.example to .env and configure valid values:",
      "   cp .env.example .env",
    ].join("\n");

    throw new Error(message);
  }

  return result.data;
}

