import Database from "better-sqlite3";
import type { Database as BetterSqliteDatabase } from "better-sqlite3";
import type { ITransactionalResource } from "../daemon/types.js";

export interface DatabaseOptions {
  dbPath?: string;
  walBusyTimeoutMs?: number;
  inMemory?: boolean;
  existingDb?: BetterSqliteDatabase;
}

export class SwarmDatabase implements ITransactionalResource {
  public readonly name = "swarm-sqlite-db";
  private db: BetterSqliteDatabase;
  private activeTransactionCount = 0;

  constructor(options: DatabaseOptions = {}) {
    if (options.existingDb) {
      this.db = options.existingDb;
    } else {
      const dbPath = options.inMemory ? ":memory:" : options.dbPath ?? "memory-bank.sqlite";
      this.db = new Database(dbPath);
    }

    const busyTimeout = options.walBusyTimeoutMs ?? 5000;

    // Enable WAL mode and performance optimizations
    this.db.pragma("journal_mode = WAL");
    this.db.pragma(`busy_timeout = ${busyTimeout}`);
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");

    this.initializeSchema();
  }

  private initializeSchema(): void {
    this.db.exec(`
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
      CREATE INDEX IF NOT EXISTS idx_decisions_created ON ArchitecturalDecisions(created_at);
      CREATE INDEX IF NOT EXISTS idx_snapshots_decision ON CodeSnapshots(decision_id);
    `);
  }

  getRawDatabase(): BetterSqliteDatabase {
    return this.db;
  }

  hasActiveTransaction(): boolean {
    return this.activeTransactionCount > 0;
  }

  commitActiveTransactions(): void {
    // In better-sqlite3 with WAL mode, running transactions are auto-managed
    // and checkpoints can be cleanly written out.
    if (this.db.open) {
      try {
        this.db.pragma("wal_checkpoint(PASSIVE)");
      } catch {
        // Handle gracefully if db is closing
      }
    }
    this.activeTransactionCount = 0;
  }

  close(): void {
    if (this.db.open) {
      try {
        this.db.pragma("wal_checkpoint(TRUNCATE)");
      } catch {
        // Ignore checkpoint failure during close
      }
      this.db.close();
    }
  }

  runInTransaction<T>(fn: (db: BetterSqliteDatabase) => T): T {
    this.activeTransactionCount++;
    const transaction = this.db.transaction(() => {
      return fn(this.db);
    });

    try {
      const result = transaction();
      return result;
    } finally {
      this.activeTransactionCount = Math.max(0, this.activeTransactionCount - 1);
    }
  }
}
