# 🧠 Memory Bus (Agent Swarm OS)

**The infinite context and local memory layer for autonomous AI agents.**

AI coding agents (Cursor, Cline, custom CLI agents) suffer from severe context decay. They forget the architectural decisions made on Day 1 by Day 3. **Memory Bus** is a local, OS-level background daemon that intercepts agent actions, parses their code into AST snapshots, and stores their reasoning in a hybrid SQLite/Vector database.

When an agent starts a new task, Memory Bus dynamically injects the exact historical context they need back into their prompt via the Model Context Protocol (MCP).

---

## 🚀 Quick Start

### Global Installation & Run
```bash
# 1. Install globally
npm install -g memory-bus

# 2. Start the background daemon in your repository
memory-bus start --daemon

# 3. Check daemon status
memory-bus status

# 4. Launch real-time Terminal UI monitor
memory-bus monitor
```

### Local Development Setup
```bash
# Clone the repository
git clone https://github.com/hariom123-dev/Memory-Bank.git
cd Memory-Bank

# Install dependencies
npm install

# Run the full test suite (70 unit tests across 19 suites)
npm test

# Build and bundle
npm run build
npm run bundle
```

---

## 🏗️ Core Architecture

This is not a wrapper. It is a strictly typed, fault-tolerant memory orchestrator built for local execution:

- **Zero-Cost Local Embeddings:** Uses `@xenova/transformers` (`all-MiniLM-L6-v2`) to generate semantic embeddings entirely locally inside the Node process. No OpenAI API keys, Pinecone subscriptions, or cloud dependencies required.
- **AST Code Snapshots:** Uses `ts-morph` and the TypeScript Compiler API to store the structural graph of your code (exported classes, methods, parameters, types, and JSDoc comments) alongside the agent's reasoning, not just raw text.
- **Git-Branch Isolation:** Memory is strictly scoped. Context learned on `feature/auth` will not pollute the `main` branch prompt.
- **Multi-Agent Multiplexer:** Safely coordinates concurrent reads and writes from a swarm of agents working in parallel using SQLite Write-Ahead Logging (`WAL`) mode. Requesting agent decisions are weighted at 1.0x (primary) while peer decisions are surfaced at 0.5x (read-only cross-agent knowledge).
- **Autonomous Garbage Collection:** Automatically scans the filesystem and prunes orphaned vectors and AST snapshots in batches of 50 when files are deleted.
- **Context Hydration Engine:** Strictly budgets retrieved historical decisions and AST snapshots to fit within a 10,000-token prompt budget.

---

## 🗄️ Tech Stack

| Layer | Technologies |
|---|---|
| **Daemon Orchestration** | Node.js (>=20), XState v5, Typed PubSub Bus |
| **Database** | `better-sqlite3` (WAL mode, Relational + JSON indexes) |
| **Vector Search** | Local Transformers.js (`Xenova/all-MiniLM-L6-v2`) |
| **AST Parser** | `ts-morph` & TypeScript Compiler API |
| **Interoperability** | Model Context Protocol (`@modelcontextprotocol/sdk`) |
| **File Interceptor** | `chokidar` (debounced file-watcher with Git diff capture) |
| **Bundling & Build** | `typescript`, `tsup`, `vitest` |

---

## 🔌 Model Context Protocol (MCP) Integration

Memory Bus exposes two native MCP tools for AI agents:
- `store_decision`: Vectorizes reasoning, extracts AST snapshots, and commits memories to the graph.
- `retrieve_context`: Queries semantic and lexical indexes, applying agent-specific weighting and branch isolation.

### Client Configuration (Cursor, Claude Desktop, Cline)

Add this configuration to your client's MCP configuration settings:

```json
{
  "mcpServers": {
    "memory-bus": {
      "command": "node",
      "args": ["<PATH_TO_MEMORY_BANK>/dist/cli/index.js", "mcp"]
    }
  }
}
```

---

## 💻 CLI Commands

```bash
memory-bus start          # Start daemon in foreground
memory-bus start --daemon # Start daemon as a detached background process
memory-bus stop           # Gracefully terminate background daemon (commits pending transactions)
memory-bus status         # Display whether daemon is active and PID
memory-bus monitor        # Launch real-time Terminal UI monitor
memory-bus mcp            # Launch MCP stdio server
memory-bus version        # Print version
```

---

## 🤝 Contributing

We are actively looking for contributors to help expand AST parser support to Python and Rust, build additional TUI dashboards, and optimize vector similarity search.

1. Fork the repository
2. Create your branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m "Add amazing feature"`)
4. Verify tests pass (`npm test`)
5. Push to the branch (`git push origin feature/amazing-feature`)
6. Open a Pull Request

---

## 📄 License

MIT © [hariom123-dev](https://github.com/hariom123-dev)
