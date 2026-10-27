import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { MemoryRepository } from "../db/relational.js";
import { VectorEmbeddingEngine } from "../db/vector.js";
import { AstMemoryParser } from "../ast/parser.js";
import { MultiAgentMultiplexer } from "../swarm/multiplexer.js";
import type { ILogger } from "../daemon/types.js";

export interface McpServerOptions {
  repository?: MemoryRepository;
  vectorEngine?: VectorEmbeddingEngine;
  astParser?: AstMemoryParser;
  multiplexer?: MultiAgentMultiplexer;
  logger?: ILogger;
}

export function createMemoryBusMcpServer(options: McpServerOptions = {}): {
  server: Server;
  handleToolCall: (name: string, args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
} {
  const repo = options.repository ?? new MemoryRepository({ inMemory: true });
  const vectorEngine = options.vectorEngine ?? new VectorEmbeddingEngine({ useMockFallback: true });
  const astParser = options.astParser ?? new AstMemoryParser();
  const multiplexer = options.multiplexer ?? new MultiAgentMultiplexer({ existingDb: repo.getDatabase() });
  const logger = options.logger;

  const server = new Server(
    {
      name: "memory-bus-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  const tools: Tool[] = [
    {
      name: "store_decision",
      description:
        "Stores an architectural decision made by an AI agent. Vectorizes the reasoning, extracts AST footprints of the affected files, and persists the memory graph.",
      inputSchema: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "Unique identifier of the agent" },
          session_id: { type: "string", description: "Current task/session ID" },
          context_summary: { type: "string", description: "Summary of the context or problem" },
          reasoning: { type: "string", description: "Detailed reasoning for the decision" },
          file_paths: {
            type: "array",
            items: { type: "string" },
            description: "List of files impacted or modified",
          },
        },
        required: ["agent_id", "session_id", "context_summary", "reasoning"],
      },
    },
    {
      name: "retrieve_context",
      description:
        "Performs semantic search across historical architectural decisions and AST code footprints, weighted specifically for the requesting agent.",
      inputSchema: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "Unique identifier of the agent requesting context" },
          session_id: { type: "string", description: "Current task/session ID" },
          query: { type: "string", description: "Semantic search query or topic" },
          limit: { type: "number", description: "Maximum number of decisions to return" },
        },
        required: ["agent_id", "session_id", "query"],
      },
    },
  ];

  async function handleToolCall(
    name: string,
    args: Record<string, unknown>
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    if (name === "store_decision") {
      const agentId = String(args["agent_id"] ?? "default_agent");
      const sessionId = String(args["session_id"] ?? "default_session");
      const contextSummary = String(args["context_summary"] ?? "");
      const reasoning = String(args["reasoning"] ?? "");
      const filePaths = Array.isArray(args["file_paths"])
        ? (args["file_paths"] as string[])
        : [];

      // 1. Vectorize reasoning
      const embedding = await vectorEngine.embed(`${contextSummary} ${reasoning}`);

      // 2. Parse AST of target files
      let astFootprint: Record<string, unknown> | undefined;
      if (filePaths.length > 0) {
        try {
          const firstPath = filePaths[0]!;
          const astData = astParser.parseSource(firstPath);
          astFootprint = {
            classes: astData.classes.map((c) => c.name),
            functions: astData.functions.map((f) => f.name),
            dependencies: astData.dependencies,
          };
        } catch {
          // fallback if file doesn't exist yet
        }
      }

      // 3. Store via multiplexer / repo
      const stored = multiplexer.storeDecision({
        agentId,
        sessionId,
        contextSummary,
        reasoning,
        filePaths,
        ...(astFootprint ? { astFootprint } : {}),
        embedding,
      });

      return {
        content: [
          {
            type: "text",
            text: `Decision '${stored.id}' stored successfully for agent '${agentId}'.`,
          },
        ],
      };
    }

    if (name === "retrieve_context") {
      const agentId = String(args["agent_id"] ?? "default_agent");
      const query = String(args["query"] ?? "");
      const limit = typeof args["limit"] === "number" ? args["limit"] : 10;

      // 1. Embed query
      const queryEmbedding = await vectorEngine.embed(query);

      // 2. Retrieve weighted context
      const result = multiplexer.retrieveWeightedContext(
        { agentId, query, limit },
        queryEmbedding
      );

      return {
        content: [
          {
            type: "text",
            text: result.markdownSummary,
          },
        ],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  }

  // Register MCP Handlers
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const toolName = request.params.name;
      const toolArgs = (request.params.arguments ?? {}) as Record<string, unknown>;
      return await handleToolCall(toolName, toolArgs);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger?.error("MCP tool execution error:", errorMsg);
      return {
        content: [{ type: "text", text: `Error: ${errorMsg}` }],
        isError: true,
      };
    }
  });

  return { server, handleToolCall };
}
