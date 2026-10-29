import type { WeightedDecision } from "../swarm/types.js";
import type { CodeSnapshotEntity } from "../db/relational.js";
import type { EpochSummaryEntity } from "../db/summarizer.js";

export interface HydrationOptions {
  tokenBudget?: number; // default 10,000
  recentDecisionsWindowMs?: number; // default 24 hours (86,400,000 ms)
  filterRecentWindow?: boolean; // default false unless requested or epochs present
}

export interface HydrateFilterOptions {
  filterRecentWindow?: boolean;
  now?: number;
  recentDecisionsWindowMs?: number;
}

export interface HydratedContext {
  markdown: string;
  totalTokensEstimated: number;
  decisionsIncluded: number;
  snapshotsIncluded: number;
  epochsIncluded: number;
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
  private recentDecisionsWindowMs: number;
  private filterRecentWindow: boolean;

  constructor(options: HydrationOptions = {}) {
    this.defaultTokenBudget = options.tokenBudget ?? 10000;
    this.recentDecisionsWindowMs = options.recentDecisionsWindowMs ?? 24 * 60 * 60 * 1000; // 24 hours
    this.filterRecentWindow = options.filterRecentWindow ?? false;
  }

  /**
   * Hydrates context for AI agents:
   * 1. Injects dense EpochSummary memories first to provide high-level historical context.
   * 2. Uses granular ArchitecturalDecisions only for recent work (last 24 hours).
   * 3. Appends structural AST snapshots.
   * 4. Strictly adheres to the token budget.
   */
  hydrate(
    query: string,
    decisions: WeightedDecision[],
    snapshots: CodeSnapshotEntity[] = [],
    epochSummaries: EpochSummaryEntity[] = [],
    customBudget?: number,
    options?: HydrateFilterOptions
  ): HydratedContext {
    const budget = customBudget ?? this.defaultTokenBudget;
    let tokensUsed = 0;
    let isTruncated = false;
    let decisionsIncluded = 0;
    let snapshotsIncluded = 0;
    let epochsIncluded = 0;

    const lines: string[] = [];

    // 1. Header (reserved ~50 tokens)
    const header = [
      `# Memory Bank Hydrated Context`,
      `**Query:** \`${query}\` | **Token Budget:** ${budget}`,
      "",
    ].join("\n");

    tokensUsed += estimateTokens(header);
    lines.push(header);

    // 2. INJECT DENSE EPOCH SUMMARIES FIRST (Historical milestones)
    if (epochSummaries.length > 0 && tokensUsed < budget) {
      lines.push("## Dense Epoch Summaries (Historical Memory)");
      tokensUsed += estimateTokens("## Dense Epoch Summaries (Historical Memory)\n");

      // Sort epochs descending by recency
      const sortedEpochs = [...epochSummaries].sort(
        (a, b) => b.lastDecisionAt - a.lastDecisionAt
      );

      for (const epoch of sortedEpochs) {
        const timeframe = `${new Date(epoch.firstDecisionAt).toLocaleDateString()} - ${new Date(epoch.lastDecisionAt).toLocaleDateString()}`;
        const filesFormatted =
          epoch.impactedFiles.slice(0, 10).map((f) => `\`${f}\``).join(", ") || "None";
        const keyPoints = epoch.keyDecisions
          .slice(0, 5)
          .map((kd) => `  - ${kd}`)
          .join("\n");

        const epochText = [
          `### [EPOCH: ${epoch.sessionId}] ${epoch.decisionCount} Decisions (${timeframe})`,
          `- **Agent:** \`${epoch.agentId}\` | **Decisions Compressed:** ${epoch.decisionCount}`,
          `- **Summary:** ${epoch.summary}`,
          `- **Impacted Files:** ${filesFormatted}${epoch.impactedFiles.length > 10 ? ` ... (+${epoch.impactedFiles.length - 10} more)` : ""}`,
          keyPoints ? `- **Key Decisions:**\n${keyPoints}` : "",
          "",
        ].filter(Boolean).join("\n");

        const epochTokens = estimateTokens(epochText);
        if (tokensUsed + epochTokens <= budget) {
          tokensUsed += epochTokens;
          lines.push(epochText);
          epochsIncluded++;
        } else {
          isTruncated = true;
          break;
        }
      }
    }

    // 3. GRANULAR ARCHITECTURAL DECISIONS (LAST 24 HOURS OF WORK)
    const shouldFilter =
      options?.filterRecentWindow ??
      (this.filterRecentWindow || epochSummaries.length > 0);
    const windowMs =
      options?.recentDecisionsWindowMs ?? this.recentDecisionsWindowMs;
    const now = options?.now ?? Date.now();
    const cutoff = now - windowMs;

    const candidateDecisions = shouldFilter
      ? decisions.filter((d) => d.decision.createdAt >= cutoff)
      : decisions;

    const sortedDecisions = [...candidateDecisions].sort((a, b) => {
      // Prioritize primary agent decisions, then weighted score, then recency
      if (a.attribution !== b.attribution) {
        return a.attribution === "primary" ? -1 : 1;
      }
      if (b.weightedScore !== a.weightedScore) {
        return b.weightedScore - a.weightedScore;
      }
      return b.decision.createdAt - a.decision.createdAt;
    });

    if (sortedDecisions.length > 0 && tokensUsed < budget) {
      const sectionTitle = shouldFilter
        ? "## Architectural Decisions (Last 24 Hours)"
        : "## Architectural Decisions";

      lines.push(sectionTitle);
      tokensUsed += estimateTokens(`${sectionTitle}\n`);

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
    }

    // 4. Exact Structural AST Snapshots
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
      epochsIncluded,
      isTruncated,
    };
  }
}
