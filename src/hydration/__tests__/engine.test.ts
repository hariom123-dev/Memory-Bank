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
});
