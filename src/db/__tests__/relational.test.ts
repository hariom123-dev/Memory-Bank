import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryRepository } from "../relational.js";

describe("Phase 2: Hybrid Relational Database Engine", () => {
  let repo: MemoryRepository;

  beforeEach(() => {
    repo = new MemoryRepository({ inMemory: true });
  });

  afterEach(() => {
    repo.close();
  });

  it("inserts and finds sessions", () => {
    const session = {
      id: "sess-001",
      agentId: "agent-coder",
      role: "lead-developer",
      createdAt: 1000,
      lastActiveAt: 1000,
    };

    repo.insertSession(session);
    const retrieved = repo.findSessionById("sess-001");

    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe("sess-001");
    expect(retrieved?.agentId).toBe("agent-coder");
    expect(retrieved?.role).toBe("lead-developer");
  });

  it("inserts and queries architectural decisions", () => {
    repo.insertSession({
      id: "sess-002",
      agentId: "agent-arch",
      createdAt: 1000,
      lastActiveAt: 1000,
    });

    const decision = {
      id: "dec-001",
      sessionId: "sess-002",
      agentId: "agent-arch",
      contextSummary: "Migrated to JWT Bearer authentication",
      reasoning: "Stateless auth improves scalability across horizontal replicas",
      filePaths: ["src/auth/jwt.ts", "src/auth/middleware.ts"],
      embedding: [0.1, 0.2, 0.3],
      branchName: "main",
      createdAt: 2000,
    };

    repo.insertDecision(decision);

    const found = repo.findDecisionById("dec-001");
    expect(found).not.toBeNull();
    expect(found?.contextSummary).toBe("Migrated to JWT Bearer authentication");
    expect(found?.filePaths).toEqual(["src/auth/jwt.ts", "src/auth/middleware.ts"]);
    expect(found?.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(found?.branchName).toBe("main");

    const agentDecisions = repo.findDecisionsByAgent("agent-arch");
    expect(agentDecisions.length).toBe(1);
  });

  it("inserts and retrieves code AST snapshots", () => {
    repo.insertSession({ id: "sess-003", agentId: "agent-1", createdAt: 100, lastActiveAt: 100 });
    repo.insertDecision({
      id: "dec-002",
      sessionId: "sess-003",
      agentId: "agent-1",
      contextSummary: "Added AST parser",
      reasoning: "Needed structural analysis",
      filePaths: ["src/ast/parser.ts"],
      createdAt: 200,
    });

    const snapshot = {
      id: "snap-001",
      decisionId: "dec-002",
      filePath: "src/ast/parser.ts",
      astJson: { classes: ["AstMemoryParser"], exports: ["parseSourceFile"] },
      createdAt: 200,
    };

    repo.insertCodeSnapshot(snapshot);

    const snapshots = repo.findSnapshotsByDecisionId("dec-002");
    expect(snapshots.length).toBe(1);
    expect(snapshots[0]?.filePath).toBe("src/ast/parser.ts");

    const byPath = repo.findSnapshotsByFilePath("src/ast/parser.ts");
    expect(byPath.length).toBe(1);
  });
});
