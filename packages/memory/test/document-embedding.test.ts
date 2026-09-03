import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_EMBEDDING_BATCH_SIZE,
  DEFAULT_MIN_EMBEDDABLE_CHARS,
  DOCUMENT_EMBEDDING_VERSION,
  JarvisError,
  MAX_EMBEDDING_BATCH_SIZE,
  type DocumentChunk,
  type EmbeddingRequest,
  type EmbeddingResponse,
  type IEmbeddingProvider,
  type IKnowledgeRepository,
} from "@jarvis/core";
import {
  DocumentEmbeddingService,
  resolveEmbeddingOptions,
  validateEmbeddingBatch,
} from "../src/embedding/index.js";
import { DocumentChunkingService } from "../src/chunking/index.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const DIMS = 1536;

/** A deterministic vector, distinct per seed, so pairing can be asserted. */
function vector(seed: number, dimensions = DIMS): number[] {
  return Array.from({ length: dimensions }, (_, i) => (seed + i) / 10_000);
}

interface FakeProviderOptions {
  dimensions?: number;
  model?: string;
  /** Overrides the response for full control (dimension mismatch, junk, ...). */
  respond?: (inputs: string[]) => EmbeddingResponse | Promise<EmbeddingResponse>;
  /** Throws on the Nth call (0-based) instead of responding. */
  failOnCall?: number;
  failWith?: unknown;
  usage?: boolean;
}

class FakeEmbeddingProvider implements IEmbeddingProvider {
  readonly id = "fake-embedding";
  readonly name = "Fake Embedding Provider";
  readonly dimensions: number;

  calls: string[][] = [];
  models: (string | undefined)[] = [];

  constructor(private options: FakeProviderOptions = {}) {
    this.dimensions = options.dimensions ?? DIMS;
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    const callIndex = this.calls.length;
    this.calls.push(inputs);
    this.models.push(request.model);

    if (this.options.failOnCall === callIndex) {
      throw this.options.failWith ?? new Error("provider exploded");
    }

    if (this.options.respond) return this.options.respond(inputs);

    return {
      embeddings: inputs.map((_, i) => vector(callIndex * 1000 + i, this.dimensions)),
      model: this.options.model ?? "fake-model-v1",
      ...(this.options.usage
        ? { usage: { promptTokens: inputs.length * 10, totalTokens: inputs.length * 12 } }
        : {}),
    };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

/** Minimal in-memory stand-in for the Sprint 3.1 repository. */
function makeFakeRepository() {
  const written: Array<{ documentId: string; chunkIndex: number; embedding: number[] }> = [];
  let failNext = false;

  const repo: IKnowledgeRepository = {
    createDocument: vi.fn(),
    getDocumentById: vi.fn(),
    listDocuments: vi.fn(),
    updateDocumentStatus: vi.fn(),
    deleteDocument: vi.fn(),
    createChunks: vi.fn(),
    getChunksByDocument: vi.fn(),
    deleteChunksByDocument: vi.fn(),
    updateChunkEmbeddings: async (documentId, embeddings) => {
      if (failNext) throw new Error("database unavailable");
      for (const item of embeddings) {
        written.push({ documentId, ...item });
      }
      return embeddings.length;
    },
  } as unknown as IKnowledgeRepository;

  return {
    repo,
    written,
    failPersistence: () => {
      failNext = true;
    },
  };
}

/** Chunks without running the real chunker, for precise control. */
function makeChunks(contents: string[]): DocumentChunk[] {
  let offset = 0;
  return contents.map((content, index) => {
    const chunk: DocumentChunk = {
      id: `chunk-${index}`,
      index,
      content,
      charCount: content.length,
      wordCount: content.trim() === "" ? 0 : content.trim().split(/\s+/).length,
      startOffset: offset,
      endOffset: offset + content.length,
      overlapWithPrevious: 0,
      boundary: "hard",
      metadata: { chunkingVersion: "3.3.0", pageNumbers: [], sections: [] },
    };
    offset += content.length;
    return chunk;
  });
}

const service = (options: FakeProviderOptions = {}) => {
  const provider = new FakeEmbeddingProvider(options);
  return { provider, embedder: new DocumentEmbeddingService({ provider }) };
};

// ---------------------------------------------------------------------------
// Option validation
// ---------------------------------------------------------------------------

describe("resolveEmbeddingOptions", () => {
  it("applies documented defaults", () => {
    expect(resolveEmbeddingOptions()).toEqual({
      batchSize: DEFAULT_EMBEDDING_BATCH_SIZE,
      minChars: DEFAULT_MIN_EMBEDDABLE_CHARS,
    });
  });

  it.each([0, -1, 1.5])("rejects batchSize %p", (batchSize) => {
    expect(() => resolveEmbeddingOptions({ batchSize })).toThrow(JarvisError);
  });

  it("rejects a batchSize beyond the ceiling", () => {
    expect(() =>
      resolveEmbeddingOptions({ batchSize: MAX_EMBEDDING_BATCH_SIZE + 1 })
    ).toThrow(/must not exceed/);
  });

  it("rejects a negative minChars", () => {
    expect(() => resolveEmbeddingOptions({ minChars: -1 })).toThrow(JarvisError);
  });

  it("raises INVALID_REQUEST for bad configuration", () => {
    try {
      resolveEmbeddingOptions({ batchSize: 0 });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as JarvisError).code).toBe("INVALID_REQUEST");
      expect((error as JarvisError).statusCode).toBe(400);
    }
  });

  it("requires a provider", () => {
    expect(
      () => new DocumentEmbeddingService({} as unknown as { provider: IEmbeddingProvider })
    ).toThrow(/provider is required/);
  });

  it("validates eagerly in the constructor", () => {
    const provider = new FakeEmbeddingProvider();
    expect(() => new DocumentEmbeddingService({ provider, batchSize: -1 })).toThrow(
      JarvisError
    );
  });
});

// ---------------------------------------------------------------------------
// Success
// ---------------------------------------------------------------------------

describe("successful embedding", () => {
  it("returns one vector per chunk, in chunk order", async () => {
    const { embedder } = service();
    const chunks = makeChunks(["alpha text", "beta text", "gamma text"]);

    const result = await embedder.embedChunks(chunks);

    expect(result.embeddedCount).toBe(3);
    expect(result.embeddings.map((e) => e.index)).toEqual([0, 1, 2]);
    expect(result.embeddings.map((e) => e.chunkId)).toEqual([
      "chunk-0",
      "chunk-1",
      "chunk-2",
    ]);
    for (const item of result.embeddings) {
      expect(item.embedding).toHaveLength(DIMS);
      expect(item.dimensions).toBe(DIMS);
      expect(item.embeddingVersion).toBe(DOCUMENT_EMBEDDING_VERSION);
    }
  });

  it("sends the trimmed chunk text to the provider", async () => {
    const { provider, embedder } = service();
    await embedder.embedChunks(makeChunks(["  padded text  "]));

    expect(provider.calls[0]).toEqual(["padded text"]);
  });

  it("records the model the provider actually used", async () => {
    const { embedder } = service({ model: "text-embedding-3-small-v2" });
    const result = await embedder.embedChunks(makeChunks(["some text"]));

    expect(result.model).toBe("text-embedding-3-small-v2");
    expect(result.embeddings[0]!.model).toBe("text-embedding-3-small-v2");
  });

  it("passes an explicit model override through to the provider", async () => {
    const { provider, embedder } = service();
    await embedder.embedChunks(makeChunks(["some text"]), { model: "custom-model" });

    expect(provider.models[0]).toBe("custom-model");
  });

  it("aggregates token usage across batches", async () => {
    const { embedder } = service({ usage: true });
    const chunks = makeChunks(Array.from({ length: 5 }, (_, i) => `chunk body ${i}`));

    const result = await embedder.embedChunks(chunks, { batchSize: 2 });

    expect(result.batchCount).toBe(3);
    expect(result.usage).toEqual({ promptTokens: 50, totalTokens: 60 });
  });

  it("omits usage when the provider reports none", async () => {
    const { embedder } = service({ usage: false });
    const result = await embedder.embedChunks(makeChunks(["text here"]));

    expect(result).not.toHaveProperty("usage");
  });

  it("works end to end on real chunker output", async () => {
    const chunker = new DocumentChunkingService();
    const text = Array.from(
      { length: 60 },
      (_, i) => `Sentence ${i} with a reasonable amount of body text.`
    ).join(" ");
    const chunked = chunker.chunkText(text, {}, { chunkSize: 300, chunkOverlap: 30 });

    const { embedder } = service();
    const result = await embedder.embedChunks(chunked.chunks);

    expect(result.embeddedCount).toBe(chunked.chunkCount);
    expect(result.embeddings.map((e) => e.chunkId)).toEqual(
      chunked.chunks.map((c) => c.id)
    );
  });
});

// ---------------------------------------------------------------------------
// Batching and determinism
// ---------------------------------------------------------------------------

describe("batching", () => {
  it("splits into batches of the configured size", async () => {
    const { provider, embedder } = service();
    const chunks = makeChunks(Array.from({ length: 10 }, (_, i) => `body number ${i}`));

    const result = await embedder.embedChunks(chunks, { batchSize: 3 });

    expect(result.batchCount).toBe(4);
    expect(provider.calls.map((c) => c.length)).toEqual([3, 3, 3, 1]);
  });

  it("makes a single call when everything fits one batch", async () => {
    const { provider, embedder } = service();
    await embedder.embedChunks(makeChunks(["one body", "two body"]), { batchSize: 64 });

    expect(provider.calls).toHaveLength(1);
  });

  it("keeps chunk-to-vector pairing correct across batch edges", async () => {
    const { embedder } = service();
    const chunks = makeChunks(Array.from({ length: 7 }, (_, i) => `distinct body ${i}`));

    const batched = await embedder.embedChunks(chunks, { batchSize: 2 });
    const single = await embedder.embedChunks(chunks, { batchSize: 100 });

    // Different batch splits must still map each chunk to the vector generated
    // for its own text.
    expect(batched.embeddings.map((e) => e.chunkId)).toEqual(
      single.embeddings.map((e) => e.chunkId)
    );
  });

  it("processes chunks in index order regardless of input order", async () => {
    const { provider, embedder } = service();
    const chunks = makeChunks(["first body", "second body", "third body"]);
    const shuffled = [chunks[2]!, chunks[0]!, chunks[1]!];

    const result = await embedder.embedChunks(shuffled);

    expect(result.embeddings.map((e) => e.index)).toEqual([0, 1, 2]);
    expect(provider.calls[0]).toEqual(["first body", "second body", "third body"]);
  });

  it("sends identical text once and shares the vector", async () => {
    const { provider, embedder } = service();
    const chunks = makeChunks(["repeated boilerplate", "unique body", "repeated boilerplate"]);

    const result = await embedder.embedChunks(chunks);

    expect(provider.calls[0]).toEqual(["repeated boilerplate", "unique body"]);
    expect(result.deduplicatedCount).toBe(1);
    expect(result.embeddedCount).toBe(3);
    // Both copies must carry the same vector, not two different ones.
    expect(result.embeddings[0]!.embedding).toEqual(result.embeddings[2]!.embedding);
    expect(result.embeddings[0]!.embedding).not.toEqual(result.embeddings[1]!.embedding);
  });

  it("reports zero deduplication when all chunks differ", async () => {
    const { embedder } = service();
    const result = await embedder.embedChunks(makeChunks(["aaa body", "bbb body"]));
    expect(result.deduplicatedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Empty and invalid chunks
// ---------------------------------------------------------------------------

describe("empty and invalid chunks", () => {
  it("returns an empty result for no chunks, without calling the provider", async () => {
    const { provider, embedder } = service();
    const result = await embedder.embedChunks([]);

    expect(result.embeddedCount).toBe(0);
    expect(result.batchCount).toBe(0);
    expect(provider.calls).toHaveLength(0);
  });

  it("skips empty and whitespace-only chunks", async () => {
    const { provider, embedder } = service();
    const chunks = makeChunks(["real body text", "", "   \n\t  ", "more body text"]);

    const result = await embedder.embedChunks(chunks);

    expect(result.embeddedCount).toBe(2);
    expect(result.skippedCount).toBe(2);
    expect(result.skipped.map((s) => s.reason)).toEqual(["empty", "empty"]);
    expect(provider.calls[0]).toEqual(["real body text", "more body text"]);
  });

  it("skips chunks below the minimum length", async () => {
    const { embedder } = service();
    const result = await embedder.embedChunks(makeChunks(["ok body", "x"]), {
      minChars: 3,
    });

    expect(result.embeddedCount).toBe(1);
    expect(result.skipped).toEqual([
      { chunkId: "chunk-1", index: 1, reason: "too-short", charCount: 1 },
    ]);
  });

  it("reports which chunks were skipped rather than dropping them silently", async () => {
    const { embedder } = service();
    const result = await embedder.embedChunks(makeChunks(["good body", "  "]));

    expect(result.skipped[0]).toEqual({
      chunkId: "chunk-1",
      index: 1,
      reason: "empty",
      charCount: 0,
    });
  });

  it("never calls the provider when every chunk is skipped", async () => {
    const { provider, embedder } = service();
    const result = await embedder.embedChunks(makeChunks(["", "  ", "\n"]));

    expect(provider.calls).toHaveLength(0);
    expect(result.embeddings).toEqual([]);
    expect(result.skippedCount).toBe(3);
    expect(result.batchCount).toBe(0);
  });

  it("embeds short chunks when the minimum is lowered", async () => {
    const { embedder } = service();
    const result = await embedder.embedChunks(makeChunks(["x"]), { minChars: 1 });
    expect(result.embeddedCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Provider failure
// ---------------------------------------------------------------------------

describe("provider failure", () => {
  it("wraps an unknown provider error as DOCUMENT_EMBEDDING_FAILED", async () => {
    const { embedder } = service({ failOnCall: 0 });

    await expect(embedder.embedChunks(makeChunks(["body text"]))).rejects.toMatchObject({
      code: "DOCUMENT_EMBEDDING_FAILED",
      statusCode: 500,
    });
  });

  it("carries the underlying message in details for diagnosis", async () => {
    const { embedder } = service({ failOnCall: 0, failWith: new Error("socket hang up") });

    try {
      await embedder.embedChunks(makeChunks(["body text"]));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as JarvisError).details?.cause).toBe("socket hang up");
      expect((error as JarvisError).details?.provider).toBe("fake-embedding");
    }
  });

  it("passes a provider JarvisError through untouched", async () => {
    // Rate limiting must stay distinguishable — the caller decides whether a
    // retry is worthwhile, and flattening it would lose that.
    const rateLimited = new JarvisError("RATE_LIMITED", "slow down", { retryAfter: 60 });
    const { embedder } = service({ failOnCall: 0, failWith: rateLimited });

    await expect(embedder.embedChunks(makeChunks(["body text"]))).rejects.toMatchObject({
      code: "RATE_LIMITED",
      statusCode: 429,
    });
  });

  it("fails the whole document when a later batch fails", async () => {
    const { embedder } = service({ failOnCall: 1 });
    const chunks = makeChunks(Array.from({ length: 6 }, (_, i) => `body number ${i}`));

    await expect(embedder.embedChunks(chunks, { batchSize: 2 })).rejects.toMatchObject({
      code: "DOCUMENT_EMBEDDING_FAILED",
    });
  });

  it("reports which batch failed", async () => {
    const { embedder } = service({ failOnCall: 2 });
    const chunks = makeChunks(Array.from({ length: 6 }, (_, i) => `body number ${i}`));

    try {
      await embedder.embedChunks(chunks, { batchSize: 2 });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as JarvisError).details?.batchIndex).toBe(2);
    }
  });
});

// ---------------------------------------------------------------------------
// Response validation
// ---------------------------------------------------------------------------

describe("response validation", () => {
  it("rejects a dimension mismatch", async () => {
    const { embedder } = service({
      respond: (inputs) => ({
        embeddings: inputs.map(() => vector(1, 768)),
        model: "wrong-dims",
      }),
    });

    await expect(embedder.embedChunks(makeChunks(["body text"]))).rejects.toMatchObject({
      code: "DOCUMENT_EMBEDDING_FAILED",
    });
    await expect(embedder.embedChunks(makeChunks(["body text"]))).rejects.toThrow(
      /768 dimensions, expected 1536/
    );
  });

  it("rejects too few vectors for the inputs sent", async () => {
    const { embedder } = service({
      respond: () => ({ embeddings: [vector(1)], model: "short" }),
    });

    await expect(
      embedder.embedChunks(makeChunks(["first body", "second body"]))
    ).rejects.toThrow(/count does not match/);
  });

  it("rejects an empty vector", async () => {
    const { embedder } = service({
      respond: (inputs) => ({ embeddings: inputs.map(() => []), model: "empty" }),
    });

    await expect(embedder.embedChunks(makeChunks(["body text"]))).rejects.toThrow(
      /empty or malformed vector/
    );
  });

  it("rejects a non-array response", async () => {
    const { embedder } = service({
      respond: () => ({ embeddings: null as unknown as number[][], model: "junk" }),
    });

    await expect(embedder.embedChunks(makeChunks(["body text"]))).rejects.toThrow(
      /non-array response/
    );
  });

  it("rejects NaN inside a vector", async () => {
    const { embedder } = service({
      respond: () => {
        const bad = vector(1);
        bad[42] = Number.NaN;
        return { embeddings: [bad], model: "nan" };
      },
    });

    await expect(embedder.embedChunks(makeChunks(["body text"]))).rejects.toThrow(
      /non-finite value/
    );
  });

  it("rejects Infinity inside a vector", async () => {
    const { embedder } = service({
      respond: () => {
        const bad = vector(1);
        bad[7] = Number.POSITIVE_INFINITY;
        return { embeddings: [bad], model: "inf" };
      },
    });

    await expect(embedder.embedChunks(makeChunks(["body text"]))).rejects.toThrow(
      /non-finite value/
    );
  });

  it("honours a provider that declares non-default dimensions", async () => {
    const provider = new FakeEmbeddingProvider({ dimensions: 768 });
    const embedder = new DocumentEmbeddingService({ provider });

    const result = await embedder.embedChunks(makeChunks(["body text"]));

    expect(result.dimensions).toBe(768);
    expect(result.embeddings[0]!.embedding).toHaveLength(768);
  });

  it("exposes validateEmbeddingBatch for direct use", () => {
    expect(() => validateEmbeddingBatch([vector(1)], 1, DIMS)).not.toThrow();
    expect(() => validateEmbeddingBatch([vector(1)], 2, DIMS)).toThrow(JarvisError);
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe("persistence", () => {
  it("writes vectors keyed by chunk index", async () => {
    const { embedder } = service();
    const { repo, written } = makeFakeRepository();

    const result = await embedder.embedAndPersist(
      repo,
      "doc-1",
      makeChunks(["alpha body", "beta body"])
    );

    expect(result.persistedCount).toBe(2);
    expect(written.map((w) => w.chunkIndex)).toEqual([0, 1]);
    expect(written.every((w) => w.documentId === "doc-1")).toBe(true);
    expect(written[0]!.embedding).toHaveLength(DIMS);
  });

  it("persists only chunks that were embedded", async () => {
    const { embedder } = service();
    const { repo, written } = makeFakeRepository();

    const result = await embedder.embedAndPersist(
      repo,
      "doc-2",
      makeChunks(["real body", "  ", "another body"])
    );

    expect(result.persistedCount).toBe(2);
    expect(written.map((w) => w.chunkIndex)).toEqual([0, 2]);
  });

  it("writes nothing when every chunk is skipped", async () => {
    const { embedder } = service();
    const { repo, written } = makeFakeRepository();

    const result = await embedder.embedAndPersist(repo, "doc-3", makeChunks(["", " "]));

    expect(result.persistedCount).toBe(0);
    expect(written).toHaveLength(0);
  });

  it("does not persist anything when embedding fails", async () => {
    const { embedder } = service({ failOnCall: 0 });
    const { repo, written } = makeFakeRepository();

    await expect(
      embedder.embedAndPersist(repo, "doc-4", makeChunks(["body text"]))
    ).rejects.toMatchObject({ code: "DOCUMENT_EMBEDDING_FAILED" });

    expect(written).toHaveLength(0);
  });

  it("surfaces a repository failure to the caller", async () => {
    const { embedder } = service();
    const { repo, failPersistence } = makeFakeRepository();
    failPersistence();

    await expect(
      embedder.embedAndPersist(repo, "doc-5", makeChunks(["body text"]))
    ).rejects.toThrow(/database unavailable/);
  });

  it("returns the embedding result alongside the persisted count", async () => {
    const { embedder } = service();
    const { repo } = makeFakeRepository();

    const result = await embedder.embedAndPersist(
      repo,
      "doc-6",
      makeChunks(["alpha body", "beta body"])
    );

    expect(result.embeddedCount).toBe(2);
    expect(result.embeddingVersion).toBe(DOCUMENT_EMBEDDING_VERSION);
    expect(result.dimensions).toBe(DIMS);
  });
});
