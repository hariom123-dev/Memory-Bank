import Database, { type Database as BetterSqliteDatabase } from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ITransactionalResource, ILogger } from "../daemon/types.js";
import { MigrationRunner } from "./migrations/runner.js";
import type { EpochSummaryEntity } from "./summarizer.js";

export interface SessionEntity {
  id: string;
  agentId: string;
  role?: string;
  createdAt: number;
  lastActiveAt: number;
}

export interface ArchitecturalDecisionEntity {
  id: string;
  sessionId: string;
  agentId: string;
  contextSummary: string;
  reasoning: string;
  filePaths: string[];
  embedding?: number[];
  branchName?: string;
  createdAt: number;
}

export interface CodeSnapshotEntity {
  id: string;
  decisionId: string;
  filePath: string;
  astJson: Record<string, unknown> | string;
  createdAt: number;
}

export interface RelationalDbOptions {
  dbPath?: string;
  inMemory?: boolean;
  walBusyTimeoutMs?: number;
  logger?: ILogger;
}

export class MemoryRepository implements ITransactionalResource {
  public readonly name = "memory-repository-sqlite";
  private db: BetterSqliteDatabase;
  private logger?: ILogger | undefined;
  private activeTransaction = false;

  constructor(options: RelationalDbOptions = {}) {
    this.logger = options.logger;
    const rawPath = options.inMemory ? ":memory:" : options.dbPath ?? "memory-bank.sqlite";
    const dbPath = rawPath === ":memory:" ? ":memory:" : resolve(rawPath);

    if (dbPath !== ":memory:") {
      const parentDir = dirname(dbPath);
      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
      }
    }

    this.db = new Database(dbPath);

    const busyTimeout = options.walBusyTimeoutMs ?? 5000;
    this.db.pragma("journal_mode = WAL");
    this.db.pragma(`busy_timeout = ${busyTimeout}`);
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");

    this.runInitialMigration();
  }

  private runInitialMigration(): void {
    const runner = new MigrationRunner(this.db, this.logger);
    runner.runMigrations([
      {
        version: 1,
        name: "001_initial_schema.sql",
        sql: `
          CREATE TABLE IF NOT EXISTS Sessions (
            id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL,
            role TEXT,
            created_at INTEGER NOT NULL,
            last_active_at INTEGER NOT NULL
          );

          CREATE TABLE IF NOT EXISTS ArchitecturalDecisions (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            context_summary TEXT NOT NULL,
            reasoning TEXT NOT NULL,
            file_paths TEXT NOT NULL,
            embedding TEXT,
            branch_name TEXT DEFAULT 'main',
            created_at INTEGER NOT NULL,
            FOREIGN KEY (session_id) REFERENCES Sessions(id) ON DELETE CASCADE
          );

          CREATE TABLE IF NOT EXISTS CodeSnapshots (
            id TEXT PRIMARY KEY,
            decision_id TEXT NOT NULL,
            file_path TEXT NOT NULL,
            ast_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (decision_id) REFERENCES ArchitecturalDecisions(id) ON DELETE CASCADE
          );

          CREATE INDEX IF NOT EXISTS idx_decisions_agent ON ArchitecturalDecisions(agent_id);
          CREATE INDEX IF NOT EXISTS idx_decisions_session ON ArchitecturalDecisions(session_id);
          CREATE INDEX IF NOT EXISTS idx_decisions_branch ON ArchitecturalDecisions(branch_name);
          CREATE INDEX IF NOT EXISTS idx_decisions_created ON ArchitecturalDecisions(created_at);
          CREATE INDEX IF NOT EXISTS idx_snapshots_decision ON CodeSnapshots(decision_id);
          CREATE INDEX IF NOT EXISTS idx_snapshots_filepath ON CodeSnapshots(file_path);
        `,
      },
      {
        version: 2,
        name: "002_epoch_summaries.sql",
        sql: `
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
        `,
      },
    ]);
  }

  getDatabase(): BetterSqliteDatabase {
    return this.db;
  }

  hasActiveTransaction(): boolean {
    return this.activeTransaction;
  }

  commitActiveTransactions(): void {
    if (this.db.open) {
      try {
        this.db.pragma("wal_checkpoint(PASSIVE)");
      } catch {
        // ignore
      }
    }
    this.activeTransaction = false;
  }

  close(): void {
    if (this.db.open) {
      try {
        this.db.pragma("wal_checkpoint(TRUNCATE)");
      } catch {
        // ignore
      }
      this.db.close();
    }
  }

  runTransaction<T>(action: () => T): T {
    this.activeTransaction = true;
    const tx = this.db.transaction(() => action());
    try {
      return tx();
    } finally {
      this.activeTransaction = false;
    }
  }

  // --- SESSIONS ---
  insertSession(session: SessionEntity): SessionEntity {
    this.db
      .prepare<[string, string, string | null, number, number]>(
        `INSERT INTO Sessions (id, agent_id, role, created_at, last_active_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET last_active_at = excluded.last_active_at`
      )
      .run(
        session.id,
        session.agentId,
        session.role ?? null,
        session.createdAt,
        session.lastActiveAt
      );
    return session;
  }

  findSessionById(id: string): SessionEntity | null {
    interface SessionRow {
      id: string;
      agent_id: string;
      role: string | null;
      created_at: number;
      last_active_at: number;
    }
    const row = this.db
      .prepare<[string]>("SELECT * FROM Sessions WHERE id = ?")
      .get(id) as SessionRow | undefined;

    if (!row) return null;
    return {
      id: row.id,
      agentId: row.agent_id,
      ...(row.role ? { role: row.role } : {}),
      createdAt: row.created_at,
      lastActiveAt: row.last_active_at,
    };
  }

  // --- ARCHITECTURAL DECISIONS ---
  insertDecision(decision: ArchitecturalDecisionEntity): ArchitecturalDecisionEntity {
    const embeddingStr = decision.embedding ? JSON.stringify(decision.embedding) : null;
    const filePathsStr = JSON.stringify(decision.filePaths);
    const branch = decision.branchName ?? "main";

    this.db
      .prepare<[string, string, string, string, string, string, string | null, string, number]>(
        `INSERT INTO ArchitecturalDecisions
         (id, session_id, agent_id, context_summary, reasoning, file_paths, embedding, branch_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        decision.id,
        decision.sessionId,
        decision.agentId,
        decision.contextSummary,
        decision.reasoning,
        filePathsStr,
        embeddingStr,
        branch,
        decision.createdAt
      );

    return decision;
  }

  findDecisionById(id: string): ArchitecturalDecisionEntity | null {
    interface DecisionRow {
      id: string;
      session_id: string;
      agent_id: string;
      context_summary: string;
      reasoning: string;
      file_paths: string;
      embedding: string | null;
      branch_name: string;
      created_at: number;
    }

    const row = this.db
      .prepare<[string]>("SELECT * FROM ArchitecturalDecisions WHERE id = ?")
      .get(id) as DecisionRow | undefined;

    if (!row) return null;
    return this.mapDecisionRow(row);
  }

  findDecisionsByAgent(agentId: string, branchName?: string): ArchitecturalDecisionEntity[] {
    interface DecisionRow {
      id: string;
      session_id: string;
      agent_id: string;
      context_summary: string;
      reasoning: string;
      file_paths: string;
      embedding: string | null;
      branch_name: string;
      created_at: number;
    }

    let rows: DecisionRow[];
    if (branchName) {
      rows = this.db
        .prepare<[string, string]>(
          "SELECT * FROM ArchitecturalDecisions WHERE agent_id = ? AND branch_name = ? ORDER BY created_at DESC"
        )
        .all(agentId, branchName) as DecisionRow[];
    } else {
      rows = this.db
        .prepare<[string]>(
          "SELECT * FROM ArchitecturalDecisions WHERE agent_id = ? ORDER BY created_at DESC"
        )
        .all(agentId) as DecisionRow[];
    }

    return rows.map((r) => this.mapDecisionRow(r));
  }

  findDecisionsByBranch(branchName: string): ArchitecturalDecisionEntity[] {
    interface DecisionRow {
      id: string;
      session_id: string;
      agent_id: string;
      context_summary: string;
      reasoning: string;
      file_paths: string;
      embedding: string | null;
      branch_name: string;
      created_at: number;
    }

    const rows = this.db
      .prepare<[string]>(
        "SELECT * FROM ArchitecturalDecisions WHERE branch_name = ? ORDER BY created_at DESC"
      )
      .all(branchName) as DecisionRow[];

    return rows.map((r) => this.mapDecisionRow(r));
  }

  findAllDecisions(): ArchitecturalDecisionEntity[] {
    interface DecisionRow {
      id: string;
      session_id: string;
      agent_id: string;
      context_summary: string;
      reasoning: string;
      file_paths: string;
      embedding: string | null;
      branch_name: string;
      created_at: number;
    }

    const rows = this.db
      .prepare<[]>("SELECT * FROM ArchitecturalDecisions ORDER BY created_at DESC")
      .all() as DecisionRow[];

    return rows.map((r) => this.mapDecisionRow(r));
  }

  deleteDecision(id: string): boolean {
    const res = this.db.prepare<[string]>("DELETE FROM ArchitecturalDecisions WHERE id = ?").run(id);
    return res.changes > 0;
  }

  // --- CODE SNAPSHOTS ---
  insertCodeSnapshot(snapshot: CodeSnapshotEntity): CodeSnapshotEntity {
    const astStr =
      typeof snapshot.astJson === "string" ? snapshot.astJson : JSON.stringify(snapshot.astJson);

    this.db
      .prepare<[string, string, string, string, number]>(
        `INSERT INTO CodeSnapshots (id, decision_id, file_path, ast_json, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(snapshot.id, snapshot.decisionId, snapshot.filePath, astStr, snapshot.createdAt);

    return snapshot;
  }

  findSnapshotsByDecisionId(decisionId: string): CodeSnapshotEntity[] {
    interface SnapshotRow {
      id: string;
      decision_id: string;
      file_path: string;
      ast_json: string;
      created_at: number;
    }

    const rows = this.db
      .prepare<[string]>("SELECT * FROM CodeSnapshots WHERE decision_id = ?")
      .all(decisionId) as SnapshotRow[];

    return rows.map((r) => ({
      id: r.id,
      decisionId: r.decision_id,
      filePath: r.file_path,
      astJson: r.ast_json,
      createdAt: r.created_at,
    }));
  }

  findSnapshotsByFilePath(filePath: string): CodeSnapshotEntity[] {
    interface SnapshotRow {
      id: string;
      decision_id: string;
      file_path: string;
      ast_json: string;
      created_at: number;
    }

    const rows = this.db
      .prepare<[string]>("SELECT * FROM CodeSnapshots WHERE file_path = ?")
      .all(filePath) as SnapshotRow[];

    return rows.map((r) => ({
      id: r.id,
      decisionId: r.decision_id,
      filePath: r.file_path,
      astJson: r.ast_json,
      createdAt: r.created_at,
    }));
  }

  findAllSnapshots(): CodeSnapshotEntity[] {
    interface SnapshotRow {
      id: string;
      decision_id: string;
      file_path: string;
      ast_json: string;
      created_at: number;
    }

    const rows = this.db
      .prepare<[]>("SELECT * FROM CodeSnapshots ORDER BY created_at DESC")
      .all() as SnapshotRow[];

    return rows.map((r) => ({
      id: r.id,
      decisionId: r.decision_id,
      filePath: r.file_path,
      astJson: r.ast_json,
      createdAt: r.created_at,
    }));
  }

  deleteSnapshotsByFilePath(filePath: string): number {
    const res = this.db
      .prepare<[string]>("DELETE FROM CodeSnapshots WHERE file_path = ?")
      .run(filePath);
    return res.changes;
  }

  private mapDecisionRow(row: {
    id: string;
    session_id: string;
    agent_id: string;
    context_summary: string;
    reasoning: string;
    file_paths: string;
    embedding: string | null;
    branch_name: string;
    created_at: number;
  }): ArchitecturalDecisionEntity {
    let filePaths: string[] = [];
    try {
      filePaths = JSON.parse(row.file_paths) as string[];
    } catch {
      filePaths = [row.file_paths];
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
      contextSummary: row.context_summary,
      reasoning: row.reasoning,
      filePaths,
      ...(embedding ? { embedding } : {}),
      branchName: row.branch_name,
      createdAt: row.created_at,
    };
  }

  // --- EPOCH SUMMARIES ---
  insertEpochSummary(epoch: EpochSummaryEntity): EpochSummaryEntity {
    this.db
      .prepare<[string, string, string, string, string, string, number, number, number, string | null, number]>(
        `INSERT INTO EpochSummaries
         (id, session_id, agent_id, summary, key_decisions, impacted_files, decision_count, first_decision_at, last_decision_at, embedding, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        epoch.id,
        epoch.sessionId,
        epoch.agentId,
        epoch.summary,
        JSON.stringify(epoch.keyDecisions),
        JSON.stringify(epoch.impactedFiles),
        epoch.decisionCount,
        epoch.firstDecisionAt,
        epoch.lastDecisionAt,
        epoch.embedding ? JSON.stringify(epoch.embedding) : null,
        epoch.createdAt
      );

    return epoch;
  }

  findEpochSummariesBySession(sessionId: string): EpochSummaryEntity[] {
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

    const rows = this.db
      .prepare<[string]>("SELECT * FROM EpochSummaries WHERE session_id = ? ORDER BY created_at DESC")
      .all(sessionId) as RawEpochRow[];

    return rows.map((r) => this.mapEpochRow(r));
  }

  findAllEpochSummaries(): EpochSummaryEntity[] {
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

    const rows = this.db
      .prepare<[]>("SELECT * FROM EpochSummaries ORDER BY created_at DESC")
      .all() as RawEpochRow[];

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

  deleteEpochSummary(id: string): boolean {
    const res = this.db.prepare<[string]>("DELETE FROM EpochSummaries WHERE id = ?").run(id);
    return res.changes > 0;
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
