import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MultiAgentMultiplexer } from "../multiplexer.js";
import { SwarmDatabase } from "../database.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Phase 11: Multi-Agent Session Multiplexer", () => {
  let tempDir: string;
  let dbPath: string;
  let multiplexer: MultiAgentMultiplexer;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "memory-bank-swarm-"));
    dbPath = join(tempDir, "swarm-test.sqlite");
    multiplexer = new MultiAgentMultiplexer({ dbPath, inMemory: false });
  });

  afterEach(() => {
    multiplexer.close();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error on windows locks
    }
  });

  it("configures SQLite with WAL mode and pragmas", () => {
    const rawDb = multiplexer.getDatabase().getRawDatabase();
    const journalMode = rawDb.pragma("journal_mode", { simple: true });
    expect(journalMode).toBe("wal");

    const busyTimeout = rawDb.pragma("busy_timeout", { simple: true });
    expect(busyTimeout).toBe(5000);
  });

  it("handles concurrent writes from multiple agents in parallel without database locks", async () => {
    const agentRoles = [
      { id: "coder-agent", role: "Coder" },
      { id: "reviewer-agent", role: "Reviewer" },
      { id: "qa-agent", role: "QA Engineer" },
      { id: "security-agent", role: "Security Auditor" },
    ];

    // Simulate 20 concurrent write requests across the 4 agents
    const writePromises = Array.from({ length: 20 }, (_, idx) => {
      const agent = agentRoles[idx % agentRoles.length]!;
      return Promise.resolve().then(() => {
        return multiplexer.storeDecision({
          agentId: agent.id,
          sessionId: `sess-${agent.id}-${idx}`,
          contextSummary: `Architectural decision #${idx} by ${agent.role}`,
          reasoning: `Selected algorithm variant ${idx} for optimal throughput`,
          filePaths: [`src/core/worker_${idx}.ts`],
          astFootprint: { functions: [`handleJob_${idx}`] },
        });
      });
    });

    const results = await Promise.all(writePromises);
    expect(results.length).toBe(20);

    const coderDecisions = multiplexer.getDecisionsByAgent("coder-agent");
    const reviewerDecisions = multiplexer.getDecisionsByAgent("reviewer-agent");

    expect(coderDecisions.length).toBe(5);
    expect(reviewerDecisions.length).toBe(5);
  });

  it("retrieves context heavily weighting requesting agent's decisions over peer agents", () => {
    // 1. Coder stores decision regarding auth token encryption
    multiplexer.storeDecision({
      agentId: "coder-agent",
      sessionId: "session-coder-1",
      contextSummary: "Implemented JWT auth token encryption using AES-GCM",
      reasoning: "AES-GCM provides authenticated encryption to prevent token tampering",
      filePaths: ["src/auth/token.ts"],
    });

    // 2. Reviewer stores decision on the same topic
    multiplexer.storeDecision({
      agentId: "reviewer-agent",
      sessionId: "session-reviewer-1",
      contextSummary: "Reviewed JWT auth token encryption recommendations",
      reasoning: "Recommended rotating AES-GCM keys every 30 days and enforcing short token expiry",
      filePaths: ["src/auth/token.ts", "src/auth/audit.ts"],
    });

    // When coder asks about "auth token encryption":
    const coderContext = multiplexer.retrieveWeightedContext({
      agentId: "coder-agent",
      query: "auth token encryption",
    });

    expect(coderContext.decisions.length).toBe(2);
    // Coder's own decision must have higher weighted score
    const topDecisionForCoder = coderContext.decisions[0];
    expect(topDecisionForCoder?.originAgentId).toBe("coder-agent");
    expect(topDecisionForCoder?.attribution).toBe("primary");
    expect(topDecisionForCoder?.isOwnDecision).toBe(true);

    const peerDecisionForCoder = coderContext.decisions[1];
    expect(peerDecisionForCoder?.originAgentId).toBe("reviewer-agent");
    expect(peerDecisionForCoder?.attribution).toBe("peer");
    expect(peerDecisionForCoder?.weightedScore).toBeLessThan(topDecisionForCoder!.weightedScore);

    // Conversely, when reviewer asks for the exact same query:
    const reviewerContext = multiplexer.retrieveWeightedContext({
      agentId: "reviewer-agent",
      query: "auth token encryption",
    });

    // Reviewer's own decision ranks first for reviewer
    expect(reviewerContext.decisions[0]?.originAgentId).toBe("reviewer-agent");
    expect(reviewerContext.decisions[0]?.attribution).toBe("primary");
    expect(reviewerContext.decisions[1]?.originAgentId).toBe("coder-agent");
    expect(reviewerContext.decisions[1]?.attribution).toBe("peer");
  });

  it("generates markdown summary with primary vs peer swarm attributions", () => {
    multiplexer.storeDecision({
      agentId: "coder-agent",
      sessionId: "s1",
      contextSummary: "Added SQLite WAL connection pool",
      reasoning: "WAL mode avoids locking database during concurrent agent writes",
      filePaths: ["src/db/sqlite.ts"],
    });

    multiplexer.storeDecision({
      agentId: "devops-agent",
      sessionId: "s2",
      contextSummary: "Configured SQLite checkpoint schedule",
      reasoning: "Triggers passive WAL truncation periodically",
      filePaths: ["src/db/cron.ts"],
    });

    const context = multiplexer.retrieveWeightedContext({
      agentId: "coder-agent",
      query: "SQLite WAL mode",
    });

    expect(context.markdownSummary).toContain("## Primary Context (Your Decisions)");
    expect(context.markdownSummary).toContain("## Cross-Agent Swarm Knowledge (Read-Only Peer Context)");
    expect(context.markdownSummary).toContain("[PEER: `devops-agent`]");
    expect(context.markdownSummary).toContain("0.5x Peer Discount");
  });

  it("calculates similarity accurately using cosine vector embeddings when provided", () => {
    const vector1 = [1.0, 0.0, 0.0];
    const vector2 = [0.0, 1.0, 0.0];

    multiplexer.storeDecision({
      agentId: "coder-agent",
      sessionId: "s-vec-1",
      contextSummary: "Vector decision A",
      reasoning: "Reasoning A",
      embedding: vector1,
    });

    multiplexer.storeDecision({
      agentId: "reviewer-agent",
      sessionId: "s-vec-2",
      contextSummary: "Vector decision B",
      reasoning: "Reasoning B",
      embedding: vector2,
    });

    // Query with vector matching vector1
    const queryVector = [1.0, 0.0, 0.0];
    const result = multiplexer.retrieveWeightedContext(
      { agentId: "reviewer-agent", query: "query", threshold: 0 },
      queryVector
    );

    // Decision A is orthogonal to vector2, so Decision A has cosine similarity 1.0
    const decisionA = result.decisions.find((d) => d.decision.contextSummary === "Vector decision A");
    const decisionB = result.decisions.find((d) => d.decision.contextSummary === "Vector decision B");

    expect(decisionA?.rawScore).toBeCloseTo(1.0, 3);
    expect(decisionB?.rawScore).toBeCloseTo(0.0, 3);
  });

  it("tracks and retrieves active agent sessions", () => {
    multiplexer.registerSession("agent-alpha", "session-alpha-1", "Planner");
    multiplexer.registerSession("agent-beta", "session-beta-1", "Executor");

    const sessions = multiplexer.getActiveSessions();
    expect(sessions.length).toBe(2);

    const alphaSession = sessions.find((s) => s.agentId === "agent-alpha");
    expect(alphaSession?.role).toBe("Planner");
  });

  it("adheres to ITransactionalResource lifecycle requirements", () => {
    expect(multiplexer.name).toBe("multi-agent-multiplexer");
    expect(multiplexer.hasActiveTransaction()).toBe(false);

    // commit checkpoint
    expect(() => multiplexer.commitActiveTransactions()).not.toThrow();
  });
});
