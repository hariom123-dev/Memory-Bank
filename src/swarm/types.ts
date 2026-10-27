/**
 * Types and interfaces for the Multi-Agent Session Multiplexer
 */

export interface AgentSession {
  sessionId: string;
  agentId: string;
  role?: string;
  createdAt: number;
  lastActiveAt: number;
}

export interface StoreDecisionParams {
  agentId: string;
  sessionId: string;
  contextSummary: string;
  reasoning: string;
  filePaths?: string[];
  astFootprint?: Record<string, unknown> | string;
  embedding?: number[];
}

export interface StoredDecision {
  id: string;
  sessionId: string;
  agentId: string;
  contextSummary: string;
  reasoning: string;
  filePaths: string[];
  createdAt: number;
  astFootprint?: Record<string, unknown> | string;
  embedding?: number[];
}

export interface RetrieveContextParams {
  agentId: string;
  sessionId?: string;
  query: string;
  limit?: number;
  threshold?: number;
}

export type DecisionAttribution = "primary" | "peer";

export interface WeightedDecision {
  decision: StoredDecision;
  rawScore: number;
  weightedScore: number;
  isOwnDecision: boolean;
  originAgentId: string;
  attribution: DecisionAttribution;
}

export interface MultiplexedContextResult {
  requestingAgentId: string;
  query: string;
  decisions: WeightedDecision[];
  markdownSummary: string;
}

export interface MultiplexerConfig {
  ownAgentWeight: number;    // e.g. 1.0 (decisions made by the requesting agent)
  peerAgentWeight: number;   // e.g. 0.5 (read-only decisions from other swarm agents)
  maxResults: number;        // default limit of returned decisions
  walBusyTimeoutMs: number;  // WAL lock busy timeout in ms
}
