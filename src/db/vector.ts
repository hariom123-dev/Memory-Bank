import type { ILogger } from "../daemon/types.js";

export interface VectorSearchResult {
  id: string;
  similarity: number;
}

export interface VectorEngineOptions {
  modelName?: string;
  quantized?: boolean;
  logger?: ILogger;
  useMockFallback?: boolean;
}

export class VectorEmbeddingEngine {
  private modelName: string;
  private quantized: boolean;
  private logger?: ILogger | undefined;
  private useMockFallback: boolean;
  private pipelinePromise: Promise<unknown> | null = null;
  private isLoaded = false;

  constructor(options: VectorEngineOptions = {}) {
    this.modelName = options.modelName ?? "Xenova/all-MiniLM-L6-v2";
    this.quantized = options.quantized ?? true;
    this.logger = options.logger;
    this.useMockFallback = options.useMockFallback ?? false;
  }

  /**
   * Initializes and caches the embedding pipeline asynchronously.
   * Prevents freezing daemon startup.
   */
  async initialize(): Promise<void> {
    if (this.pipelinePromise) {
      await this.pipelinePromise;
      return;
    }

    if (this.useMockFallback) {
      this.isLoaded = true;
      return;
    }

    this.pipelinePromise = (async () => {
      try {
        this.logger?.info(`Loading local vector model '${this.modelName}' asynchronously...`);
        const { pipeline } = await import("@xenova/transformers");
        const pipe = await pipeline("feature-extraction", this.modelName, {
          quantized: this.quantized,
        });
        this.isLoaded = true;
        this.logger?.info(`Vector model '${this.modelName}' loaded and ready.`);
        return pipe;
      } catch (err) {
        this.logger?.warn("Failed to load local transformers model, enabling deterministic mock fallback:", err);
        this.useMockFallback = true;
        this.isLoaded = true;
        return null;
      }
    })();

    await this.pipelinePromise;
  }

  isModelLoaded(): boolean {
    return this.isLoaded;
  }

  /**
   * Generates a normalized 384-dimensional vector embedding for text.
   */
  async embed(text: string): Promise<number[]> {
    if (!this.isLoaded && !this.pipelinePromise) {
      await this.initialize();
    } else if (this.pipelinePromise) {
      await this.pipelinePromise;
    }

    if (this.useMockFallback) {
      return this.generateDeterministicMockEmbedding(text);
    }

    try {
      const pipe = (await this.pipelinePromise) as ((
        input: string,
        opts: { pooling: string; normalize: boolean }
      ) => Promise<{ data: Float32Array }>) | null;

      if (!pipe) {
        return this.generateDeterministicMockEmbedding(text);
      }

      const output = await pipe(text, { pooling: "mean", normalize: true });
      return Array.from(output.data);
    } catch (err) {
      this.logger?.warn("Embedding generation failed, falling back to deterministic mock:", err);
      return this.generateDeterministicMockEmbedding(text);
    }
  }

  /**
   * Computes cosine similarity between two normalized vectors.
   */
  cosineSimilarity(vecA: number[], vecB: number[]): number {
    if (vecA.length !== vecB.length || vecA.length === 0) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
      const a = vecA[i] ?? 0;
      const b = vecB[i] ?? 0;
      dot += a * b;
      normA += a * a;
      normB += b * b;
    }
    if (normA === 0 || normB === 0) return 0;
    return Math.max(0, dot / (Math.sqrt(normA) * Math.sqrt(normB)));
  }

  /**
   * Performs semantic search against candidates.
   */
  searchSimilar(
    queryVector: number[],
    candidates: Array<{ id: string; embedding: number[] }>,
    limit = 10,
    minSimilarity = 0.05
  ): VectorSearchResult[] {
    const scored: VectorSearchResult[] = [];

    for (const item of candidates) {
      const sim = this.cosineSimilarity(queryVector, item.embedding);
      if (sim >= minSimilarity) {
        scored.push({ id: item.id, similarity: Number(sim.toFixed(4)) });
      }
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, limit);
  }

  /**
   * Deterministic 384-dimensional vector embedding for mock/fallback scenarios.
   */
  private generateDeterministicMockEmbedding(text: string): number[] {
    const dim = 384;
    const vec = new Array<number>(dim).fill(0);
    const words = text.toLowerCase().split(/\s+/);

    for (let i = 0; i < words.length; i++) {
      const word = words[i]!;
      for (let j = 0; j < word.length; j++) {
        const charCode = word.charCodeAt(j);
        const idx = (charCode * (j + 1) * (i + 1)) % dim;
        vec[idx] = (vec[idx] ?? 0) + 1.0;
      }
    }

    // Normalize
    let norm = 0;
    for (let i = 0; i < dim; i++) {
      norm += (vec[i] ?? 0) * (vec[i] ?? 0);
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < dim; i++) {
        vec[i] = (vec[i] ?? 0) / norm;
      }
    } else {
      vec[0] = 1.0;
    }

    return vec;
  }
}
