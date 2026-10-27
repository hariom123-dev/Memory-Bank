import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DaemonProcessManager } from "../daemonize.js";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Phase 14: OS-Level Daemonization", () => {
  let tempDir: string;
  let pidFile: string;
  let manager: DaemonProcessManager;

  beforeEach(() => {
    tempDir = join(tmpdir(), `mb-daemon-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    pidFile = join(tempDir, "test-daemon.pid");
    manager = new DaemonProcessManager({ pidFilePath: pidFile });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("writes, reads, and removes PID files", () => {
    expect(manager.getPid()).toBeNull();

    manager.writePid(12345);
    expect(existsSync(pidFile)).toBe(true);
    expect(manager.getPid()).toBe(12345);

    manager.removePid();
    expect(existsSync(pidFile)).toBe(false);
    expect(manager.getPid()).toBeNull();
  });

  it("detects current process as alive and non-existent pid as not running", () => {
    // Current process is alive
    expect(manager.isProcessAlive(process.pid)).toBe(true);

    // Write a dummy dead pid (e.g. 99999999)
    manager.writePid(99999999);
    // Should detect stale PID and clean it up
    expect(manager.isDaemonRunning()).toBe(false);
    expect(manager.getPid()).toBeNull();
  });

  it("reports status cleanly", () => {
    const status = manager.statusDaemon();
    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();
  });
});
