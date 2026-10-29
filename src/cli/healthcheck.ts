import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { validateEnv } from "../config/env.js";

export interface HealthcheckOptions {
  workspacePath?: string;
  silent?: boolean;
}

export interface HealthcheckResult {
  ok: boolean;
  git: { ok: boolean; version?: string; error?: string };
  docker: { ok: boolean; warning?: string };
  workspaceWrite: { ok: boolean; error?: string };
  env: { ok: boolean; error?: string };
}

// ANSI Color Helpers
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

/**
 * Verifies Git accessibility in the system $PATH.
 */
export function checkGit(): { ok: boolean; version?: string; error?: string } {
  try {
    const version = execFileSync("git", ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    return { ok: true, version };
  } catch {
    return {
      ok: false,
      error:
        "Git is not installed or not accessible in your system $PATH.\n" +
        "👉 Please install Git (https://git-scm.com/downloads) and ensure it is added to your environment PATH.",
    };
  }
}

/**
 * Checks whether the Docker daemon is actively running.
 * Emits a friendly yellow terminal warning if Docker is stopped.
 */
export function checkDocker(silent = false): { ok: boolean; warning?: string } {
  try {
    execFileSync("docker", ["info"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    });
    return { ok: true };
  } catch {
    const warning = "⚠️ Docker is not running. Please start Docker Desktop.";
    if (!silent) {
      console.warn(`${YELLOW}${warning}${RESET}`);
    }
    return { ok: false, warning };
  }
}

/**
 * Checks for write permissions on the workspace directory.
 */
export function checkWorkspaceWrite(workspacePath: string): { ok: boolean; error?: string } {
  const resolvedPath = resolve(workspacePath);
  const probeFile = join(resolvedPath, `.healthcheck-probe-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);

  try {
    writeFileSync(probeFile, "healthcheck", "utf-8");
    unlinkSync(probeFile);
    return { ok: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error:
        `Workspace directory is not writable: ${resolvedPath}\n` +
        `👉 Please ensure your user account has write permissions to this directory.\n` +
        `Details: ${detail}`,
    };
  }
}

/**
 * Comprehensive startup bootloader healthcheck.
 */
export async function runHealthcheck(options: HealthcheckOptions = {}): Promise<HealthcheckResult> {
  const workspacePath = options.workspacePath ?? process.cwd();
  const silent = options.silent ?? false;

  if (!silent) {
    console.log(`${BOLD}🔍 Running Memory Bank System Healthcheck...${RESET}`);
  }

  // 1. Environment validation
  let envOk = true;
  let envError: string | undefined;
  try {
    validateEnv();
    if (!silent) {
      console.log(`  ${GREEN}✔${RESET} Environment variables validated`);
    }
  } catch (err) {
    envOk = false;
    envError = err instanceof Error ? err.message : String(err);
    if (!silent) {
      console.error(`${RED}${envError}${RESET}`);
    }
  }

  // 2. Git check
  const git = checkGit();
  if (git.ok) {
    if (!silent) {
      console.log(`  ${GREEN}✔${RESET} Git available (${git.version})`);
    }
  } else {
    if (!silent) {
      console.error(`  ${RED}✖ ${git.error}${RESET}`);
    }
  }

  // 3. Docker check
  const docker = checkDocker(silent);
  if (docker.ok && !silent) {
    console.log(`  ${GREEN}✔${RESET} Docker daemon running`);
  }

  // 4. Workspace write check
  const workspaceWrite = checkWorkspaceWrite(workspacePath);
  if (workspaceWrite.ok) {
    if (!silent) {
      console.log(`  ${GREEN}✔${RESET} Workspace write permissions verified (${resolve(workspacePath)})`);
    }
  } else {
    if (!silent) {
      console.error(`  ${RED}✖ ${workspaceWrite.error}${RESET}`);
    }
  }

  const overallOk = git.ok && workspaceWrite.ok && envOk;

  if (!silent) {
    if (overallOk) {
      console.log(`${GREEN}${BOLD}✔ System healthcheck passed! Memory Bank is ready to start.${RESET}\n`);
    } else {
      console.error(`${RED}${BOLD}✖ Startup healthcheck failed. Please resolve the errors above.${RESET}\n`);
    }
  }

  return {
    ok: overallOk,
    git,
    docker,
    workspaceWrite,
    env: { ok: envOk, ...(envError ? { error: envError } : {}) },
  };
}

// Direct execution entry point (e.g., via `node dist/cli/healthcheck.js` or `npm run bootstrap`)
const isDirectCli =
  typeof process.argv[1] === "string" &&
  (process.argv[1].endsWith("healthcheck.ts") ||
    process.argv[1].endsWith("healthcheck.js") ||
    process.argv[1].endsWith("healthcheck"));

if (isDirectCli) {
  runHealthcheck()
    .then((result) => {
      if (!result.ok) {
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error(`${RED}Healthcheck encountered an unexpected error:${RESET}`, err);
      process.exit(1);
    });
}

