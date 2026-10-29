import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database, { type Database as BetterSqliteDatabase } from "better-sqlite3";
import { EpochSummarizer } from "../summarizer.js";

describe("Context Deduplication and Graph Summarization Pipeline", () => {
  let db: BetterSqliteDatabase;
  let summarizer: EpochSummarizer;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    // Initialize required base tables
    db.exec(`
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
    `);

    summarizer = new EpochSummarizer({
      db,
      threshold: 50,
      batchSize: 50,
    });
  });

  afterEach(() => {
    summarizer.stopScheduled();
    if (db.open) {
      db.close();
    }
  });

  it("ensures the EpochSummaries table and indexes exist", () => {
    const tableCheck = db
      .prepare<[string]>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("EpochSummaries");
    expect(tableCheck).toBeDefined();

    const idxCheck = db
      .prepare<[string]>("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get("idx_epoch_summaries_session");
    expect(idxCheck).toBeDefined();
  });

  it("skips sessions that have fewer than 50 distinct decisions", async () => {
    db.prepare(
      "INSERT INTO Sessions (id, agent_id, created_at, last_active_at) VALUES ('s1', 'coder', 1, 1)"
    ).run();

    // Insert 49 decisions (< 50)
    const insertDecision = db.prepare(`
      INSERT INTO ArchitecturalDecisions
      (id, session_id, agent_id, context_summary, reasoning, file_paths, created_at)
      VALUES (?, 's1', 'coder', ?, ?, '["src/auth.ts"]', ?)
    `);

    for (let i = 0; i < 49; i++) {
      insertDecision.run(`dec-${i}`, `Decision ${i}`, `Reasoning ${i}`, 1000 + i);
    }

    const result = await summarizer.summarizeSession("s1");
    expect(result).toBeNull();

    // Verify 49 decisions are still intact
    const count = db
      .prepare<[string]>("SELECT COUNT(*) as cnt FROM ArchitecturalDecisions WHERE session_id = ?")
      .get("s1") as { cnt: number };
    expect(count.cnt).toBe(49);

    const epochs = summarizer.getEpochSummaries("s1");
    expect(epochs.length).toBe(0);
  });

  it("compiles 50 granular decisions into a single EpochSummary node and deletes the 50 raw decisions in a transaction", async () => {
    db.prepare(
      "INSERT INTO Sessions (id, agent_id, created_at, last_active_at) VALUES ('s1', 'coder', 1, 1)"
    ).run();

    const insertDecision = db.prepare(`
      INSERT INTO ArchitecturalDecisions
      (id, session_id, agent_id, context_summary, reasoning, file_paths, created_at)
      VALUES (?, 's1', 'coder', ?, ?, ?, ?)
    `);

    const insertSnapshot = db.prepare(`
      INSERT INTO CodeSnapshots
      (id, decision_id, file_path, ast_json, created_at)
      VALUES (?, ?, ?, '{"classes":["AuthService"]}', ?)
    `);

    // Insert 55 decisions (exceeds 50 threshold)
    for (let i = 0; i < 55; i++) {
      const decId = `dec-${i}`;
      const filePath = i % 2 === 0 ? "src/auth/jwt.ts" : "src/auth/session.ts";
      insertDecision.run(
        decId,
        `Architecture decision milestone #${i}`,
        `Reasoning for decision #${i}: improved security and performance`,
        JSON.stringify([filePath]),
        1000 + i * 60000 // Each 1 minute apart
      );
      insertSnapshot.run(`snap-${i}`, decId, filePath, 1000 + i * 60000);
    }

    // Verify initial count is 55
    const initialCount = db
      .prepare<[string]>("SELECT COUNT(*) as cnt FROM ArchitecturalDecisions WHERE session_id = ?")
      .get("s1") as { cnt: number };
    expect(initialCount.cnt).toBe(55);

    // Run summarization
    const epoch = await summarizer.summarizeSession("s1");
    expect(epoch).not.toBeNull();
    expect(epoch?.sessionId).toBe("s1");
    expect(epoch?.decisionCount).toBe(50);
    expect(epoch?.impactedFiles).toContain("src/auth/jwt.ts");
    expect(epoch?.impactedFiles).toContain("src/auth/session.ts");
    expect(epoch?.keyDecisions.length).toBe(50);
    expect(epoch?.summary).toContain("Epoch Summary for session 's1' (50 decisions compressed)");

    // Exactly 50 raw decisions deleted, remaining = 55 - 50 = 5
    const remainingCount = db
      .prepare<[string]>("SELECT COUNT(*) as cnt FROM ArchitecturalDecisions WHERE session_id = ?")
      .get("s1") as { cnt: number };
    expect(remainingCount.cnt).toBe(5);

    // Snapshots corresponding to deleted decisions must also be deleted
    const remainingSnapshots = db
      .prepare<[]>("SELECT COUNT(*) as cnt FROM CodeSnapshots")
      .get() as { cnt: number };
    expect(remainingSnapshots.cnt).toBe(5);

    // Verify EpochSummaries table contains 1 entry
    const epochCount = db
      .prepare<[]>("SELECT COUNT(*) as cnt FROM EpochSummaries")
      .get() as { cnt: number };
    expect(epochCount.cnt).toBe(1);

    const retrieved = summarizer.getEpochSummaries("s1");
    expect(retrieved.length).toBe(1);
    expect(retrieved[0]?.id).toBe(epoch?.id);
  });

  it("handles runCycle scanning across multiple sessions with autonomous batch compression", async () => {
    // Session 1: 52 decisions
    // Session 2: 102 decisions (2 full epochs of 50 + 2 remainder)
    // Session 3: 20 decisions (< 50)
    db.prepare(
      "INSERT INTO Sessions (id, agent_id, created_at, last_active_at) VALUES ('s1', 'coder', 1, 1), ('s2', 'reviewer', 2, 2), ('s3', 'qa', 3, 3)"
    ).run();

    const insertDecision = db.prepare(`
      INSERT INTO ArchitecturalDecisions
      (id, session_id, agent_id, context_summary, reasoning, file_paths, created_at)
      VALUES (?, ?, ?, ?, ?, '["src/core.ts"]', ?)
    `);

    for (let i = 0; i < 52; i++) {
      insertDecision.run(`s1-dec-${i}`, "s1", "coder", `S1 D${i}`, `R${i}`, 1000 + i);
    }

    for (let i = 0; i < 102; i++) {
      insertDecision.run(`s2-dec-${i}`, "s2", "reviewer", `S2 D${i}`, `R${i}`, 2000 + i);
    }

    for (let i = 0; i < 20; i++) {
      insertDecision.run(`s3-dec-${i}`, "s3", "qa", `S3 D${i}`, `R${i}`, 3000 + i);
    }

    const cycleResult = await summarizer.runCycle();
    expect(cycleResult.sessionsProcessed).toBe(2); // s1 and s2
    expect(cycleResult.epochsCreated).toBe(3); // 1 for s1, 2 for s2
    expect(cycleResult.decisionsSummarized).toBe(150); // 50 + 50 + 50

    // Check remaining decisions
    const s1Remaining = db.prepare("SELECT COUNT(*) as cnt FROM ArchitecturalDecisions WHERE session_id = 's1'").get() as { cnt: number };
    const s2Remaining = db.prepare("SELECT COUNT(*) as cnt FROM ArchitecturalDecisions WHERE session_id = 's2'").get() as { cnt: number };
    const s3Remaining = db.prepare("SELECT COUNT(*) as cnt FROM ArchitecturalDecisions WHERE session_id = 's3'").get() as { cnt: number };

    expect(s1Remaining.cnt).toBe(2);
    expect(s2Remaining.cnt).toBe(2);
    expect(s3Remaining.cnt).toBe(20);
  });

  it("rolls back the transaction atomically if an error occurs during compression, ensuring no data loss", async () => {
    db.prepare(
      "INSERT INTO Sessions (id, agent_id, created_at, last_active_at) VALUES ('s1', 'coder', 1, 1)"
    ).run();

    const insertDecision = db.prepare(`
      INSERT INTO ArchitecturalDecisions
      (id, session_id, agent_id, context_summary, reasoning, file_paths, created_at)
      VALUES (?, 's1', 'coder', ?, ?, '["src/index.ts"]', ?)
    `);

    for (let i = 0; i < 50; i++) {
      insertDecision.run(`dec-${i}`, `D${i}`, `R${i}`, 1000 + i);
    }

    // Corrupt EpochSummaries table temporarily to cause an insert failure inside the transaction
    db.exec("DROP TABLE EpochSummaries");
    db.exec(`
      CREATE TABLE EpochSummaries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        summary TEXT NOT NULL CHECK(summary = 'IMPOSSIBLE_VALUE')
      )
    `);

    await expect(summarizer.summarizeSession("s1")).rejects.toThrow();

    // Verify all 50 decisions still exist (transaction was cleanly rolled back)
    const count = db
      .prepare<[]>("SELECT COUNT(*) as cnt FROM ArchitecturalDecisions WHERE session_id = 's1'")
      .get() as { cnt: number };
    expect(count.cnt).toBe(50);
  });

  it("supports startScheduled and stopScheduled for autonomous cron jobs", () => {
    expect(summarizer.isScheduled()).toBe(false);
    summarizer.startScheduled(500);
    expect(summarizer.isScheduled()).toBe(true);
    summarizer.stopScheduled();
    expect(summarizer.isScheduled()).toBe(false);
  });
});
