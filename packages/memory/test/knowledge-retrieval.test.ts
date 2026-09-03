import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_RETRIEVAL_TOP_K,
  DEFAULT_SIMILARITY_THRESHOLD,
  JarvisError,
  KNOWLEDGE_RETRIEVAL_VERSION,
  MAX_RETRIEVAL_TOP_K,
  type EmbeddingRequest,
  type EmbeddingResponse,
  type IEmbeddingProvider,
  type IKnowledgeRepository,
  type KnowledgeChunkMatch,
  type KnowledgeChunkSearchOptions,
} from "@jarvis/core";
import {
  KnowledgeRetrievalService,
  compareRetrievedChunks,
  resolveRetrievalOptions,
  toRetrievedChunk,
} from "../src/retrieval/index.js";

// ---------------------------------------------------------------------------
// Test doubles
//
// The corpus lives in a 3-dimensional space so every expected score can be
// worked out by hand: [1,0,0] is the "refunds" axis, [0,1,0] "shipping" and
// [0,0,1] "security".
// ---------------------------------------------------------------------------

const DIMS = 3;

const REFUNDS = [1, 0, 0];
const SHIPPING = [0, 1, 0];
const SECURITY = [0, 0, 1];
const ANTI_REFUNDS = [-1, 0, 0];
/** cos to REFUNDS = 3/sqrt(10) ≈ 0.9487 */
const MOSTLY_REFUNDS = [3, 1, 0];

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

interface FakeProviderOptions {
  dimensions?: number;
  model?: string;
  /** Query text to vector. Anything unlisted falls back to REFUNDS. */
  vectors?: Record<string, number[]>;
  /** Overrides the response entirely (bad counts, junk vectors, ...). */
  respond?: (inputs: string[]) => EmbeddingResponse | Promise<EmbeddingResponse>;
  failWith?: unknown;
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
    this.calls.push(inputs);
    this.models.push(request.model);

    if (this.options.failWith) throw this.options.failWith;
    if (this.options.respond) return this.options.respond(inputs);

    return {
      embeddings: inputs.map(
        (text) => this.options.vectors?.[text] ?? [...REFUNDS]
      ),
      model: this.options.model ?? "fake-embed-v1",
    };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

interface CorpusRow {
  id: string;
  userId: string;
  documentId: string;
  documentTitle: string;
  documentType: string | null;
  source: string | null;
  status: string;
  chunkIndex: number;
  content: string;
  embedding: number[];
  metadata?: unknown;
}

interface FakeRepoOptions {
  failWith?: unknown;
  /** Returns something that is not an array, as a broken store might. */
  returnJunk?: boolean;
  /** Reverses the result order, to prove the service imposes its own. */
  reverse?: boolean;
}

/**
 * In-memory stand-in for `PrismaKnowledgeRepository.searchChunksByEmbedding`.
 *
 * It implements the documented contract rather than returning canned rows —
 * real cosine ranking, the ownership scope, the threshold, the filters, the
 * `(documentId, chunkIndex)` tiebreak and the limit — so the service tests
 * exercise ranking behaviour instead of a stub.
 */
function makeCorpusRepository(rows: CorpusRow[], options: FakeRepoOptions = {}) {
  const searchCalls: Array<{
    userId: string;
    embedding: number[];
    options: KnowledgeChunkSearchOptions;
  }> = [];

  const search = async (
    userId: string,
    embedding: number[],
    searchOptions: KnowledgeChunkSearchOptions
  ): Promise<KnowledgeChunkMatch[]> => {
    searchCalls.push({ userId, embedding, options: searchOptions });

    if (options.failWith) throw options.failWith;
    if (options.returnJunk) return "not-an-array" as unknown as KnowledgeChunkMatch[];

    const filters = [
      searchOptions.documentIds,
      searchOptions.documentTypes,
      searchOptions.sources,
      searchOptions.statuses,
    ];
    if (filters.some((values) => values !== undefined && values.length === 0)) {
      return [];
    }

    let candidates = rows.filter((row) => row.userId === userId);

    if (searchOptions.documentIds) {
      candidates = candidates.filter((row) =>
        searchOptions.documentIds!.includes(row.documentId)
      );
    }
    if (searchOptions.documentTypes) {
      candidates = candidates.filter(
        (row) =>
          row.documentType !== null &&
          searchOptions.documentTypes!.includes(row.documentType)
      );
    }
    if (searchOptions.sources) {
      candidates = candidates.filter(
        (row) => row.source !== null && searchOptions.sources!.includes(row.source)
      );
    }
    if (searchOptions.statuses) {
      candidates = candidates.filter((row) =>
        searchOptions.statuses!.includes(row.status)
      );
    }

    let scored = candidates.map((row) => {
      const score = cosine(embedding, row.embedding);
      return {
        id: row.id,
        documentId: row.documentId,
        content: row.content,
        chunkIndex: row.chunkIndex,
        metadata: row.metadata ?? null,
        documentTitle: row.documentTitle,
        documentType: row.documentType,
        source: row.source,
        status: row.status,
        score,
        distance: 1 - score,
      } satisfies KnowledgeChunkMatch;
    });

    if (searchOptions.similarityThreshold !== undefined) {
      const floor = searchOptions.similarityThreshold;
      scored = scored.filter((row) => row.score >= floor);
    }

    scored.sort((a, b) => {
      if (a.distance !== b.distance) return a.distance - b.distance;
      if (a.documentId !== b.documentId) return a.documentId < b.documentId ? -1 : 1;
      return a.chunkIndex - b.chunkIndex;
    });

    const limited = scored.slice(0, searchOptions.limit);
    return options.reverse ? limited.reverse() : limited;
  };

  const repo = {
    createDocument: vi.fn(),
    getDocumentById: vi.fn(),
    listDocuments: vi.fn(),
    updateDocumentStatus: vi.fn(),
    deleteDocument: vi.fn(),
    createChunks: vi.fn(),
    getChunksByDocument: vi.fn(),
    deleteChunksByDocument: vi.fn(),
    updateChunkEmbeddings: vi.fn(),
    searchChunksByEmbedding: search,
  } as unknown as IKnowledgeRepository;

  return { repo, searchCalls };
}

/** Metadata in the exact shape the Sprint 3.3 chunk mapper writes. */
const SPRINT_33_METADATA = {
  chunkId: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
  charCount: 34,
  wordCount: 6,
  startOffset: 0,
  endOffset: 34,
  overlapWithPrevious: 0,
  boundary: "paragraph",
  chunkSize: 1000,
  chunkOverlap: 200,
  documentTitle: "Refund Policy.pdf",
  fileName: "Refund Policy.pdf",
  format: "pdf",
  mimeType: "application/pdf",
  contentHash: "f".repeat(64),
  extractionVersion: "3.2.0",
  chunkingVersion: "3.3.0",
  pageNumbers: [1, 2],
  sections: [
    { title: "Refunds", level: 1, order: 0 },
    { title: "Eligibility", level: 2, order: 1 },
  ],
  primarySection: { title: "Refunds", level: 1, order: 0 },
};

const USER = "user-1";

function corpus(): CorpusRow[] {
  return [
    {
      id: "row-a0",
      userId: USER,
      documentId: "doc-a",
      documentTitle: "Refund Policy.pdf",
      documentType: "POLICY",
      source: "upload",
      status: "PROCESSED",
      chunkIndex: 0,
      content: "Refunds are issued within 14 days.",
      embedding: REFUNDS,
      metadata: SPRINT_33_METADATA,
    },
    {
      id: "row-a1",
      userId: USER,
      documentId: "doc-a",
      documentTitle: "Refund Policy.pdf",
      documentType: "POLICY",
      source: "upload",
      status: "PROCESSED",
      chunkIndex: 1,
      content: "Refund requests need an order number.",
      embedding: MOSTLY_REFUNDS,
      metadata: { chunkingVersion: "3.3.0", pageNumbers: [2], sections: [] },
    },
    {
      id: "row-b0",
      userId: USER,
      documentId: "doc-b",
      documentTitle: "Shipping FAQ.docx",
      documentType: "FAQ",
      source: "import",
      status: "PROCESSED",
      chunkIndex: 0,
      content: "Shipping takes three to five business days.",
      embedding: SHIPPING,
      metadata: null,
    },
    {
      id: "row-b1",
      userId: USER,
      documentId: "doc-b",
      documentTitle: "Shipping FAQ.docx",
      documentType: "FAQ",
      source: "import",
      status: "PROCESSED",
      chunkIndex: 1,
      content: "Report security incidents to the on-call engineer.",
      embedding: SECURITY,
      metadata: null,
    },
    {
      id: "row-c0",
      userId: USER,
      documentId: "doc-c",
      documentTitle: "Sales Deck.pptx",
      documentType: null,
      source: null,
      status: "UPLOADED",
      chunkIndex: 0,
      content: "No refunds are ever issued under any circumstances.",
      embedding: ANTI_REFUNDS,
      metadata: null,
    },
    // Ties with row-a0 exactly: identical text embeds to an identical vector,
    // which is what the ordering tiebreak exists for.
    {
      id: "row-d2",
      userId: USER,
      documentId: "doc-d",
      documentTitle: "Refund Policy (copy).pdf",
      documentType: "POLICY",
      source: "upload",
      status: "PROCESSED",
      chunkIndex: 2,
      content: "Refunds are issued within 14 days.",
      embedding: REFUNDS,
      metadata: null,
    },
  ];
}

function makeService(
  rows: CorpusRow[] = corpus(),
  providerOptions: FakeProviderOptions = {},
  repoOptions: FakeRepoOptions = {},
  config: Record<string, unknown> = {}
) {
  const provider = new FakeEmbeddingProvider(providerOptions);
  const { repo, searchCalls } = makeCorpusRepository(rows, repoOptions);
  const service = new KnowledgeRetrievalService({ provider, repository: repo, ...config });
  return { service, provider, repo, searchCalls };
}

// ---------------------------------------------------------------------------
// Option resolution
// ---------------------------------------------------------------------------

describe("resolveRetrievalOptions", () => {
  it("1. applies the documented defaults", () => {
    const resolved = resolveRetrievalOptions();
    expect(resolved.topK).toBe(DEFAULT_RETRIEVAL_TOP_K);
    expect(resolved.similarityThreshold).toBe(DEFAULT_SIMILARITY_THRESHOLD);
    expect(resolved.filters).toEqual({});
    expect(resolved.model).toBeUndefined();
  });

  it("2. keeps caller-supplied values", () => {
    const resolved = resolveRetrievalOptions({
      topK: 12,
      similarityThreshold: 0.75,
      model: "text-embedding-3-large",
    });
    expect(resolved.topK).toBe(12);
    expect(resolved.similarityThreshold).toBe(0.75);
    expect(resolved.model).toBe("text-embedding-3-large");
  });

  it("3. rejects a topK that is not a positive integer", () => {
    for (const topK of [0, -1, 1.5, Number.NaN]) {
      expect(() => resolveRetrievalOptions({ topK })).toThrow(JarvisError);
      expect(() => resolveRetrievalOptions({ topK })).toThrow(/positive integer/);
    }
  });

  it("4. rejects a topK above the maximum", () => {
    expect(() => resolveRetrievalOptions({ topK: MAX_RETRIEVAL_TOP_K + 1 })).toThrow(
      /must not exceed/
    );
    expect(() =>
      resolveRetrievalOptions({ topK: MAX_RETRIEVAL_TOP_K })
    ).not.toThrow();
  });

  it("5. rejects a non-finite threshold", () => {
    expect(() =>
      resolveRetrievalOptions({ similarityThreshold: Number.NaN })
    ).toThrow(/finite number/);
    expect(() =>
      resolveRetrievalOptions({ similarityThreshold: Number.POSITIVE_INFINITY })
    ).toThrow(/finite number/);
  });

  it("6. rejects a threshold outside the cosine range", () => {
    expect(() => resolveRetrievalOptions({ similarityThreshold: 1.5 })).toThrow(
      /between -1 and 1/
    );
    expect(() => resolveRetrievalOptions({ similarityThreshold: -2 })).toThrow(
      /between -1 and 1/
    );
    expect(() => resolveRetrievalOptions({ similarityThreshold: -1 })).not.toThrow();
    expect(() => resolveRetrievalOptions({ similarityThreshold: 1 })).not.toThrow();
  });

  it("7. copies filter arrays so later mutation cannot reach the service", () => {
    const documentIds = ["doc-a"];
    const resolved = resolveRetrievalOptions({ documentIds });
    documentIds.push("doc-b");
    expect(resolved.filters.documentIds).toEqual(["doc-a"]);
  });

  it("8. carries an INVALID_REQUEST code on option errors", () => {
    try {
      resolveRetrievalOptions({ topK: 0 });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(JarvisError);
      expect((error as JarvisError).code).toBe("INVALID_REQUEST");
    }
  });
});

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe("KnowledgeRetrievalService construction", () => {
  it("9. requires an embedding provider", () => {
    const { repo } = makeCorpusRepository([]);
    expect(
      () => new KnowledgeRetrievalService({ repository: repo } as never)
    ).toThrow(/embedding provider is required/);
  });

  it("10. requires a knowledge repository", () => {
    const provider = new FakeEmbeddingProvider();
    expect(
      () => new KnowledgeRetrievalService({ provider } as never)
    ).toThrow(/repository is required/);
  });

  it("11. validates default options at construction, not on first query", () => {
    const provider = new FakeEmbeddingProvider();
    const { repo } = makeCorpusRepository([]);
    expect(
      () => new KnowledgeRetrievalService({ provider, repository: repo, topK: -3 })
    ).toThrow(/positive integer/);
  });
});

// ---------------------------------------------------------------------------
// Successful retrieval
// ---------------------------------------------------------------------------

describe("successful retrieval", () => {
  it("12. returns the chunks closest to the query", async () => {
    const { service } = makeService();
    const result = await service.retrieve(USER, "refund policy");

    expect(result.resultCount).toBeGreaterThan(0);
    expect(result.results[0]!.content).toBe("Refunds are issued within 14 days.");
    expect(result.results[0]!.score).toBeCloseTo(1, 10);
  });

  it("13. scores every result as cosine similarity within range", async () => {
    const { service } = makeService();
    const result = await service.retrieve(USER, "refund policy");

    for (const chunk of result.results) {
      expect(chunk.score).toBeGreaterThanOrEqual(-1);
      expect(chunk.score).toBeLessThanOrEqual(1);
      expect(chunk.score).toBeCloseTo(1 - chunk.distance, 10);
    }
  });

  it("14. reports the query, provider model, dimensions and version", async () => {
    const { service } = makeService([], { model: "fake-embed-v9" });
    const result = await service.retrieve(USER, "  refund policy  ");

    expect(result.query).toBe("  refund policy  ");
    expect(result.model).toBe("fake-embed-v9");
    expect(result.dimensions).toBe(DIMS);
    expect(result.retrievalVersion).toBe(KNOWLEDGE_RETRIEVAL_VERSION);
    expect(result.emptyQuery).toBe(false);
  });

  it("15. embeds the trimmed query exactly once", async () => {
    const { service, provider } = makeService();
    await service.retrieve(USER, "  refund policy \n");

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toEqual(["refund policy"]);
  });

  it("16. forwards an explicit model to the provider", async () => {
    const { service, provider } = makeService();
    await service.retrieve(USER, "refund policy", { model: "text-embedding-3-large" });

    expect(provider.models[0]).toBe("text-embedding-3-large");
  });

  it("17. scopes the search to the requesting user", async () => {
    const { service, searchCalls } = makeService();
    await service.retrieve("user-42", "refund policy");

    expect(searchCalls[0]!.userId).toBe("user-42");
  });

  it("18. returns nothing for a user with no documents", async () => {
    const { service } = makeService();
    const result = await service.retrieve("user-with-nothing", "refund policy");

    expect(result.results).toEqual([]);
    expect(result.resultCount).toBe(0);
    expect(result.emptyQuery).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// top-K
// ---------------------------------------------------------------------------

describe("top-K", () => {
  it("19. defaults to the documented top-K", async () => {
    const { service, searchCalls } = makeService();
    const result = await service.retrieve(USER, "refund policy");

    expect(result.topK).toBe(DEFAULT_RETRIEVAL_TOP_K);
    expect(searchCalls[0]!.options.limit).toBe(DEFAULT_RETRIEVAL_TOP_K);
  });

  it("20. limits the results to a custom top-K", async () => {
    const { service } = makeService();
    const result = await service.retrieve(USER, "refund policy", { topK: 2 });

    expect(result.results).toHaveLength(2);
    expect(result.resultCount).toBe(2);
    expect(result.topK).toBe(2);
  });

  it("21. keeps the highest scoring chunks when truncating", async () => {
    const { service } = makeService();
    const top1 = await service.retrieve(USER, "refund policy", { topK: 1 });
    const top3 = await service.retrieve(USER, "refund policy", { topK: 3 });

    expect(top1.results[0]!.chunkId).toBe(top3.results[0]!.chunkId);
    expect(top1.results[0]!.score).toBeCloseTo(1, 10);
  });

  it("22. returns everything available when top-K exceeds the corpus", async () => {
    const { service } = makeService();
    const result = await service.retrieve(USER, "refund policy", {
      topK: 50,
      similarityThreshold: -1,
    });

    expect(result.results).toHaveLength(corpus().length);
  });

  it("23. passes top-K to the store as the row limit", async () => {
    const { service, searchCalls } = makeService();
    await service.retrieve(USER, "refund policy", { topK: 7 });

    expect(searchCalls[0]!.options.limit).toBe(7);
  });

  it("24. rejects an invalid per-call top-K", async () => {
    const { service } = makeService();
    await expect(service.retrieve(USER, "refund policy", { topK: 0 })).rejects.toThrow(
      /positive integer/
    );
  });

  it("25. inherits a constructor top-K when the call does not name one", async () => {
    const { service } = makeService(corpus(), {}, {}, { topK: 2 });
    const result = await service.retrieve(USER, "refund policy");

    expect(result.results).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Similarity threshold
// ---------------------------------------------------------------------------

describe("similarity threshold", () => {
  it("26. drops chunks pointing away from the query by default", async () => {
    const { service } = makeService();
    const result = await service.retrieve(USER, "refund policy", { topK: 50 });

    const ids = result.results.map((chunk) => chunk.chunkId);
    expect(ids).not.toContain("row-c0");
    expect(result.similarityThreshold).toBe(DEFAULT_SIMILARITY_THRESHOLD);
  });

  it("27. filters everything below an explicit floor", async () => {
    const { service } = makeService();
    const result = await service.retrieve(USER, "refund policy", {
      topK: 50,
      similarityThreshold: 0.5,
    });

    expect(result.results.map((chunk) => chunk.chunkId).sort()).toEqual([
      "row-a0",
      "row-a1",
      "row-d2",
    ]);
    for (const chunk of result.results) {
      expect(chunk.score).toBeGreaterThanOrEqual(0.5);
    }
  });

  it("28. at a floor of 1 keeps only exact matches", async () => {
    const { service } = makeService();
    const result = await service.retrieve(USER, "refund policy", {
      topK: 50,
      similarityThreshold: 1,
    });

    expect(result.results.map((chunk) => chunk.chunkId)).toEqual(["row-a0", "row-d2"]);
  });

  it("29. at a floor of -1 keeps opposing chunks too", async () => {
    const { service } = makeService();
    const result = await service.retrieve(USER, "refund policy", {
      topK: 50,
      similarityThreshold: -1,
    });

    expect(result.results.map((chunk) => chunk.chunkId)).toContain("row-c0");
    expect(result.results.at(-1)!.chunkId).toBe("row-c0");
  });

  it("30. passes the threshold to the store", async () => {
    const { service, searchCalls } = makeService();
    await service.retrieve(USER, "refund policy", { similarityThreshold: 0.42 });

    expect(searchCalls[0]!.options.similarityThreshold).toBe(0.42);
  });

  it("31. enforces the floor even when the store ignores it", async () => {
    // A store that returns everything regardless of the threshold it was given.
    const rows = corpus();
    const provider = new FakeEmbeddingProvider();
    const lenient = {
      searchChunksByEmbedding: async (): Promise<KnowledgeChunkMatch[]> =>
        rows.map((row) => {
          const score = cosine(REFUNDS, row.embedding);
          return {
            id: row.id,
            documentId: row.documentId,
            content: row.content,
            chunkIndex: row.chunkIndex,
            metadata: row.metadata ?? null,
            documentTitle: row.documentTitle,
            documentType: row.documentType,
            source: row.source,
            status: row.status,
            score,
            distance: 1 - score,
          } satisfies KnowledgeChunkMatch;
        }),
    } as unknown as IKnowledgeRepository;

    const service = new KnowledgeRetrievalService({ provider, repository: lenient });
    const result = await service.retrieve(USER, "refund policy", {
      topK: 50,
      similarityThreshold: 0.9,
    });

    expect(result.results.map((chunk) => chunk.chunkId).sort()).toEqual([
      "row-a0",
      "row-a1",
      "row-d2",
    ]);
  });

  it("32. rejects an invalid per-call threshold", async () => {
    const { service } = makeService();
    await expect(
      service.retrieve(USER, "refund policy", { similarityThreshold: 4 })
    ).rejects.toThrow(/between -1 and 1/);
  });
});

// ---------------------------------------------------------------------------
// Ranking and ordering
// ---------------------------------------------------------------------------

describe("ranking and deterministic order", () => {
  it("33. orders results by descending similarity", async () => {
    const { service } = makeService();
    const result = await service.retrieve(USER, "refund policy", {
      topK: 50,
      similarityThreshold: -1,
    });

    const scores = result.results.map((chunk) => chunk.score);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1]!).toBeGreaterThanOrEqual(scores[i]!);
    }
  });

  it("34. breaks ties on documentId then chunkIndex", async () => {
    const { service } = makeService();
    const result = await service.retrieve(USER, "refund policy", {
      topK: 50,
      similarityThreshold: 1,
    });

    // row-a0 and row-d2 both score exactly 1.
    expect(result.results.map((chunk) => chunk.documentId)).toEqual(["doc-a", "doc-d"]);
  });

  it("35. returns an identical order for repeated identical queries", async () => {
    const { service } = makeService();
    const first = await service.retrieve(USER, "refund policy", {
      topK: 50,
      similarityThreshold: -1,
    });
    const second = await service.retrieve(USER, "refund policy", {
      topK: 50,
      similarityThreshold: -1,
    });

    expect(second.results.map((chunk) => chunk.chunkId)).toEqual(
      first.results.map((chunk) => chunk.chunkId)
    );
  });

  it("36. re-sorts a store that returns rows out of order", async () => {
    const ordered = makeService();
    const reversed = makeService(corpus(), {}, { reverse: true });

    const expected = await ordered.service.retrieve(USER, "refund policy", {
      topK: 50,
      similarityThreshold: -1,
    });
    const actual = await reversed.service.retrieve(USER, "refund policy", {
      topK: 50,
      similarityThreshold: -1,
    });

    expect(actual.results.map((chunk) => chunk.chunkId)).toEqual(
      expected.results.map((chunk) => chunk.chunkId)
    );
  });

  it("37. compareRetrievedChunks is a total order over ties", () => {
    const base = {
      documentTitle: "t",
      documentType: null,
      source: null,
      content: "c",
      distance: 0,
      pageNumbers: [],
      sections: [],
      metadata: null,
    };
    const a = { ...base, chunkId: "x", documentId: "doc-a", chunkIndex: 1, score: 0.5 };
    const b = { ...base, chunkId: "y", documentId: "doc-a", chunkIndex: 0, score: 0.5 };
    const c = { ...base, chunkId: "z", documentId: "doc-b", chunkIndex: 0, score: 0.9 };

    expect([a, b, c].sort(compareRetrievedChunks).map((r) => r.chunkId)).toEqual([
      "z",
      "y",
      "x",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Metadata preservation
// ---------------------------------------------------------------------------

describe("metadata preservation", () => {
  it("38. carries the document identity onto every result", async () => {
    const { service } = makeService();
    const result = await service.retrieve(USER, "refund policy", { topK: 1 });
    const top = result.results[0]!;

    expect(top.documentId).toBe("doc-a");
    expect(top.documentTitle).toBe("Refund Policy.pdf");
    expect(top.documentType).toBe("POLICY");
    expect(top.source).toBe("upload");
    expect(top.chunkId).toBe("row-a0");
    expect(top.chunkIndex).toBe(0);
  });

  it("39. lifts page numbers and sections out of the chunk metadata", async () => {
    const { service } = makeService();
    const result = await service.retrieve(USER, "refund policy", { topK: 1 });
    const top = result.results[0]!;

    expect(top.pageNumbers).toEqual([1, 2]);
    expect(top.sections).toEqual([
      { title: "Refunds", level: 1, order: 0 },
      { title: "Eligibility", level: 2, order: 1 },
    ]);
    expect(top.primarySection).toEqual({ title: "Refunds", level: 1, order: 0 });
  });

  it("40. lifts the deterministic chunk id and source offsets", async () => {
    const { service } = makeService();
    const result = await service.retrieve(USER, "refund policy", { topK: 1 });
    const top = result.results[0]!;

    expect(top.deterministicChunkId).toBe(SPRINT_33_METADATA.chunkId);
    expect(top.startOffset).toBe(0);
    expect(top.endOffset).toBe(34);
  });

  it("41. keeps the raw metadata blob untouched", async () => {
    const { service } = makeService();
    const result = await service.retrieve(USER, "refund policy", { topK: 1 });

    expect(result.results[0]!.metadata).toEqual(SPRINT_33_METADATA);
  });

  it("42. degrades safely when a chunk has no metadata", async () => {
    const { service } = makeService();
    const result = await service.retrieve(USER, "refund policy", {
      topK: 50,
      similarityThreshold: -1,
    });
    const bare = result.results.find((chunk) => chunk.chunkId === "row-b0")!;

    expect(bare.metadata).toBeNull();
    expect(bare.pageNumbers).toEqual([]);
    expect(bare.sections).toEqual([]);
    expect(bare.primarySection).toBeUndefined();
    expect(bare.startOffset).toBeUndefined();
  });

  it("43. ignores malformed metadata rather than failing the search", () => {
    const match: KnowledgeChunkMatch = {
      id: "row-x",
      documentId: "doc-x",
      content: "text",
      chunkIndex: 0,
      metadata: {
        pageNumbers: "page four",
        sections: [{ title: "ok", level: 1, order: 0 }, { title: 42 }, null],
        primarySection: "Refunds",
        chunkId: 99,
        startOffset: -5,
        endOffset: 3.7,
      },
      documentTitle: "Broken.pdf",
      documentType: null,
      source: null,
      status: "PROCESSED",
      score: 0.5,
      distance: 0.5,
    };

    const mapped = toRetrievedChunk(match);
    expect(mapped.pageNumbers).toEqual([]);
    expect(mapped.sections).toEqual([{ title: "ok", level: 1, order: 0 }]);
    expect(mapped.primarySection).toBeUndefined();
    expect(mapped.deterministicChunkId).toBeUndefined();
    expect(mapped.startOffset).toBeUndefined();
    expect(mapped.endOffset).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

describe("metadata filters", () => {
  it("44. restricts the search to named documents", async () => {
    const { service } = makeService();
    const result = await service.retrieve(USER, "refund policy", {
      topK: 50,
      similarityThreshold: -1,
      documentIds: ["doc-b"],
    });

    expect(result.results.every((chunk) => chunk.documentId === "doc-b")).toBe(true);
    expect(result.resultCount).toBe(2);
  });

  it("45. restricts the search by document type", async () => {
    const { service } = makeService();
    const result = await service.retrieve(USER, "refund policy", {
      topK: 50,
      similarityThreshold: -1,
      documentTypes: ["FAQ"],
    });

    expect(result.results.every((chunk) => chunk.documentType === "FAQ")).toBe(true);
    expect(result.resultCount).toBe(2);
  });

  it("46. restricts the search by source", async () => {
    const { service } = makeService();
    const result = await service.retrieve(USER, "refund policy", {
      topK: 50,
      similarityThreshold: -1,
      sources: ["import"],
    });

    expect(result.results.every((chunk) => chunk.source === "import")).toBe(true);
  });

  it("47. restricts the search by document status", async () => {
    const { service } = makeService();
    const result = await service.retrieve(USER, "refund policy", {
      topK: 50,
      similarityThreshold: -1,
      statuses: ["UPLOADED"],
    });

    expect(result.results.map((chunk) => chunk.chunkId)).toEqual(["row-c0"]);
  });

  it("48. combines filters", async () => {
    const { service } = makeService();
    const result = await service.retrieve(USER, "refund policy", {
      topK: 50,
      similarityThreshold: -1,
      documentTypes: ["POLICY"],
      documentIds: ["doc-a"],
    });

    expect(result.results.map((chunk) => chunk.chunkId)).toEqual(["row-a0", "row-a1"]);
  });

  it("49. treats an empty allow-list as matching nothing", async () => {
    const { service } = makeService();
    const result = await service.retrieve(USER, "refund policy", {
      documentIds: [],
    });

    expect(result.results).toEqual([]);
    expect(result.resultCount).toBe(0);
  });

  it("50. forwards filters to the store rather than filtering after the fact", async () => {
    const { service, searchCalls } = makeService();
    await service.retrieve(USER, "refund policy", {
      documentIds: ["doc-a"],
      documentTypes: ["POLICY"],
      sources: ["upload"],
      statuses: ["PROCESSED"],
    });

    expect(searchCalls[0]!.options).toMatchObject({
      documentIds: ["doc-a"],
      documentTypes: ["POLICY"],
      sources: ["upload"],
      statuses: ["PROCESSED"],
    });
  });

  it("51. inherits constructor filters when a call names none", async () => {
    const { service } = makeService(corpus(), {}, {}, { documentIds: ["doc-b"] });
    const result = await service.retrieve(USER, "refund policy", {
      topK: 50,
      similarityThreshold: -1,
    });

    expect(result.results.every((chunk) => chunk.documentId === "doc-b")).toBe(true);
  });

  it("52. lets a per-call filter replace the constructor default", async () => {
    const { service } = makeService(corpus(), {}, {}, { documentIds: ["doc-b"] });
    const result = await service.retrieve(USER, "refund policy", {
      topK: 50,
      similarityThreshold: -1,
      documentIds: ["doc-a"],
    });

    expect(result.results.every((chunk) => chunk.documentId === "doc-a")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Empty query and no matches
// ---------------------------------------------------------------------------

describe("empty queries", () => {
  it("53. returns an empty result for an empty string", async () => {
    const { service } = makeService();
    const result = await service.retrieve(USER, "");

    expect(result.results).toEqual([]);
    expect(result.resultCount).toBe(0);
    expect(result.emptyQuery).toBe(true);
  });

  it("54. returns an empty result for whitespace only", async () => {
    const { service } = makeService();
    const result = await service.retrieve(USER, "   \n\t  ");

    expect(result.emptyQuery).toBe(true);
    expect(result.results).toEqual([]);
  });

  it("55. calls neither the provider nor the store", async () => {
    const { service, provider, searchCalls } = makeService();
    await service.retrieve(USER, "  ");

    expect(provider.calls).toHaveLength(0);
    expect(searchCalls).toHaveLength(0);
  });

  it("56. still reports the resolved options and version", async () => {
    const { service } = makeService();
    const result = await service.retrieve(USER, "", { topK: 3, similarityThreshold: 0.4 });

    expect(result.topK).toBe(3);
    expect(result.similarityThreshold).toBe(0.4);
    expect(result.dimensions).toBe(DIMS);
    expect(result.retrievalVersion).toBe(KNOWLEDGE_RETRIEVAL_VERSION);
  });

  it("57. tolerates a null query without throwing", async () => {
    const { service } = makeService();
    const result = await service.retrieve(USER, null as unknown as string);

    expect(result.emptyQuery).toBe(true);
    expect(result.query).toBe("");
  });

  it("58. rejects a missing userId", async () => {
    const { service } = makeService();
    await expect(service.retrieve("", "refund policy")).rejects.toThrow(
      /userId is required/
    );
    await expect(service.retrieve("   ", "refund policy")).rejects.toThrow(
      /userId is required/
    );
  });
});

describe("no matches", () => {
  it("59. returns an empty result for an empty corpus", async () => {
    const { service } = makeService([]);
    const result = await service.retrieve(USER, "refund policy");

    expect(result.results).toEqual([]);
    expect(result.resultCount).toBe(0);
    expect(result.emptyQuery).toBe(false);
  });

  it("60. returns an empty result when the threshold excludes everything", async () => {
    // A query vector equidistant from all three axes: its best similarity in
    // this corpus is 0.73, so a floor of 0.9 leaves nothing.
    const { service } = makeService(corpus(), {
      vectors: { "unrelated question": [1, 1, 1] },
    });
    const result = await service.retrieve(USER, "unrelated question", {
      topK: 50,
      similarityThreshold: 0.9,
    });

    expect(result.results).toEqual([]);
    expect(result.resultCount).toBe(0);
    expect(result.emptyQuery).toBe(false);
  });

  it("61. distinguishes no matches from an empty query", async () => {
    const { service } = makeService([]);
    const noMatches = await service.retrieve(USER, "refund policy");
    const empty = await service.retrieve(USER, "");

    expect(noMatches.emptyQuery).toBe(false);
    expect(empty.emptyQuery).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Provider and database failures
// ---------------------------------------------------------------------------

describe("provider failures", () => {
  it("62. wraps a plain provider error as DOCUMENT_EMBEDDING_FAILED", async () => {
    const { service } = makeService(corpus(), {
      failWith: new Error("connection reset"),
    });

    try {
      await service.retrieve(USER, "refund policy");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(JarvisError);
      expect((error as JarvisError).code).toBe("DOCUMENT_EMBEDDING_FAILED");
      expect((error as JarvisError).details?.cause).toBe("connection reset");
      expect((error as JarvisError).details?.stage).toBe("query-embedding");
    }
  });

  it("63. passes a provider JarvisError through untouched", async () => {
    const rateLimited = new JarvisError("RATE_LIMITED", "Too many requests");
    const { service } = makeService(corpus(), { failWith: rateLimited });

    try {
      await service.retrieve(USER, "refund policy");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBe(rateLimited);
      expect((error as JarvisError).code).toBe("RATE_LIMITED");
    }
  });

  it("64. rejects a response with the wrong number of vectors", async () => {
    const { service } = makeService(corpus(), {
      respond: () => ({ embeddings: [], model: "fake-embed-v1" }),
    });

    await expect(service.retrieve(USER, "refund policy")).rejects.toThrow(
      /does not match the number of inputs/
    );
  });

  it("65. rejects a query vector with the wrong dimensions", async () => {
    const { service } = makeService(corpus(), {
      respond: () => ({ embeddings: [[1, 0]], model: "fake-embed-v1" }),
    });

    try {
      await service.retrieve(USER, "refund policy");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as JarvisError).code).toBe("DOCUMENT_EMBEDDING_FAILED");
      expect((error as Error).message).toMatch(/2 dimensions, expected 3/);
    }
  });

  it("66. rejects a query vector containing a non-finite value", async () => {
    const { service } = makeService(corpus(), {
      respond: () => ({ embeddings: [[1, Number.NaN, 0]], model: "fake-embed-v1" }),
    });

    await expect(service.retrieve(USER, "refund policy")).rejects.toThrow(
      /non-finite value/
    );
  });

  it("67. rejects an empty query vector", async () => {
    const { service } = makeService(corpus(), {
      respond: () => ({ embeddings: [[]], model: "fake-embed-v1" }),
    });

    await expect(service.retrieve(USER, "refund policy")).rejects.toThrow(
      /empty or malformed vector/
    );
  });

  it("68. never reaches the store when embedding fails", async () => {
    const { service, searchCalls } = makeService(corpus(), {
      failWith: new Error("provider down"),
    });

    await expect(service.retrieve(USER, "refund policy")).rejects.toThrow();
    expect(searchCalls).toHaveLength(0);
  });
});

describe("database failures", () => {
  it("69. wraps a store error as KNOWLEDGE_RETRIEVAL_FAILED", async () => {
    const { service } = makeService(corpus(), {}, {
      failWith: new Error("vector extension unavailable"),
    });

    try {
      await service.retrieve(USER, "refund policy");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(JarvisError);
      expect((error as JarvisError).code).toBe("KNOWLEDGE_RETRIEVAL_FAILED");
      expect((error as JarvisError).details?.cause).toBe("vector extension unavailable");
    }
  });

  it("70. passes a store JarvisError through untouched", async () => {
    const denied = new JarvisError("AUTHORIZATION_FAILED", "Access denied");
    const { service } = makeService(corpus(), {}, { failWith: denied });

    await expect(service.retrieve(USER, "refund policy")).rejects.toBe(denied);
  });

  it("71. rejects a store that returns a non-array", async () => {
    const { service } = makeService(corpus(), {}, { returnJunk: true });

    try {
      await service.retrieve(USER, "refund policy");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as JarvisError).code).toBe("KNOWLEDGE_RETRIEVAL_FAILED");
      expect((error as Error).message).toMatch(/non-array/);
    }
  });

  it("72. reports a 500 status for a retrieval failure", async () => {
    const { service } = makeService(corpus(), {}, { failWith: new Error("boom") });

    try {
      await service.retrieve(USER, "refund policy");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as JarvisError).statusCode).toBe(500);
    }
  });
});
