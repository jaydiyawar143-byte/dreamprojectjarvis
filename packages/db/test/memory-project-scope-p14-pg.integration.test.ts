// Phase 14 — project-scoped memory, relevance ranking, the new list filters and
// the fail-closed control store, against REAL PostgreSQL + pgvector.
//
// THE ISOLATION MATRIX. Two users, three projects:
//
//   alice: personal, project A1, project A2
//   bob:   personal, project B1
//
// Every memory below has the SAME embedding, so similarity never explains why
// a memory is or is not returned — only the user and the project can.
//
//   - a personal memory is recalled in every conversation of its owner
//   - a project memory is recalled only with its own project active
//   - no project is active → no project memory at all
//   - naming another user's project selects nothing of theirs: the project id
//     is always applied beside the user id, never instead of it
//
// SAFETY. Runs only against an explicitly supplied, separate test database —
// never the development (5432) or deployment (5433) one.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { parseMemoryLearningControl } from "@jarvis/core";
import { PrismaMemoryRepository } from "../src/repositories/memory-repository.js";
import { PrismaProjectRepository } from "../src/repositories/project-repository.js";
import { PrismaConversationRepository } from "../src/repositories/conversation-repository.js";
import { PrismaPreferenceRepository } from "../src/repositories/preference-repository.js";

const EXPLICIT_DATABASE_URL = process.env.DATABASE_URL;
const SAFE_TARGET = !!EXPLICIT_DATABASE_URL && !/:(?:5432|5433)\//.test(EXPLICIT_DATABASE_URL);

const prisma = SAFE_TARGET ? new PrismaClient() : null;
let dbUp = false;
if (prisma) {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}

const STAMP = Date.now();
const DIMS = 1536;
const userIds: string[] = [];
const DAY = 86_400_000;

function unit(components: Record<number, number>): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const [i, x] of Object.entries(components)) v[Number(i)] = x;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}
/** A unit vector whose cosine similarity to the query is exactly `cos`. */
const at = (cos: number) => unit({ 0: cos, 1: Math.sqrt(1 - cos * cos) });
const QUERY = unit({ 0: 1 });

async function newUser(tag: string): Promise<string> {
  const user = await prisma!.user.create({
    data: { email: `p14-scope-${tag}-${STAMP}-${userIds.length}@jarvis-test.local`, name: `P14 ${tag}`, password: "not-a-real-password-hash", role: "VIEWER" },
  });
  userIds.push(user.id);
  return user.id;
}

function evidenceAt(when: Date, conversations = 1) {
  return { v: 1, count: conversations, conversations, firstSeenAt: when.toISOString(), lastSeenAt: when.toISOString(), sources: [], revisions: 0, previousSourceMessageIds: [] };
}

const repo = () => new PrismaMemoryRepository(prisma!);

/** A learned memory, stored through the repository's own write path. */
async function learn(
  userId: string,
  content: string,
  options: { projectId?: string; embedding?: number[]; confidence?: number; importance?: number; stated?: Date; conversations?: number; expiresAt?: Date; sourceMessageId?: string } = {}
): Promise<string> {
  const [record] = await repo().store({
    userId,
    memories: [
      {
        type: "PREFERENCE",
        content,
        importance: options.importance ?? 0.5,
        confidence: options.confidence ?? 0.7,
        sourceType: "USER",
        ...(options.sourceMessageId ? { sourceMessageId: options.sourceMessageId } : {}),
        ...(options.projectId ? { projectId: options.projectId } : {}),
        expiresAt: options.expiresAt ?? new Date(Date.now() + 90 * DAY),
        metadata: { evidence: evidenceAt(options.stated ?? new Date(), options.conversations ?? 1) },
        embedding: options.embedding ?? at(0.9),
      },
    ],
  });
  return record!.id;
}

const recall = async (userId: string, projectId?: string | null, limit = 10) =>
  (await repo().recall({ userId, query: "q", embedding: QUERY, limit, minSimilarity: 0.3, ...(projectId !== undefined ? { projectId } : {}) })).map((r) => r.memory.content);

afterAll(async () => {
  if (dbUp && userIds.length > 0) {
    await prisma!.message.deleteMany({ where: { conversation: { userId: { in: userIds } } } });
    await prisma!.conversation.deleteMany({ where: { userId: { in: userIds } } });
    await prisma!.userSetting.deleteMany({ where: { userId: { in: userIds } } });
    await prisma!.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma?.$disconnect();
});

// ---------------------------------------------------------------------------
// The isolation matrix
// ---------------------------------------------------------------------------

describe.skipIf(!dbUp)("Phase 14 — project-scoped memory isolation (PostgreSQL)", () => {
  let alice: string;
  let bob: string;
  let a1: string;
  let a2: string;
  let b1: string;

  beforeAll(async () => {
    const projects = new PrismaProjectRepository(prisma!);
    alice = await newUser("alice");
    bob = await newUser("bob");
    a1 = (await projects.create(alice, { name: "Alice One" })).id;
    a2 = (await projects.create(alice, { name: "Alice Two" })).id;
    b1 = (await projects.create(bob, { name: "Bob One" })).id;

    await learn(alice, "alice personal");
    await learn(alice, "alice project A1", { projectId: a1 });
    await learn(alice, "alice project A2", { projectId: a2 });
    await learn(bob, "bob personal");
    await learn(bob, "bob project B1", { projectId: b1 });
  });

  it("with no active project, only personal memories are recalled", async () => {
    expect((await recall(alice)).sort()).toEqual(["alice personal"]);
    expect((await recall(alice, null)).sort()).toEqual(["alice personal"]);
    expect((await recall(bob)).sort()).toEqual(["bob personal"]);
  });

  it("a project's memories are recalled only with that project active — beside the personal ones", async () => {
    expect((await recall(alice, a1)).sort()).toEqual(["alice personal", "alice project A1"]);
    expect((await recall(alice, a2)).sort()).toEqual(["alice personal", "alice project A2"]);
    expect((await recall(bob, b1)).sort()).toEqual(["bob personal", "bob project B1"]);
  });

  it("one project's memory never reaches another project of the same user", async () => {
    expect(await recall(alice, a1)).not.toContain("alice project A2");
    expect(await recall(alice, a2)).not.toContain("alice project A1");
  });

  it("a forged project id selects nothing of its real owner's: it is applied beside the user id", async () => {
    // Bob names Alice's project; Alice names Bob's.
    expect((await recall(bob, a1)).sort()).toEqual(["bob personal"]);
    expect((await recall(alice, b1)).sort()).toEqual(["alice personal"]);
    // And a project that does not exist is simply no project.
    expect((await recall(alice, "no-such-project")).sort()).toEqual(["alice personal"]);
  });

  it("findSimilar — what dedup compares against — looks in exactly one scope", async () => {
    const similar = async (userId: string, projectId: string | null) => (await repo().findSimilar(userId, QUERY, 0.3, 10, { projectId })).map((m) => m.content).sort();

    expect(await similar(alice, null)).toEqual(["alice personal"]);
    expect(await similar(alice, a1)).toEqual(["alice project A1"]);
    expect(await similar(alice, a2)).toEqual(["alice project A2"]);
    expect(await similar(bob, a1)).toEqual([]);
    // Without a scope it is the user's own memories, and still never another user's.
    expect((await repo().findSimilar(alice, QUERY, 0.3, 10)).map((m) => m.content).sort()).toEqual(["alice personal", "alice project A1", "alice project A2"]);
  });

  it("list() applies each scope, always inside the user's own memories", async () => {
    const list = async (userId: string, scope?: Parameters<PrismaMemoryRepository["list"]>[0]["scope"]) =>
      (await repo().list({ userId, limit: 50, ...(scope ? { scope } : {}) })).memories.map((m) => m.content).sort();

    expect(await list(alice)).toEqual(["alice personal", "alice project A1", "alice project A2"]);
    expect(await list(alice, { kind: "PERSONAL" })).toEqual(["alice personal"]);
    expect(await list(alice, { kind: "PROJECT", projectId: a1 })).toEqual(["alice project A1"]);
    expect(await list(alice, { kind: "VISIBLE_IN", projectId: a1 })).toEqual(["alice personal", "alice project A1"]);
    expect(await list(alice, { kind: "VISIBLE_IN", projectId: null })).toEqual(["alice personal"]);
    // Forged.
    expect(await list(bob, { kind: "PROJECT", projectId: a1 })).toEqual([]);
    expect(await list(bob, { kind: "VISIBLE_IN", projectId: a1 })).toEqual(["bob personal"]);
  });

  it("a memory carries its project, and an update never moves it", async () => {
    const [stored] = (await repo().list({ userId: alice, limit: 50, scope: { kind: "PROJECT", projectId: a1 } })).memories;
    expect(stored!.projectId).toBe(a1);

    const updated = await repo().update({ userId: alice, memoryId: stored!.id, content: "alice project A1", confidence: 0.8, embedding: at(0.9) });
    expect(updated.projectId).toBe(a1);
    expect((await recall(alice, a2)).sort()).toEqual(["alice personal", "alice project A2"]);
  });

  it("the database itself refuses a memory in a project its user does not own", async () => {
    const before = await prisma!.memory.count({ where: { userId: bob } });

    // Bob's memory, tagged with Alice's project.
    await expect(learn(bob, "bob in alice's project", { projectId: a1 })).rejects.toThrow();

    expect(await prisma!.memory.count({ where: { userId: bob } })).toBe(before);
    expect(await recall(alice, a1)).not.toContain("bob in alice's project");
  });
});

// ---------------------------------------------------------------------------
// Projects and conversations
// ---------------------------------------------------------------------------

describe.skipIf(!dbUp)("Phase 14 — projects and the conversations in them (PostgreSQL)", () => {
  it("a project is found only by its owner; another user's is the same as an unknown one", async () => {
    const projects = new PrismaProjectRepository(prisma!);
    const carol = await newUser("carol");
    const dave = await newUser("dave");
    const project = await projects.create(carol, { name: "  Campaign   X ", description: " Spring launch " });

    expect(project).toMatchObject({ userId: carol, name: "Campaign X", description: "Spring launch" });
    expect(await projects.findOwned(carol, project.id)).toMatchObject({ id: project.id });
    expect(await projects.findOwned(dave, project.id)).toBeNull();
    expect(await projects.findOwned(carol, "no-such-project")).toBeNull();
    expect((await projects.list(carol)).map((p) => p.name)).toEqual(["Campaign X"]);
    expect(await projects.list(dave)).toEqual([]);
  });

  it("refuses an empty name and a second project with the same name", async () => {
    const projects = new PrismaProjectRepository(prisma!);
    const erin = await newUser("erin");
    await projects.create(erin, { name: "Alpha" });

    await expect(projects.create(erin, { name: "Alpha" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(projects.create(erin, { name: "   " })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(projects.create(erin, { name: "x".repeat(81) })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    // The same name is fine for someone else.
    const frank = await newUser("frank");
    expect((await projects.create(frank, { name: "Alpha" })).name).toBe("Alpha");
  });

  it("a conversation takes one of its user's own projects, and cannot take anyone else's", async () => {
    const projects = new PrismaProjectRepository(prisma!);
    const conversations = new PrismaConversationRepository(prisma!);
    const gina = await newUser("gina");
    const hank = await newUser("hank");
    const project = await projects.create(gina, { name: "Gina's" });

    const inProject = await conversations.create({ userId: gina, projectId: project.id });
    expect(inProject.projectId).toBe(project.id);
    expect((await conversations.findByIdAndUserId(inProject.id, gina))!.projectId).toBe(project.id);

    const personal = await conversations.create({ userId: gina });
    expect(personal.projectId).toBeNull();

    // Hank names Gina's project: the create fails, and nothing is left behind.
    await expect(conversations.create({ userId: hank, projectId: project.id })).rejects.toThrow();
    expect(await prisma!.conversation.count({ where: { userId: hank } })).toBe(0);
  });

  it("the memory screen's conversation is created once, and a message is found only by its owner", async () => {
    const conversations = new PrismaConversationRepository(prisma!);
    const ivy = await newUser("ivy");
    const jack = await newUser("jack");

    const first = await conversations.findOrCreateTitled(ivy, "Memory controls");
    const second = await conversations.findOrCreateTitled(ivy, "Memory controls");
    expect(second.id).toBe(first.id);
    expect(first.projectId).toBeNull();

    const message = await conversations.addMessage({ conversationId: first.id, role: "user", content: "I prefer light mode" });
    expect(await conversations.findMessageOwned(ivy, message.id)).toMatchObject({ id: message.id, role: "user", content: "I prefer light mode", conversationId: first.id });
    expect(await conversations.findMessageOwned(jack, message.id)).toBeNull();
    expect(await conversations.findMessageOwned(ivy, "no-such-message")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Relevance ranking
// ---------------------------------------------------------------------------

describe.skipIf(!dbUp)("Phase 14 — recall is ranked by the relevance score (PostgreSQL)", () => {
  it("returns the score and all four of its parts", async () => {
    const user = await newUser("parts");
    await learn(user, "scored", { embedding: at(0.8), confidence: 0.8, importance: 0.6, conversations: 2 });

    const [result] = await repo().recall({ userId: user, query: "q", embedding: QUERY, limit: 5, minSimilarity: 0.3 });

    expect(result!.semanticScore).toBeCloseTo(0.8, 5);
    expect(result!.recencyScore).toBe(1);
    expect(result!.confidenceScore).toBe(0.8);
    expect(result!.importanceScore).toBe(0.6);
    expect(result!.finalScore).toBeCloseTo(0.7 * 0.8 + 0.1 * 1 + 0.1 * 0.8 + 0.1 * 0.6, 5);
  });

  it("between memories about equally similar, the one stated recently and often comes first", async () => {
    const user = await newUser("tie");
    // The stale one is slightly MORE similar: cosine alone would put it first.
    await learn(user, "stale: weekly reports", { embedding: at(0.62), confidence: 0.55, stated: new Date(Date.now() - 80 * DAY) });
    await learn(user, "fresh: monthly reports", { embedding: at(0.6), confidence: 0.9, conversations: 3 });

    expect(await recall(user)).toEqual(["fresh: monthly reports", "stale: weekly reports"]);
  });

  it("a clearly more similar memory still wins, however weak its other signals", async () => {
    const user = await newUser("dominance");
    await learn(user, "relevant but weak", { embedding: at(0.9), confidence: 0.55, importance: 0, stated: new Date(Date.now() - 85 * DAY) });
    await learn(user, "strong but barely related", { embedding: at(0.35), confidence: 0.95, importance: 1, conversations: 4 });

    expect(await recall(user)).toEqual(["relevant but weak", "strong but barely related"]);
  });

  it("no score brings a memory below the similarity floor into the result", async () => {
    const user = await newUser("floor");
    await learn(user, "irrelevant, however confident", { embedding: at(0.1), confidence: 0.95, importance: 1, conversations: 4 });

    expect(await recall(user)).toEqual([]);
  });

  it("ranks a bounded pool and returns no more than the limit — the best ones, not merely the nearest", async () => {
    const user = await newUser("pool");
    // Twelve near-identical-similarity memories; the three stated most often
    // are slightly LESS similar than the rest.
    for (let i = 0; i < 9; i++) await learn(user, `ordinary ${i}`, { embedding: at(0.7), confidence: 0.55, stated: new Date(Date.now() - 70 * DAY) });
    for (let i = 0; i < 3; i++) await learn(user, `confirmed ${i}`, { embedding: at(0.69), confidence: 0.95, conversations: 4 });

    const top = await recall(user, null, 3);
    expect(top).toHaveLength(3);
    expect(top.sort()).toEqual(["confirmed 0", "confirmed 1", "confirmed 2"]);
  });

  it("an expired memory is never recalled, whatever it would score", async () => {
    const user = await newUser("expired");
    await learn(user, "expired", { embedding: at(0.99), confidence: 0.95, expiresAt: new Date(Date.now() - 1000) });
    await learn(user, "current", { embedding: at(0.5) });

    expect(await recall(user)).toEqual(["current"]);
  });
});

// ---------------------------------------------------------------------------
// list() filters, and the retention sweep's one cross-user read
// ---------------------------------------------------------------------------

describe.skipIf(!dbUp)("Phase 14 — list filters and expired-user lookup (PostgreSQL)", () => {
  it("search matches content case-insensitively, inside the user's own memories only", async () => {
    const mine = await newUser("search-mine");
    const theirs = await newUser("search-theirs");
    await learn(mine, "I prefer Short Captions");
    await learn(mine, "I work in Balaghat");
    await learn(theirs, "I prefer short captions too");

    const found = await repo().list({ userId: mine, limit: 50, search: "short captions" });
    expect(found.memories.map((m) => m.content)).toEqual(["I prefer Short Captions"]);
    expect(found.total).toBe(1);
    // A LIKE wildcard is text, not a pattern.
    expect((await repo().list({ userId: mine, limit: 50, search: "%" })).total).toBe(0);
  });

  it("sourceMessageId finds what one message taught, without scanning the rest", async () => {
    const user = await newUser("source");
    await learn(user, "from message one", { sourceMessageId: "msg-one" });
    await learn(user, "from message two", { sourceMessageId: "msg-two" });

    const found = await repo().list({ userId: user, limit: 50, includeExpired: true, sourceMessageId: "msg-one" });
    expect(found.memories.map((m) => m.content)).toEqual(["from message one"]);
  });

  it("expiredBefore selects only memories that expired before that instant", async () => {
    const user = await newUser("expired-before");
    await learn(user, "expired long ago", { expiresAt: new Date(Date.now() - 40 * DAY) });
    await learn(user, "expired recently", { expiresAt: new Date(Date.now() - 5 * DAY) });
    await learn(user, "still current");

    const cutoff = new Date(Date.now() - 30 * DAY);
    const found = await repo().list({ userId: user, limit: 50, includeExpired: true, expiredBefore: cutoff });
    expect(found.memories.map((m) => m.content)).toEqual(["expired long ago"]);
  });

  it("usersWithExpiredMemories returns ids of users with a row expired before the cutoff, bounded", async () => {
    const due = await newUser("sweep-due");
    const notDue = await newUser("sweep-not-due");
    const none = await newUser("sweep-none");
    await learn(due, "long expired", { expiresAt: new Date(Date.now() - 40 * DAY) });
    await learn(notDue, "recently expired", { expiresAt: new Date(Date.now() - 5 * DAY) });
    await learn(none, "current");

    const cutoff = new Date(Date.now() - 30 * DAY);
    const found = await repo().usersWithExpiredMemories(cutoff, 500);
    expect(found).toContain(due);
    expect(found).not.toContain(notDue);
    expect(found).not.toContain(none);
    expect(await repo().usersWithExpiredMemories(cutoff, 0)).toEqual([]);
    expect((await repo().usersWithExpiredMemories(cutoff, 1)).length).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// The memory-control store fails closed
// ---------------------------------------------------------------------------

describe.skipIf(!dbUp)("Phase 14 — a corrupt memory-control document is unreadable, not absent (PostgreSQL)", () => {
  const key = "prefs:memory";
  const strict = () => new PrismaPreferenceRepository(prisma!, key, "unreadable");

  it("no document: the defaults — learning on, no vetoes", async () => {
    const user = await newUser("control-absent");
    expect(await strict().get(user)).toBeNull();
    expect(parseMemoryLearningControl(await strict().get(user))).toEqual({ learningPaused: false, vetoedSourceMessageIds: [] });
  });

  it("a valid document is read as written", async () => {
    const user = await newUser("control-valid");
    await strict().put(user, { v: 1, learningPaused: false, vetoedSourceMessageIds: ["msg-1"] });
    expect(parseMemoryLearningControl(await strict().get(user))).toEqual({ learningPaused: false, vetoedSourceMessageIds: ["msg-1"] });
  });

  it.each([
    ["not JSON at all", "{{{ not json"],
    ["truncated JSON", '{"v":1,"learningPaused":false,"vetoedSourceMessageIds":["msg-1"'],
    ["a JSON string", '"learning on"'],
    ["a JSON number", "1"],
    ["null", "null"],
    ["empty", ""],
  ])("%s reads as PAUSED — it used to read as 'learning on, no vetoes'", async (_name, value) => {
    const user = await newUser("control-corrupt");
    await prisma!.userSetting.create({ data: { userId: user, key, value } });

    const stored = await strict().get(user);
    expect(stored).not.toBeNull();
    expect(parseMemoryLearningControl(stored).learningPaused).toBe(true);
  });

  it("the dashboard's preferences still degrade to defaults: that store is unchanged", async () => {
    const user = await newUser("control-dashboard");
    await prisma!.userSetting.create({ data: { userId: user, key: "prefs:command-center", value: "{{{ not json" } });
    expect(await new PrismaPreferenceRepository(prisma!).get(user)).toBeNull();
  });
});
