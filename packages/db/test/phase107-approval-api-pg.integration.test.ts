// PHASE 10.7 — approval decision semantics on real PostgreSQL.
// Skipped when DB is down. Proves the DURABLE layer (not just fakes):
//  1. Concurrent decideApproval('approve') ×N → exactly one winner; every
//     loser deterministically CONFLICT (PostgreSQL row-level atomicity).
//  2. Expired-but-PENDING approve classifies as EXPIRED (regression: it used
//     to fall through to loser-classification and misreport as CONFLICT).
//  3. Approve-after-reject is denied; reject is idempotent.
//  4. Reject can veto an APPROVED-not-yet-consumed approval; after atomic
//     consumption, retroactive reject is refused (already_consumed).
//  5. listByUser is user-scoped, paginated, and lazily reports expired rows
//     under the "expired" filter while hiding them from "pending".
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), "../../.env") });
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaApprovalRepository } from "../src/repositories/approval-repository.js";
import { PrismaToolExecutionRepository } from "../src/repositories/tool-execution-repository.js";
import { computeParamsHash } from "@jarvis/core";

const prisma = new PrismaClient();

let dbUp = false;
try {
  await prisma.$queryRaw`SELECT 1`;
  dbUp = true;
} catch {
  dbUp = false;
}

let userAId: string | null = null;
let userBId: string | null = null;
const createdApprovalIds: string[] = [];
const createdExecutionIds: string[] = [];

beforeAll(async () => {
  if (!dbUp) return;
  const suffix = Date.now();
  const a = await prisma.user.create({
    data: {
      email: `phase107-pgtest-${suffix}@jarvis-test.local`,
      name: "Phase 10.7 Approval Test A",
      password: "not-a-real-password-hash",
      role: "VIEWER",
    },
  });
  const b = await prisma.user.create({
    data: {
      email: `phase107-pgtest-b-${suffix}@jarvis-test.local`,
      name: "Phase 10.7 Approval Test B",
      password: "not-a-real-password-hash",
      role: "VIEWER",
    },
  });
  userAId = a.id;
  userBId = b.id;
});

afterAll(async () => {
  if (dbUp) {
    // Explicit cleanup (same pattern as Phase 10.3/10.6 lessons: never rely
    // on cross-model cascades under parallel suites).
    if (createdApprovalIds.length) {
      await prisma.approval
        .deleteMany({ where: { id: { in: createdApprovalIds } } })
        .catch(() => {});
    }
    if (createdExecutionIds.length) {
      await prisma.toolExecution
        .deleteMany({ where: { executionId: { in: createdExecutionIds } } })
        .catch(() => {});
    }
    for (const id of [userAId, userBId]) {
      if (id) {
        await prisma.approval.deleteMany({ where: { userId: id } }).catch(() => {});
        await prisma.toolExecution.deleteMany({ where: { userId: id } }).catch(() => {});
        await prisma.user.delete({ where: { id } }).catch(() => {});
      }
    }
  }
  await prisma.$disconnect();
});

function makeRepo() {
  return {
    approvals: new PrismaApprovalRepository(prisma),
    executions: new PrismaToolExecutionRepository(prisma),
  };
}

async function seedApproval(
  repo: ReturnType<typeof makeRepo>["approvals"],
  userId: string,
  opts?: { ttlMs?: number }
) {
  const params = {
    accountId: "act_111111111",
    name: `PG Probe ${Math.random().toString(36).slice(2, 8)}`,
    dailyBudget: 25,
  };
  const approval = await repo.create({
    userId,
    toolId: "meta.campaign.create",
    action: "execute",
    params,
    paramsHash: computeParamsHash(params),
    expiresAt: new Date(
      Date.now() + (opts?.ttlMs ?? 10 * 60 * 1000)
    ).toISOString(),
  });
  createdApprovalIds.push(approval.id);
  return approval;
}

describe.skipIf(!dbUp)("PHASE 10.7 — PG approval decisions", () => {
  it("1. concurrent approves — exactly one winner, all losers CONFLICT", async () => {
    const { approvals } = makeRepo();
    const approval = await seedApproval(approvals, userAId!);

    const N = 10;
    const outcomes = await Promise.all(
      Array.from({ length: N }, () =>
        approvals.decideApproval(approval.id, userAId!, "approve")
      )
    );

    const winners = outcomes.filter((o) => o.outcome === "approved");
    const conflicts = outcomes.filter(
      (o) => o.outcome === "conflict" && o.currentState === "APPROVED"
    );
    expect(winners.length).toBe(1);
    expect(conflicts.length).toBe(N - 1);
  });

  it("2. expired-PENDING approve classifies EXPIRED (not conflict)", async () => {
    const { approvals } = makeRepo();
    const approval = await seedApproval(approvals, userAId!, { ttlMs: -1000 });

    const result = await approvals.decideApproval(
      approval.id,
      userAId!,
      "approve"
    );
    expect(result.outcome).toBe("expired");
  });

  it("3. approve-after-reject denied; repeated reject idempotent", async () => {
    const { approvals } = makeRepo();
    const a1 = await seedApproval(approvals, userAId!);

    const rejected = await approvals.decideApproval(a1.id, userAId!, "reject");
    expect(rejected.outcome).toBe("rejected");

    const approveAfterReject = await approvals.decideApproval(
      a1.id,
      userAId!,
      "approve"
    );
    expect(approveAfterReject.outcome).toBe("already_rejected");

    const rejectAgain = await approvals.decideApproval(a1.id, userAId!, "reject");
    expect(rejectAgain).toMatchObject({
      outcome: "already_rejected",
      idempotent: true,
    });

    const a2 = await seedApproval(approvals, userAId!);
    await approvals.decideApproval(a2.id, userAId!, "approve");
    const veto = await approvals.decideApproval(a2.id, userAId!, "reject");
    expect(veto.outcome).toBe("rejected"); // veto before consume is legal
  });

  it("4. reject after atomic CONSUMPTION refused retroactively", async () => {
    const { approvals, executions } = makeRepo();

    const params = {
      accountId: "act_111111111",
      name: "Consume-then-reject probe",
      dailyBudget: 30,
    };
    const approval = await approvals.create({
      userId: userAId!,
      toolId: "meta.campaign.create",
      action: "execute",
      params,
      paramsHash: computeParamsHash(params),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
    createdApprovalIds.push(approval.id);

    await approvals.decideApproval(approval.id, userAId!, "approve");

    const exec = await executions.begin({
      userId: userAId!,
      toolId: "meta.campaign.create",
      idempotencyKey: `pg107-consume:${Date.now()}:${Math.random()
        .toString(36)
        .slice(2)}`,
      paramsHash: computeParamsHash(params),
      provider: "meta-ads",
    });
    createdExecutionIds.push(exec.executionId);

    // Long lease per the parallel-suite lesson (>30min recovery scans).
    const consumed = await approvals.consumeForExecution(
      {
        approvalId: approval.id,
        userId: userAId!,
        toolId: "meta.campaign.create",
        paramsHash: computeParamsHash(params),
        executionId: exec.executionId,
      },
      { ownerId: "pg107-worker", leaseMs: 120 * 60 * 1000 }
    );
    expect(consumed.ok).toBe(true);

    const retroReject = await approvals.decideApproval(
      approval.id,
      userAId!,
      "reject"
    );
    expect(retroReject.outcome).toBe("already_consumed");

    // Double consumption also denied with zero side effects.
    const exec2 = await executions.begin({
      userId: userAId!,
      toolId: "meta.campaign.create",
      idempotencyKey: `pg107-replay:${Date.now()}:${Math.random()
        .toString(36)
        .slice(2)}`,
      paramsHash: computeParamsHash(params),
      provider: "meta-ads",
    });
    createdExecutionIds.push(exec2.executionId);
    const replay = await approvals.consumeForExecution(
      {
        approvalId: approval.id,
        userId: userAId!,
        toolId: "meta.campaign.create",
        paramsHash: computeParamsHash(params),
        executionId: exec2.executionId,
      },
      { ownerId: "pg107-worker" }
    );
    expect(replay.ok).toBe(false);
    expect(replay.reason).toContain("consumed");
    const exec2After = await prisma.toolExecution.findUnique({
      where: { executionId: exec2.executionId },
    });
    expect(exec2After!.status).toBe("PENDING"); // rollback left claim untouched
  });

  it("5. foreign user decisions are FORBIDDEN at the durable layer too", async () => {
    const { approvals } = makeRepo();
    const approval = await seedApproval(approvals, userAId!);
    const result = await approvals.decideApproval(
      approval.id,
      userBId!,
      "approve"
    );
    expect(result.outcome).toBe("forbidden");
  });

  it("6. listByUser scoping, pagination and lazy-expiry reporting", async () => {
    const { approvals } = makeRepo();
    // Deltas (not absolute counts): earlier tests in this suite share the
    // fixture user, so assertions must be independent of execution order.
    const beforeA = await approvals.listByUser(userAId!, { limit: 100 });
    const expiredBeforeCount = (
      await approvals.listByUser(userAId!, { status: "expired", limit: 100 })
    ).total;
    const pendingBeforeCount = (
      await approvals.listByUser(userAId!, { status: "pending", limit: 100 })
    ).total;
    const beforeBPending = await approvals.listByUser(userBId!, {
      status: "pending",
      limit: 100,
    });

    // 3 live + 1 expired for A; 1 live for B.
    for (let i = 0; i < 3; i++) await seedApproval(approvals, userAId!);
    await seedApproval(approvals, userAId!, { ttlMs: -1000 });
    const bOnly = await seedApproval(approvals, userBId!);

    const afterAllRows = await approvals.listByUser(userAId!, { limit: 100 });
    expect(afterAllRows.total).toBe(beforeA.total + 4);

    // Pagination is server-enforced regardless of total volume.
    const page1 = await approvals.listByUser(userAId!, { page: 1, limit: 2 });
    expect(page1.items.length).toBe(2);
    expect(page1.total).toBe(beforeA.total + 4);

    const pendingView = await approvals.listByUser(userAId!, {
      status: "pending",
      limit: 100,
    });
    expect(pendingView.total).toBe(pendingBeforeCount + 3);

    const expiredView = await approvals.listByUser(userAId!, {
      status: "expired",
      limit: 100,
    });
    expect(expiredView.total).toBe(expiredBeforeCount + 1);
    expect(
      expiredView.items.some((a) => a.id === createdApprovalIds.at(-2))
    ).toBe(true);

    const forB = await approvals.listByUser(userBId!, {
      status: "pending",
      limit: 100,
    });
    expect(forB.total).toBe(beforeBPending.total + 1);
    expect(forB.items.map((a) => a.id)).toContain(bOnly.id);
  });
});
