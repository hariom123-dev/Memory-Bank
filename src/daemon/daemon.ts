import { createActor, type ActorRefFrom } from "xstate";
import { daemonMachine } from "./lifecycle.machine.js";
import { ServiceContainer, TOKENS, ConsoleLogger, type IContainer } from "./container.js";
import { GracefulShutdownManager } from "./shutdown.js";
import { validateEnv } from "../config/env.js";
import type {
  DaemonState,
  DaemonConfig,
  ILogger,
  ITransactionalResource,
  ShutdownResult,
} from "./types.js";

export interface DaemonOptions {
  container?: IContainer;
  config?: Partial<DaemonConfig>;
  autoBindSignals?: boolean;
}

export class MemoryBankDaemon {
  private container: IContainer;
  private actor: ActorRefFrom<typeof daemonMachine>;
  private shutdownManager: GracefulShutdownManager;
  private logger: ILogger;
  private config: DaemonConfig;
  private autoBindSignals: boolean;

  constructor(options: DaemonOptions = {}) {
    // Validate environment variables prior to booting XState machine
    const envConfig = validateEnv();

    this.container = options.container ?? new ServiceContainer();
    this.autoBindSignals = options.autoBindSignals ?? false;

    this.config = {
      name: "memory-bank-daemon",
      version: "0.1.0",
      shutdownTimeoutMs: envConfig.MEMORY_BANK_SHUTDOWN_TIMEOUT_MS,
      logLevel: envConfig.LOG_LEVEL,
      ...options.config,
    };

    // Configure logger
    if (!this.container.has(TOKENS.Logger)) {
      this.container.registerInstance(TOKENS.Logger, new ConsoleLogger());
    }
    this.logger = this.container.resolve(TOKENS.Logger);

    // Register config
    this.container.registerInstance(TOKENS.Config, this.config);

    // Configure shutdown manager
    this.shutdownManager = new GracefulShutdownManager({
      timeoutMs: this.config.shutdownTimeoutMs,
      logger: this.logger,
    });
    this.container.registerInstance(TOKENS.ShutdownManager, this.shutdownManager);

    // Initialize XState actor
    this.actor = createActor(daemonMachine);
    this.actor.start();

    // Hook daemon state transition on shutdown
    this.shutdownManager.registerHook({
      name: "daemon-machine-shutdown",
      priority: 10,
      execute: () => {
        if (this.getState() !== "SHUTDOWN") {
          this.actor.send({ type: "TERMINATE", reason: "Daemon shutdown initiated" });
        }
      },
    });

    if (this.autoBindSignals) {
      this.shutdownManager.bindProcessSignals();
    }
  }

  getContainer(): IContainer {
    return this.container;
  }

  getShutdownManager(): GracefulShutdownManager {
    return this.shutdownManager;
  }

  getState(): DaemonState {
    const snapshot = this.actor.getSnapshot();
    return snapshot.value as DaemonState;
  }

  getSnapshot() {
    return this.actor.getSnapshot();
  }

  /**
   * Registers a transactional database resource (e.g. SQLite connection/transaction).
   * Ensures that uncommitted transactions are committed before the process halts.
   */
  registerTransactionalResource(resource: ITransactionalResource): this {
    this.shutdownManager.registerTransactionalResource(resource);
    return this;
  }

  /**
   * Starts the daemon, transitioning INITIALIZING -> LISTENING.
   */
  async start(): Promise<void> {
    const currentState = this.getState();
    if (currentState !== "INITIALIZING") {
      throw new Error(`Cannot start daemon: current state is '${currentState}', expected 'INITIALIZING'.`);
    }

    try {
      this.logger.info(`Starting Memory Bank Daemon [${this.config.name} v${this.config.version}]...`);
      this.actor.send({ type: "INITIALIZE_SUCCESS" });
      this.logger.info(`Memory Bank Daemon is now LISTENING.`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to start daemon: ${errorMsg}`);
      this.actor.send({ type: "INITIALIZE_FAILURE", error: errorMsg });
      throw err;
    }
  }

  /**
   * Executes a memory ingestion operation, transitioning LISTENING -> INGESTING_MEMORY -> LISTENING.
   */
  async ingestMemory<T>(
    sessionId: string,
    source: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const currentState = this.getState();
    if (currentState !== "LISTENING") {
      throw new Error(
        `Cannot ingest memory: daemon is in '${currentState}' state, must be 'LISTENING'.`
      );
    }

    this.actor.send({
      type: "START_INGESTION",
      payload: { sessionId, source },
    });

    try {
      this.logger.debug(`Ingesting memory for session ${sessionId}...`);
      const result = await operation();
      this.actor.send({ type: "INGESTION_SUCCESS" });
      return result;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Memory ingestion failed: ${errorMsg}`);
      this.actor.send({ type: "INGESTION_FAILURE", error: errorMsg });
      throw err;
    }
  }

  /**
   * Executes a context retrieval operation, transitioning LISTENING -> RETRIEVING_CONTEXT -> LISTENING.
   */
  async retrieveContext<T>(
    query: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const currentState = this.getState();
    if (currentState !== "LISTENING") {
      throw new Error(
        `Cannot retrieve context: daemon is in '${currentState}' state, must be 'LISTENING'.`
      );
    }

    this.actor.send({
      type: "START_RETRIEVAL",
      payload: { query },
    });

    try {
      this.logger.debug(`Retrieving context for query: "${query}"...`);
      const result = await operation();
      this.actor.send({ type: "RETRIEVAL_SUCCESS" });
      return result;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Context retrieval failed: ${errorMsg}`);
      this.actor.send({ type: "RETRIEVAL_FAILURE", error: errorMsg });
      throw err;
    }
  }

  /**
   * Gracefully shuts down the daemon, committing all active transactions
   * and releasing resources.
   */
  async stop(reason = "Explicit daemon stop"): Promise<ShutdownResult> {
    this.logger.info(`Stopping Memory Bank Daemon [Reason: ${reason}]...`);
    if (this.autoBindSignals) {
      this.shutdownManager.unbindProcessSignals();
    }
    const result = await this.shutdownManager.triggerShutdown(reason);
    if (this.getState() !== "SHUTDOWN") {
      this.actor.send({ type: "TERMINATE", reason });
    }
    this.actor.stop();
    return result;
  }
}
