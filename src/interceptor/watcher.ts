import { watch, type FSWatcher } from "chokidar";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TypedEventBus } from "../events/bus.js";
import type { MemoryBusEventMap } from "../events/types.js";
import type { ILogger } from "../daemon/types.js";

export interface WatcherOptions {
  workspacePath: string;
  bus: TypedEventBus<MemoryBusEventMap>;
  debounceMs?: number;
  ignoredPatterns?: Array<string | RegExp>;
  logger?: ILogger;
}

export class BackgroundInterceptor {
  private workspacePath: string;
  private bus: TypedEventBus<MemoryBusEventMap>;
  private debounceMs: number;
  private ignoredPatterns: Array<string | RegExp>;
  private logger?: ILogger | undefined;
  private watcher: FSWatcher | null = null;
  private pendingDebounceTimers = new Map<string, NodeJS.Timeout>();

  constructor(options: WatcherOptions) {
    this.workspacePath = resolve(options.workspacePath);
    this.bus = options.bus;
    this.debounceMs = options.debounceMs ?? 3000;
    this.ignoredPatterns = options.ignoredPatterns ?? [
      /(^|[/\\])\../,
      "**/node_modules/**",
      "**/.git/**",
      "**/dist/**",
      "**/*.sqlite*",
    ];
    this.logger = options.logger;
  }

  isWatching(): boolean {
    return this.watcher !== null;
  }

  async start(): Promise<void> {
    if (this.watcher) {
      return;
    }

    this.logger?.info(`Starting Background Interceptor on: ${this.workspacePath}`);

    this.watcher = watch(this.workspacePath, {
      ignored: this.ignoredPatterns,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });

    this.watcher.on("add", (filePath) => this.handleFileEvent(filePath, "add"));
    this.watcher.on("change", (filePath) => this.handleFileEvent(filePath, "change"));
    this.watcher.on("unlink", (filePath) => this.handleFileEvent(filePath, "unlink"));

    this.logger?.info("Background Interceptor active.");
  }

  async stop(): Promise<void> {
    for (const timer of this.pendingDebounceTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingDebounceTimers.clear();

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
      this.logger?.info("Background Interceptor stopped.");
    }
  }

  /**
   * Internal debounce handler (3000ms by default)
   */
  handleFileEvent(filePath: string, changeType: "add" | "change" | "unlink"): void {
    const existingTimer = this.pendingDebounceTimers.get(filePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.pendingDebounceTimers.delete(filePath);
      void this.dispatchFileChanged(filePath, changeType);
    }, this.debounceMs);

    if (typeof timer.unref === "function") {
      timer.unref();
    }

    this.pendingDebounceTimers.set(filePath, timer);
  }

  private async dispatchFileChanged(
    filePath: string,
    changeType: "add" | "change" | "unlink"
  ): Promise<void> {
    let diff: string | undefined;
    let content: string | undefined;

    if (changeType !== "unlink" && existsSync(filePath)) {
      try {
        content = readFileSync(filePath, "utf-8");
      } catch {
        // ignore read error
      }

      diff = this.extractGitDiff(filePath);
    }

    this.logger?.info(`Emitting FILE_CHANGED [${changeType}] for: ${filePath}`);

    await this.bus.publish("FILE_CHANGED", {
      filePath,
      changeType,
      ...(diff ? { diff } : {}),
      ...(content ? { content } : {}),
      timestamp: Date.now(),
    });
  }

  private extractGitDiff(filePath: string): string | undefined {
    try {
      const output = execSync(`git diff HEAD -- "${filePath}"`, {
        cwd: this.workspacePath,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return output.trim() || undefined;
    } catch {
      return undefined;
    }
  }
}
