import { describe, it, expect } from "vitest";
import { createMemoryBankMcpServer } from "../server.js";

describe("Phase 5: The MCP (Model Context Protocol) Server", () => {
  it("executes store_decision tool and persists decision with vector embeddings", async () => {
    const { handleToolCall } = createMemoryBankMcpServer();

    const storeResult = await handleToolCall("store_decision", {
      agent_id: "coder-agent-1",
      session_id: "sess-100",
      context_summary: "Selected AES-256-GCM for encrypted sessions",
      reasoning: "GCM mode provides confidentiality and integrity guarantees",
      file_paths: ["src/security/crypto.ts"],
    });

    expect(storeResult.content[0]?.text).toContain("stored successfully for agent 'coder-agent-1'");
  });

  it("executes retrieve_context tool and returns formatted Markdown context", async () => {
    const { handleToolCall } = createMemoryBankMcpServer();

    // Store a decision first
    await handleToolCall("store_decision", {
      agent_id: "coder-agent-1",
      session_id: "sess-100",
      context_summary: "Configured JWT expiration to 15 minutes",
      reasoning: "Short lived tokens reduce replay window",
      file_paths: ["src/auth/jwt.ts"],
    });

    // Retrieve context
    const retrieveResult = await handleToolCall("retrieve_context", {
      agent_id: "coder-agent-1",
      session_id: "sess-100",
      query: "JWT expiration token duration",
    });

    const markdown = retrieveResult.content[0]?.text ?? "";
    expect(markdown).toContain("# Swarm Memory Context");
    expect(markdown).toContain("Configured JWT expiration to 15 minutes");
    expect(markdown).toContain("Short lived tokens reduce replay window");
  });
});
