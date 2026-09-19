// Sprint 3.6 — Knowledge Base API.
//
// The router is exercised against the REAL extraction, chunking, embedding and
// retrieval services from Sprints 3.2 to 3.5. Only two things are faked: the
// knowledge repository (an in-memory store implementing the same contract,
// including cosine search) and the embedding provider (deterministic vectors,
// so no OpenAI key or network is involved). That keeps the tests about the API
// layer while still proving the pipeline it drives actually runs.

import { describe, it, expect, beforeEach } from "vitest";
import type { Router } from "express";
import { createKnowledgeRouter, MAX_UPLOAD_BYTES } from "../src/routes/knowledge.js";
import { KNOWLEDGE_DOCUMENT_STATUS } from "../src/services/knowledge-ingestion.js";
import { JarvisError } from "@jarvis/core";
import type {
  EmbeddingRequest,
  EmbeddingResponse,
  IEmbeddingProvider,
  IKnowledgeRepository,
  KnowledgeChunkData,
  KnowledgeChunkMatch,
  KnowledgeChunkSearchOptions,
  KnowledgeDocumentData,
} from "@jarvis/core";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const USER_A = "user-alpha";
const USER_B = "user-beta";
const TOKEN_A = "token-alpha";
const TOKEN_B = "token-beta";

const DIMS = 3;

/** Keyword-driven vectors, so a query and a matching chunk land on one axis. */
function vectorFor(text: string): number[] {
  const lowered = text.toLowerCase();
  if (lowered.includes("refund")) return [1, 0, 0];
  if (lowered.includes("shipping")) return [0, 1, 0];
  return [0, 0, 1];
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

interface FakeProviderOptions {
  failWith?: unknown;
  dimensions?: number;
}

class FakeEmbeddingProvider implements IEmbeddingProvider {
  readonly id = "fake-embedding";
  readonly name = "Fake Embedding Provider";
  readonly dimensions: number;
  calls: string[][] = [];

  constructor(private options: FakeProviderOptions = {}) {
    this.dimensions = options.dimensions ?? DIMS;
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    this.calls.push(inputs);
    if (this.options.failWith) throw this.options.failWith;
    return {
      embeddings: inputs.map((text) => vectorFor(text)),
      model: "fake-embed-v1",
    };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

interface StoredChunk extends KnowledgeChunkData {
  embedding: number[] | null;
}

/** In-memory knowledge store honouring the Sprint 3.1/3.5 repository contract. */
class FakeKnowledgeRepository implements IKnowledgeRepository {
  documents: KnowledgeDocumentData[] = [];
  chunks: StoredChunk[] = [];
  private seq = 0;

  /** Set to make the next call of the named method throw. */
  failures: Partial<Record<keyof IKnowledgeRepository, unknown>> = {};

  private maybeFail(method: keyof IKnowledgeRepository): void {
    const failure = this.failures[method];
    if (failure) throw failure;
  }

  async createDocument(
    userId: string,
    data: {
      title: string;
      content: string;
      documentType?: string;
      mimeType?: string;
      source?: string;
      metadata?: any;
    }
  ): Promise<KnowledgeDocumentData> {
    this.maybeFail("createDocument");
    const doc: KnowledgeDocumentData = {
      id: `doc${String(++this.seq).padStart(8, "0")}xyz`,
      userId,
      title: data.title,
      documentType: data.documentType ?? null,
      mimeType: data.mimeType ?? null,
      content: data.content,
      source: data.source ?? null,
      status: "UPLOADED",
      metadata: data.metadata ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.documents.push(doc);
    return doc;
  }

  async getDocumentById(id: string, userId: string): Promise<KnowledgeDocumentData | null> {
    this.maybeFail("getDocumentById");
    return this.documents.find((d) => d.id === id && d.userId === userId) ?? null;
  }

  async listDocuments(userId: string): Promise<KnowledgeDocumentData[]> {
    this.maybeFail("listDocuments");
    return this.documents.filter((d) => d.userId === userId);
  }

  async updateDocumentStatus(
    id: string,
    userId: string,
    status: string
  ): Promise<KnowledgeDocumentData> {
    this.maybeFail("updateDocumentStatus");
    const doc = this.documents.find((d) => d.id === id);
    if (!doc) throw new Error("Document not found");
    if (doc.userId !== userId) throw new Error("Access denied");
    doc.status = status;
    doc.updatedAt = new Date();
    return doc;
  }

  async deleteDocument(id: string, userId: string): Promise<void> {
    this.maybeFail("deleteDocument");
    const index = this.documents.findIndex((d) => d.id === id && d.userId === userId);
    if (index === -1) throw new Error("Access denied or document not found");
    this.documents.splice(index, 1);
    this.chunks = this.chunks.filter((c) => c.documentId !== id);
  }

  async createChunks(
    documentId: string,
    chunks: Array<{ content: string; chunkIndex: number; metadata?: any }>
  ): Promise<KnowledgeChunkData[]> {
    this.maybeFail("createChunks");
    const created: StoredChunk[] = chunks.map((chunk) => ({
      id: `chk${String(++this.seq).padStart(8, "0")}xyz`,
      documentId,
      content: chunk.content,
      chunkIndex: chunk.chunkIndex,
      metadata: chunk.metadata ?? null,
      embedding: null,
    }));
    this.chunks.push(...created);
    return created;
  }

  async getChunksByDocument(
    documentId: string,
    userId: string
  ): Promise<KnowledgeChunkData[]> {
    this.maybeFail("getChunksByDocument");
    const doc = this.documents.find((d) => d.id === documentId && d.userId === userId);
    if (!doc) throw new Error("Access denied or document not found");
    return this.chunks
      .filter((c) => c.documentId === documentId)
      .sort((a, b) => a.chunkIndex - b.chunkIndex);
  }

  async deleteChunksByDocument(documentId: string, userId: string): Promise<void> {
    this.maybeFail("deleteChunksByDocument");
    const doc = this.documents.find((d) => d.id === documentId && d.userId === userId);
    if (!doc) throw new Error("Access denied or document not found");
    this.chunks = this.chunks.filter((c) => c.documentId !== documentId);
  }

  async updateChunkEmbeddings(
    documentId: string,
    embeddings: Array<{ chunkIndex: number; embedding: number[] }>
  ): Promise<number> {
    this.maybeFail("updateChunkEmbeddings");
    let updated = 0;
    for (const item of embeddings) {
      const chunk = this.chunks.find(
        (c) => c.documentId === documentId && c.chunkIndex === item.chunkIndex
      );
      if (chunk) {
        chunk.embedding = item.embedding;
        updated++;
      }
    }
    return updated;
  }

  async searchChunksByEmbedding(
    userId: string,
    embedding: number[],
    options: KnowledgeChunkSearchOptions
  ): Promise<KnowledgeChunkMatch[]> {
    this.maybeFail("searchChunksByEmbedding");

    const filters = [
      options.documentIds,
      options.documentTypes,
      options.sources,
      options.statuses,
    ];
    if (filters.some((values) => values !== undefined && values.length === 0)) return [];

    const owned = new Map(
      this.documents.filter((d) => d.userId === userId).map((d) => [d.id, d])
    );

    let scored = this.chunks
      .filter((chunk) => chunk.embedding !== null && owned.has(chunk.documentId))
      .map((chunk) => {
        const doc = owned.get(chunk.documentId)!;
        const score = cosine(embedding, chunk.embedding!);
        return {
          id: chunk.id,
          documentId: chunk.documentId,
          content: chunk.content,
          chunkIndex: chunk.chunkIndex,
          metadata: chunk.metadata,
          documentTitle: doc.title,
          documentType: doc.documentType,
          source: doc.source,
          status: doc.status,
          score,
          distance: 1 - score,
        } satisfies KnowledgeChunkMatch;
      });

    if (options.documentIds) {
      scored = scored.filter((row) => options.documentIds!.includes(row.documentId));
    }
    if (options.documentTypes) {
      scored = scored.filter(
        (row) => row.documentType !== null && options.documentTypes!.includes(row.documentType)
      );
    }
    if (options.sources) {
      scored = scored.filter(
        (row) => row.source !== null && options.sources!.includes(row.source)
      );
    }
    if (options.statuses) {
      scored = scored.filter((row) => options.statuses!.includes(row.status));
    }
    if (options.similarityThreshold !== undefined) {
      scored = scored.filter((row) => row.score >= options.similarityThreshold!);
    }

    scored.sort((a, b) => {
      if (a.distance !== b.distance) return a.distance - b.distance;
      if (a.documentId !== b.documentId) return a.documentId < b.documentId ? -1 : 1;
      return a.chunkIndex - b.chunkIndex;
    });

    return scored.slice(0, options.limit);
  }
}

interface AuditRecord {
  userId: string;
  action: string;
  result: string;
  metadata?: Record<string, unknown>;
}

function makeContainer(options: {
  repository: FakeKnowledgeRepository;
  provider: IEmbeddingProvider | null;
  audit: AuditRecord[];
}) {
  return {
    tokenService: {
      verifyAccessToken: (token: string) => {
        if (token === TOKEN_A) return { userId: USER_A, role: "member", email: "a@example.com" };
        if (token === TOKEN_B) return { userId: USER_B, role: "member", email: "b@example.com" };
        return null;
      },
    },
    auditLogger: {
      log: async (entry: AuditRecord) => {
        options.audit.push(entry);
      },
    },
    knowledgeRepo: options.repository,
    embeddingProvider: options.provider,
  } as unknown as Parameters<typeof createKnowledgeRouter>[0];
}

// ---------------------------------------------------------------------------
// Request harness: walks the router the way express does, with a JSON body.
// ---------------------------------------------------------------------------

interface TestResponse {
  status: number;
  body: any;
}

async function call(
  router: Router,
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {}
): Promise<TestResponse> {
  const parsed = new URL(path, "http://test");
  const pathname = parsed.pathname;

  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  const res = {
    _status: 200,
    _body: null as unknown,
    status(code: number) {
      this._status = code;
      return this;
    },
    json(body: unknown) {
      this._body = body;
      return this;
    },
  };

  const stack =
    ((router as unknown as {
      stack: Array<{
        route?: {
          path: string;
          methods: Record<string, boolean>;
          stack: Array<{ handle: (...args: any[]) => unknown }>;
        };
      }>;
    }).stack) ?? [];

  for (const layer of stack) {
    if (!layer.route) continue;
    if (!layer.route.methods[method.toLowerCase()]) continue;

    const regex = new RegExp("^" + layer.route.path.replace(/:[^/]+/g, "([^/]+)") + "$");
    const match = pathname.match(regex);
    if (!match) continue;

    const params: Record<string, string> = {};
    const names = [...layer.route.path.matchAll(/:([^/]+)/g)].map((m) => m[1]!);
    names.forEach((name, i) => {
      params[name] = decodeURIComponent(match[i + 1]!);
    });

    const req = {
      method,
      url: pathname + parsed.search,
      originalUrl: pathname + parsed.search,
      path: pathname,
      params,
      query: Object.fromEntries(parsed.searchParams),
      headers,
      body: options.body,
      get(header: string) {
        return headers[header];
      },
    };

    const chain = layer.route.stack;
    const responded = () => (res as unknown as { _body: unknown })._body !== null;
    const runAt = (i: number): unknown => {
      if (responded()) return undefined;
      const entry = chain[i];
      if (!entry) return undefined;
      if (entry.handle.length >= 3) {
        return new Promise<void>((resolveStep) => {
          entry.handle(req, res, () => resolveStep());
          if (responded()) resolveStep();
        }).then(() => runAt(i + 1));
      }
      return entry.handle(req, res);
    };

    await runAt(0);
    return {
      status: (res as unknown as { _status: number })._status,
      body: (res as unknown as { _body: unknown })._body,
    };
  }

  return { status: 404, body: { success: false, error: { code: "NO_ROUTE" } } };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REFUND_PARAGRAPH =
  "Refunds are issued within fourteen days of the original purchase date. " +
  "A refund request must include the order number and the reason for return. " +
  "Refund processing begins once the returned item has been inspected. ";

const SHIPPING_PARAGRAPH =
  "Shipping takes three to five business days for domestic destinations. " +
  "Shipping costs are calculated at checkout based on weight and destination. " +
  "Shipping delays are communicated by email as soon as they are known. ";

/** ~2.4k characters, so the real chunker produces several chunks. */
const MARKDOWN_DOC = [
  "# Refund Policy",
  "",
  REFUND_PARAGRAPH.repeat(6).trim(),
  "",
  "# Shipping Policy",
  "",
  SHIPPING_PARAGRAPH.repeat(6).trim(),
  "",
].join("\n");

const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

function seedDocument(
  repo: FakeKnowledgeRepository,
  userId: string,
  spec: {
    title: string;
    documentType?: string | null;
    source?: string | null;
    status?: string;
    chunks: Array<{ content: string; metadata?: unknown }>;
  }
): KnowledgeDocumentData {
  const doc: KnowledgeDocumentData = {
    id: `doc${String(repo.documents.length + 100)}seeded`,
    userId,
    title: spec.title,
    documentType: spec.documentType ?? "MD",
    mimeType: "text/markdown",
    content: spec.chunks.map((c) => c.content).join("\n"),
    source: spec.source ?? "upload",
    status: spec.status ?? KNOWLEDGE_DOCUMENT_STATUS.processed,
    metadata: { fileName: `${spec.title}.md`, charCount: 10, wordCount: 2, contentHash: "x".repeat(64) },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  repo.documents.push(doc);

  spec.chunks.forEach((chunk, index) => {
    repo.chunks.push({
      id: `chk${doc.id}-${index}`,
      documentId: doc.id,
      content: chunk.content,
      chunkIndex: index,
      metadata: chunk.metadata ?? null,
      embedding: vectorFor(chunk.content),
    });
  });

  return doc;
}

// ---------------------------------------------------------------------------

describe("Sprint 3.6 — Knowledge API", () => {
  let repo: FakeKnowledgeRepository;
  let provider: FakeEmbeddingProvider;
  let audit: AuditRecord[];
  let router: Router;

  function build(options: { provider?: IEmbeddingProvider | null } = {}): Router {
    const activeProvider =
      options.provider === undefined ? provider : options.provider;
    return createKnowledgeRouter(
      makeContainer({ repository: repo, provider: activeProvider, audit }),
      { repository: repo }
    );
  }

  beforeEach(() => {
    repo = new FakeKnowledgeRepository();
    provider = new FakeEmbeddingProvider();
    audit = [];
    router = build();
  });

  // -------------------------------------------------------------------------
  // Authentication and authorization
  // -------------------------------------------------------------------------

  describe("authentication", () => {
    it("1. rejects ingestion without a token", async () => {
      const res = await call(router, "post", "/documents", {
        body: { fileName: "a.md", content: base64("hello world") },
      });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("AUTHENTICATION_REQUIRED");
    });

    it("2. rejects listing without a token", async () => {
      const res = await call(router, "get", "/documents");
      expect(res.status).toBe(401);
    });

    it("3. rejects search without a token", async () => {
      const res = await call(router, "post", "/search", { body: { query: "refund" } });
      expect(res.status).toBe(401);
    });

    it("4. rejects an unrecognised token", async () => {
      const res = await call(router, "get", "/documents", { token: "not-a-token" });
      expect(res.status).toBe(401);
      expect(res.body.error.message).toMatch(/Invalid or expired/);
    });

    it("5. rejects deletion without a token", async () => {
      const doc = seedDocument(repo, USER_A, { title: "Refunds", chunks: [{ content: "Refund text" }] });
      const res = await call(router, "delete", `/documents/${doc.id}`);
      expect(res.status).toBe(401);
      expect(repo.documents).toHaveLength(1);
    });
  });

  describe("user isolation", () => {
    it("6. does not list another user's documents", async () => {
      seedDocument(repo, USER_A, { title: "A doc", chunks: [{ content: "Refund text" }] });
      const res = await call(router, "get", "/documents", { token: TOKEN_B });

      expect(res.status).toBe(200);
      expect(res.body.data.documents).toEqual([]);
      expect(res.body.data.total).toBe(0);
    });

    it("7. returns 404 rather than 403 for another user's document", async () => {
      const doc = seedDocument(repo, USER_A, { title: "A doc", chunks: [{ content: "Refund text" }] });
      const res = await call(router, "get", `/documents/${doc.id}`, { token: TOKEN_B });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("DOCUMENT_NOT_FOUND");
    });

    it("8. will not read another user's chunks", async () => {
      const doc = seedDocument(repo, USER_A, { title: "A doc", chunks: [{ content: "Refund text" }] });
      const res = await call(router, "get", `/documents/${doc.id}/chunks`, { token: TOKEN_B });
      expect(res.status).toBe(404);
    });

    it("9. will not delete another user's document", async () => {
      const doc = seedDocument(repo, USER_A, { title: "A doc", chunks: [{ content: "Refund text" }] });
      const res = await call(router, "delete", `/documents/${doc.id}`, { token: TOKEN_B });

      expect(res.status).toBe(404);
      expect(repo.documents).toHaveLength(1);
    });

    it("10. never returns another user's chunks from search", async () => {
      seedDocument(repo, USER_A, { title: "A doc", chunks: [{ content: "Refund policy details" }] });
      const res = await call(router, "post", "/search", {
        token: TOKEN_B,
        body: { query: "refund" },
      });

      expect(res.status).toBe(200);
      expect(res.body.data.results).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Ingestion — success
  // -------------------------------------------------------------------------

  describe("ingestion", () => {
    it("11. ingests a markdown document through the real pipeline", async () => {
      const res = await call(router, "post", "/documents", {
        token: TOKEN_A,
        body: {
          fileName: "policies.md",
          content: base64(MARKDOWN_DOC),
          mimeType: "text/markdown",
          source: "upload-1",
        },
      });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.chunkCount).toBeGreaterThan(1);
      expect(res.body.data.embedded).toBe(true);
      expect(res.body.data.searchable).toBe(true);
      expect(res.body.data.document.status).toBe(KNOWLEDGE_DOCUMENT_STATUS.processed);
    });

    it("12. stores the extracted document with its derived fields", async () => {
      await call(router, "post", "/documents", {
        token: TOKEN_A,
        body: { fileName: "policies.md", content: base64(MARKDOWN_DOC) },
      });

      expect(repo.documents).toHaveLength(1);
      const stored = repo.documents[0]!;
      expect(stored.userId).toBe(USER_A);
      expect(stored.documentType).toBe("MD");
      expect(stored.mimeType).toBe("text/markdown");
      expect(stored.content).toContain("Refunds are issued");
    });

    it("13. persists every chunk and writes a vector for each", async () => {
      const res = await call(router, "post", "/documents", {
        token: TOKEN_A,
        body: { fileName: "policies.md", content: base64(MARKDOWN_DOC) },
      });

      const chunkCount = res.body.data.chunkCount;
      expect(repo.chunks).toHaveLength(chunkCount);
      expect(repo.chunks.every((c) => c.embedding !== null)).toBe(true);
      expect(res.body.data.embeddedCount).toBe(chunkCount);
    });

    it("14. honours an explicit title override", async () => {
      const res = await call(router, "post", "/documents", {
        token: TOKEN_A,
        body: {
          fileName: "policies.md",
          content: base64(MARKDOWN_DOC),
          title: "Customer Policies 2026",
        },
      });

      expect(res.body.data.document.title).toBe("Customer Policies 2026");
    });

    it("15. audits a successful ingestion without recording content", async () => {
      await call(router, "post", "/documents", {
        token: TOKEN_A,
        body: { fileName: "policies.md", content: base64(MARKDOWN_DOC) },
      });

      const entry = audit.find((a) => a.action === "knowledge.document.ingest");
      expect(entry).toBeDefined();
      expect(entry!.result).toBe("success");
      expect(entry!.userId).toBe(USER_A);
      expect(JSON.stringify(entry!.metadata)).not.toContain("Refunds are issued");
    });

    it("16. makes an ingested document immediately searchable", async () => {
      await call(router, "post", "/documents", {
        token: TOKEN_A,
        body: { fileName: "policies.md", content: base64(MARKDOWN_DOC) },
      });

      const res = await call(router, "post", "/search", {
        token: TOKEN_A,
        body: { query: "refund policy", topK: 3 },
      });

      expect(res.status).toBe(200);
      expect(res.body.data.resultCount).toBeGreaterThan(0);
      expect(res.body.data.results[0].content.toLowerCase()).toContain("refund");
    });

    it("17. accepts a plain text upload", async () => {
      const res = await call(router, "post", "/documents", {
        token: TOKEN_A,
        body: { fileName: "notes.txt", content: base64("Refund notes for the team.") },
      });

      expect(res.status).toBe(201);
      expect(res.body.data.document.documentType).toBe("TXT");
    });
  });

  // -------------------------------------------------------------------------
  // Ingestion — validation
  // -------------------------------------------------------------------------

  describe("ingestion validation", () => {
    it("18. rejects a missing fileName", async () => {
      const res = await call(router, "post", "/documents", {
        token: TOKEN_A,
        body: { content: base64("hello") },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/fileName is required/);
    });

    it("19. rejects a missing body", async () => {
      const res = await call(router, "post", "/documents", { token: TOKEN_A });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/JSON request body/);
    });

    it("20. rejects missing content", async () => {
      const res = await call(router, "post", "/documents", {
        token: TOKEN_A,
        body: { fileName: "a.md" },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/base64/);
    });

    it("21. rejects content that is not valid base64", async () => {
      const res = await call(router, "post", "/documents", {
        token: TOKEN_A,
        body: { fileName: "a.md", content: "not base64 !!!" },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/not valid base64/);
    });

    it("22. rejects an empty file", async () => {
      const res = await call(router, "post", "/documents", {
        token: TOKEN_A,
        body: { fileName: "a.md", content: "" },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_REQUEST");
    });

    it("23. rejects an upload above the size ceiling with 413", async () => {
      // Base64 length is a multiple of 4 and decodes past MAX_UPLOAD_BYTES.
      const oversized = "A".repeat(Math.ceil((MAX_UPLOAD_BYTES * 4) / 3 / 4) * 4 + 4);
      const res = await call(router, "post", "/documents", {
        token: TOKEN_A,
        body: { fileName: "big.md", content: oversized },
      });

      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe("DOCUMENT_TOO_LARGE");
      expect(repo.documents).toHaveLength(0);
    });

    it("24. rejects a non-string mimeType", async () => {
      const res = await call(router, "post", "/documents", {
        token: TOKEN_A,
        body: { fileName: "a.md", content: base64("hello"), mimeType: 42 },
      });
      expect(res.status).toBe(400);
    });

    it("25. rejects a blank title", async () => {
      const res = await call(router, "post", "/documents", {
        token: TOKEN_A,
        body: { fileName: "a.md", content: base64("hello"), title: "   " },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/title must not be blank/);
    });

    it("26. writes nothing when validation fails", async () => {
      await call(router, "post", "/documents", {
        token: TOKEN_A,
        body: { fileName: "a.md", content: "@@@@" },
      });
      expect(repo.documents).toHaveLength(0);
      expect(repo.chunks).toHaveLength(0);
    });
  });

  describe("unsupported files", () => {
    it("27. rejects an unsupported extension with 415", async () => {
      const res = await call(router, "post", "/documents", {
        token: TOKEN_A,
        body: { fileName: "payload.exe", content: base64("MZ binary") },
      });

      expect(res.status).toBe(415);
      expect(res.body.error.code).toBe("DOCUMENT_UNSUPPORTED_FORMAT");
      expect(res.body.error.message).toMatch(/\.pdf/);
    });

    it("28. rejects a file with no extension", async () => {
      const res = await call(router, "post", "/documents", {
        token: TOKEN_A,
        body: { fileName: "README", content: base64("text") },
      });
      expect(res.status).toBe(415);
    });

    it("29. rejects a mimeType that contradicts the extension", async () => {
      const res = await call(router, "post", "/documents", {
        token: TOKEN_A,
        body: {
          fileName: "notes.txt",
          content: base64("text"),
          mimeType: "application/pdf",
        },
      });
      expect(res.status).toBe(415);
    });

    it("30. rejects bytes that do not match the declared format", async () => {
      // A .pdf name with text bytes fails the magic-byte check in extraction.
      const res = await call(router, "post", "/documents", {
        token: TOKEN_A,
        body: { fileName: "fake.pdf", content: base64("this is not a pdf") },
      });

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(repo.documents).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Ingestion — failures
  // -------------------------------------------------------------------------

  describe("ingestion failures", () => {
    it("31. marks the document FAILED when embedding fails", async () => {
      const failing = new FakeEmbeddingProvider({
        failWith: new Error("provider exploded"),
      });
      const localRouter = build({ provider: failing });

      const res = await call(localRouter, "post", "/documents", {
        token: TOKEN_A,
        body: { fileName: "policies.md", content: base64(MARKDOWN_DOC) },
      });

      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe("DOCUMENT_EMBEDDING_FAILED");
      expect(repo.documents[0]!.status).toBe(KNOWLEDGE_DOCUMENT_STATUS.failed);
    });

    it("32. preserves a rate-limit status from the provider", async () => {
      const failing = new FakeEmbeddingProvider({
        failWith: new JarvisError("RATE_LIMITED", "Too many requests"),
      });
      const localRouter = build({ provider: failing });

      const res = await call(localRouter, "post", "/documents", {
        token: TOKEN_A,
        body: { fileName: "policies.md", content: base64(MARKDOWN_DOC) },
      });

      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe("RATE_LIMITED");
    });

    it("33. reports a database failure as a flat internal error", async () => {
      repo.failures.createDocument = new Error(
        'relation "KnowledgeDocument" does not exist'
      );

      const res = await call(router, "post", "/documents", {
        token: TOKEN_A,
        body: { fileName: "policies.md", content: base64(MARKDOWN_DOC) },
      });

      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe("INTERNAL_ERROR");
      expect(JSON.stringify(res.body)).not.toContain("KnowledgeDocument");
    });

    it("34. audits a failed ingestion", async () => {
      repo.failures.createDocument = new Error("db down");
      await call(router, "post", "/documents", {
        token: TOKEN_A,
        body: { fileName: "policies.md", content: base64(MARKDOWN_DOC) },
      });

      const entry = audit.find(
        (a) => a.action === "knowledge.document.ingest" && a.result === "failure"
      );
      expect(entry).toBeDefined();
      expect(JSON.stringify(entry!.metadata)).not.toContain("db down");
    });
  });

  // -------------------------------------------------------------------------
  // Degraded mode
  // -------------------------------------------------------------------------

  describe("no embedding provider configured", () => {
    it("35. still ingests, marking the document PENDING_EMBEDDING", async () => {
      const localRouter = build({ provider: null });
      const res = await call(localRouter, "post", "/documents", {
        token: TOKEN_A,
        body: { fileName: "policies.md", content: base64(MARKDOWN_DOC) },
      });

      expect(res.status).toBe(201);
      expect(res.body.data.embedded).toBe(false);
      expect(res.body.data.searchable).toBe(false);
      expect(res.body.data.document.status).toBe(
        KNOWLEDGE_DOCUMENT_STATUS.pendingEmbedding
      );
      expect(repo.chunks.length).toBeGreaterThan(0);
      expect(repo.chunks.every((c) => c.embedding === null)).toBe(true);
    });

    it("36. reports search as unavailable rather than failing obscurely", async () => {
      const localRouter = build({ provider: null });
      const res = await call(localRouter, "post", "/search", {
        token: TOKEN_A,
        body: { query: "refund" },
      });

      expect(res.status).toBe(503);
      expect(res.body.error.message).toMatch(/embedding provider/i);
    });
  });

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  describe("search", () => {
    beforeEach(() => {
      seedDocument(repo, USER_A, {
        title: "Refund Policy",
        documentType: "POLICY",
        source: "upload",
        chunks: [
          { content: "Refunds are issued within 14 days.", metadata: { pageNumbers: [1] } },
          { content: "Refund requests need an order number." },
        ],
      });
      seedDocument(repo, USER_A, {
        title: "Shipping FAQ",
        documentType: "FAQ",
        source: "import",
        chunks: [{ content: "Shipping takes three to five days." }],
      });
    });

    it("37. returns ranked matches for a query", async () => {
      const res = await call(router, "post", "/search", {
        token: TOKEN_A,
        body: { query: "refund policy" },
      });

      expect(res.status).toBe(200);
      expect(res.body.data.resultCount).toBeGreaterThan(0);
      expect(res.body.data.results[0].score).toBeCloseTo(1, 6);
      expect(res.body.data.emptyQuery).toBe(false);
    });

    it("38. respects topK", async () => {
      const res = await call(router, "post", "/search", {
        token: TOKEN_A,
        body: { query: "refund policy", topK: 1, similarityThreshold: -1 },
      });

      expect(res.body.data.results).toHaveLength(1);
      expect(res.body.data.topK).toBe(1);
    });

    it("39. respects the similarity threshold", async () => {
      const res = await call(router, "post", "/search", {
        token: TOKEN_A,
        body: { query: "refund policy", similarityThreshold: 0.99 },
      });

      expect(res.body.data.results.every((r: any) => r.score >= 0.99)).toBe(true);
      expect(res.body.data.similarityThreshold).toBe(0.99);
    });

    it("40. applies a documentType filter", async () => {
      const res = await call(router, "post", "/search", {
        token: TOKEN_A,
        body: { query: "refund policy", documentTypes: ["FAQ"], similarityThreshold: -1 },
      });

      expect(res.body.data.results.every((r: any) => r.documentType === "FAQ")).toBe(true);
      expect(res.body.data.resultCount).toBe(1);
    });

    it("41. applies a source filter", async () => {
      const res = await call(router, "post", "/search", {
        token: TOKEN_A,
        body: { query: "refund policy", sources: ["import"], similarityThreshold: -1 },
      });

      expect(res.body.data.results.every((r: any) => r.source === "import")).toBe(true);
    });

    it("42. treats an empty filter list as matching nothing", async () => {
      const res = await call(router, "post", "/search", {
        token: TOKEN_A,
        body: { query: "refund policy", documentIds: [] },
      });

      expect(res.status).toBe(200);
      expect(res.body.data.results).toEqual([]);
    });

    it("43. preserves citation metadata on results", async () => {
      const res = await call(router, "post", "/search", {
        token: TOKEN_A,
        body: { query: "refund policy", topK: 1 },
      });

      const hit = res.body.data.results[0];
      expect(hit.documentTitle).toBe("Refund Policy");
      expect(hit.documentType).toBe("POLICY");
      expect(hit.chunkIndex).toBe(0);
      expect(hit.pageNumbers).toEqual([1]);
    });

    it("44. returns an empty result for a blank query without calling the provider", async () => {
      const before = provider.calls.length;
      const res = await call(router, "post", "/search", {
        token: TOKEN_A,
        body: { query: "   " },
      });

      expect(res.status).toBe(200);
      expect(res.body.data.emptyQuery).toBe(true);
      expect(res.body.data.results).toEqual([]);
      expect(provider.calls.length).toBe(before);
    });

    it("45. returns no matches without erroring", async () => {
      const res = await call(router, "post", "/search", {
        token: TOKEN_A,
        body: { query: "refund policy", similarityThreshold: 1, documentTypes: ["FAQ"] },
      });

      expect(res.status).toBe(200);
      expect(res.body.data.resultCount).toBe(0);
      expect(res.body.data.emptyQuery).toBe(false);
    });

    it("46. rejects a missing query", async () => {
      const res = await call(router, "post", "/search", { token: TOKEN_A, body: {} });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/query is required/);
    });

    it("47. rejects an invalid topK", async () => {
      const res = await call(router, "post", "/search", {
        token: TOKEN_A,
        body: { query: "refund", topK: 0 },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_REQUEST");
    });

    it("48. rejects a threshold outside the cosine range", async () => {
      const res = await call(router, "post", "/search", {
        token: TOKEN_A,
        body: { query: "refund", similarityThreshold: 5 },
      });
      expect(res.status).toBe(400);
    });

    it("49. rejects a filter that is not an array of strings", async () => {
      const res = await call(router, "post", "/search", {
        token: TOKEN_A,
        body: { query: "refund", documentIds: "doc-1" },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/array of strings/);
    });

    it("50. reports a search database failure as an internal error", async () => {
      repo.failures.searchChunksByEmbedding = new Error("vector extension unavailable");

      const res = await call(router, "post", "/search", {
        token: TOKEN_A,
        body: { query: "refund policy" },
      });

      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe("KNOWLEDGE_RETRIEVAL_FAILED");
      expect(JSON.stringify(res.body)).not.toContain("vector extension");
    });

    it("51. reports an embedding failure during search", async () => {
      const failing = new FakeEmbeddingProvider({ failWith: new Error("provider down") });
      const localRouter = build({ provider: failing });

      const res = await call(localRouter, "post", "/search", {
        token: TOKEN_A,
        body: { query: "refund policy" },
      });

      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe("DOCUMENT_EMBEDDING_FAILED");
      expect(JSON.stringify(res.body)).not.toContain("provider down");
    });
  });

  // -------------------------------------------------------------------------
  // Document reads and deletion
  // -------------------------------------------------------------------------

  describe("document reads", () => {
    it("52. lists a user's own documents", async () => {
      seedDocument(repo, USER_A, { title: "One", chunks: [{ content: "Refund" }] });
      seedDocument(repo, USER_B, { title: "Two", chunks: [{ content: "Refund" }] });

      const res = await call(router, "get", "/documents", { token: TOKEN_A });
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.documents[0].title).toBe("One");
    });

    it("53. returns a single document including its text", async () => {
      const doc = seedDocument(repo, USER_A, {
        title: "One",
        chunks: [{ content: "Refund details here" }],
      });

      const res = await call(router, "get", `/documents/${doc.id}`, { token: TOKEN_A });
      expect(res.status).toBe(200);
      expect(res.body.data.document.content).toContain("Refund details");
    });

    it("54. omits document text from the list view", async () => {
      seedDocument(repo, USER_A, { title: "One", chunks: [{ content: "Refund details" }] });
      const res = await call(router, "get", "/documents", { token: TOKEN_A });

      expect(res.body.data.documents[0].content).toBeUndefined();
    });

    it("55. returns a document's chunks in order", async () => {
      const doc = seedDocument(repo, USER_A, {
        title: "One",
        chunks: [{ content: "Refund one" }, { content: "Refund two" }],
      });

      const res = await call(router, "get", `/documents/${doc.id}/chunks`, {
        token: TOKEN_A,
      });

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(2);
      expect(res.body.data.chunks.map((c: any) => c.chunkIndex)).toEqual([0, 1]);
    });

    it("56. rejects a malformed document id", async () => {
      const res = await call(router, "get", "/documents/!!", { token: TOKEN_A });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/Invalid document id/);
    });

    it("57. returns 404 for an unknown document", async () => {
      const res = await call(router, "get", "/documents/doc00000000missing", {
        token: TOKEN_A,
      });
      expect(res.status).toBe(404);
    });

    it("58. reports a listing failure as an internal error", async () => {
      repo.failures.listDocuments = new Error("connection terminated unexpectedly");
      const res = await call(router, "get", "/documents", { token: TOKEN_A });

      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe("INTERNAL_ERROR");
      expect(JSON.stringify(res.body)).not.toContain("connection terminated");
    });
  });

  describe("deletion", () => {
    it("59. deletes a document and its chunks", async () => {
      const doc = seedDocument(repo, USER_A, {
        title: "One",
        chunks: [{ content: "Refund one" }, { content: "Refund two" }],
      });

      const res = await call(router, "delete", `/documents/${doc.id}`, { token: TOKEN_A });

      expect(res.status).toBe(200);
      expect(res.body.data.deleted).toBe(true);
      expect(repo.documents).toHaveLength(0);
      expect(repo.chunks).toHaveLength(0);
    });

    it("60. audits a deletion", async () => {
      const doc = seedDocument(repo, USER_A, { title: "One", chunks: [{ content: "Refund" }] });
      await call(router, "delete", `/documents/${doc.id}`, { token: TOKEN_A });

      const entry = audit.find((a) => a.action === "knowledge.document.delete");
      expect(entry).toBeDefined();
      expect(entry!.result).toBe("success");
    });

    it("61. returns 404 when deleting an unknown document", async () => {
      const res = await call(router, "delete", "/documents/doc00000000missing", {
        token: TOKEN_A,
      });
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Response hygiene
  // -------------------------------------------------------------------------

  describe("response hygiene", () => {
    it("62. never exposes vector distance or raw chunk metadata in search hits", async () => {
      seedDocument(repo, USER_A, {
        title: "Refund Policy",
        chunks: [
          {
            content: "Refunds are issued within 14 days.",
            metadata: {
              pageNumbers: [1],
              contentHash: "deadbeef".repeat(8),
              chunkingVersion: "3.3.0",
            },
          },
        ],
      });

      const res = await call(router, "post", "/search", {
        token: TOKEN_A,
        body: { query: "refund" },
      });

      const serialized = JSON.stringify(res.body);
      expect(res.body.data.results[0].distance).toBeUndefined();
      expect(res.body.data.results[0].metadata).toBeUndefined();
      expect(serialized).not.toContain("deadbeef");
      expect(serialized).not.toContain("chunkingVersion");
    });

    it("63. omits the embedding model and vector dimensions from search responses", async () => {
      seedDocument(repo, USER_A, { title: "Refund", chunks: [{ content: "Refund text" }] });
      const res = await call(router, "post", "/search", {
        token: TOKEN_A,
        body: { query: "refund" },
      });

      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain("fake-embed-v1");
      expect(res.body.data.dimensions).toBeUndefined();
      expect(res.body.data.model).toBeUndefined();
    });

    it("64. omits pipeline version strings from document views", async () => {
      await call(router, "post", "/documents", {
        token: TOKEN_A,
        body: { fileName: "policies.md", content: base64(MARKDOWN_DOC) },
      });

      const res = await call(router, "get", "/documents", { token: TOKEN_A });
      const serialized = JSON.stringify(res.body);

      expect(serialized).not.toContain("extractionVersion");
      expect(serialized).not.toContain("contentHash");
    });

    it("65. never serialises a JarvisError's details", async () => {
      repo.failures.searchChunksByEmbedding = new JarvisError(
        "KNOWLEDGE_RETRIEVAL_FAILED",
        "Knowledge chunk similarity search failed",
        { provider: "openai-embeddings", cause: "ECONNREFUSED 10.0.0.5:5432" }
      );
      seedDocument(repo, USER_A, { title: "Refund", chunks: [{ content: "Refund text" }] });

      const res = await call(router, "post", "/search", {
        token: TOKEN_A,
        body: { query: "refund" },
      });

      const serialized = JSON.stringify(res.body);
      expect(res.body.error.details).toBeUndefined();
      expect(serialized).not.toContain("openai-embeddings");
      expect(serialized).not.toContain("10.0.0.5");
    });

    it("66. uses the shared success envelope", async () => {
      seedDocument(repo, USER_A, { title: "One", chunks: [{ content: "Refund" }] });
      const res = await call(router, "get", "/documents", { token: TOKEN_A });

      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(typeof res.body.timestamp).toBe("string");
    });

    it("67. uses the shared error envelope", async () => {
      const res = await call(router, "get", "/documents/!!", { token: TOKEN_A });

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBeDefined();
      expect(res.body.error.message).toBeDefined();
      expect(typeof res.body.timestamp).toBe("string");
    });
  });
});
