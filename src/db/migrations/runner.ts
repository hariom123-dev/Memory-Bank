import type { Database } from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ILogger } from "../../daemon/types.js";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export class MigrationRunner {
  private db: Database;
  private logger?: ILogger | undefined;

  constructor(db: Database, logger?: ILogger | undefined) {
    this.db = db;
    this.logger = logger;
  }

  getCurrentVersion(): number {
    const row = this.db.pragma("user_version", { simple: true }) as number;
    return typeof row === "number" ? row : 0;
  }

  setVersion(version: number): void {
    this.db.pragma(`user_version = ${version}`);
  }

  loadMigrationsFromDir(migrationsDir: string): Migration[] {
    const files = readdirSync(migrationsDir)
      .filter((file) => file.endsWith(".sql"))
      .sort();

    return files.map((file) => {
      const match = file.match(/^(\d+)_/);
      const version = match && match[1] ? parseInt(match[1], 10) : 0;
      const sql = readFileSync(join(migrationsDir, file), "utf-8");
      return {
        version,
        name: file,
        sql,
      };
    });
  }

  runMigrations(migrations: Migration[]): { appliedCount: number; currentVersion: number } {
    const sorted = [...migrations].sort((a, b) => a.version - b.version);
    let currentVersion = this.getCurrentVersion();
    let appliedCount = 0;

    for (const migration of sorted) {
      if (migration.version > currentVersion) {
        this.logger?.info(`Applying migration ${migration.name} (v${migration.version})...`);
        const applyTx = this.db.transaction(() => {
          this.db.exec(migration.sql);
          this.setVersion(migration.version);
        });

        applyTx();
        currentVersion = migration.version;
        appliedCount++;
        this.logger?.info(`Migration ${migration.name} applied successfully. Current version: ${currentVersion}`);
      }
    }

    return { appliedCount, currentVersion };
  }
}
