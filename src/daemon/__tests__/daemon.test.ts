import { describe, it, expect, vi } from "vitest";
import { MemoryBankDaemon } from "../daemon.js";
import type { ITransactionalResource, ILogger } from "../types.js";
import { TOKENS, ServiceContainer } from "../container.js";

describe("MemoryBankDaemon Orchestration", () => {
  const silentLogger: ILogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  it("initializes in INITIALIZING state and transitions to LISTENING on start()", async () => {
    const container = new ServiceContainer();
    container.registerInstance(TOKENS.Logger, silentLogger);

    const daemon = new MemoryBankDaemon({ container });
    expect(daemon.getState()).toBe("INITIALIZING");

    await daemon.start();
    expect(daemon.getState()).toBe("LISTENING");

    await daemon.stop("test complete");
    expect(daemon.getState()).toBe("SHUTDOWN");
  });

  it("orchestrates memory ingestion lifecycle and state transitions", async () => {
    const container = new ServiceContainer();
    container.registerInstance(TOKENS.Logger, silentLogger);

    const daemon = new MemoryBankDaemon({ container });
    await daemon.start();

    let stateDuringOperation = "";
    const operation = vi.fn().mockImplementation(async () => {
      stateDuringOperation = daemon.getState();
      return { decisionId: "dec-101", success: true };
    });

    const result = await daemon.ingestMemory("sess-1", "src/auth/jwt.ts", operation);

    expect(stateDuringOperation).toBe("INGESTING_MEMORY");
    expect(daemon.getState()).toBe("LISTENING");
    expect(result).toEqual({ decisionId: "dec-101", success: true });
    expect(operation).toHaveBeenCalledTimes(1);

    await daemon.stop();
  });

  it("orchestrates context retrieval lifecycle and state transitions", async () => {
    const container = new ServiceContainer();
    container.registerInstance(TOKENS.Logger, silentLogger);

    const daemon = new MemoryBankDaemon({ container });
    await daemon.start();

    let stateDuringOperation = "";
    const operation = vi.fn().mockImplementation(async () => {
      stateDuringOperation = daemon.getState();
      return { matches: ["auth token refresh logic"] };
    });

    const result = await daemon.retrieveContext("How does JWT refresh work?", operation);

    expect(stateDuringOperation).toBe("RETRIEVING_CONTEXT");
    expect(daemon.getState()).toBe("LISTENING");
    expect(result).toEqual({ matches: ["auth token refresh logic"] });
    expect(operation).toHaveBeenCalledTimes(1);

    await daemon.stop();
  });

  it("reverts to LISTENING if ingestion operation throws an error", async () => {
    const container = new ServiceContainer();
    container.registerInstance(TOKENS.Logger, silentLogger);

    const daemon = new MemoryBankDaemon({ container });
    await daemon.start();

    const failingOperation = vi.fn().mockRejectedValue(new Error("Disk I/O error"));

    await expect(
      daemon.ingestMemory("sess-err", "main.ts", failingOperation)
    ).rejects.toThrow("Disk I/O error");

    expect(daemon.getState()).toBe("LISTENING");
    expect(daemon.getSnapshot().context.lastError).toBe("Disk I/O error");

    await daemon.stop();
  });

  it("commits pending database transactions during daemon stop()", async () => {
    const container = new ServiceContainer();
    container.registerInstance(TOKENS.Logger, silentLogger);

    const daemon = new MemoryBankDaemon({ container });

    const mockDb: ITransactionalResource = {
      name: "sqlite-daemon-db",
      hasActiveTransaction: vi.fn().mockReturnValue(true),
      commitActiveTransactions: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };

    daemon.registerTransactionalResource(mockDb);
    await daemon.start();

    const shutdownResult = await daemon.stop("User interrupt (SIGINT simulation)");

    expect(shutdownResult.success).toBe(true);
    expect(mockDb.hasActiveTransaction).toHaveBeenCalled();
    expect(mockDb.commitActiveTransactions).toHaveBeenCalledTimes(1);
    expect(mockDb.close).toHaveBeenCalledTimes(1);
    expect(daemon.getState()).toBe("SHUTDOWN");
  });

  it("throws error when attempting operations in invalid states", async () => {
    const container = new ServiceContainer();
    container.registerInstance(TOKENS.Logger, silentLogger);

    const daemon = new MemoryBankDaemon({ container });
    // Not started yet (INITIALIZING)
    await expect(daemon.ingestMemory("s1", "f1", async () => "ok")).rejects.toThrow(
      "Cannot ingest memory: daemon is in 'INITIALIZING' state, must be 'LISTENING'."
    );

    await daemon.start();
    // Cannot start twice
    await expect(daemon.start()).rejects.toThrow(
      "Cannot start daemon: current state is 'LISTENING', expected 'INITIALIZING'."
    );

    await daemon.stop();
  });
});
