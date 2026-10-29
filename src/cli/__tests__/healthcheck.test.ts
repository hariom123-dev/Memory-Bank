import { describe, it, expect, vi } from "vitest";
import {
  checkGit,
  checkDocker,
  checkWorkspaceWrite,
  runHealthcheck,
} from "../healthcheck.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

describe("Phase DevEx: Healthcheck Bootloader", () => {
  it("verifies Git accessibility in system PATH", () => {
    const result = checkGit();
    expect(result.ok).toBe(true);
    expect(result.version).toMatch(/git version/i);
  });

  it("handles Docker check gracefully with yellow terminal warning if stopped", () => {
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = checkDocker(false);
    expect(typeof result.ok).toBe("boolean");

    if (!result.ok) {
      expect(result.warning).toBe("⚠️ Docker is not running. Please start Docker Desktop.");
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("⚠️ Docker is not running. Please start Docker Desktop.")
      );
    }

    consoleWarnSpy.mockRestore();
  });

  it("verifies workspace directory write permissions", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "mb-healthcheck-"));
    try {
      const result = checkWorkspaceWrite(tempDir);
      expect(result.ok).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reports failure when workspace is not writable", () => {
    // Attempting to write inside a non-existent invalid path
    const invalidPath = join(tmpdir(), "non-existent-subpath-xyz", "nested-folder");
    const result = checkWorkspaceWrite(invalidPath);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Workspace directory is not writable");
  });

  it("runs full preflight healthcheck and returns structured result", async () => {
    const result = await runHealthcheck({ silent: true });
    expect(result.ok).toBe(true);
    expect(result.git.ok).toBe(true);
    expect(result.workspaceWrite.ok).toBe(true);
    expect(result.env.ok).toBe(true);
  });
});

