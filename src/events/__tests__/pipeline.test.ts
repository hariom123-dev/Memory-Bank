import { describe, it, expect, vi } from "vitest";
import { TypedEventBus } from "../bus.js";
import { DecoupledMemoryPipeline } from "../pipeline.js";
import type {
  MemoryBankEventMap,
  MemoryIngestedPayload,
  CriticalErrorPayload,
} from "../types.js";

describe("DecoupledMemoryPipeline", () => {
  it("processes FILE_CHANGED, extracts AST, and publishes MEMORY_INGESTED", async () => {
    const bus = new TypedEventBus<MemoryBankEventMap>();
    const ingestedEvents: MemoryIngestedPayload[] = [];
    const storedMemories: MemoryIngestedPayload[] = [];

    bus.subscribe("MEMORY_INGESTED", (p) => {
      ingestedEvents.push(p);
    });

    const mockAstProcessor = vi.fn().mockResolvedValue({
      sessionId: "session-42",
      decisionId: "decision-99",
      sourceFile: "src/auth/service.ts",
      astFootprint: { functions: ["authenticateUser"], classes: [] },
      summary: "Implemented authenticateUser with JWT token generation",
      metadata: { linesOfCode: 45 },
    });

    const mockVectorProcessor = vi.fn().mockResolvedValue({
      vectorEmbeddingId: "vec-12345",
      dimension: 384,
    });

    const mockStorageHandler = vi.fn().mockImplementation(async (payload) => {
      storedMemories.push(payload);
    });

    const pipeline = new DecoupledMemoryPipeline({
      bus,
      astProcessor: mockAstProcessor,
      vectorProcessor: mockVectorProcessor,
      storageHandler: mockStorageHandler,
    });

    pipeline.start();

    await bus.publish("FILE_CHANGED", {
      filePath: "src/auth/service.ts",
      changeType: "change",
      diff: "+ export function authenticateUser() {}",
      timestamp: Date.now(),
    });

    expect(mockAstProcessor).toHaveBeenCalledTimes(1);
    expect(mockVectorProcessor).toHaveBeenCalledTimes(1);
    expect(ingestedEvents.length).toBe(1);
    expect(ingestedEvents[0]?.sourceFile).toBe("src/auth/service.ts");
    expect(ingestedEvents[0]?.vectorEmbeddingId).toBe("vec-12345");
    expect(ingestedEvents[0]?.embeddingDimension).toBe(384);
    expect(storedMemories.length).toBe(1);

    pipeline.stop();
  });

  it("publishes CRITICAL_ERROR if the AST processor throws an unexpected exception", async () => {
    const bus = new TypedEventBus<MemoryBankEventMap>();
    const criticalErrors: CriticalErrorPayload[] = [];

    bus.subscribe("CRITICAL_ERROR", (err) => {
      criticalErrors.push(err);
    });

    const failingAstProcessor = vi.fn().mockRejectedValue(new Error("SyntaxError: Unexpected token"));

    const pipeline = new DecoupledMemoryPipeline({
      bus,
      astProcessor: failingAstProcessor,
    });

    pipeline.start();

    await bus.publish("FILE_CHANGED", {
      filePath: "src/broken.ts",
      changeType: "add",
      timestamp: Date.now(),
    });

    expect(criticalErrors.length).toBe(1);
    expect(criticalErrors[0]?.component).toBe("AST_MEMORY_PIPELINE");
    expect(criticalErrors[0]?.message).toBe("SyntaxError: Unexpected token");
    expect(criticalErrors[0]?.severity).toBe("critical");

    pipeline.stop();
  });

  it("ignores non-code files and file deletions (unlink)", async () => {
    const bus = new TypedEventBus<MemoryBankEventMap>();
    const mockAstProcessor = vi.fn();

    const pipeline = new DecoupledMemoryPipeline({
      bus,
      astProcessor: mockAstProcessor,
    });

    pipeline.start();

    // 1. Markdown file (not in supported extensions)
    await bus.publish("FILE_CHANGED", {
      filePath: "docs/architecture.md",
      changeType: "change",
      timestamp: Date.now(),
    });

    // 2. Unlink event
    await bus.publish("FILE_CHANGED", {
      filePath: "src/deleted.ts",
      changeType: "unlink",
      timestamp: Date.now(),
    });

    expect(mockAstProcessor).not.toHaveBeenCalled();

    pipeline.stop();
  });

  it("stops and detaches event listeners cleanly", async () => {
    const bus = new TypedEventBus<MemoryBankEventMap>();
    const mockAstProcessor = vi.fn();

    const pipeline = new DecoupledMemoryPipeline({
      bus,
      astProcessor: mockAstProcessor,
    });

    pipeline.start();
    expect(pipeline.isRunning()).toBe(true);

    pipeline.stop();
    expect(pipeline.isRunning()).toBe(false);

    await bus.publish("FILE_CHANGED", {
      filePath: "src/app.ts",
      changeType: "change",
      timestamp: Date.now(),
    });

    expect(mockAstProcessor).not.toHaveBeenCalled();
  });
});
