import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { TypedEventBus } from "../events/bus.js";
import type { MemoryBusEventMap } from "../events/types.js";
import type { ILogger } from "../daemon/types.js";

export interface BranchManagerOptions {
  workspaceRoot: string;
  bus: TypedEventBus<MemoryBusEventMap>;
  logger?: ILogger;
  defaultBranch?: string;
}

export class GitBranchManager {
  private workspaceRoot: string;
  private bus: TypedEventBus<MemoryBusEventMap>;
  private logger?: ILogger | undefined;
  private currentBranch: string;
  private watcher: FSWatcher | null = null;
  private gitHeadPath: string;

  constructor(options: BranchManagerOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.bus = options.bus;
    this.logger = options.logger;
    this.gitHeadPath = join(this.workspaceRoot, ".git", "HEAD");
    this.currentBranch = this.detectCurrentBranch(options.defaultBranch ?? "main");
  }

  getCurrentBranch(): string {
    return this.currentBranch;
  }

  detectCurrentBranch(fallback = "main"): string {
    if (!existsSync(this.gitHeadPath)) {
      return fallback;
    }

    try {
      const content = readFileSync(this.gitHeadPath, "utf-8").trim();
      if (content.startsWith("ref: refs/heads/")) {
        return content.replace("ref: refs/heads/", "");
      }
      // Detached HEAD
      return content.slice(0, 8);
    } catch (err) {
      this.logger?.warn("Failed to read .git/HEAD:", err);
      return fallback;
    }
  }

  start(): this {
    if (this.watcher) {
      return this;
    }

    const gitDir = join(this.workspaceRoot, ".git");
    if (!existsSync(gitDir)) {
      this.logger?.info("No .git directory found; branch manager running in static mode.");
      return this;
    }

    try {
      this.watcher = watch(gitDir, (eventType, filename) => {
        if (filename === "HEAD" || eventType === "rename") {
          this.checkBranchChange();
        }
      });
      this.logger?.info(`GitBranchManager watching ${this.gitHeadPath} (current: ${this.currentBranch})`);
    } catch (err) {
      this.logger?.warn("Failed to watch .git directory:", err);
    }

    return this;
  }

  stop(): this {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      this.logger?.info("GitBranchManager stopped.");
    }
    return this;
  }

  /**
   * Manually checks or simulates branch changes.
   */
  async checkBranchChange(): Promise<boolean> {
    const newBranch = this.detectCurrentBranch(this.currentBranch);
    if (newBranch !== this.currentBranch) {
      const prev = this.currentBranch;
      this.currentBranch = newBranch;
      this.logger?.info(`Git branch changed from '${prev}' to '${newBranch}'. Emitting BRANCH_CHANGED.`);

      await this.bus.publish("BRANCH_CHANGED", {
        previousBranch: prev,
        currentBranch: newBranch,
        timestamp: Date.now(),
      });

      return true;
    }
    return false;
  }

  /**
   * Scopes an array of items to the current active branch.
   */
  filterByBranch<T extends { branchName?: string }>(items: T[], targetBranch?: string): T[] {
    const branch = targetBranch ?? this.currentBranch;
    return items.filter((item) => (item.branchName ?? "main") === branch);
  }
}
