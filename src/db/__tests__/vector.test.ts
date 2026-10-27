import { describe, it, expect } from "vitest";
import { VectorEmbeddingEngine } from "../vector.js";

describe("Phase 3: Local Vector Embedding Engine", () => {
  it("initializes asynchronously without blocking", async () => {
    const engine = new VectorEmbeddingEngine({ useMockFallback: true });
    expect(engine.isModelLoaded()).toBe(false);

    await engine.initialize();
    expect(engine.isModelLoaded()).toBe(true);
  });

  it("computes normalized vector embeddings", async () => {
    const engine = new VectorEmbeddingEngine({ useMockFallback: true });
    const embedding = await engine.embed("How does authentication work in Memory Bus?");

    expect(Array.isArray(embedding)).toBe(true);
    expect(embedding.length).toBe(384);

    // Verify vector norm is ~1.0
    const norm = Math.sqrt(embedding.reduce((acc, val) => acc + val * val, 0));
    expect(norm).toBeCloseTo(1.0, 3);
  });

  it("calculates cosine similarity and ranks semantic search results", async () => {
    const engine = new VectorEmbeddingEngine({ useMockFallback: true });

    const vecAuth = await engine.embed("User authentication and JWT token verification");
    const vecAuthSimilar = await engine.embed("User login, bearer auth, and token refresh");
    const vecDatabase = await engine.embed("SQLite database WAL checkpointing and migrations");

    const candidates = [
      { id: "dec-auth", embedding: vecAuthSimilar },
      { id: "dec-db", embedding: vecDatabase },
    ];

    const results = engine.searchSimilar(vecAuth, candidates, 10, 0.0);

    expect(results.length).toBe(2);
    // Auth should be more similar to Auth than DB
    expect(results[0]?.id).toBe("dec-auth");
    expect(results[0]?.similarity).toBeGreaterThan(results[1]!.similarity);
  });
});
