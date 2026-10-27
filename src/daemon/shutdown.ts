import type {
  ITransactionalResource,
  IShutdownHook,
  ShutdownResult,
  ILogger,
} from "./types.js";

export interface ShutdownManagerOptions {
  timeoutMs?: number;
  logger?: ILogger;
  exitProcessOnSignal?: boolean;
}

export class GracefulShutdownManager {
  private hooks: IShutdownHook[] = [];
  private transactionalResources = new Set<ITransactionalResource>();
  private isShuttingDown = false;
  private signalHandlers: Array<{ signal: NodeJS.Signals; handler: () => void }> = [];
  private beforeExitHandler?: (() => void) | undefined;
  private logger?: ILogger | undefined;
  private timeoutMs: number;
  private exitProcessOnSignal: boolean;

  constructor(options: ShutdownManagerOptions = {}) {
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.exitProcessOnSignal = options.exitProcessOnSignal ?? false;
  }

  /**
   * Registers a transactional database/state resource.
   * On shutdown, any active transactions are committed first before closing.
   */
  registerTransactionalResource(resource: ITransactionalResource): this {
    this.transactionalResources.add(resource);

    // Register high-priority commit hook
    this.registerHook({
      name: `commit-transactions:${resource.name}`,
      priority: 1000,
      execute: async () => {
        if (resource.hasActiveTransaction()) {
          this.logger?.info(`Committing active transactions for resource: ${resource.name}`);
          await resource.commitActiveTransactions();
        }
      },
    });

    // Register lower-priority close hook
    this.registerHook({
      name: `close-resource:${resource.name}`,
      priority: 500,
      execute: async () => {
        this.logger?.info(`Closing resource: ${resource.name}`);
        await resource.close();
      },
    });

    return this;
  }

  unregisterTransactionalResource(resource: ITransactionalResource): boolean {
    this.hooks = this.hooks.filter(
      (h) =>
        h.name !== `commit-transactions:${resource.name}` &&
        h.name !== `close-resource:${resource.name}`
    );
    return this.transactionalResources.delete(resource);
  }

  /**
   * Registers an arbitrary shutdown hook with priority (higher = executed earlier).
   */
  registerHook(hook: IShutdownHook): this {
    // Avoid duplicate hook names
    this.hooks = this.hooks.filter((h) => h.name !== hook.name);
    this.hooks.push(hook);
    // Sort descending by priority
    this.hooks.sort((a, b) => b.priority - a.priority);
    return this;
  }

  unregisterHook(name: string): boolean {
    const initialLen = this.hooks.length;
    this.hooks = this.hooks.filter((h) => h.name !== name);
    return this.hooks.length < initialLen;
  }

  /**
   * Binds process signal listeners for graceful shutdown.
   */
  bindProcessSignals(): this {
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

    for (const signal of signals) {
      const handler = () => {
        this.logger?.warn(`Received termination signal ${signal}. Initiating graceful shutdown...`);
        void this.triggerShutdown(`Process signal ${signal}`).then(() => {
          if (this.exitProcessOnSignal) {
            process.exit(0);
          }
        });
      };

      process.on(signal, handler);
      this.signalHandlers.push({ signal, handler });
    }

    this.beforeExitHandler = () => {
      if (!this.isShuttingDown && this.hasPendingTransactions()) {
        this.logger?.warn("Process exiting with uncommitted transactions. Flushing...");
        void this.triggerShutdown("beforeExit flush");
      }
    };
    process.on("beforeExit", this.beforeExitHandler);

    return this;
  }

  /**
   * Unbinds process signal listeners (useful for test isolation).
   */
  unbindProcessSignals(): this {
    for (const { signal, handler } of this.signalHandlers) {
      process.removeListener(signal, handler);
    }
    this.signalHandlers = [];

    if (this.beforeExitHandler) {
      process.removeListener("beforeExit", this.beforeExitHandler);
      this.beforeExitHandler = undefined;
    }

    return this;
  }

  hasPendingTransactions(): boolean {
    for (const resource of this.transactionalResources) {
      if (resource.hasActiveTransaction()) {
        return true;
      }
    }
    return false;
  }

  /**
   * Triggers the graceful shutdown sequence.
   * Executes hooks ordered by priority with timeout protection.
   */
  async triggerShutdown(reason = "Manual invocation"): Promise<ShutdownResult> {
    if (this.isShuttingDown) {
      this.logger?.warn(`Shutdown already in progress (triggered again by '${reason}').`);
      return {
        success: true,
        durationMs: 0,
        executedHooks: [],
        errors: [],
      };
    }

    this.isShuttingDown = true;
    const startTime = Date.now();
    const executedHooks: string[] = [];
    const errors: Array<{ hook: string; error: Error }> = [];

    this.logger?.info(`Initiating graceful shutdown [Reason: ${reason}]...`);

    // Execute hooks with a total deadline timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Graceful shutdown timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
    });

    const executionPromise = (async () => {
      for (const hook of this.hooks) {
        try {
          this.logger?.debug(`Executing shutdown hook: ${hook.name} (priority: ${hook.priority})`);
          await hook.execute();
          executedHooks.push(hook.name);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          this.logger?.error(`Error in shutdown hook '${hook.name}':`, error);
          errors.push({ hook: hook.name, error });
        }
      }
    })();

    try {
      await Promise.race([executionPromise, timeoutPromise]);
    } catch (err) {
      const timeoutError = err instanceof Error ? err : new Error(String(err));
      this.logger?.error("Graceful shutdown timeout exceeded:", timeoutError);
      errors.push({ hook: "shutdown-timeout", error: timeoutError });
    }

    const durationMs = Date.now() - startTime;
    this.logger?.info(`Graceful shutdown completed in ${durationMs}ms. Errors: ${errors.length}`);

    return {
      success: errors.length === 0,
      durationMs,
      executedHooks,
      errors,
    };
  }

  getRegisteredHooks(): readonly IShutdownHook[] {
    return [...this.hooks];
  }

  getTransactionalResources(): readonly ITransactionalResource[] {
    return Array.from(this.transactionalResources);
  }

  getIsShuttingDown(): boolean {
    return this.isShuttingDown;
  }
}
