// S6 Phase 3 — T38: the trace-message lookup against REAL PostgreSQL.
//
// `findTraceMessages(userId, traceId, since, limit)` is the query S6 binds a
// trace to its request with. It must return ONLY the caller's messages —
// ownership through Conversation.userId — whose metadata.traceId EQUALS the
// trace id, inside the window, oldest first, at most `limit` of them.
//
// Uses dedicated users that are removed afterwards. Conversations and messages
// do not cascade from a user, so they are deleted explicitly.
// Skips automatically when the database is unreachable. Point DATABASE_URL at a
// separate test database, never the development one (AGENTS.md).
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), "../../.env") });
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaConversationRepository } from "../src/repositories/conversation-repository.js";

const prisma = new PrismaClient();

// Connectivity probe at module evaluation: describe.skipIf() decides during
// collection, before any beforeAll hook.
let dbUp = false;
try {
  await prisma.$queryRaw`SELECT 1`;
  dbUp = true;
} catch {
  dbUp = false;
}

const STAMP = Date.now();
const TRACE = `s6-trace-${STAMP}`;
const NOW = new Date();
const SINCE = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60 * 1000);

const ids: Record<string, string> = {};
const userIds: string[] = [];
const conversationIds: string[] = [];

async function message(
  key: string,
  conversationId: string,
  role: string,
  metadata: Record<string, unknown> | null,
  createdAt: Date
): Promise<void> {
  const row = await prisma.message.create({
    data: {
      conversationId,
      role,
      content: `${key} content`,
      ...(metadata ? { metadata: metadata as Prisma.InputJsonValue } : {}),
      createdAt,
    },
  });
  ids[key] = row.id;
}

beforeAll(async () => {
  if (!dbUp) return;
  const alice = await prisma.user.create({
    data: { email: `s6-alice-${STAMP}@jarvis-test.local`, name: "S6 Alice", password: "not-a-real-password-hash", role: "VIEWER" },
  });
  const bob = await prisma.user.create({
    data: { email: `s6-bob-${STAMP}@jarvis-test.local`, name: "S6 Bob", password: "not-a-real-password-hash", role: "VIEWER" },
  });
  userIds.push(alice.id, bob.id);
  ids.alice = alice.id;
  ids.bob = bob.id;

  const aliceMain = await prisma.conversation.create({ data: { userId: alice.id } });
  const aliceOther = await prisma.conversation.create({ data: { userId: alice.id } });
  const bobMain = await prisma.conversation.create({ data: { userId: bob.id } });
  conversationIds.push(aliceMain.id, aliceOther.id, bobMain.id);

  await message("request", aliceMain.id, "user", { traceId: TRACE }, minutesAgo(10));
  await message("reply", aliceMain.id, "assistant", { traceId: TRACE, model: {} }, minutesAgo(9));
  await message("otherTrace", aliceMain.id, "user", { traceId: `${TRACE}-other` }, minutesAgo(8));
  await message("nearMiss", aliceMain.id, "user", { traceId: `${TRACE}x` }, minutesAgo(7));
  await message("noMetadata", aliceMain.id, "user", null, minutesAgo(6));
  await message("tooOld", aliceMain.id, "user", { traceId: TRACE }, new Date(SINCE.getTime() - 60_000));
  await message("otherConversation", aliceOther.id, "assistant", { traceId: TRACE }, minutesAgo(5));
  await message("bobs", bobMain.id, "user", { traceId: TRACE }, minutesAgo(4));
});

afterAll(async () => {
  if (conversationIds.length > 0) {
    await prisma.message.deleteMany({ where: { conversationId: { in: conversationIds } } }).catch(() => {});
    await prisma.conversation.deleteMany({ where: { id: { in: conversationIds } } }).catch(() => {});
  }
  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }
  await prisma.$disconnect();
});

describe.skipIf(!dbUp)("S6 T38 — findTraceMessages on real PostgreSQL", () => {
  it("returns the caller's messages for the trace, across their conversations, oldest first", async () => {
    const repo = new PrismaConversationRepository(prisma);
    const found = await repo.findTraceMessages(ids.alice!, TRACE, SINCE, 10);
    expect(found.map((m) => m.id)).toEqual([ids.request, ids.reply, ids.otherConversation]);
  });

  it("never returns another user's message, even with the same trace id", async () => {
    const repo = new PrismaConversationRepository(prisma);
    const forAlice = await repo.findTraceMessages(ids.alice!, TRACE, SINCE, 10);
    const forBob = await repo.findTraceMessages(ids.bob!, TRACE, SINCE, 10);
    expect(forAlice.map((m) => m.id)).not.toContain(ids.bobs);
    expect(forBob.map((m) => m.id)).toEqual([ids.bobs]);
  });

  it("matches the trace id exactly, needs metadata, and respects the window", async () => {
    const repo = new PrismaConversationRepository(prisma);
    const found = (await repo.findTraceMessages(ids.alice!, TRACE, SINCE, 10)).map((m) => m.id);
    for (const excluded of ["otherTrace", "nearMiss", "noMetadata", "tooOld"]) {
      expect(found, excluded).not.toContain(ids[excluded]);
    }
  });

  it("honours the limit, keeping the oldest", async () => {
    const repo = new PrismaConversationRepository(prisma);
    const found = await repo.findTraceMessages(ids.alice!, TRACE, SINCE, 2);
    expect(found.map((m) => m.id)).toEqual([ids.request, ids.reply]);
  });

  it("returns the same message shape the chat route reads, metadata intact", async () => {
    const repo = new PrismaConversationRepository(prisma);
    const [request] = await repo.findTraceMessages(ids.alice!, TRACE, SINCE, 1);
    expect(request).toMatchObject({ id: ids.request, role: "user", content: "request content", metadata: { traceId: TRACE } });
    expect(Number.isNaN(Date.parse(request!.createdAt))).toBe(false);
  });
});
