import type { WeightedDecision } from "../swarm/types.js";
import type { CodeSnapshotEntity } from "../db/relational.js";

export interface HydrationOptions {
  tokenBudget?: number; // default 10,000
}

export interface HydratedContext {
  markdown: string;
  totalTokensEstimated: number;
  decisionsIncluded: number;
  snapshotsIncluded: number;
  isTruncated: boolean;
}

/**
 * Estimates token count using standard ~4 characters per token heuristic
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export class ContextHydrationEngine {
  private defaultTokenBudget: number;

  constructor(options: HydrationOptions = {}) {
    this.defaultTokenBudget = options.tokenBudget ?? 10000;
  }

  /**
   * Hydrates raw decisions and AST snapshots into a prompt-ready markdown string
   * strictly adhering to the token budget.
   */
  hydrate(
    query: string,
    decisions: WeightedDecision[],
    snapshots: CodeSnapshotEntity[] = [],
    customBudget?: number
  ): HydratedContext {
    const budget = customBudget ?? this.defaultTokenBudget;
    let tokensUsed = 0;
    let isTruncated = false;
    let decisionsIncluded = 0;
    let snapshotsIncluded = 0;

    const lines: string[] = [];

    // 1. Header (reserved ~50 tokens)
    const header = [
      `# Memory Bus Hydrated Context`,
      `**Query:** \`${query}\` | **Token Budget:** ${budget}`,
      "",
    ].join("\n");

    tokensUsed += estimateTokens(header);
    lines.push(header);

    // 2. Prioritize Recent & High-Weight Architectural Decisions
    const sortedDecisions = [...decisions].sort((a, b) => {
      // Prioritize primary agent decisions, then weighted score, then recency
      if (a.attribution !== b.attribution) {
        return a.attribution === "primary" ? -1 : 1;
      }
      if (b.weightedScore !== a.weightedScore) {
        return b.weightedScore - a.weightedScore;
      }
      return b.decision.createdAt - a.decision.createdAt;
    });

    lines.push("## Architectural Decisions");
    tokensUsed += estimateTokens("## Architectural Decisions\n");

    for (const item of sortedDecisions) {
      const decisionText = [
        `### [${item.attribution.toUpperCase()}] ${item.decision.contextSummary}`,
        `- **Agent:** \`${item.originAgentId}\` | **Relevance:** ${item.weightedScore.toFixed(2)}`,
        `- **Reasoning:** ${item.decision.reasoning}`,
        `- **Files:** ${item.decision.filePaths.map((f) => `\`${f}\``).join(", ") || "None"}`,
        "",
      ].join("\n");

      const itemTokens = estimateTokens(decisionText);
      if (tokensUsed + itemTokens <= budget) {
        tokensUsed += itemTokens;
        lines.push(decisionText);
        decisionsIncluded++;
      } else {
        isTruncated = true;
        break;
      }
    }

    // 3. Exact AST Snapshots
    if (snapshots.length > 0 && tokensUsed < budget) {
      lines.push("## Structural AST Snapshots");
      tokensUsed += estimateTokens("## Structural AST Snapshots\n");

      for (const snap of snapshots) {
        const astString =
          typeof snap.astJson === "string"
            ? snap.astJson
            : JSON.stringify(snap.astJson, null, 2);

        const snapText = [
          `#### File: \`${snap.filePath}\``,
          "```json",
          astString,
          "```",
          "",
        ].join("\n");

        const snapTokens = estimateTokens(snapText);
        if (tokensUsed + snapTokens <= budget) {
          tokensUsed += snapTokens;
          lines.push(snapText);
          snapshotsIncluded++;
        } else {
          isTruncated = true;
          break;
        }
      }
    }

    if (isTruncated) {
      lines.push(`\n> [!NOTE]\n> *Context truncated to adhere to the ${budget} token budget.*`);
      tokensUsed += estimateTokens(`\n> [!NOTE]\n> *Context truncated to adhere to the ${budget} token budget.*`);
    }

    return {
      markdown: lines.join("\n"),
      totalTokensEstimated: tokensUsed,
      decisionsIncluded,
      snapshotsIncluded,
      isTruncated,
    };
  }
}
