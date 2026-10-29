import { describe, it, expect } from "vitest";
import { ContextHydrationEngine, estimateTokens } from "../engine.js";
import type { WeightedDecision } from "../../swarm/types.js";

describe("Phase 8: Context Hydration Engine", () => {
  it("estimates token counts conservatively", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("12345678")).toBe(2);
  });

  it("prioritizes primary decisions and fits within the 10,000 token budget", () => {
    const engine = new ContextHydrationEngine({ tokenBudget: 10000 });

    const decisions: WeightedDecision[] = [
      {
        decision: {
          id: "dec-1",
          sessionId: "s1",
          agentId: "coder",
          contextSummary: "Implemented JWT Auth",
          reasoning: "Secure stateless auth",
          filePaths: ["src/auth.ts"],
          createdAt: 1000,
        },
        rawScore: 0.9,
        weightedScore: 0.9,
        isOwnDecision: true,
        originAgentId: "coder",
        attribution: "primary",
      },
      {
        decision: {
          id: "dec-2",
          sessionId: "s2",
          agentId: "reviewer",
          contextSummary: "Code Review Notes",
          reasoning: "Checked edge cases",
          filePaths: ["src/auth.ts"],
          createdAt: 900,
        },
        rawScore: 0.8,
        weightedScore: 0.4,
        isOwnDecision: false,
        originAgentId: "reviewer",
        attribution: "peer",
      },
    ];

    const result = engine.hydrate("auth", decisions);

    expect(result.decisionsIncluded).toBe(2);
    expect(result.isTruncated).toBe(false);
    expect(result.totalTokensEstimated).toBeLessThanOrEqual(10000);
    expect(result.markdown).toContain("[PRIMARY] Implemented JWT Auth");
    expect(result.markdown).toContain("[PEER] Code Review Notes");
  });

  it("truncates decisions and includes notice when token budget is exceeded", () => {
    // Tight budget of 70 tokens
    const engine = new ContextHydrationEngine({ tokenBudget: 70 });

    const longReasoning = "A".repeat(500);
    const decisions: WeightedDecision[] = [
      {
        decision: {
          id: "dec-1",
          sessionId: "s1",
          agentId: "coder",
          contextSummary: "Large decision",
          reasoning: longReasoning,
          filePaths: ["src/large.ts"],
          createdAt: 1000,
        },
        rawScore: 0.9,
        weightedScore: 0.9,
        isOwnDecision: true,
        originAgentId: "coder",
        attribution: "primary",
      },
    ];

    const result = engine.hydrate("large query", decisions);

    expect(result.isTruncated).toBe(true);
    expect(result.markdown).toContain("Context truncated to adhere to the 70 token budget");
  });

  it("injects dense EpochSummary memories first before granular decisions", () => {
    const engine = new ContextHydrationEngine({ tokenBudget: 10000 });

    const now = Date.now();
    const epochSummaries = [
      {
        id: "epoch-1",
        sessionId: "session-1",
        agentId: "lead-architect",
        summary: "Compiled 50 foundational architecture decisions for auth & storage",
        keyDecisions: ["Configured SQLite WAL mode", "Adopted MiniLM embeddings"],
        impactedFiles: ["src/db/relational.ts", "src/auth/jwt.ts"],
        decisionCount: 50,
        firstDecisionAt: now - 7 * 24 * 60 * 60 * 1000,
        lastDecisionAt: now - 2 * 24 * 60 * 60 * 1000,
        createdAt: now - 2 * 24 * 60 * 60 * 1000,
      },
    ];

    const recentDecisions: WeightedDecision[] = [
      {
        decision: {
          id: "dec-recent",
          sessionId: "session-current",
          agentId: "coder",
          contextSummary: "Added refresh token rotation",
          reasoning: "Mitigate stolen token replay attacks",
          filePaths: ["src/auth/token.ts"],
          createdAt: now - 1 * 60 * 60 * 1000, // 1 hour ago (within 24h)
        },
        rawScore: 0.95,
        weightedScore: 0.95,
        isOwnDecision: true,
        originAgentId: "coder",
        attribution: "primary",
      },
      {
        decision: {
          id: "dec-ancient",
          sessionId: "session-ancient",
          agentId: "coder",
          contextSummary: "Initial prototype scratchpad",
          reasoning: "Quick experiment with no auth",
          filePaths: ["src/scratch.ts"],
          createdAt: now - 50 * 24 * 60 * 60 * 1000, // 50 days ago (older than 24h)
        },
        rawScore: 0.9,
        weightedScore: 0.9,
        isOwnDecision: true,
        originAgentId: "coder",
        attribution: "primary",
      },
    ];

    const result = engine.hydrate("auth design", recentDecisions, [], epochSummaries, 10000, {
      filterRecentWindow: true,
      now,
    });

    expect(result.epochsIncluded).toBe(1);
    expect(result.decisionsIncluded).toBe(1); // Only the recent one within 24h
    expect(result.markdown).toContain("Dense Epoch Summaries (Historical Memory)");
    expect(result.markdown).toContain("Compiled 50 foundational architecture decisions");
    expect(result.markdown).toContain("Added refresh token rotation");
    expect(result.markdown).not.toContain("Initial prototype scratchpad");

    // Verify ordering: Epoch summaries must appear before granular decisions in markdown
    const epochPos = result.markdown.indexOf("Dense Epoch Summaries");
    const decisionPos = result.markdown.indexOf("Architectural Decisions");
    expect(epochPos).toBeGreaterThan(-1);
    expect(decisionPos).toBeGreaterThan(epochPos);
  });
});
