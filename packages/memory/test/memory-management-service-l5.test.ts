// S7.2 L5 — MemoryManagementService: the one place a user's memories are
// listed, forgotten, paused or vetoed.
//
// It uses the existing store and nothing else: every call is scoped to the
// user, a foreign or unknown id is NOT_FOUND (indistinguishable), deletion
// takes explicit ids bound to the version the user was shown, a stale target
// deletes nothing, and the audit trail holds ids and counts — never content.
import { describe, it, expect } from "vitest";
import type {
  AuditEntry,
  IMemoryStore,
  MemoryDeleteRequest,
  MemoryListRequest,
  MemoryListResult,
  MemoryRecord,
} from "@jarvis/core";
import { MEMORY_VETO_LIMIT } from "@jarvis/core";
import { MemoryManagementService, MEMORY_FORGET_LIMIT } from "../src/memory-management-service.js";

const T0 = new Date("2026-09-01T10:00:00.000Z");

function evidence(count: number) {
  return { v: 1, count, conversations: 1, firstSeenAt: T0.toISOString(), lastSeenAt: T0.toISOString(), sources: [], revisions: 0, previousSourceMessageIds: [] };
}

function memory(id: string, over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id,
    userId: "user-1",
    type: "PREFERENCE",
    content: `content of ${id}`,
    importance: 0.7,
    confidence: 0.7,
    accessCount: 0,
    sourceType: "USER",
    sourceConversationId: "conv-secret",
    sourceMessageId: "msg-secret",
    metadata: { embedding: [0.5], evidence: evidence(1), sourceTraceId: "trace-secret" },
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

/** A user-scoped store, with the repository's delete semantics (an empty id list deletes nothing). */
class FakeStore implements IMemoryStore {
  readonly id = "fake";
  readonly name = "fake";
  readonly deletes: MemoryDeleteRequest[] = [];
  constructor(public rows: MemoryRecord[]) {}
  async getById(userId: string, memoryId: string) {
    return this.rows.find((r) => r.id === memoryId && r.userId === userId) ?? null;
  }
  async list(request: MemoryListRequest): Promise<MemoryListResult> {
    const now = Date.now();
    const mine = this.rows.filter((r) => r.userId === request.userId && (request.includeExpired || !r.expiresAt || r.expiresAt.getTime() > now));
    const offset = request.offset ?? 0;
    const page = mine.slice(offset, offset + (request.limit ?? 20));
    return { memories: page, total: mine.length, hasMore: offset + page.length < mine.length };
  }
  async delete(request: MemoryDeleteRequest) {
    this.deletes.push(request);
    if (request.memoryIds !== undefined && request.memoryIds.length === 0) return 0;
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !(r.userId === request.userId && (!request.memoryIds || request.memoryIds.includes(r.id))));
    return before - this.rows.length;
  }
  async deleteAll(userId: string) {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.userId !== userId);
    return before - this.rows.length;
  }
  async store(): Promise<MemoryRecord[]> {
    throw new Error("L5 never stores a memory");
  }
  async update(): Promise<MemoryRecord> {
    throw new Error("L5 never updates a memory");
  }
  async recall() {
    return [];
  }
  async findSimilar() {
    return [];
  }
  async count(userId: string) {
    return this.rows.filter((r) => r.userId === userId).length;
  }
  async isAvailable() {
    return true;
  }
}

function setup(rows: MemoryRecord[] = [memory("m-1"), memory("m-2"), memory("m-3"), memory("theirs", { userId: "user-2" })]) {
  const store = new FakeStore(rows);
  const settings = new Map<string, Record<string, unknown>>();
  const audit: Array<Omit<AuditEntry, "id" | "timestamp">> = [];
  const service = new MemoryManagementService({
    store,
    control: {
      async get(userId) {
        return settings.get(userId) ?? null;
      },
      async put(userId, value) {
        settings.set(userId, value);
      },
    },
    audit: {
      async log(entry) {
        audit.push(entry);
      },
    },
  });
  return { service, store, settings, audit };
}

const v = (id: string, version = T0.toISOString()) => ({ id, version });

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

describe("L5 — list", () => {
  it("returns only the user's own memories, as safe views", async () => {
    const { service } = setup();
    const result = await service.list("user-1");

    expect(result.memories.map((m) => m.id)).toEqual(["m-1", "m-2", "m-3"]);
    expect(result.total).toBe(3);
    const text = JSON.stringify(result);
    for (const forbidden of ["secret", "embedding", "user-1", "metadata", "confidence"]) expect(text, forbidden).not.toContain(forbidden);
  });

  it("hides expired memories unless asked", async () => {
    const { service } = setup([memory("m-live"), memory("m-expired", { expiresAt: new Date("2000-01-01T00:00:00.000Z") })]);
    expect((await service.list("user-1")).memories.map((m) => m.id)).toEqual(["m-live"]);
    expect((await service.list("user-1", { includeExpired: true })).memories.map((m) => m.id)).toEqual(["m-live", "m-expired"]);
  });

  it("marks legacy memories instead of hiding them", async () => {
    const { service } = setup([memory("m-old", { sourceType: "conversation", metadata: { embedding: [0.1] } }), memory("m-new")]);
    expect((await service.list("user-1")).memories.map((m) => [m.id, m.legacy])).toEqual([
      ["m-old", true],
      ["m-new", false],
    ]);
  });

  it("looks memories up only among the user's own: a foreign id is simply absent", async () => {
    const { service } = setup();
    expect((await service.views("user-1", ["m-2", "theirs", "nope", "m-1"])).map((m) => m.id)).toEqual(["m-2", "m-1"]);
  });

  it("finds what a message taught, only for that user", async () => {
    const { service } = setup([
      memory("m-a", { sourceMessageId: "msg-7" }),
      memory("m-b", { sourceMessageId: "msg-8" }),
      memory("m-c", { sourceMessageId: "msg-7", userId: "user-2" }),
    ]);
    expect((await service.fromSourceMessage("user-1", "msg-7")).map((m) => m.id)).toEqual(["m-a"]);
  });
});

// ---------------------------------------------------------------------------
// Forget
// ---------------------------------------------------------------------------

describe("L5 — forget", () => {
  it("forgets one memory by id and version, and audits ids and counts only", async () => {
    const { service, store, audit } = setup();
    expect(await service.forget("user-1", [v("m-2")])).toEqual({ status: "FORGOTTEN", deleted: 1, notFound: 0 });
    expect(store.rows.map((r) => r.id)).toEqual(["m-1", "m-3", "theirs"]);
    expect(audit).toEqual([
      { userId: "user-1", action: "memory.forget", result: "success", metadata: { memoryIds: ["m-2"], requested: 1, deleted: 1, notFound: 0, stale: 0 } },
    ]);
  });

  it("forgets several selected memories", async () => {
    const { service, store } = setup();
    expect(await service.forget("user-1", [v("m-1"), v("m-3"), v("m-1")])).toEqual({ status: "FORGOTTEN", deleted: 2, notFound: 0 });
    expect(store.rows.map((r) => r.id)).toEqual(["m-2", "theirs"]);
  });

  it("an empty target list deletes nothing and never reaches the store", async () => {
    const { service, store } = setup();
    expect(await service.forget("user-1", [])).toEqual({ status: "NOTHING_TO_FORGET", deleted: 0 });
    expect(store.deletes).toEqual([]);
    expect(store.rows).toHaveLength(4);
  });

  it("another user's memory is NOT_FOUND — exactly like an id that never existed — and is untouched", async () => {
    const { service, store } = setup();
    const foreign = await service.forget("user-1", [v("theirs")]);
    const missing = await service.forget("user-1", [v("never-existed")]);

    expect(foreign).toEqual({ status: "NOT_FOUND", deleted: 0 });
    expect(missing).toEqual(foreign);
    expect(store.deletes).toEqual([]);
    expect(store.rows.find((r) => r.id === "theirs")).toBeDefined();
  });

  it("a stale target deletes nothing at all — not even the others in the same request — and asks for re-resolution", async () => {
    const { service, store, audit } = setup([memory("m-1"), memory("m-2", { updatedAt: new Date("2026-09-05T00:00:00.000Z") })]);
    expect(await service.forget("user-1", [v("m-1"), v("m-2")])).toEqual({ status: "STALE", deleted: 0, stale: 1 });
    expect(store.deletes).toEqual([]);
    expect(store.rows).toHaveLength(2);
    expect(audit[0]).toMatchObject({ action: "memory.forget", result: "rejected", metadata: { stale: 1, deleted: 0 } });
  });

  it("forgets what still exists and reports what did not", async () => {
    const { service, store } = setup();
    expect(await service.forget("user-1", [v("m-1"), v("gone")])).toEqual({ status: "FORGOTTEN", deleted: 1, notFound: 1 });
    expect(store.rows.map((r) => r.id)).toEqual(["m-2", "m-3", "theirs"]);
  });

  it(`refuses more than ${MEMORY_FORGET_LIMIT} targets at once`, async () => {
    const { service, store } = setup();
    const many = Array.from({ length: MEMORY_FORGET_LIMIT + 1 }, (_, i) => v(`m-${i}`));
    await expect(service.forget("user-1", many)).rejects.toThrow();
    expect(store.deletes).toEqual([]);
  });
});

describe("L5 — forget all", () => {
  it("ALL forgets every memory of the user, expired ones included — and no one else's", async () => {
    const { service, store, audit } = setup([memory("m-1"), memory("m-exp", { expiresAt: new Date("2000-01-01T00:00:00.000Z") }), memory("theirs", { userId: "user-2" })]);
    expect(await service.forgetAll("user-1", "ALL")).toEqual({ status: "FORGOTTEN", deleted: 2 });
    expect(store.rows.map((r) => r.id)).toEqual(["theirs"]);
    expect(audit).toEqual([{ userId: "user-1", action: "memory.forget_all", result: "success", metadata: { scope: "ALL", deleted: 2 } }]);
  });

  it("LEGACY forgets only the memories learned before provenance and evidence", async () => {
    const { service, store } = setup([
      memory("m-new"),
      memory("m-no-evidence", { metadata: { embedding: [0.1] } }),
      memory("m-old-source", { sourceType: "conversation" }),
      memory("theirs-old", { userId: "user-2", sourceType: "conversation" }),
    ]);
    expect(await service.forgetAll("user-1", "LEGACY")).toEqual({ status: "FORGOTTEN", deleted: 2 });
    expect(store.rows.map((r) => r.id)).toEqual(["m-new", "theirs-old"]);
  });

  it("nothing to forget is said plainly, with nothing deleted", async () => {
    const { service, store } = setup([memory("m-new")]);
    expect(await service.forgetAll("user-1", "LEGACY")).toEqual({ status: "NOTHING_TO_FORGET", deleted: 0 });
    expect(store.deletes).toEqual([]);
    expect(await service.count("user-2", "ALL")).toBe(0);
  });

  it("counts what a forget-all would remove", async () => {
    const { service } = setup([memory("m-1"), memory("m-old", { sourceType: "conversation" }), memory("theirs", { userId: "user-2" })]);
    expect(await service.count("user-1", "ALL")).toBe(2);
    expect(await service.count("user-1", "LEGACY")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Learning controls
// ---------------------------------------------------------------------------

describe("L5 — pause, resume and veto", () => {
  it("pausing stores the flag, deletes nothing, and is audited; resuming clears only the pause", async () => {
    const { service, store, settings, audit } = setup();
    await service.vetoSource("user-1", "msg-9");
    await service.pauseLearning("user-1");

    expect(await service.learningControl("user-1")).toEqual({ learningPaused: true, vetoedSourceMessageIds: ["msg-9"] });
    expect(store.deletes).toEqual([]);
    expect(store.rows).toHaveLength(4);

    await service.resumeLearning("user-1");
    expect(await service.learningControl("user-1")).toEqual({ learningPaused: false, vetoedSourceMessageIds: ["msg-9"] });
    expect(settings.get("user-2")).toBeUndefined();
    expect(audit.map((a) => a.action)).toEqual(["memory.veto", "memory.learning_pause", "memory.learning_resume"]);
  });

  it("a veto is audited without the message id", async () => {
    const { service, audit } = setup();
    await service.vetoSource("user-1", "msg-9");
    expect(JSON.stringify(audit)).not.toContain("msg-9");
  });

  it(`keeps only the newest ${MEMORY_VETO_LIMIT} vetoes`, async () => {
    const { service } = setup();
    for (let i = 0; i < MEMORY_VETO_LIMIT + 2; i++) await service.vetoSource("user-1", `msg-${i}`);
    const control = await service.learningControl("user-1");
    expect(control.vetoedSourceMessageIds).toHaveLength(MEMORY_VETO_LIMIT);
    expect(control.vetoedSourceMessageIds).not.toContain("msg-0");
  });

  it("with nothing stored, learning is on", async () => {
    const { service } = setup();
    expect(await service.learningControl("user-1")).toEqual({ learningPaused: false, vetoedSourceMessageIds: [] });
  });
});

describe("L5 — the audit trail never holds content", () => {
  it("no memory text, search phrase or source id appears in any audit row", async () => {
    const { service, audit } = setup([memory("m-1", { content: "User prefers short captions" }), memory("m-2", { content: "User works late" })]);
    await service.list("user-1");
    await service.forget("user-1", [v("m-1")]);
    await service.forgetAll("user-1", "ALL");
    await service.vetoSource("user-1", "msg-secret");
    await service.pauseLearning("user-1");

    const text = JSON.stringify(audit);
    for (const forbidden of ["captions", "works late", "msg-secret", "conv-secret", "trace-secret", "content"]) expect(text, forbidden).not.toContain(forbidden);
    expect(audit.map((a) => a.action)).toEqual(["memory.forget", "memory.forget_all", "memory.veto", "memory.learning_pause"]);
  });
});
