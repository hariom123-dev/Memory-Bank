import { describe, it, expect, vi } from "vitest";
import { GracefulShutdownManager } from "../shutdown.js";
import type { ITransactionalResource } from "../types.js";

describe("Graceful Shutdown & Transaction Commit Infrastructure", () => {
  it("commits pending database transactions before closing the resource", async () => {
    const callOrder: string[] = [];

    const mockDbResource: ITransactionalResource = {
      name: "sqlite-main",
      hasActiveTransaction: vi.fn().mockReturnValue(true),
      commitActiveTransactions: vi.fn().mockImplementation(async () => {
        callOrder.push("commit");
      }),
      close: vi.fn().mockImplementation(async () => {
        callOrder.push("close");
      }),
    };

    const manager = new GracefulShutdownManager();
    manager.registerTransactionalResource(mockDbResource);

    const result = await manager.triggerShutdown("Test shutdown");

    expect(result.success).toBe(true);
    expect(mockDbResource.hasActiveTransaction).toHaveBeenCalled();
    expect(mockDbResource.commitActiveTransactions).toHaveBeenCalledTimes(1);
    expect(mockDbResource.close).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["commit", "close"]);
  });

  it("skips commit if resource has no active transaction, but still closes it", async () => {
    const mockDbResource: ITransactionalResource = {
      name: "sqlite-idle",
      hasActiveTransaction: vi.fn().mockReturnValue(false),
      commitActiveTransactions: vi.fn(),
      close: vi.fn(),
    };

    const manager = new GracefulShutdownManager();
    manager.registerTransactionalResource(mockDbResource);

    const result = await manager.triggerShutdown("Idle test");

    expect(result.success).toBe(true);
    expect(mockDbResource.commitActiveTransactions).not.toHaveBeenCalled();
    expect(mockDbResource.close).toHaveBeenCalledTimes(1);
  });

  it("executes hooks in descending priority order", async () => {
    const executionOrder: string[] = [];
    const manager = new GracefulShutdownManager();

    manager.registerHook({
      name: "low-priority",
      priority: 10,
      execute: () => {
        executionOrder.push("low");
      },
    });

    manager.registerHook({
      name: "high-priority",
      priority: 500,
      execute: () => {
        executionOrder.push("high");
      },
    });

    manager.registerHook({
      name: "critical-db-commit",
      priority: 1000,
      execute: () => {
        executionOrder.push("critical");
      },
    });

    await manager.triggerShutdown("Order test");

    expect(executionOrder).toEqual(["critical", "high", "low"]);
  });

  it("isolates errors so a failing hook does not block subsequent hooks", async () => {
    const executed: string[] = [];
    const manager = new GracefulShutdownManager();

    manager.registerHook({
      name: "failing-hook",
      priority: 100,
      execute: () => {
        throw new Error("Disk full on flush");
      },
    });

    manager.registerHook({
      name: "subsequent-hook",
      priority: 50,
      execute: () => {
        executed.push("subsequent");
      },
    });

    const result = await manager.triggerShutdown("Failure isolation test");

    expect(result.success).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]?.hook).toBe("failing-hook");
    expect(result.errors[0]?.error.message).toBe("Disk full on flush");
    expect(executed).toContain("subsequent");
  });

  it("handles shutdown timeout gracefully without hanging indefinitely", async () => {
    const manager = new GracefulShutdownManager({ timeoutMs: 100 });

    manager.registerHook({
      name: "hanging-hook",
      priority: 100,
      execute: () => new Promise((resolve) => setTimeout(resolve, 5000)),
    });

    const result = await manager.triggerShutdown("Timeout test");

    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.hook === "shutdown-timeout")).toBe(true);
  });

  it("binds and unbinds process signals cleanly", () => {
    const manager = new GracefulShutdownManager();
    const listenersBefore = process.listenerCount("SIGINT");

    manager.bindProcessSignals();
    expect(process.listenerCount("SIGINT")).toBe(listenersBefore + 1);

    manager.unbindProcessSignals();
    expect(process.listenerCount("SIGINT")).toBe(listenersBefore);
  });
});
