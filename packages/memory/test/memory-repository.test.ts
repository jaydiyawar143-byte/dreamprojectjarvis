import { describe, it, expect, beforeEach } from "vitest";
import { PrismaMemoryRepository } from "@jarvis/db";

interface MemoryRow {
  id: string;
  userId: string;
  type: string;
  content: string;
  summary: string | null;
  importance: number;
  confidence: number;
  accessCount: number;
  lastAccessedAt: Date | null;
  metadata: unknown;
  sourceType: string | null;
  sourceConversationId: string | null;
  sourceMessageId: string | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date | null;
}

let store: MemoryRow[];
let nextId: number;

function makeRow(overrides: Partial<MemoryRow> & { userId: string }): MemoryRow {
  nextId++;
  const now = new Date();
  return {
    id: overrides.id ?? `mem-${nextId}`,
    userId: overrides.userId,
    type: overrides.type ?? "FACT",
    content: overrides.content ?? `content-${nextId}`,
    summary: overrides.summary ?? null,
    importance: overrides.importance ?? 0.5,
    confidence: overrides.confidence ?? 0.5,
    accessCount: overrides.accessCount ?? 0,
    lastAccessedAt: overrides.lastAccessedAt ?? null,
    metadata: overrides.metadata ?? null,
    sourceType: overrides.sourceType ?? null,
    sourceConversationId: overrides.sourceConversationId ?? null,
    sourceMessageId: overrides.sourceMessageId ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    expiresAt: overrides.expiresAt ?? null,
  };
}

function createMockPrisma() {
  return {
    memory: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row: MemoryRow = {
          id: (data.id as string) ?? `mem-${++nextId}`,
          userId: data.userId as string,
          type: data.type as string,
          content: data.content as string,
          summary: (data.summary as string) ?? null,
          importance: (data.importance as number) ?? 0.5,
          confidence: (data.confidence as number) ?? 0.5,
          accessCount: 0,
          lastAccessedAt: null,
          metadata: data.metadata ?? null,
          sourceType: (data.sourceType as string) ?? null,
          sourceConversationId: (data.sourceConversationId as string) ?? null,
          sourceMessageId: (data.sourceMessageId as string) ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
          expiresAt: (data.expiresAt as Date) ?? null,
        };
        store.push(row);
        return row;
      },

      findUnique: async ({ where }: { where: { id: string } }) => {
        return store.find((r) => r.id === where.id) ?? null;
      },

      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        return (
          store.find((r) => {
            if (where.id && r.id !== where.id) return false;
            if (where.userId && r.userId !== where.userId) return false;
            return true;
          }) ?? null
        );
      },

      findMany: async ({
        where,
        orderBy,
        skip,
        take,
      }: {
        where: Record<string, unknown>;
        orderBy?: Record<string, string>;
        skip?: number;
        take?: number;
      }) => {
        let rows = store.filter((r) => {
          if (where.userId && r.userId !== where.userId) return false;
          if (where.type && r.type !== where.type) return false;
          if (where.OR && Array.isArray(where.OR)) {
            const orMatch = where.OR.some((cond: Record<string, unknown>) => {
              if (cond.expiresAt && typeof cond.expiresAt === "object" && cond.expiresAt !== null) {
                const expCond = cond.expiresAt as Record<string, unknown>;
                if (expCond.gt && expCond.gt instanceof Date) {
                  return r.expiresAt !== null && r.expiresAt > expCond.gt;
                }
              }
              if (cond.expiresAt === null) {
                return r.expiresAt === null;
              }
              return false;
            });
            if (!orMatch) return false;
          }
          return true;
        });

        if (orderBy?.createdAt === "desc") {
          rows = rows.sort(
            (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
          );
        }

        const offset = skip ?? 0;
        const limit = take ?? rows.length;
        return rows.slice(offset, offset + limit);
      },

      update: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const row = store.find((r) => {
          if (where.id && r.id !== where.id) return false;
          if (where.userId && r.userId !== where.userId) return false;
          return true;
        });
        if (!row) throw new Error("Record not found");
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },

      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        const before = store.length;
        store = store.filter((r) => {
          const matchesUserId = !where.userId || r.userId === where.userId;
          const matchesId = !where.id || (typeof where.id === "object" && where.id !== null && (where.id as { in?: string[] }).in?.includes(r.id));
          const matchesType = !where.type || r.type === where.type;
          let matchesCreatedAt = true;
          if (where.createdAt && typeof where.createdAt === "object" && where.createdAt !== null) {
            const cCond = where.createdAt as Record<string, unknown>;
            if (cCond.lt && cCond.lt instanceof Date) {
              matchesCreatedAt = r.createdAt < cCond.lt;
            }
          }
          const shouldDelete = matchesUserId && matchesId && matchesType && matchesCreatedAt;
          return !shouldDelete;
        });
        return { count: before - store.length };
      },

      count: async ({ where }: { where: Record<string, unknown> }) => {
        return store.filter((r) => {
          if (where.userId && r.userId !== where.userId) return false;
          if (where.OR && Array.isArray(where.OR)) {
            return where.OR.some((cond: Record<string, unknown>) => {
              if (cond.expiresAt === null) return r.expiresAt === null;
              if (cond.expiresAt && typeof cond.expiresAt === "object" && cond.expiresAt !== null) {
                const expCond = cond.expiresAt as Record<string, unknown>;
                if (expCond.gt && expCond.gt instanceof Date) {
                  return r.expiresAt !== null && r.expiresAt > expCond.gt;
                }
              }
              return false;
            });
          }
          return true;
        }).length;
      },
    },

    $executeRawUnsafe: async () => 1,
    $queryRaw: async () => [{ "?column?": 1 }],
    $queryRawUnsafe: async () => [],
  };
}

function createRepo() {
  const mockPrisma = createMockPrisma() as never;
  return new PrismaMemoryRepository(mockPrisma);
}

beforeEach(() => {
  store = [];
  nextId = 0;
});

describe("PrismaMemoryRepository", () => {
  describe("1. Create memory", () => {
    it("creates a memory and returns MemoryRecord", async () => {
      const repo = createRepo();
      const results = await repo.store({
        userId: "user-a",
        memories: [{ type: "FACT", content: "The sky is blue", importance: 0.8, confidence: 0.9 }],
      });
      expect(results).toHaveLength(1);
      expect(results[0].userId).toBe("user-a");
      expect(results[0].content).toBe("The sky is blue");
      expect(results[0].type).toBe("FACT");
      expect(results[0].id).toBeDefined();
    });
  });

  describe("2. Retrieve memory by ID", () => {
    it("retrieves a memory by userId + memoryId", async () => {
      const repo = createRepo();
      const [created] = await repo.store({
        userId: "user-a",
        memories: [{ type: "FACT", content: "Test retrieval", importance: 0.5, confidence: 0.5 }],
      });
      const found = await repo.getById("user-a", created.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
      expect(found!.content).toBe("Test retrieval");
    });

    it("returns null for non-existent memory", async () => {
      const repo = createRepo();
      const found = await repo.getById("user-a", "non-existent");
      expect(found).toBeNull();
    });
  });

  describe("3. Update memory", () => {
    it("updates content and summary", async () => {
      const repo = createRepo();
      const [created] = await repo.store({
        userId: "user-a",
        memories: [{ type: "FACT", content: "Original", importance: 0.5, confidence: 0.5 }],
      });
      const updated = await repo.update({
        userId: "user-a",
        memoryId: created.id,
        content: "Updated content",
        summary: "Updated summary",
        importance: 0.9,
      });
      expect(updated.content).toBe("Updated content");
      expect(updated.summary).toBe("Updated summary");
      expect(updated.importance).toBe(0.9);
    });
  });

  describe("4. Delete memory by ID", () => {
    it("deletes a specific memory by ID", async () => {
      const repo = createRepo();
      const [created] = await repo.store({
        userId: "user-a",
        memories: [{ type: "FACT", content: "To delete", importance: 0.5, confidence: 0.5 }],
      });
      const count = await repo.delete({ userId: "user-a", memoryIds: [created.id] });
      expect(count).toBe(1);
      const found = await repo.getById("user-a", created.id);
      expect(found).toBeNull();
    });
  });

  describe("5. Delete memories by type", () => {
    it("deletes all memories of a specific type", async () => {
      const repo = createRepo();
      await repo.store({
        userId: "user-a",
        memories: [
          { type: "FACT", content: "fact-1", importance: 0.5, confidence: 0.5 },
          { type: "FACT", content: "fact-2", importance: 0.5, confidence: 0.5 },
          { type: "GOAL", content: "goal-1", importance: 0.5, confidence: 0.5 },
        ],
      });
      const count = await repo.delete({ userId: "user-a", type: "FACT" });
      expect(count).toBe(2);
      const remaining = await repo.list({ userId: "user-a" });
      expect(remaining.memories).toHaveLength(1);
      expect(remaining.memories[0].type).toBe("GOAL");
    });
  });

  describe("6. Delete memories older than age", () => {
    it("deletes memories older than a cutoff date", async () => {
      const repo = createRepo();
      const oldDate = new Date("2020-01-01");
      const recentDate = new Date("2025-01-01");
      await repo.store({
        userId: "user-a",
        memories: [
          { type: "FACT", content: "old", importance: 0.5, confidence: 0.5 },
          { type: "FACT", content: "new", importance: 0.5, confidence: 0.5 },
        ],
      });
      store[0].createdAt = oldDate;
      store[1].createdAt = recentDate;
      const cutoff = new Date("2022-01-01");
      const count = await repo.delete({ userId: "user-a", olderThan: cutoff });
      expect(count).toBe(1);
      const remaining = await repo.list({ userId: "user-a" });
      expect(remaining.memories).toHaveLength(1);
      expect(remaining.memories[0].content).toBe("new");
    });
  });

  describe("7. Delete all user memories", () => {
    it("deletes all memories for a user", async () => {
      const repo = createRepo();
      await repo.store({
        userId: "user-a",
        memories: [
          { type: "FACT", content: "a-1", importance: 0.5, confidence: 0.5 },
          { type: "GOAL", content: "a-2", importance: 0.5, confidence: 0.5 },
        ],
      });
      await repo.store({
        userId: "user-b",
        memories: [{ type: "FACT", content: "b-1", importance: 0.5, confidence: 0.5 }],
      });
      const count = await repo.deleteAll("user-a");
      expect(count).toBe(2);
      const remaining = await repo.list({ userId: "user-a" });
      expect(remaining.memories).toHaveLength(0);
      const userB = await repo.list({ userId: "user-b" });
      expect(userB.memories).toHaveLength(1);
    });
  });

  describe("8. Pagination / bounded results", () => {
    it("returns paginated results with limit and offset", async () => {
      const repo = createRepo();
      const mems = Array.from({ length: 5 }, (_, i) => ({
        type: "FACT" as const,
        content: `item-${i}`,
        importance: 0.5,
        confidence: 0.5,
      }));
      await repo.store({ userId: "user-a", memories: mems });
      const page1 = await repo.list({ userId: "user-a", limit: 2, offset: 0 });
      expect(page1.memories).toHaveLength(2);
      expect(page1.total).toBe(5);
      expect(page1.hasMore).toBe(true);
      const page2 = await repo.list({ userId: "user-a", limit: 2, offset: 2 });
      expect(page2.memories).toHaveLength(2);
      expect(page2.hasMore).toBe(true);
      const page3 = await repo.list({ userId: "user-a", limit: 2, offset: 4 });
      expect(page3.memories).toHaveLength(1);
      expect(page3.hasMore).toBe(false);
    });
  });

  describe("9. Expired memory handling", () => {
    it("excludes expired memories from listing by default", async () => {
      const repo = createRepo();
      const past = new Date("2020-01-01");
      const future = new Date("2099-12-31");
      await repo.store({
        userId: "user-a",
        memories: [
          { type: "FACT", content: "expired", importance: 0.5, confidence: 0.5, expiresAt: past },
          { type: "FACT", content: "valid", importance: 0.5, confidence: 0.5, expiresAt: future },
          { type: "FACT", content: "no-expiry", importance: 0.5, confidence: 0.5 },
        ],
      });
      const result = await repo.list({ userId: "user-a", includeExpired: false });
      expect(result.memories).toHaveLength(2);
      const contents = result.memories.map((m) => m.content);
      expect(contents).toContain("valid");
      expect(contents).toContain("no-expiry");
      expect(contents).not.toContain("expired");
    });

    it("includes expired memories when includeExpired is true", async () => {
      const repo = createRepo();
      const past = new Date("2020-01-01");
      await repo.store({
        userId: "user-a",
        memories: [
          { type: "FACT", content: "expired", importance: 0.5, confidence: 0.5, expiresAt: past },
        ],
      });
      const result = await repo.list({ userId: "user-a", includeExpired: true });
      expect(result.memories).toHaveLength(1);
      expect(result.memories[0].content).toBe("expired");
    });
  });

  describe("10. Provenance persistence", () => {
    it("preserves sourceType, sourceConversationId, and sourceMessageId", async () => {
      const repo = createRepo();
      const [created] = await repo.store({
        userId: "user-a",
        memories: [
          {
            type: "FACT",
            content: "Provenance test",
            importance: 0.5,
            confidence: 0.5,
            sourceType: "conversation",
            sourceConversationId: "conv-123",
            sourceMessageId: "msg-456",
          },
        ],
      });
      expect(created.sourceType).toBe("conversation");
      expect(created.sourceConversationId).toBe("conv-123");
      expect(created.sourceMessageId).toBe("msg-456");
      const retrieved = await repo.getById("user-a", created.id);
      expect(retrieved!.sourceType).toBe("conversation");
      expect(retrieved!.sourceConversationId).toBe("conv-123");
      expect(retrieved!.sourceMessageId).toBe("msg-456");
    });
  });

  describe("11. User A cannot read User B memory", () => {
    it("returns null when wrong userId tries to read", async () => {
      const repo = createRepo();
      const [created] = await repo.store({
        userId: "user-a",
        memories: [{ type: "FACT", content: "Secret A", importance: 0.5, confidence: 0.5 }],
      });
      const result = await repo.getById("user-b", created.id);
      expect(result).toBeNull();
    });
  });

  describe("12. User A cannot update User B memory", () => {
    it("throws when wrong userId tries to update", async () => {
      const repo = createRepo();
      const [created] = await repo.store({
        userId: "user-a",
        memories: [{ type: "FACT", content: "Secret A", importance: 0.5, confidence: 0.5 }],
      });
      await expect(
        repo.update({ userId: "user-b", memoryId: created.id, content: "Hacked" })
      ).rejects.toThrow();
    });
  });

  describe("13. User A cannot delete User B memory", () => {
    it("deletes 0 records when wrong userId tries to delete", async () => {
      const repo = createRepo();
      const [created] = await repo.store({
        userId: "user-a",
        memories: [{ type: "FACT", content: "Secret A", importance: 0.5, confidence: 0.5 }],
      });
      const count = await repo.delete({ userId: "user-b", memoryIds: [created.id] });
      expect(count).toBe(0);
      const found = await repo.getById("user-a", created.id);
      expect(found).not.toBeNull();
    });
  });

  describe("14. Empty result behavior", () => {
    it("returns empty array for list of non-existent user", async () => {
      const repo = createRepo();
      const result = await repo.list({ userId: "non-existent" });
      expect(result.memories).toHaveLength(0);
      expect(result.total).toBe(0);
      expect(result.hasMore).toBe(false);
    });

    it("returns 0 for count of non-existent user", async () => {
      const repo = createRepo();
      const count = await repo.count("non-existent");
      expect(count).toBe(0);
    });

    it("returns 0 for deleteAll of non-existent user", async () => {
      const repo = createRepo();
      const count = await repo.deleteAll("non-existent");
      expect(count).toBe(0);
    });
  });

  describe("15. Invalid input behavior", () => {
    it("rejects memory content containing API keys", async () => {
      const repo = createRepo();
      await expect(
        repo.store({
          userId: "user-a",
          memories: [
            {
              type: "FACT",
              content: "My key is sk-proj-abcdefghijklmnop",
              importance: 0.5,
              confidence: 0.5,
            },
          ],
        })
      ).rejects.toThrow("secrets");
    });

    it("rejects memory content containing passwords", async () => {
      const repo = createRepo();
      await expect(
        repo.store({
          userId: "user-a",
          memories: [
            {
              type: "FACT",
              content: "password=hunter2",
              importance: 0.5,
              confidence: 0.5,
            },
          ],
        })
      ).rejects.toThrow("secrets");
    });

    it("accepts normal non-secret content", async () => {
      const repo = createRepo();
      const results = await repo.store({
        userId: "user-a",
        memories: [
          {
            type: "FACT",
            content: "User prefers dark mode",
            importance: 0.7,
            confidence: 0.8,
          },
        ],
      });
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe("User prefers dark mode");
    });
  });
});
