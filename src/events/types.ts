import { z } from "zod";

/**
 * Zod schemas for runtime validation of Memory Bank event payloads
 */

export const FileChangedPayloadSchema = z.object({
  filePath: z.string().min(1, "filePath must not be empty"),
  changeType: z.enum(["add", "change", "unlink"]),
  diff: z.string().optional(),
  content: z.string().optional(),
  timestamp: z.number().default(() => Date.now()),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type FileChangedPayload = z.infer<typeof FileChangedPayloadSchema>;

export const MemoryIngestedPayloadSchema = z.object({
  sessionId: z.string().min(1, "sessionId must not be empty"),
  decisionId: z.string().optional(),
  sourceFile: z.string().min(1, "sourceFile must not be empty"),
  astFootprint: z.union([z.record(z.string(), z.unknown()), z.string()]),
  vectorEmbeddingId: z.string().optional(),
  embeddingDimension: z.number().int().positive().optional(),
  summary: z.string().min(1, "summary must not be empty"),
  timestamp: z.number().default(() => Date.now()),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type MemoryIngestedPayload = z.infer<typeof MemoryIngestedPayloadSchema>;

export const ContextRequestedPayloadSchema = z.object({
  requestId: z.string().min(1, "requestId must not be empty"),
  query: z.string().min(1, "query must not be empty"),
  requester: z.string().default("agent"),
  tokenBudget: z.number().int().positive().default(10000),
  timestamp: z.number().default(() => Date.now()),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type ContextRequestedPayload = z.infer<typeof ContextRequestedPayloadSchema>;

export const CriticalErrorPayloadSchema = z.object({
  errorId: z.string().min(1, "errorId must not be empty"),
  component: z.string().min(1, "component must not be empty"),
  message: z.string().min(1, "message must not be empty"),
  stack: z.string().optional(),
  severity: z.enum(["low", "medium", "high", "critical"]).default("critical"),
  timestamp: z.number().default(() => Date.now()),
  context: z.record(z.string(), z.unknown()).optional(),
});

export type CriticalErrorPayload = z.infer<typeof CriticalErrorPayloadSchema>;

export const BranchChangedPayloadSchema = z.object({
  previousBranch: z.string(),
  currentBranch: z.string(),
  timestamp: z.number().default(() => Date.now()),
});

export type BranchChangedPayload = z.infer<typeof BranchChangedPayloadSchema>;

/**
 * Standard Event-to-Payload mapping for the Memory Bank architecture
 */
export type MemoryBankEventMap = {
  FILE_CHANGED: FileChangedPayload;
  MEMORY_INGESTED: MemoryIngestedPayload;
  CONTEXT_REQUESTED: ContextRequestedPayload;
  CRITICAL_ERROR: CriticalErrorPayload;
  BRANCH_CHANGED: BranchChangedPayload;
};

export type MemoryBankEventName = keyof MemoryBankEventMap;

export type MemoryBusEventMap = MemoryBankEventMap;
export type MemoryBusEventName = MemoryBankEventName;

export const EVENT_SCHEMAS: {
  [K in MemoryBankEventName]: z.ZodType<MemoryBankEventMap[K]>;
} = {
  FILE_CHANGED: FileChangedPayloadSchema,
  MEMORY_INGESTED: MemoryIngestedPayloadSchema,
  CONTEXT_REQUESTED: ContextRequestedPayloadSchema,
  CRITICAL_ERROR: CriticalErrorPayloadSchema,
  BRANCH_CHANGED: BranchChangedPayloadSchema,
};
