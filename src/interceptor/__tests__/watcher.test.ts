import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BackgroundInterceptor } from "../watcher.js";
import { TypedEventBus } from "../../events/bus.js";
import type { MemoryBusEventMap, FileChangedPayload } from "../../events/types.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Phase 7: The Background Interceptor", () => {
  let tempDir: string;
  let bus: TypedEventBus<MemoryBusEventMap>;
  let interceptor: BackgroundInterceptor;

  beforeEach(() => {
    tempDir = join(tmpdir(), `mb-interceptor-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    bus = new TypedEventBus<MemoryBusEventMap>();
  });

  afterEach(async () => {
    if (interceptor) {
      await interceptor.stop();
    }
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("debounces rapid file edits and emits a single FILE_CHANGED event", async () => {
    const receivedEvents: FileChangedPayload[] = [];
    bus.subscribe("FILE_CHANGED", (e) => {
      receivedEvents.push(e);
    });

    // Use a short 50ms debounce for tests
    interceptor = new BackgroundInterceptor({
      workspacePath: tempDir,
      bus,
      debounceMs: 50,
    });

    const testFile = join(tempDir, "rapid.ts");
    writeFileSync(testFile, "export const v = 1;");

    // Simulate 3 rapid file events
    interceptor.handleFileEvent(testFile, "change");
    interceptor.handleFileEvent(testFile, "change");
    interceptor.handleFileEvent(testFile, "change");

    expect(receivedEvents.length).toBe(0);

    // Wait for debounce timer to fire
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(receivedEvents.length).toBe(1);
    expect(receivedEvents[0]?.filePath).toBe(testFile);
    expect(receivedEvents[0]?.changeType).toBe("change");
    expect(receivedEvents[0]?.content).toContain("export const v = 1;");
  });

  it("starts and stops watching cleanly", async () => {
    interceptor = new BackgroundInterceptor({
      workspacePath: tempDir,
      bus,
      debounceMs: 100,
    });

    await interceptor.start();
    expect(interceptor.isWatching()).toBe(true);

    await interceptor.stop();
    expect(interceptor.isWatching()).toBe(false);
  });
});
