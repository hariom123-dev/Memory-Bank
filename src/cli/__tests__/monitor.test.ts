import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TerminalMonitorDashboard } from "../monitor.js";
import { TypedEventBus } from "../../events/bus.js";
import type { MemoryBankEventMap } from "../../events/types.js";
import { MemoryRepository } from "../../db/relational.js";

describe("Phase 10: The Local Terminal UI (TUI) Monitor", () => {
  let bus: TypedEventBus<MemoryBankEventMap>;
  let repo: MemoryRepository;
  let monitor: TerminalMonitorDashboard;

  beforeEach(() => {
    bus = new TypedEventBus<MemoryBankEventMap>();
    repo = new MemoryRepository({ inMemory: true });
    monitor = new TerminalMonitorDashboard({
      bus,
      repository: repo,
    });
    monitor.start();
  });

  afterEach(() => {
    monitor.stop();
    repo.close();
  });

  it("subscribes to live events and renders a formatted terminal snapshot", async () => {
    await bus.publish("MEMORY_INGESTED", {
      sessionId: "s1",
      sourceFile: "src/auth.ts",
      astFootprint: {},
      summary: "Implemented JWT Auth",
      timestamp: Date.now(),
    });

    const snapshot = monitor.renderSnapshot();

    expect(snapshot).toContain("MEMORY BANK - AGENT SWARM OS MONITOR");
    expect(snapshot).toContain("[Daemon State]:     LISTENING");
    expect(snapshot).toContain("MEMORY_INGESTED");
    expect(snapshot).toContain("src/auth.ts - Implemented JWT Auth");
  });

  it("tracks database counts in metrics", () => {
    repo.insertSession({ id: "s1", agentId: "a1", createdAt: 1, lastActiveAt: 1 });
    repo.insertDecision({
      id: "d1",
      sessionId: "s1",
      agentId: "a1",
      contextSummary: "decision 1",
      reasoning: "reasoning",
      filePaths: ["f1"],
      createdAt: 1,
    });

    const metrics = monitor.getMetrics();
    expect(metrics.totalDecisions).toBe(1);
  });
});
