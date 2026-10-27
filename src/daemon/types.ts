/**
 * Core type definitions for the Memory Bus daemon lifecycle,
 * dependency injection, and graceful shutdown orchestration.
 */

export type DaemonState =
  | "INITIALIZING"
  | "LISTENING"
  | "INGESTING_MEMORY"
  | "RETRIEVING_CONTEXT"
  | "SHUTDOWN";

export interface DaemonMachineContext {
  startedAt: number | null;
  activeOperations: number;
  lastError: string | null;
  currentSessionId: string | null;
  shutdownReason: string | null;
}

export type DaemonLifecycleEvent =
  | { type: "INITIALIZE_SUCCESS" }
  | { type: "INITIALIZE_FAILURE"; error: string }
  | { type: "START_INGESTION"; payload: { sessionId: string; source: string } }
  | { type: "INGESTION_SUCCESS"; payload?: { decisionId?: string } }
  | { type: "INGESTION_FAILURE"; error: string }
  | { type: "START_RETRIEVAL"; payload: { query: string } }
  | { type: "RETRIEVAL_SUCCESS"; payload?: { resultCount?: number } }
  | { type: "RETRIEVAL_FAILURE"; error: string }
  | { type: "TERMINATE"; reason?: string };

export interface ILogger {
  info(message: string, ...meta: unknown[]): void;
  warn(message: string, ...meta: unknown[]): void;
  error(message: string, ...meta: unknown[]): void;
  debug(message: string, ...meta: unknown[]): void;
}

export interface ITransactionalResource {
  readonly name: string;
  hasActiveTransaction(): boolean;
  commitActiveTransactions(): Promise<void> | void;
  rollbackActiveTransactions?(): Promise<void> | void;
  close(): Promise<void> | void;
}

export interface IShutdownHook {
  readonly name: string;
  readonly priority: number; // Higher number = executed earlier
  execute(): Promise<void> | void;
}

export interface ShutdownResult {
  success: boolean;
  durationMs: number;
  executedHooks: string[];
  errors: Array<{ hook: string; error: Error }>;
}

export interface DaemonConfig {
  readonly name: string;
  readonly version: string;
  readonly shutdownTimeoutMs: number;
  readonly logLevel: "debug" | "info" | "warn" | "error";
}
