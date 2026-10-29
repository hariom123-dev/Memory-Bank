import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

export interface DaemonizeOptions {
  pidFilePath?: string;
}

export class DaemonProcessManager {
  private pidFilePath: string;

  constructor(options: DaemonizeOptions = {}) {
    this.pidFilePath = options.pidFilePath
      ? resolve(options.pidFilePath)
      : resolve(homedir(), ".memory-bank", "daemon.pid");
  }

  getPidFilePath(): string {
    return this.pidFilePath;
  }

  getPid(): number | null {
    if (!existsSync(this.pidFilePath)) {
      return null;
    }

    try {
      const pidStr = readFileSync(this.pidFilePath, "utf-8").trim();
      const pid = parseInt(pidStr, 10);
      return Number.isNaN(pid) ? null : pid;
    } catch {
      return null;
    }
  }

  writePid(pid: number): void {
    const dir = dirname(this.pidFilePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.pidFilePath, String(pid), "utf-8");
  }

  removePid(): void {
    if (existsSync(this.pidFilePath)) {
      try {
        unlinkSync(this.pidFilePath);
      } catch {
        // ignore
      }
    }
  }

  isProcessAlive(pid: number): boolean {
    try {
      // Signal 0 tests for process existence without killing it
      process.kill(pid, 0);
      return true;
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      return error.code === "EPERM"; // Exists but no permission to kill
    }
  }

  isDaemonRunning(): boolean {
    const pid = this.getPid();
    if (!pid) return false;

    const alive = this.isProcessAlive(pid);
    if (!alive) {
      // Stale PID file
      this.removePid();
      return false;
    }
    return true;
  }

  startDaemon(
    entryScript: string,
    args: string[] = []
  ): { pid: number; status: "started" | "already_running" } {
    if (this.isDaemonRunning()) {
      const existingPid = this.getPid()!;
      return { pid: existingPid, status: "already_running" };
    }

    const scriptPath = resolve(entryScript);
    const child = spawn(process.execPath, [scriptPath, ...args], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });

    const pid = child.pid;
    if (!pid) {
      throw new Error("Failed to spawn detached daemon process.");
    }

    child.unref();
    this.writePid(pid);

    return { pid, status: "started" };
  }

  stopDaemon(): { status: "stopped" | "not_running"; pid?: number } {
    const pid = this.getPid();
    if (!pid || !this.isProcessAlive(pid)) {
      this.removePid();
      return { status: "not_running" };
    }

    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ignore
    }

    this.removePid();
    return { status: "stopped", pid };
  }

  statusDaemon(): { running: boolean; pid: number | null } {
    const running = this.isDaemonRunning();
    const pid = running ? this.getPid() : null;
    return { running, pid };
  }
}
