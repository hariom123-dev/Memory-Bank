import { randomUUID } from "node:crypto";
import { SwarmDatabase, type DatabaseOptions } from "./database.js";
import type {
  AgentSession,
  StoreDecisionParams,
  StoredDecision,
  RetrieveContextParams,
  WeightedDecision,
  MultiplexedContextResult,
  MultiplexerConfig,
} from "./types.js";
import type { ILogger, ITransactionalResource } from "../daemon/types.js";

function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length || vecA.length === 0) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    const a = vecA[i] ?? 0;
    const b = vecB[i] ?? 0;
    dotProduct += a * b;
    normA += a * a;
    normB += b * b;
  }
  if (normA === 0 || normB === 0) return 0;
  return Math.max(0, dotProduct / (Math.sqrt(normA) * Math.sqrt(normB)));
}

function calculateLexicalMatch(query: string, text: string): number {
  const queryWords = query.toLowerCase().split(/\W+/).filter((w) => w.length > 1);
  if (queryWords.length === 0) return 0.5;
  const lowerText = text.toLowerCase();
  let matches = 0;
  for (const word of queryWords) {
    if (lowerText.includes(word)) {
      matches++;
    }
  }
  return matches / queryWords.length;
}

export class MultiAgentMultiplexer implements ITransactionalResource {
  public readonly name = "multi-agent-multiplexer";
  private db: SwarmDatabase;
  private config: MultiplexerConfig;
  private logger?: ILogger | undefined;

  constructor(
    dbOrOptions?: SwarmDatabase | DatabaseOptions,
    config: Partial<MultiplexerConfig> = {},
    logger?: ILogger | undefined
  ) {
    if (dbOrOptions instanceof SwarmDatabase) {
      this.db = dbOrOptions;
    } else {
      this.db = new SwarmDatabase(dbOrOptions);
    }

    this.config = {
      ownAgentWeight: config.ownAgentWeight ?? 1.0,
      peerAgentWeight: config.peerAgentWeight ?? 0.5,
      maxResults: config.maxResults ?? 10,
      walBusyTimeoutMs: config.walBusyTimeoutMs ?? 5000,
    };
    this.logger = logger;
  }

  getDatabase(): SwarmDatabase {
    return this.db;
  }

  hasActiveTransaction(): boolean {
    return this.db.hasActiveTransaction();
  }

  commitActiveTransactions(): void {
    this.db.commitActiveTransactions();
  }

  close(): void {
    this.db.close();
  }

  /**
   * Registers or updates an active session for an agent in the swarm.
   */
  registerSession(agentId: string, sessionId: string, role?: string): AgentSession {
    const now = Date.now();
    const rawDb = this.db.getRawDatabase();

    const existing = rawDb
      .prepare<[string]>("SELECT * FROM Sessions WHERE id = ?")
      .get(sessionId) as {
      id: string;
      agent_id: string;
      role: string | null;
      created_at: number;
      last_active_at: number;
    } | undefined;

    if (existing) {
      rawDb
        .prepare<[number, string]>("UPDATE Sessions SET last_active_at = ? WHERE id = ?")
        .run(now, sessionId);

      return {
        sessionId: existing.id,
        agentId: existing.agent_id,
        ...(existing.role ? { role: existing.role } : {}),
        createdAt: existing.created_at,
        lastActiveAt: now,
      };
    }

    rawDb
      .prepare<[string, string, string | null, number, number]>(
        "INSERT INTO Sessions (id, agent_id, role, created_at, last_active_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(sessionId, agentId, role ?? null, now, now);

    return {
      sessionId,
      agentId,
      ...(role ? { role } : {}),
      createdAt: now,
      lastActiveAt: now,
    };
  }

  /**
   * Stores an architectural decision partitioned by agentId and sessionId.
   * Executes safely in WAL mode, recording optional AST snapshots.
   */
  storeDecision(params: StoreDecisionParams): StoredDecision {
    const { agentId, sessionId, contextSummary, reasoning, filePaths, astFootprint, embedding } = params;
    const now = Date.now();
    const decisionId = `dec_${randomUUID()}`;
    const pathsArray = filePaths ?? [];

    this.db.runInTransaction((rawDb) => {
      // Ensure session exists
      this.registerSession(agentId, sessionId);

      // Insert decision
      rawDb
        .prepare<[string, string, string, string, string, string, string | null, number]>(
          `INSERT INTO ArchitecturalDecisions
           (id, session_id, agent_id, context_summary, reasoning, file_paths, embedding, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          decisionId,
          sessionId,
          agentId,
          contextSummary,
          reasoning,
          JSON.stringify(pathsArray),
          embedding ? JSON.stringify(embedding) : null,
          now
        );

      // Insert AST Snapshot if provided
      if (astFootprint) {
        const snapshotId = `snap_${randomUUID()}`;
        const targetPath = pathsArray[0] ?? "unknown";
        const astString =
          typeof astFootprint === "string" ? astFootprint : JSON.stringify(astFootprint);

        rawDb
          .prepare<[string, string, string, string, number]>(
            `INSERT INTO CodeSnapshots (id, decision_id, file_path, ast_json, created_at)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(snapshotId, decisionId, targetPath, astString, now);
      }
    });

    this.logger?.info(`Stored architectural decision ${decisionId} for agent ${agentId}`);

    return {
      id: decisionId,
      sessionId,
      agentId,
      contextSummary,
      reasoning,
      filePaths: pathsArray,
      createdAt: now,
      ...(astFootprint ? { astFootprint } : {}),
      ...(embedding ? { embedding } : {}),
    };
  }

  /**
   * Retrieves context heavily weighting decisions made by the requesting agent,
   * while incorporating read-only, lower-weighted context from other swarm agents.
   */
  retrieveWeightedContext(
    params: RetrieveContextParams,
    queryEmbedding?: number[]
  ): MultiplexedContextResult {
    const { agentId, query, limit } = params;
    const maxResults = limit ?? this.config.maxResults;
    const rawDb = this.db.getRawDatabase();

    interface RawDecisionRow {
      id: string;
      session_id: string;
      agent_id: string;
      context_summary: string;
      reasoning: string;
      file_paths: string;
      embedding: string | null;
      created_at: number;
      ast_json: string | null;
    }

    const rows = rawDb
      .prepare<[]>(
        `SELECT d.*, s.ast_json
         FROM ArchitecturalDecisions d
         LEFT JOIN CodeSnapshots s ON s.decision_id = d.id
         ORDER BY d.created_at DESC`
      )
      .all() as RawDecisionRow[];

    const scoredDecisions: WeightedDecision[] = [];

    for (const row of rows) {
      const isOwnDecision = row.agent_id === agentId;
      const weight = isOwnDecision ? this.config.ownAgentWeight : this.config.peerAgentWeight;

      let rawScore = 0;
      let embeddingVec: number[] | undefined;

      if (row.embedding) {
        try {
          embeddingVec = JSON.parse(row.embedding) as number[];
        } catch {
          // ignore corrupted embedding
        }
      }

      if (queryEmbedding && embeddingVec && embeddingVec.length === queryEmbedding.length) {
        rawScore = cosineSimilarity(queryEmbedding, embeddingVec);
      } else {
        const textToMatch = `${row.context_summary} ${row.reasoning}`;
        rawScore = calculateLexicalMatch(query, textToMatch);
      }

      // Minimum relevance threshold
      if (rawScore >= (params.threshold ?? 0.05)) {
        let filePaths: string[] = [];
        try {
          filePaths = JSON.parse(row.file_paths) as string[];
        } catch {
          filePaths = [row.file_paths];
        }

        const decision: StoredDecision = {
          id: row.id,
          sessionId: row.session_id,
          agentId: row.agent_id,
          contextSummary: row.context_summary,
          reasoning: row.reasoning,
          filePaths,
          createdAt: row.created_at,
          ...(row.ast_json ? { astFootprint: row.ast_json } : {}),
          ...(embeddingVec ? { embedding: embeddingVec } : {}),
        };

        scoredDecisions.push({
          decision,
          rawScore,
          weightedScore: Number((rawScore * weight).toFixed(4)),
          isOwnDecision,
          originAgentId: row.agent_id,
          attribution: isOwnDecision ? "primary" : "peer",
        });
      }
    }

    // Sort descending by weighted score
    scoredDecisions.sort((a, b) => b.weightedScore - a.weightedScore);
    const topResults = scoredDecisions.slice(0, maxResults);

    // Format Markdown summary
    const markdownSummary = this.formatContextMarkdown(agentId, query, topResults);

    return {
      requestingAgentId: agentId,
      query,
      decisions: topResults,
      markdownSummary,
    };
  }

  getDecisionsByAgent(agentId: string): StoredDecision[] {
    const rawDb = this.db.getRawDatabase();
    interface RawRow {
      id: string;
      session_id: string;
      agent_id: string;
      context_summary: string;
      reasoning: string;
      file_paths: string;
      created_at: number;
    }

    const rows = rawDb
      .prepare<[string]>(
        "SELECT * FROM ArchitecturalDecisions WHERE agent_id = ? ORDER BY created_at DESC"
      )
      .all(agentId) as RawRow[];

    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      agentId: r.agent_id,
      contextSummary: r.context_summary,
      reasoning: r.reasoning,
      filePaths: JSON.parse(r.file_paths) as string[],
      createdAt: r.created_at,
    }));
  }

  getActiveSessions(): AgentSession[] {
    const rawDb = this.db.getRawDatabase();
    interface SessionRow {
      id: string;
      agent_id: string;
      role: string | null;
      created_at: number;
      last_active_at: number;
    }

    const rows = rawDb
      .prepare<[]>("SELECT * FROM Sessions ORDER BY last_active_at DESC")
      .all() as SessionRow[];

    return rows.map((r) => ({
      sessionId: r.id,
      agentId: r.agent_id,
      ...(r.role ? { role: r.role } : {}),
      createdAt: r.created_at,
      lastActiveAt: r.last_active_at,
    }));
  }

  private formatContextMarkdown(
    agentId: string,
    query: string,
    results: WeightedDecision[]
  ): string {
    const lines: string[] = [
      `# Swarm Memory Context [Query: "${query}"]`,
      `**Requesting Agent:** \`${agentId}\` | **Matches Retrieved:** ${results.length}`,
      "",
    ];

    const primaryDecisions = results.filter((r) => r.attribution === "primary");
    const peerDecisions = results.filter((r) => r.attribution === "peer");

    if (primaryDecisions.length > 0) {
      lines.push("## Primary Context (Your Decisions)");
      for (const item of primaryDecisions) {
        lines.push(`### [${item.decision.id}] ${item.decision.contextSummary}`);
        lines.push(`- **Relevance:** Raw: ${item.rawScore.toFixed(2)} | Weighted: ${item.weightedScore.toFixed(2)}`);
        lines.push(`- **Reasoning:** ${item.decision.reasoning}`);
        lines.push(`- **Files:** ${item.decision.filePaths.map((f) => `\`${f}\``).join(", ") || "None"}`);
        lines.push("");
      }
    }

    if (peerDecisions.length > 0) {
      lines.push("## Cross-Agent Swarm Knowledge (Read-Only Peer Context)");
      for (const item of peerDecisions) {
        lines.push(`### [PEER: \`${item.originAgentId}\`] ${item.decision.contextSummary}`);
        lines.push(`- **Relevance:** Raw: ${item.rawScore.toFixed(2)} | Weighted: ${item.weightedScore.toFixed(2)} (0.5x Peer Discount)`);
        lines.push(`- **Reasoning:** ${item.decision.reasoning}`);
        lines.push(`- **Files:** ${item.decision.filePaths.map((f) => `\`${f}\``).join(", ") || "None"}`);
        lines.push("");
      }
    }

    if (results.length === 0) {
      lines.push("*No matching architectural decisions found.*");
    }

    return lines.join("\n");
  }
}
