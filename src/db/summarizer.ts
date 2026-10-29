import { randomUUID } from "node:crypto";
import type { Database as BetterSqliteDatabase } from "better-sqlite3";
import type { MemoryRepository } from "./relational.js";
import type { SwarmDatabase } from "../swarm/database.js";
import type { ILogger } from "../daemon/types.js";

export interface EpochSummaryEntity {
  id: string;
  sessionId: string;
  agentId: string;
  summary: string;
  keyDecisions: string[];
  impactedFiles: string[];
  decisionCount: number;
  firstDecisionAt: number;
  lastDecisionAt: number;
  embedding?: number[];
  createdAt: number;
}

export interface EpochSummarizerOptions {
  db: BetterSqliteDatabase | MemoryRepository | SwarmDatabase;
  threshold?: number; // default: 50 distinct decisions in a session
  batchSize?: number; // default: 50
  intervalMs?: number; // default: 60000ms (1 minute)
  logger?: ILogger;
  embedder?: (text: string) => Promise<number[]> | number[];
}

export interface EpochSummaryCycleResult {
  sessionsProcessed: number;
  epochsCreated: number;
  decisionsSummarized: number;
  epochSummaries: EpochSummaryEntity[];
  durationMs: number;
}

interface RawDecisionRecord {
  id: string;
  session_id: string;
  agent_id: string;
  context_summary: string;
  reasoning: string;
  file_paths: string;
  embedding: string | null;
  branch_name?: string;
  created_at: number;
}

export class EpochSummarizer {
  private db: BetterSqliteDatabase;
  private threshold: number;
  private batchSize: number;
  private intervalMs: number;
  private logger?: ILogger | undefined;
  private embedder?: ((text: string) => Promise<number[]> | number[]) | undefined;
  private intervalTimer?: NodeJS.Timeout | undefined;

  constructor(options: EpochSummarizerOptions) {
    if ("getRawDatabase" in options.db && typeof options.db.getRawDatabase === "function") {
      this.db = options.db.getRawDatabase();
    } else if ("getDatabase" in options.db && typeof options.db.getDatabase === "function") {
      this.db = options.db.getDatabase();
    } else {
      this.db = options.db as BetterSqliteDatabase;
    }

    this.threshold = options.threshold ?? 50;
    this.batchSize = options.batchSize ?? 50;
    this.intervalMs = options.intervalMs ?? 60000;
    this.logger = options.logger;
    this.embedder = options.embedder;

    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS EpochSummaries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        key_decisions TEXT NOT NULL,
        impacted_files TEXT NOT NULL,
        decision_count INTEGER NOT NULL,
        first_decision_at INTEGER NOT NULL,
        last_decision_at INTEGER NOT NULL,
        embedding TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES Sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_epoch_summaries_session ON EpochSummaries(session_id);
      CREATE INDEX IF NOT EXISTS idx_epoch_summaries_agent ON EpochSummaries(agent_id);
      CREATE INDEX IF NOT EXISTS idx_epoch_summaries_created ON EpochSummaries(created_at);
    `);
  }

  /**
   * Scans a specific session. If the session has at least `threshold` decisions (default 50),
   * compiles the 50 oldest decisions into an EpochSummary node, commits it, and deletes the 50
   * raw decisions within an atomic better-sqlite3 transaction.
   */
  async summarizeSession(sessionId: string): Promise<EpochSummaryEntity | null> {
    const countRow = this.db
      .prepare<[string]>("SELECT COUNT(*) as cnt FROM ArchitecturalDecisions WHERE session_id = ?")
      .get(sessionId) as { cnt: number } | undefined;

    const totalDecisions = countRow?.cnt ?? 0;
    if (totalDecisions < this.threshold) {
      return null;
    }

    // Retrieve the oldest 50 decisions to compress
    const decisions = this.db
      .prepare<[string, number]>(
        `SELECT * FROM ArchitecturalDecisions
         WHERE session_id = ?
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .all(sessionId, this.batchSize) as RawDecisionRecord[];

    if (decisions.length < this.threshold) {
      return null;
    }

    const firstDecision = decisions[0]!;
    const lastDecision = decisions[decisions.length - 1]!;
    const agentId = firstDecision.agent_id;
    const firstDecisionAt = firstDecision.created_at;
    const lastDecisionAt = lastDecision.created_at;

    // Deduplicate file paths
    const fileSet = new Set<string>();
    for (const d of decisions) {
      try {
        const parsed = JSON.parse(d.file_paths) as string[];
        for (const p of parsed) fileSet.add(p);
      } catch {
        if (d.file_paths) fileSet.add(d.file_paths);
      }
    }
    const impactedFiles = Array.from(fileSet);

    // Extract key decision summaries
    const keyDecisions: string[] = decisions.map((d) => {
      const summary = d.context_summary.trim();
      const reasoning = d.reasoning.trim();
      return `${summary} -> ${reasoning}`;
    });

    // Synthesize dense epoch summary
    const summaryHeader = `Epoch Summary for session '${sessionId}' (${decisions.length} decisions compressed):`;
    const timeframe = `Timeframe: ${new Date(firstDecisionAt).toISOString()} to ${new Date(lastDecisionAt).toISOString()}`;
    const filesLine = `Impacted Files (${impactedFiles.length}): ${impactedFiles.slice(0, 20).join(", ")}${impactedFiles.length > 20 ? ` ... (+${impactedFiles.length - 20} more)` : ""}`;
    const keyLines = keyDecisions.slice(0, 25).map((kd, idx) => `  ${idx + 1}. ${kd}`);
    if (keyDecisions.length > 25) {
      keyLines.push(`  ... (+${keyDecisions.length - 25} more granular decisions compressed)`);
    }

    const compiledSummary = [
      summaryHeader,
      timeframe,
      filesLine,
      "Key Architectural Decisions:",
      ...keyLines,
    ].join("\n");

    // Optional vector embedding for semantic search
    let embedding: number[] | undefined;
    if (this.embedder) {
      try {
        const emb = await this.embedder(compiledSummary);
        if (Array.isArray(emb)) {
          embedding = emb;
        }
      } catch (err) {
        this.logger?.warn("Failed to generate embedding for EpochSummary:", err);
      }
    }

    const epochId = `epoch_${randomUUID()}`;
    const now = Date.now();
    const decisionIds = decisions.map((d) => d.id);

    // ATOMIC TRANSACTION: Insert single EpochSummary and delete the 50 granular decisions
    const transaction = this.db.transaction(() => {
      // 1. Insert EpochSummary
      this.db
        .prepare<[string, string, string, string, string, string, number, number, number, string | null, number]>(
          `INSERT INTO EpochSummaries
           (id, session_id, agent_id, summary, key_decisions, impacted_files, decision_count, first_decision_at, last_decision_at, embedding, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          epochId,
          sessionId,
          agentId,
          compiledSummary,
          JSON.stringify(keyDecisions),
          JSON.stringify(impactedFiles),
          decisions.length,
          firstDecisionAt,
          lastDecisionAt,
          embedding ? JSON.stringify(embedding) : null,
          now
        );

      // 2. Delete raw granular decisions and snapshots
      const placeholders = decisionIds.map(() => "?").join(",");
      this.db
        .prepare<string[]>(`DELETE FROM CodeSnapshots WHERE decision_id IN (${placeholders})`)
        .run(...decisionIds);
      this.db
        .prepare<string[]>(`DELETE FROM ArchitecturalDecisions WHERE id IN (${placeholders})`)
        .run(...decisionIds);
    });

    transaction();

    this.logger?.info(
      `Created EpochSummary ${epochId} for session ${sessionId} (compressed ${decisions.length} decisions).`
    );

    return {
      id: epochId,
      sessionId,
      agentId,
      summary: compiledSummary,
      keyDecisions,
      impactedFiles,
      decisionCount: decisions.length,
      firstDecisionAt,
      lastDecisionAt,
      ...(embedding ? { embedding } : {}),
      createdAt: now,
    };
  }

  /**
   * Executes a complete scan cycle across all sessions.
   * Compresses all sessions with >= threshold decisions in 50-decision batches.
   */
  async runCycle(): Promise<EpochSummaryCycleResult> {
    const startTime = Date.now();
    const epochSummaries: EpochSummaryEntity[] = [];
    let sessionsProcessed = 0;
    let decisionsSummarized = 0;

    interface SessionCountRow {
      session_id: string;
      cnt: number;
    }

    const eligibleSessions = this.db
      .prepare<[number]>(
        `SELECT session_id, COUNT(*) as cnt
         FROM ArchitecturalDecisions
         GROUP BY session_id
         HAVING cnt >= ?`
      )
      .all(this.threshold) as SessionCountRow[];

    for (const sessionRow of eligibleSessions) {
      sessionsProcessed++;
      let remaining = sessionRow.cnt;

      while (remaining >= this.threshold) {
        const epoch = await this.summarizeSession(sessionRow.session_id);
        if (!epoch) break;

        epochSummaries.push(epoch);
        decisionsSummarized += epoch.decisionCount;
        remaining -= epoch.decisionCount;
      }
    }

    const durationMs = Date.now() - startTime;
    return {
      sessionsProcessed,
      epochsCreated: epochSummaries.length,
      decisionsSummarized,
      epochSummaries,
      durationMs,
    };
  }

  /**
   * Starts an autonomous recurring cron/interval timer.
   */
  startScheduled(intervalMs = this.intervalMs): this {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
    }

    this.intervalTimer = setInterval(() => {
      void this.runCycle();
    }, intervalMs);

    if (typeof this.intervalTimer.unref === "function") {
      this.intervalTimer.unref();
    }

    return this;
  }

  /**
   * Stops the autonomous cron/interval timer.
   */
  stopScheduled(): this {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = undefined;
    }
    return this;
  }

  isScheduled(): boolean {
    return this.intervalTimer !== undefined;
  }

  /**
   * Retrieves all EpochSummaries for a session or globally.
   */
  getEpochSummaries(sessionId?: string): EpochSummaryEntity[] {
    interface RawEpochRow {
      id: string;
      session_id: string;
      agent_id: string;
      summary: string;
      key_decisions: string;
      impacted_files: string;
      decision_count: number;
      first_decision_at: number;
      last_decision_at: number;
      embedding: string | null;
      created_at: number;
    }

    let rows: RawEpochRow[];
    if (sessionId) {
      rows = this.db
        .prepare<[string]>(
          "SELECT * FROM EpochSummaries WHERE session_id = ? ORDER BY created_at DESC"
        )
        .all(sessionId) as RawEpochRow[];
    } else {
      rows = this.db
        .prepare<[]>("SELECT * FROM EpochSummaries ORDER BY created_at DESC")
        .all() as RawEpochRow[];
    }

    return rows.map((r) => this.mapEpochRow(r));
  }

  findEpochSummaryById(id: string): EpochSummaryEntity | null {
    interface RawEpochRow {
      id: string;
      session_id: string;
      agent_id: string;
      summary: string;
      key_decisions: string;
      impacted_files: string;
      decision_count: number;
      first_decision_at: number;
      last_decision_at: number;
      embedding: string | null;
      created_at: number;
    }

    const row = this.db
      .prepare<[string]>("SELECT * FROM EpochSummaries WHERE id = ?")
      .get(id) as RawEpochRow | undefined;

    if (!row) return null;
    return this.mapEpochRow(row);
  }

  private mapEpochRow(row: {
    id: string;
    session_id: string;
    agent_id: string;
    summary: string;
    key_decisions: string;
    impacted_files: string;
    decision_count: number;
    first_decision_at: number;
    last_decision_at: number;
    embedding: string | null;
    created_at: number;
  }): EpochSummaryEntity {
    let keyDecisions: string[] = [];
    try {
      keyDecisions = JSON.parse(row.key_decisions) as string[];
    } catch {
      keyDecisions = [row.key_decisions];
    }

    let impactedFiles: string[] = [];
    try {
      impactedFiles = JSON.parse(row.impacted_files) as string[];
    } catch {
      impactedFiles = [row.impacted_files];
    }

    let embedding: number[] | undefined;
    if (row.embedding) {
      try {
        embedding = JSON.parse(row.embedding) as number[];
      } catch {
        // ignore
      }
    }

    return {
      id: row.id,
      sessionId: row.session_id,
      agentId: row.agent_id,
      summary: row.summary,
      keyDecisions,
      impactedFiles,
      decisionCount: row.decision_count,
      firstDecisionAt: row.first_decision_at,
      lastDecisionAt: row.last_decision_at,
      ...(embedding ? { embedding } : {}),
      createdAt: row.created_at,
    };
  }
}
