import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryRepository } from "../relational.js";
import { VectorGarbageCollector } from "../gc.js";
import { writeFileSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Phase 12: Vector Garbage Collector", () => {
  let tempDir: string;
  let repo: MemoryRepository;
  let gc: VectorGarbageCollector;

  beforeEach(() => {
    tempDir = join(tmpdir(), `mb-gc-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    repo = new MemoryRepository({ inMemory: true });
    gc = new VectorGarbageCollector({ repository: repo, workspaceRoot: tempDir, batchSize: 10 });
  });

  afterEach(() => {
    gc.stopScheduled();
    repo.close();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("prunes orphaned AST snapshots for files that no longer exist on disk", async () => {
    // File 1 exists
    const existingFile = join(tempDir, "existing.ts");
    writeFileSync(existingFile, "export const a = 1;");

    // File 2 is deleted
    const deletedFile = join(tempDir, "deleted.ts");
    writeFileSync(deletedFile, "export const b = 2;");
    unlinkSync(deletedFile); // Delete from filesystem

    repo.insertSession({ id: "s1", agentId: "a1", createdAt: 1, lastActiveAt: 1 });
    repo.insertDecision({
      id: "d1",
      sessionId: "s1",
      agentId: "a1",
      contextSummary: "decision 1",
      reasoning: "reasoning 1",
      filePaths: [existingFile, deletedFile],
      createdAt: 1,
    });

    repo.insertCodeSnapshot({
      id: "snap-exist",
      decisionId: "d1",
      filePath: existingFile,
      astJson: { exports: ["a"] },
      createdAt: 1,
    });

    repo.insertCodeSnapshot({
      id: "snap-deleted",
      decisionId: "d1",
      filePath: deletedFile,
      astJson: { exports: ["b"] },
      createdAt: 1,
    });

    expect(repo.findAllSnapshots().length).toBe(2);

    const result = await gc.runCycle();

    expect(result.snapshotsScanned).toBe(2);
    expect(result.orphanedSnapshotsPruned).toBe(1);
    expect(result.prunedFilePaths).toContain(deletedFile);

    const remaining = repo.findAllSnapshots();
    expect(remaining.length).toBe(1);
    expect(remaining[0]?.filePath).toBe(existingFile);
  });
});
