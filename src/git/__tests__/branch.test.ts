import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GitBranchManager } from "../branch-manager.js";
import { TypedEventBus } from "../../events/bus.js";
import type { MemoryBusEventMap, BranchChangedPayload } from "../../events/types.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Phase 13: Git-Branch Context Isolation", () => {
  let tempDir: string;
  let gitDir: string;
  let headFile: string;
  let bus: TypedEventBus<MemoryBusEventMap>;
  let manager: GitBranchManager;

  beforeEach(() => {
    tempDir = join(tmpdir(), `mb-git-${Date.now()}`);
    gitDir = join(tempDir, ".git");
    headFile = join(gitDir, "HEAD");
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(headFile, "ref: refs/heads/main\n");
    bus = new TypedEventBus<MemoryBusEventMap>();
    manager = new GitBranchManager({ workspaceRoot: tempDir, bus });
  });

  afterEach(() => {
    manager.stop();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("detects current active branch from .git/HEAD", () => {
    expect(manager.getCurrentBranch()).toBe("main");
  });

  it("emits BRANCH_CHANGED when checking out another branch", async () => {
    const events: BranchChangedPayload[] = [];
    bus.subscribe("BRANCH_CHANGED", (e) => {
      events.push(e);
    });

    // Simulate git checkout -b feature/auth
    writeFileSync(headFile, "ref: refs/heads/feature/auth\n");

    const changed = await manager.checkBranchChange();

    expect(changed).toBe(true);
    expect(manager.getCurrentBranch()).toBe("feature/auth");
    expect(events.length).toBe(1);
    expect(events[0]?.previousBranch).toBe("main");
    expect(events[0]?.currentBranch).toBe("feature/auth");
  });

  it("filters decisions by active branch", () => {
    const decisions = [
      { id: "1", branchName: "main" },
      { id: "2", branchName: "feature/auth" },
      { id: "3", branchName: "feature/auth" },
    ];

    const mainOnly = manager.filterByBranch(decisions, "main");
    expect(mainOnly.length).toBe(1);
    expect(mainOnly[0]?.id).toBe("1");

    const authOnly = manager.filterByBranch(decisions, "feature/auth");
    expect(authOnly.length).toBe(2);
  });
});
