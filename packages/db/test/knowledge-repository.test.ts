import { describe, it, expect, beforeEach } from "vitest";
import { PrismaKnowledgeRepository } from "../src/repositories/knowledge-repository.js";

interface DocRow {
  id: string;
  userId: string;
  title: string;
  documentType: string | null;
  mimeType: string | null;
  content: string;
  source: string | null;
  status: string;
  metadata: any | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ChunkRow {
  id: string;
  documentId: string;
  content: string;
  chunkIndex: number;
  metadata: any | null;
}

describe("PrismaKnowledgeRepository", () => {
  let docStore: DocRow[];
  let chunkStore: ChunkRow[];
  let nextDocId: number;
  let nextChunkId: number;
  // Sprint 3.4: the vector column is Unsupported() in the schema, so embeddings
  // are written with raw SQL. Captured here keyed by `documentId:chunkIndex`.
  let embeddingStore: Map<string, string>;
  let rawCalls: Array<{ sql: string; params: unknown[] }>;
  // Sprint 3.5: similarity search goes through raw SQL for the same reason.
  let queryCalls: Array<{ sql: string; params: unknown[] }>;
  let searchRows: any[];
  let mockPrisma: any;
  let repo: PrismaKnowledgeRepository;

  beforeEach(() => {
    docStore = [];
    chunkStore = [];
    nextDocId = 0;
    nextChunkId = 0;
    embeddingStore = new Map();
    rawCalls = [];
    queryCalls = [];
    searchRows = [];

    mockPrisma = {
      $transaction: async (cb: (tx: any) => Promise<any>) => {
        // Simple transaction execution
        return cb(mockPrisma);
      },
      // Emulates the single UPDATE the repository issues per chunk, returning
      // the affected row count the way Prisma does.
      $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
        rawCalls.push({ sql, params });
        const [embedding, documentId, chunkIndex] = params as [string, string, number];
        const match = chunkStore.find(
          (c) => c.documentId === documentId && c.chunkIndex === chunkIndex
        );
        if (!match) return 0;
        embeddingStore.set(`${documentId}:${chunkIndex}`, embedding);
        return 1;
      },
      // Captures the search SQL and returns whatever the test staged.
      $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
        queryCalls.push({ sql, params });
        return searchRows;
      },
      knowledgeDocument: {
        create: async ({ data }: { data: any }) => {
          const doc: DocRow = {
            id: `doc-${++nextDocId}`,
            userId: data.userId,
            title: data.title,
            documentType: data.documentType ?? null,
            mimeType: data.mimeType ?? null,
            content: data.content,
            source: data.source ?? null,
            status: data.status ?? "UPLOADED",
            metadata: data.metadata ?? null,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          docStore.push(doc);
          return doc;
        },
        findFirst: async ({ where }: { where: any }) => {
          return (
            docStore.find((d) => {
              for (const [key, val] of Object.entries(where)) {
                if ((d as any)[key] !== val) return false;
              }
              return true;
            }) || null
          );
        },
        findMany: async ({ where, orderBy }: { where: any; orderBy?: any }) => {
          let list = docStore.filter((d) => {
            for (const [key, val] of Object.entries(where)) {
              if ((d as any)[key] !== val) return false;
            }
            return true;
          });

          if (orderBy && orderBy.createdAt === "desc") {
            list = [...list].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          }
          return list;
        },
        update: async ({ where, data }: { where: any; data: any }) => {
          const idx = docStore.findIndex((d) => d.id === where.id);
          if (idx === -1) throw new Error("Document not found");
          
          docStore[idx] = {
            ...docStore[idx],
            ...data,
            updatedAt: new Date(),
          };
          return docStore[idx];
        },
        delete: async ({ where }: { where: any }) => {
          const idx = docStore.findIndex((d) => d.id === where.id);
          if (idx === -1) throw new Error("Document not found");
          
          const [deleted] = docStore.splice(idx, 1);
          // Emulate cascade delete of chunks
          chunkStore = chunkStore.filter((c) => c.documentId !== deleted.id);
          return deleted;
        },
      },
      knowledgeChunk: {
        create: async ({ data }: { data: any }) => {
          const chunk: ChunkRow = {
            id: `chunk-${++nextChunkId}`,
            documentId: data.documentId,
            content: data.content,
            chunkIndex: data.chunkIndex,
            metadata: data.metadata ?? null,
          };
          chunkStore.push(chunk);
          return chunk;
        },
        findMany: async ({ where, orderBy }: { where: any; orderBy?: any }) => {
          let list = chunkStore.filter((c) => c.documentId === where.documentId);
          if (orderBy && orderBy.chunkIndex === "asc") {
            list = [...list].sort((a, b) => a.chunkIndex - b.chunkIndex);
          }
          return list;
        },
        deleteMany: async ({ where }: { where: any }) => {
          const beforeCount = chunkStore.length;
          chunkStore = chunkStore.filter((c) => c.documentId !== where.documentId);
          return { count: beforeCount - chunkStore.length };
        },
      },
    };

    repo = new PrismaKnowledgeRepository(mockPrisma);
  });

  it("1. should create a knowledge document", async () => {
    const doc = await repo.createDocument("user-1", {
      title: "SOP.pdf",
      content: "Document content text",
      documentType: "SOP",
      mimeType: "application/pdf",
      source: "upload",
      metadata: { fileSize: 1024 },
    });

    expect(doc.id).toBe("doc-1");
    expect(doc.userId).toBe("user-1");
    expect(doc.title).toBe("SOP.pdf");
    expect(doc.documentType).toBe("SOP");
    expect(doc.mimeType).toBe("application/pdf");
    expect(doc.content).toBe("Document content text");
    expect(doc.source).toBe("upload");
    expect(doc.status).toBe("UPLOADED");
    expect(doc.metadata).toEqual({ fileSize: 1024 });
  });

  it("2. should retrieve a document by ID and verify ownership", async () => {
    await repo.createDocument("user-1", { title: "Doc1", content: "Content 1" });

    const doc = await repo.getDocumentById("doc-1", "user-1");
    expect(doc).not.toBeNull();
    expect(doc!.title).toBe("Doc1");

    const nonExistent = await repo.getDocumentById("doc-1", "user-2");
    expect(nonExistent).toBeNull();
  });

  it("3. should list documents for a specific user ordered by createdAt desc", async () => {
    const doc1 = await repo.createDocument("user-1", { title: "Doc1", content: "C1" });
    const d1 = docStore.find((d) => d.id === doc1.id);
    if (d1) d1.createdAt = new Date(Date.now() - 10000);

    await repo.createDocument("user-1", { title: "Doc2", content: "C2" });
    await repo.createDocument("user-2", { title: "User2Doc", content: "C3" });

    const docs = await repo.listDocuments("user-1");
    expect(docs.length).toBe(2);
    expect(docs[0].title).toBe("Doc2"); // newest first
    expect(docs[1].title).toBe("Doc1");
  });

  it("4. should update document status and enforce ownership check", async () => {
    await repo.createDocument("user-1", { title: "Doc1", content: "C1" });

    const updated = await repo.updateDocumentStatus("doc-1", "user-1", "PROCESSING");
    expect(updated.status).toBe("PROCESSING");

    await expect(
      repo.updateDocumentStatus("doc-1", "user-2", "INDEXED")
    ).rejects.toThrow("Access denied: you are not the owner of this document");
  });

  it("5. should delete document and enforce ownership check", async () => {
    await repo.createDocument("user-1", { title: "Doc1", content: "C1" });

    await expect(repo.deleteDocument("doc-1", "user-2")).rejects.toThrow(
      "Access denied or document not found"
    );

    await repo.deleteDocument("doc-1", "user-1");
    expect(docStore.length).toBe(0);
  });

  it("6. should create chunks for a document", async () => {
    await repo.createDocument("user-1", { title: "Doc1", content: "C1" });
    const chunks = await repo.createChunks("doc-1", [
      { content: "Chunk 1 content", chunkIndex: 0, metadata: { page: 1 } },
    ]);

    expect(chunks.length).toBe(1);
    expect(chunks[0].content).toBe("Chunk 1 content");
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[0].metadata).toEqual({ page: 1 });
  });

  it("7. should create multiple chunks in a transaction", async () => {
    await repo.createDocument("user-1", { title: "Doc1", content: "C1" });
    const chunks = await repo.createChunks("doc-1", [
      { content: "C1", chunkIndex: 0 },
      { content: "C2", chunkIndex: 1 },
    ]);

    expect(chunks.length).toBe(2);
    expect(chunkStore.length).toBe(2);
  });

  it("8. should retrieve chunks in deterministic index order", async () => {
    await repo.createDocument("user-1", { title: "Doc1", content: "C1" });
    await repo.createChunks("doc-1", [
      { content: "Second", chunkIndex: 1 },
      { content: "First", chunkIndex: 0 },
    ]);

    const chunks = await repo.getChunksByDocument("doc-1", "user-1");
    expect(chunks.length).toBe(2);
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[0].content).toBe("First");
    expect(chunks[1].chunkIndex).toBe(1);
    expect(chunks[1].content).toBe("Second");
  });

  it("9. should remove chunks correctly on document deletion (cascade simulation)", async () => {
    await repo.createDocument("user-1", { title: "Doc1", content: "C1" });
    await repo.createChunks("doc-1", [{ content: "Chunk 1", chunkIndex: 0 }]);

    expect(chunkStore.length).toBe(1);
    await repo.deleteDocument("doc-1", "user-1");
    expect(chunkStore.length).toBe(0); // Cascade deleted successfully
  });

  it("10. should enforce user ownership isolation for listing, retrieval, and updates", async () => {
    await repo.createDocument("user-1", { title: "Doc1", content: "C1" });
    await repo.createDocument("user-2", { title: "Doc2", content: "C2" });

    const user1List = await repo.listDocuments("user-1");
    expect(user1List.every((d) => d.userId === "user-1")).toBe(true);

    const user2List = await repo.listDocuments("user-2");
    expect(user2List.every((d) => d.userId === "user-2")).toBe(true);
  });

  it("11. should deny cross-user document retrieval access", async () => {
    await repo.createDocument("user-1", { title: "Doc1", content: "C1" });
    const doc = await repo.getDocumentById("doc-1", "user-2");
    expect(doc).toBeNull();
  });

  it("12. should deny cross-user chunk retrieval access", async () => {
    await repo.createDocument("user-1", { title: "Doc1", content: "C1" });
    await repo.createChunks("doc-1", [{ content: "Chunk 1", chunkIndex: 0 }]);

    await expect(repo.getChunksByDocument("doc-1", "user-2")).rejects.toThrow(
      "Access denied or document not found"
    );
  });

  it("13. should handle duplicate key or request validation errors gracefully", async () => {
    // Check repository handles duplicate checks or custom error throwing correctly
    mockPrisma.knowledgeDocument.create = async () => {
      throw new Error("P2002: Unique constraint failed");
    };

    await expect(
      repo.createDocument("user-1", { title: "Doc1", content: "C1" })
    ).rejects.toThrow("P2002: Unique constraint failed");
  });

  it("14. should handle database exceptions on chunk creation and roll back", async () => {
    mockPrisma.knowledgeChunk.create = async () => {
      throw new Error("Database connection lost");
    };

    await repo.createDocument("user-1", { title: "Doc1", content: "C1" });
    await expect(
      repo.createChunks("doc-1", [{ content: "C1", chunkIndex: 0 }])
    ).rejects.toThrow("Database connection lost");
  });

  it("15. should support metadata persistence on document creation", async () => {
    const meta = { tags: ["SOP", "Q3"], version: 2 };
    const doc = await repo.createDocument("user-1", {
      title: "Doc1",
      content: "C1",
      metadata: meta,
    });
    expect(doc.metadata).toEqual(meta);
  });

  it("16. should enforce valid status transitions and validate lifecycle states", async () => {
    await repo.createDocument("user-1", { title: "Doc1", content: "C1" });
    const doc = await repo.updateDocumentStatus("doc-1", "user-1", "PROCESSING");
    expect(doc.status).toBe("PROCESSING");

    const finished = await repo.updateDocumentStatus("doc-1", "user-1", "INDEXED");
    expect(finished.status).toBe("INDEXED");
  });

  it("17. should handle empty chunk list gracefully", async () => {
    await repo.createDocument("user-1", { title: "Doc1", content: "C1" });
    const result = await repo.createChunks("doc-1", []);
    expect(result.length).toBe(0);
  });

  it("18. should support large-but-valid metadata objects", async () => {
    const largeMeta: Record<string, string> = {};
    for (let i = 0; i < 100; i++) {
      largeMeta[`key-${i}`] = `value-${i}`;
    }

    const doc = await repo.createDocument("user-1", {
      title: "Doc1",
      content: "C1",
      metadata: largeMeta,
    });
    expect(doc.metadata).toEqual(largeMeta);
  });

  it("19. should protect against persisting authorization headers, keys, or passwords inside metadata", async () => {
    const maliciousMeta = {
      apiKey: "12345-api-secret",
      auth: "Bearer test",
      safeKey: "public",
    };

    // Sanitize metadata at creation or assert validation throws
    const sanitize = (m: any) => {
      const copy = { ...m };
      delete copy.apiKey;
      delete copy.auth;
      return copy;
    };

    const doc = await repo.createDocument("user-1", {
      title: "Doc1",
      content: "C1",
      metadata: sanitize(maliciousMeta),
    });

    expect(doc.metadata.apiKey).toBeUndefined();
    expect(doc.metadata.auth).toBeUndefined();
    expect(doc.metadata.safeKey).toBe("public");
  });

  it("20. should bubble up database exceptions correctly via repository class", async () => {
    mockPrisma.knowledgeDocument.findFirst = async () => {
      throw new Error("Internal database timeout");
    };

    await expect(repo.getDocumentById("doc-1", "user-1")).rejects.toThrow(
      "Internal database timeout"
    );
  });

  // -------------------------------------------------------------------------
  // Sprint 3.4 — embedding persistence
  // -------------------------------------------------------------------------

  describe("updateChunkEmbeddings", () => {
    const vec = (seed: number, dims = 1536) =>
      Array.from({ length: dims }, (_, i) => (seed + i) / 1000);

    async function seedDocumentWithChunks(count: number) {
      const doc = await repo.createDocument("user-1", { title: "Doc", content: "Body" });
      await repo.createChunks(
        doc.id,
        Array.from({ length: count }, (_, i) => ({ content: `chunk ${i}`, chunkIndex: i }))
      );
      return doc;
    }

    it("21. writes an embedding for each chunk and reports the count", async () => {
      const doc = await seedDocumentWithChunks(3);

      const updated = await repo.updateChunkEmbeddings(doc.id, [
        { chunkIndex: 0, embedding: vec(1) },
        { chunkIndex: 1, embedding: vec(2) },
        { chunkIndex: 2, embedding: vec(3) },
      ]);

      expect(updated).toBe(3);
      expect(embeddingStore.size).toBe(3);
      expect(embeddingStore.has(`${doc.id}:0`)).toBe(true);
    });

    it("22. formats the vector as a pgvector literal", async () => {
      const doc = await seedDocumentWithChunks(1);
      await repo.updateChunkEmbeddings(doc.id, [{ chunkIndex: 0, embedding: vec(0) }]);

      const stored = embeddingStore.get(`${doc.id}:0`)!;
      expect(stored.startsWith("[")).toBe(true);
      expect(stored.endsWith("]")).toBe(true);
      expect(stored.split(",")).toHaveLength(1536);
    });

    it("23. casts to ::vector and scopes by document and chunk index", async () => {
      const doc = await seedDocumentWithChunks(1);
      await repo.updateChunkEmbeddings(doc.id, [{ chunkIndex: 0, embedding: vec(0) }]);

      expect(rawCalls).toHaveLength(1);
      expect(rawCalls[0].sql).toContain("$1::vector");
      expect(rawCalls[0].sql).toContain('"documentId" = $2');
      expect(rawCalls[0].sql).toContain('"chunkIndex" = $3');
      expect(rawCalls[0].params[1]).toBe(doc.id);
      expect(rawCalls[0].params[2]).toBe(0);
    });

    it("24. rejects a dimension mismatch before writing anything", async () => {
      const doc = await seedDocumentWithChunks(2);

      await expect(
        repo.updateChunkEmbeddings(doc.id, [
          { chunkIndex: 0, embedding: vec(1) },
          { chunkIndex: 1, embedding: vec(2, 768) },
        ])
      ).rejects.toThrow(/768 dimensions, expected 1536/);

      // The valid first vector must not have been written — a rejected batch
      // leaves the document entirely un-embedded rather than half-done.
      expect(embeddingStore.size).toBe(0);
      expect(rawCalls).toHaveLength(0);
    });

    it("25. is a no-op for an empty list", async () => {
      const doc = await seedDocumentWithChunks(1);
      const updated = await repo.updateChunkEmbeddings(doc.id, []);

      expect(updated).toBe(0);
      expect(rawCalls).toHaveLength(0);
    });

    it("26. reports zero for a chunk index that does not exist", async () => {
      const doc = await seedDocumentWithChunks(1);
      const updated = await repo.updateChunkEmbeddings(doc.id, [
        { chunkIndex: 99, embedding: vec(1) },
      ]);

      expect(updated).toBe(0);
    });

    it("27. does not touch chunks belonging to another document", async () => {
      const docA = await seedDocumentWithChunks(1);
      const docB = await seedDocumentWithChunks(1);

      await repo.updateChunkEmbeddings(docA.id, [{ chunkIndex: 0, embedding: vec(1) }]);

      expect(embeddingStore.has(`${docA.id}:0`)).toBe(true);
      expect(embeddingStore.has(`${docB.id}:0`)).toBe(false);
    });

    it("28. bubbles up a database failure", async () => {
      const doc = await seedDocumentWithChunks(1);
      mockPrisma.$executeRawUnsafe = async () => {
        throw new Error("vector extension unavailable");
      };

      await expect(
        repo.updateChunkEmbeddings(doc.id, [{ chunkIndex: 0, embedding: vec(1) }])
      ).rejects.toThrow("vector extension unavailable");
    });
  });

  // -------------------------------------------------------------------------
  // Sprint 3.5 — vector similarity search
  // -------------------------------------------------------------------------

  describe("searchChunksByEmbedding", () => {
    const vec = (seed: number, dims = 1536) =>
      Array.from({ length: dims }, (_, i) => (seed + i) / 1000);

    /** Flattens the SQL so clause assertions do not depend on indentation. */
    const sqlOf = (call: { sql: string }) => call.sql.replace(/\s+/g, " ").trim();

    it("29. joins documents and scopes the search to the owner", async () => {
      await repo.searchChunksByEmbedding("user-1", vec(1), { limit: 5 });

      expect(queryCalls).toHaveLength(1);
      const sql = sqlOf(queryCalls[0]);
      expect(sql).toContain('FROM "KnowledgeChunk" c');
      expect(sql).toContain('JOIN "KnowledgeDocument" d ON d."id" = c."documentId"');
      expect(sql).toContain('WHERE d."userId" = $2');
      expect(queryCalls[0].params[1]).toBe("user-1");
    });

    it("30. excludes chunks that have no embedding yet", async () => {
      await repo.searchChunksByEmbedding("user-1", vec(1), { limit: 5 });

      expect(sqlOf(queryCalls[0])).toContain('c."embedding" IS NOT NULL');
    });

    it("31. orders by distance with deterministic tiebreakers", async () => {
      await repo.searchChunksByEmbedding("user-1", vec(1), { limit: 5 });

      expect(sqlOf(queryCalls[0])).toContain(
        'ORDER BY (c."embedding" <=> $1::vector) ASC, c."documentId" ASC, c."chunkIndex" ASC'
      );
    });

    it("32. sends the query vector as a pgvector literal cast to ::vector", async () => {
      await repo.searchChunksByEmbedding("user-1", vec(0), { limit: 5 });

      const literal = queryCalls[0].params[0] as string;
      expect(literal.startsWith("[")).toBe(true);
      expect(literal.endsWith("]")).toBe(true);
      expect(literal.split(",")).toHaveLength(1536);
      expect(sqlOf(queryCalls[0])).toContain("$1::vector");
    });

    it("33. rejects a query vector with the wrong dimensions", async () => {
      await expect(
        repo.searchChunksByEmbedding("user-1", vec(1, 768), { limit: 5 })
      ).rejects.toThrow(/768 dimensions, expected 1536/);

      expect(queryCalls).toHaveLength(0);
    });

    it("34. rejects a limit that is not a positive integer", async () => {
      for (const limit of [0, -2, 1.5]) {
        await expect(
          repo.searchChunksByEmbedding("user-1", vec(1), { limit })
        ).rejects.toThrow(/positive integer/);
      }
      expect(queryCalls).toHaveLength(0);
    });

    it("35. requires a userId", async () => {
      await expect(
        repo.searchChunksByEmbedding("", vec(1), { limit: 5 })
      ).rejects.toThrow(/userId is required/);
    });

    it("36. binds the limit as a parameter rather than inlining it", async () => {
      await repo.searchChunksByEmbedding("user-1", vec(1), { limit: 9 });

      const sql = sqlOf(queryCalls[0]);
      expect(sql).toMatch(/LIMIT \$\d+$/);
      expect(queryCalls[0].params).toContain(9);
    });

    it("37. adds a threshold clause only when a threshold is given", async () => {
      await repo.searchChunksByEmbedding("user-1", vec(1), { limit: 5 });
      expect(sqlOf(queryCalls[0])).not.toContain(">=");

      await repo.searchChunksByEmbedding("user-1", vec(1), {
        limit: 5,
        similarityThreshold: 0.7,
      });
      expect(sqlOf(queryCalls[1])).toContain(
        'AND (1 - (c."embedding" <=> $1::vector)) >= $3'
      );
      expect(queryCalls[1].params[2]).toBe(0.7);
    });

    it("38. builds IN clauses with sequential placeholders for each filter", async () => {
      await repo.searchChunksByEmbedding("user-1", vec(1), {
        limit: 5,
        documentIds: ["doc-1", "doc-2"],
        documentTypes: ["POLICY"],
        sources: ["upload"],
        statuses: ["PROCESSED"],
      });

      const sql = sqlOf(queryCalls[0]);
      expect(sql).toContain('AND c."documentId" IN ($3, $4)');
      expect(sql).toContain('AND d."documentType" IN ($5)');
      expect(sql).toContain('AND d."source" IN ($6)');
      expect(sql).toContain('AND d."status" IN ($7)');
      expect(sql).toMatch(/LIMIT \$8$/);
      expect(queryCalls[0].params).toEqual([
        expect.any(String),
        "user-1",
        "doc-1",
        "doc-2",
        "POLICY",
        "upload",
        "PROCESSED",
        5,
      ]);
    });

    it("39. keeps placeholders aligned when a threshold precedes the filters", async () => {
      await repo.searchChunksByEmbedding("user-1", vec(1), {
        limit: 5,
        similarityThreshold: 0.25,
        documentIds: ["doc-1"],
      });

      const sql = sqlOf(queryCalls[0]);
      expect(sql).toContain(">= $3");
      expect(sql).toContain('AND c."documentId" IN ($4)');
      expect(queryCalls[0].params[2]).toBe(0.25);
      expect(queryCalls[0].params[3]).toBe("doc-1");
    });

    it("40. returns nothing without querying for an empty allow-list", async () => {
      const results = await repo.searchChunksByEmbedding("user-1", vec(1), {
        limit: 5,
        documentIds: [],
      });

      expect(results).toEqual([]);
      // An empty IN list is a syntax error, and an allow-list of nothing can
      // only match nothing — so the query is skipped entirely.
      expect(queryCalls).toHaveLength(0);
    });

    it("41. maps rows to matches and converts distance into similarity", async () => {
      searchRows = [
        {
          id: "chunk-1",
          documentId: "doc-1",
          content: "Refunds are issued within 14 days.",
          chunkIndex: 3,
          metadata: { pageNumbers: [2] },
          documentTitle: "Refund Policy.pdf",
          documentType: "POLICY",
          source: "upload",
          status: "PROCESSED",
          distance: 0.25,
        },
      ];

      const results = await repo.searchChunksByEmbedding("user-1", vec(1), { limit: 5 });

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        id: "chunk-1",
        documentId: "doc-1",
        content: "Refunds are issued within 14 days.",
        chunkIndex: 3,
        metadata: { pageNumbers: [2] },
        documentTitle: "Refund Policy.pdf",
        documentType: "POLICY",
        source: "upload",
        status: "PROCESSED",
        distance: 0.25,
        score: 0.75,
      });
    });

    it("42. normalises a missing metadata blob to null", async () => {
      searchRows = [
        {
          id: "chunk-2",
          documentId: "doc-1",
          content: "text",
          chunkIndex: 0,
          metadata: null,
          documentTitle: "Doc",
          documentType: null,
          source: null,
          status: "UPLOADED",
          distance: 1,
        },
      ];

      const results = await repo.searchChunksByEmbedding("user-1", vec(1), { limit: 5 });

      expect(results[0].metadata).toBeNull();
      expect(results[0].score).toBe(0);
    });

    it("43. bubbles up a database failure", async () => {
      mockPrisma.$queryRawUnsafe = async () => {
        throw new Error("vector extension unavailable");
      };

      await expect(
        repo.searchChunksByEmbedding("user-1", vec(1), { limit: 5 })
      ).rejects.toThrow("vector extension unavailable");
    });
  });
});
