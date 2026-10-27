import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { MigrationRunner } from "../migrations/runner.js";

describe("Phase 9: SQLite Migration Strategy", () => {
  it("tracks user_version and applies chronological migrations", () => {
    const db = new Database(":memory:");
    const runner = new MigrationRunner(db);

    expect(runner.getCurrentVersion()).toBe(0);

    const migrations = [
      {
        version: 1,
        name: "001_initial_schema.sql",
        sql: "CREATE TABLE TestTable (id TEXT PRIMARY KEY, val TEXT);",
      },
      {
        version: 2,
        name: "002_add_column.sql",
        sql: "ALTER TABLE TestTable ADD COLUMN age INTEGER DEFAULT 0;",
      },
    ];

    const result = runner.runMigrations(migrations);

    expect(result.appliedCount).toBe(2);
    expect(result.currentVersion).toBe(2);
    expect(runner.getCurrentVersion()).toBe(2);

    // Running again applies 0 new migrations
    const reRunResult = runner.runMigrations(migrations);
    expect(reRunResult.appliedCount).toBe(0);
    expect(reRunResult.currentVersion).toBe(2);

    db.close();
  });
});
