import { existsSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { TypedEventBus } from "../events/bus.js";
import type { MemoryBankEventMap } from "../events/types.js";
import type { ILogger } from "../daemon/types.js";

export interface BranchManagerOptions {
  workspaceRoot: string;
  bus: TypedEventBus<MemoryBankEventMap>;
  logger?: ILogger;
  defaultBranch?: string;
}

export class GitBranchManager {
  private workspaceRoot: string;
  private bus: TypedEventBus<MemoryBankEventMap>;
  private logger?: ILogger | undefined;
  private currentBranch: string;
  private watcher: FSWatcher | null = null;
  private gitHeadPath: string;

  constructor(options: BranchManagerOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.bus = options.bus;
    this.logger = options.logger;

    const paths = this.resolveGitPaths();
    this.gitHeadPath = paths ? paths.headPath : join(this.workspaceRoot, ".git", "HEAD");
    this.currentBranch = this.detectCurrentBranch(options.defaultBranch ?? "main");
  }

  private resolveGitPaths(): { gitDir: string; headPath: string } | null {
    const rawGitPath = join(this.workspaceRoot, ".git");
    if (!existsSync(rawGitPath)) {
      return null;
    }

    try {
      const stat = statSync(rawGitPath);
      if (stat.isDirectory()) {
        return {
          gitDir: rawGitPath,
          headPath: join(rawGitPath, "HEAD"),
        };
      } else if (stat.isFile()) {
        const content = readFileSync(rawGitPath, "utf-8").trim();
        if (content.startsWith("gitdir:")) {
          const rawDir = content.replace("gitdir:", "").trim();
          const targetDir = isAbsolute(rawDir) ? rawDir : resolve(this.workspaceRoot, rawDir);
          return {
            gitDir: targetDir,
            headPath: join(targetDir, "HEAD"),
          };
        }
      }
    } catch {
      // Fallback
    }

    return {
      gitDir: rawGitPath,
      headPath: join(rawGitPath, "HEAD"),
    };
  }

  getCurrentBranch(): string {
    return this.currentBranch;
  }

  detectCurrentBranch(fallback = "main"): string {
    const paths = this.resolveGitPaths();
    const headPath = paths?.headPath ?? this.gitHeadPath;

    if (!existsSync(headPath)) {
      return fallback;
    }

    try {
      const content = readFileSync(headPath, "utf-8").trim();
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

    const paths = this.resolveGitPaths();
    if (!paths || !existsSync(paths.gitDir)) {
      this.logger?.info("No .git directory found; branch manager running in static mode.");
      return this;
    }

    try {
      this.watcher = watch(paths.gitDir, (eventType, filename) => {
        if (filename === "HEAD" || eventType === "rename") {
          this.checkBranchChange();
        }
      });
      this.logger?.info(`GitBranchManager watching ${paths.headPath} (current: ${this.currentBranch})`);
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
