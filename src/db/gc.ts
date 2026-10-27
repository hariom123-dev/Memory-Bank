import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { MemoryRepository } from "./relational.js";
import type { ILogger } from "../daemon/types.js";

export interface GCResult {
  snapshotsScanned: number;
  orphanedSnapshotsPruned: number;
  prunedFilePaths: string[];
  durationMs: number;
}

export interface GCOptions {
  repository: MemoryRepository;
  workspaceRoot?: string;
  batchSize?: number;
  logger?: ILogger;
}

export class VectorGarbageCollector {
  private repository: MemoryRepository;
  private workspaceRoot: string;
  private batchSize: number;
  private logger?: ILogger | undefined;
  private intervalTimer?: NodeJS.Timeout | undefined;

  constructor(options: GCOptions) {
    this.repository = options.repository;
    this.workspaceRoot = options.workspaceRoot ?? process.cwd();
    this.batchSize = options.batchSize ?? 50;
    this.logger = options.logger;
  }

  /**
   * Runs a garbage collection cycle in batches of 50 records to prevent locking SQLite.
   */
  async runCycle(): Promise<GCResult> {
    const startTime = Date.now();
    this.logger?.info("Starting Vector Garbage Collector scan...");

    const allSnapshots = this.repository.findAllSnapshots();
    const snapshotsScanned = allSnapshots.length;
    const prunedFilePaths: string[] = [];
    let orphanedSnapshotsPruned = 0;

    // Process in batches
    for (let i = 0; i < allSnapshots.length; i += this.batchSize) {
      const batch = allSnapshots.slice(i, i + this.batchSize);

      this.repository.runTransaction(() => {
        for (const snap of batch) {
          const absPath = isAbsolute(snap.filePath)
            ? snap.filePath
            : resolve(this.workspaceRoot, snap.filePath);

          if (!existsSync(absPath)) {
            this.logger?.info(`Pruning orphaned AST snapshot for deleted file: ${snap.filePath}`);
            const deleted = this.repository.deleteSnapshotsByFilePath(snap.filePath);
            orphanedSnapshotsPruned += deleted;
            if (!prunedFilePaths.includes(snap.filePath)) {
              prunedFilePaths.push(snap.filePath);
            }
          }
        }
      });
    }

    const durationMs = Date.now() - startTime;
    this.logger?.info(
      `Vector Garbage Collector finished in ${durationMs}ms. Pruned ${orphanedSnapshotsPruned} records across ${prunedFilePaths.length} files.`
    );

    return {
      snapshotsScanned,
      orphanedSnapshotsPruned,
      prunedFilePaths,
      durationMs,
    };
  }

  /**
   * Starts a background recurring GC timer.
   */
  startScheduled(intervalMs = 60000): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
    }
    this.intervalTimer = setInterval(() => {
      void this.runCycle();
    }, intervalMs);
    if (typeof this.intervalTimer.unref === "function") {
      this.intervalTimer.unref();
    }
  }

  stopScheduled(): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = undefined;
    }
  }
}
