import { describe, it, expect, vi } from "vitest";
import { TypedEventBus } from "../bus.js";
import {
  EVENT_SCHEMAS,
  type MemoryBusEventMap,
  type FileChangedPayload,
  type MemoryIngestedPayload,
} from "../types.js";

describe("TypedEventBus PubSub System", () => {
  it("publishes and receives strongly typed FILE_CHANGED events", async () => {
    const bus = new TypedEventBus<MemoryBusEventMap>();
    const received: FileChangedPayload[] = [];

    bus.subscribe("FILE_CHANGED", (payload) => {
      received.push(payload);
    });

    const filePayload: FileChangedPayload = {
      filePath: "src/auth/token.ts",
      changeType: "change",
      diff: "+ export function verifyToken() {}",
      timestamp: Date.now(),
    };

    const result = await bus.publish("FILE_CHANGED", filePayload);

    expect(result.success).toBe(true);
    expect(result.listenerCount).toBe(1);
    expect(received.length).toBe(1);
    expect(received[0]?.filePath).toBe("src/auth/token.ts");
    expect(received[0]?.changeType).toBe("change");
  });

  it("validates payloads using Zod schemas when configured", async () => {
    const bus = new TypedEventBus<MemoryBusEventMap>({
      validatePayloads: true,
      schemas: EVENT_SCHEMAS,
    });

    const handler = vi.fn();
    bus.subscribe("MEMORY_INGESTED", handler);

    // Invalid payload missing required summary and sourceFile
    const invalidPayload = {
      sessionId: "sess-1",
      // missing sourceFile, astFootprint, summary
    } as unknown as MemoryIngestedPayload;

    const result = await bus.publish("MEMORY_INGESTED", invalidPayload);

    expect(result.success).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]?.error.message).toContain("Payload validation failed");
    expect(handler).not.toHaveBeenCalled();

    // Valid payload succeeds
    const validPayload: MemoryIngestedPayload = {
      sessionId: "sess-1",
      sourceFile: "src/db/relational.ts",
      astFootprint: { classes: ["MemoryRepository"] },
      summary: "Added MemoryRepository class",
      timestamp: Date.now(),
    };

    const validResult = await bus.publish("MEMORY_INGESTED", validPayload);
    expect(validResult.success).toBe(true);
    expect(handler).toHaveBeenCalledWith(validPayload);
  });

  it("subscribes once and automatically unsubscribes", async () => {
    const bus = new TypedEventBus<MemoryBusEventMap>();
    let count = 0;

    bus.subscribeOnce("CONTEXT_REQUESTED", () => {
      count++;
    });

    await bus.publish("CONTEXT_REQUESTED", {
      requestId: "req-1",
      query: "How does caching work?",
      requester: "agent",
      tokenBudget: 5000,
      timestamp: Date.now(),
    });

    await bus.publish("CONTEXT_REQUESTED", {
      requestId: "req-2",
      query: "How does routing work?",
      requester: "agent",
      tokenBudget: 5000,
      timestamp: Date.now(),
    });

    expect(count).toBe(1);
    expect(bus.hasListeners("CONTEXT_REQUESTED")).toBe(false);
  });

  it("receives all events through subscribeAll wildcard handler", async () => {
    const bus = new TypedEventBus<MemoryBusEventMap>();
    const auditLog: Array<{ event: string; data: unknown }> = [];

    const unsubscribe = bus.subscribeAll((event, payload) => {
      auditLog.push({ event: String(event), data: payload });
    });

    await bus.publish("FILE_CHANGED", {
      filePath: "src/daemon.ts",
      changeType: "add",
      timestamp: Date.now(),
    });

    await bus.publish("CRITICAL_ERROR", {
      errorId: "err-100",
      component: "TEST_COMPONENT",
      message: "Test fatal error",
      severity: "critical",
      timestamp: Date.now(),
    });

    expect(auditLog.length).toBe(2);
    expect(auditLog[0]?.event).toBe("FILE_CHANGED");
    expect(auditLog[1]?.event).toBe("CRITICAL_ERROR");

    unsubscribe();
    await bus.publish("FILE_CHANGED", {
      filePath: "src/index.ts",
      changeType: "change",
      timestamp: Date.now(),
    });

    expect(auditLog.length).toBe(2);
  });

  it("executes listeners in priority order", async () => {
    const bus = new TypedEventBus<MemoryBusEventMap>();
    const order: string[] = [];

    bus.subscribe("FILE_CHANGED", () => { order.push("low"); }, { priority: 10 });
    bus.subscribe("FILE_CHANGED", () => { order.push("critical"); }, { priority: 100 });
    bus.subscribe("FILE_CHANGED", () => { order.push("normal"); }, { priority: 50 });

    await bus.publish("FILE_CHANGED", {
      filePath: "file.ts",
      changeType: "change",
      timestamp: Date.now(),
    });

    expect(order).toEqual(["critical", "normal", "low"]);
  });

  it("applies subscription filters", async () => {
    const bus = new TypedEventBus<MemoryBusEventMap>();
    const received: string[] = [];

    bus.subscribe(
      "FILE_CHANGED",
      (payload) => {
        received.push(payload.filePath);
      },
      {
        filter: (payload) => payload.filePath.endsWith(".ts"),
      }
    );

    await bus.publish("FILE_CHANGED", {
      filePath: "README.md",
      changeType: "change",
      timestamp: Date.now(),
    });

    await bus.publish("FILE_CHANGED", {
      filePath: "src/main.ts",
      changeType: "change",
      timestamp: Date.now(),
    });

    expect(received).toEqual(["src/main.ts"]);
  });

  it("isolates errors across multiple subscribers", async () => {
    const bus = new TypedEventBus<MemoryBusEventMap>();
    const executed: string[] = [];

    bus.subscribe("CRITICAL_ERROR", () => {
      throw new Error("Subscriber failed intentionally");
    }, { id: "faulty_subscriber" });

    bus.subscribe("CRITICAL_ERROR", () => {
      executed.push("working_subscriber");
    }, { id: "working_subscriber" });

    const result = await bus.publish("CRITICAL_ERROR", {
      errorId: "err-2",
      component: "CORE",
      message: "Test message",
      severity: "high",
      timestamp: Date.now(),
    });

    expect(result.success).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]?.handlerId).toBe("faulty_subscriber");
    expect(result.errors[0]?.error.message).toBe("Subscriber failed intentionally");
    expect(executed).toContain("working_subscriber");
  });
});
