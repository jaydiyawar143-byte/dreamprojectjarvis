// ---------------------------------------------------------------------------
// decideApproval({ fromPendingOnly }) — the conditional write behind every
// pending-action answer (pre-PR fix after the Phase 14 re-audit).
//
// A pending action — the chat's Confirm / Cancel / Modify — is resolved only
// while it is still WAITING. Confirm already was (UPDATE … WHERE status =
// 'PENDING' AND expiresAt > now). Cancel now is too, with `fromPendingOnly`: a
// confirmed pending action is approved and run in the same request, so there
// is no moment in which cancelling it could veto anything — it could only
// contradict what already happened. Without the option, the Approvals page
// keeps its documented veto of an approved, not yet consumed approval.
//
// SAFETY. Runs only against an explicitly supplied, separate test database —
// never the development (5432) or deployment (5433) one.
// ---------------------------------------------------------------------------

import { describe, it, expect, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaApprovalRepository } from "../src/repositories/approval-repository.js";

const EXPLICIT_DATABASE_URL = process.env.DATABASE_URL;
const SAFE_TARGET = !!EXPLICIT_DATABASE_URL && !/:(?:5432|5433)\//.test(EXPLICIT_DATABASE_URL);

const prisma = SAFE_TARGET ? new PrismaClient() : null;
/** A second connection pool: a second API instance. */
const other = SAFE_TARGET ? new PrismaClient() : null;
let dbUp = false;
if (prisma && other) {
  try {
    await prisma.$queryRaw`SELECT 1`;
    await other.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}

const STAMP = Date.now();
const userIds: string[] = [];

async function newUser(tag: string): Promise<string> {
  const user = await prisma!.user.create({
    data: { email: `pending-only-${tag}-${STAMP}-${userIds.length}@jarvis-test.local`, name: `Pending-only ${tag}`, password: "not-a-real-password-hash", role: "VIEWER" },
  });
  userIds.push(user.id);
  return user.id;
}

async function waiting(userId: string): Promise<string> {
  const approval = await new PrismaApprovalRepository(prisma!).create({
    userId,
    conversationId: `conv-${STAMP}`,
    toolId: "memory.forget",
    action: "Forget 1 memory",
    params: { memoryIds: ["m-1"], versions: ["2026-10-01T00:00:00.000Z"] },
    paramsHash: "hash-1",
    riskLevel: "HIGH_IMPACT",
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
  });
  return approval.id;
}

const row = async (id: string) => (await prisma!.approval.findUnique({ where: { id }, select: { status: true, resolvedAt: true } }))!;

afterAll(async () => {
  if (dbUp && userIds.length > 0) {
    await prisma!.approval.deleteMany({ where: { userId: { in: userIds } } });
    await prisma!.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma?.$disconnect();
  await other?.$disconnect();
});

describe.skipIf(!dbUp)("decideApproval — fromPendingOnly resolves only a waiting approval (PostgreSQL)", () => {
  it("a cancel of an approval that was already granted is refused and changes nothing", async () => {
    const user = await newUser("granted");
    const id = await waiting(user);
    const repo = new PrismaApprovalRepository(prisma!);
    expect(await repo.decideApproval(id, user, "approve")).toEqual({ outcome: "approved" });
    const before = await row(id);

    expect(await repo.decideApproval(id, user, "reject", { fromPendingOnly: true })).toEqual({ outcome: "conflict", currentState: "APPROVED" });

    expect(await row(id)).toEqual(before);
  });

  it("a cancel of a waiting approval rejects it; a second cancel is not a success", async () => {
    const user = await newUser("waiting");
    const id = await waiting(user);
    const repo = new PrismaApprovalRepository(prisma!);

    expect(await repo.decideApproval(id, user, "reject", { fromPendingOnly: true })).toEqual({ outcome: "rejected" });
    expect((await repo.decideApproval(id, user, "reject", { fromPendingOnly: true })).outcome).toBe("already_rejected");
    expect((await row(id)).status).toBe("REJECTED");
  });

  it("without the option the Approvals page keeps its veto: an approved, unconsumed approval can still be rejected", async () => {
    const user = await newUser("veto");
    const id = await waiting(user);
    const repo = new PrismaApprovalRepository(prisma!);
    await repo.decideApproval(id, user, "approve");

    expect(await repo.decideApproval(id, user, "reject")).toEqual({ outcome: "rejected" });
    expect((await row(id)).status).toBe("REJECTED");
  });

  it("an approve and a pending-only cancel at once, from two connection pools, 25 times: exactly one changes the row", async () => {
    const user = await newUser("together");
    for (let trial = 0; trial < 25; trial++) {
      const id = await waiting(user);
      const [approve, cancel] = await Promise.all([
        new PrismaApprovalRepository(prisma!).decideApproval(id, user, "approve"),
        new PrismaApprovalRepository(other!).decideApproval(id, user, "reject", { fromPendingOnly: true }),
      ]);

      const won = [approve.outcome === "approved", cancel.outcome === "rejected"];
      expect(won.filter(Boolean)).toHaveLength(1);
      expect((await row(id)).status).toBe(won[0] ? "APPROVED" : "REJECTED");
    }
  });
});
