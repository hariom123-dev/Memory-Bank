import type { TypedEventBus } from "./bus.js";
import type {
  MemoryBusEventMap,
  FileChangedPayload,
  MemoryIngestedPayload,
} from "./types.js";
import type { ILogger } from "../daemon/types.js";

export interface AstProcessingResult {
  sessionId?: string;
  decisionId?: string;
  sourceFile: string;
  astFootprint: Record<string, unknown> | string;
  summary: string;
  metadata?: Record<string, unknown>;
}

export type AstProcessor = (
  fileEvent: FileChangedPayload
) => Promise<AstProcessingResult | null> | AstProcessingResult | null;

export type VectorProcessor = (
  astResult: AstProcessingResult
) => Promise<{ vectorEmbeddingId: string; dimension: number } | null>;

export type StorageHandler = (
  payload: MemoryIngestedPayload
) => Promise<void> | void;

export interface PipelineOptions {
  bus: TypedEventBus<MemoryBusEventMap>;
  astProcessor: AstProcessor;
  vectorProcessor?: VectorProcessor;
  storageHandler?: StorageHandler;
  logger?: ILogger;
  supportedExtensions?: string[];
}

export class DecoupledMemoryPipeline {
  private bus: TypedEventBus<MemoryBusEventMap>;
  private astProcessor: AstProcessor;
  private vectorProcessor?: VectorProcessor | undefined;
  private storageHandler?: StorageHandler | undefined;
  private logger?: ILogger | undefined;
  private supportedExtensions: Set<string>;
  private unsubscribeFileChanged?: (() => void) | undefined;
  private unsubscribeMemoryIngested?: (() => void) | undefined;

  constructor(options: PipelineOptions) {
    this.bus = options.bus;
    this.astProcessor = options.astProcessor;
    this.vectorProcessor = options.vectorProcessor;
    this.storageHandler = options.storageHandler;
    this.logger = options.logger;
    this.supportedExtensions = new Set(
      options.supportedExtensions ?? [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]
    );
  }

  /**
   * Starts the decoupled pipeline by listening for FILE_CHANGED events.
   */
  start(): this {
    if (this.isRunning()) {
      return this;
    }

    // Step 1: Listen for FILE_CHANGED -> Process AST -> Publish MEMORY_INGESTED
    this.unsubscribeFileChanged = this.bus.subscribe(
      "FILE_CHANGED",
      async (fileEvent) => {
        await this.handleFileChanged(fileEvent);
      },
      { id: "pipeline_ast_processor" }
    );

    // Step 2: If a storage handler is supplied, listen for MEMORY_INGESTED -> Store
    if (this.storageHandler) {
      this.unsubscribeMemoryIngested = this.bus.subscribe(
        "MEMORY_INGESTED",
        async (memoryEvent) => {
          try {
            await this.storageHandler?.(memoryEvent);
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            this.logger?.error("Failed to store ingested memory:", error);
            await this.bus.publish("CRITICAL_ERROR", {
              errorId: `err_store_${Date.now()}`,
              component: "STORAGE_HANDLER",
              message: error.message,
              stack: error.stack,
              severity: "high",
              timestamp: Date.now(),
              context: { memorySessionId: memoryEvent.sessionId },
            });
          }
        },
        { id: "pipeline_storage_handler" }
      );
    }

    this.logger?.info("DecoupledMemoryPipeline started.");
    return this;
  }

  /**
   * Stops the pipeline and detaches all event bus subscriptions.
   */
  stop(): this {
    if (this.unsubscribeFileChanged) {
      this.unsubscribeFileChanged();
      this.unsubscribeFileChanged = undefined;
    }
    if (this.unsubscribeMemoryIngested) {
      this.unsubscribeMemoryIngested();
      this.unsubscribeMemoryIngested = undefined;
    }
    this.logger?.info("DecoupledMemoryPipeline stopped.");
    return this;
  }

  isRunning(): boolean {
    return this.unsubscribeFileChanged !== undefined;
  }

  private isSupportedFile(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    for (const ext of this.supportedExtensions) {
      if (lower.endsWith(ext)) {
        return true;
      }
    }
    return false;
  }

  private async handleFileChanged(fileEvent: FileChangedPayload): Promise<void> {
    if (fileEvent.changeType === "unlink") {
      this.logger?.debug(`Skipping AST processing for unlinked file: ${fileEvent.filePath}`);
      return;
    }

    if (!this.isSupportedFile(fileEvent.filePath)) {
      this.logger?.debug(`Ignoring unsupported file extension: ${fileEvent.filePath}`);
      return;
    }

    try {
      this.logger?.debug(`Processing AST for changed file: ${fileEvent.filePath}`);
      const astResult = await this.astProcessor(fileEvent);

      if (!astResult) {
        this.logger?.debug(`AST processor returned null for file: ${fileEvent.filePath}`);
        return;
      }

      let vectorData: { vectorEmbeddingId: string; dimension: number } | null = null;
      if (this.vectorProcessor) {
        vectorData = await this.vectorProcessor(astResult);
      }

      const memoryPayload: MemoryIngestedPayload = {
        sessionId: astResult.sessionId ?? `session_${Date.now()}`,
        decisionId: astResult.decisionId,
        sourceFile: astResult.sourceFile,
        astFootprint: astResult.astFootprint,
        summary: astResult.summary,
        timestamp: Date.now(),
        metadata: astResult.metadata,
        ...(vectorData
          ? {
              vectorEmbeddingId: vectorData.vectorEmbeddingId,
              embeddingDimension: vectorData.dimension,
            }
          : {}),
      };

      this.logger?.info(`Emitting MEMORY_INGESTED for file: ${fileEvent.filePath}`);
      await this.bus.publish("MEMORY_INGESTED", memoryPayload);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.logger?.error(`Error processing AST for '${fileEvent.filePath}':`, error);

      await this.bus.publish("CRITICAL_ERROR", {
        errorId: `err_ast_${Date.now()}`,
        component: "AST_MEMORY_PIPELINE",
        message: error.message,
        stack: error.stack,
        severity: "critical",
        timestamp: Date.now(),
        context: { filePath: fileEvent.filePath },
      });
    }
  }
}
