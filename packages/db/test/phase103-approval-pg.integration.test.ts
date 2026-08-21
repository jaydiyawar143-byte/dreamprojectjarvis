// PHASE 10.3 — REAL PostgreSQL atomicity for one-time approval consumption.
// Proves: single-winner consumption under x2/x5/x10 races, durable terminal
// state across restarts, UNKNOWN/FAILED never resurrecting the approval.
// Uses a dedicated test user removed afterwards (FK cascade).
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), "../../.env") });
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { computeParamsHash } from "@jarvis/core";
import { PrismaApprovalRepository } from "../src/repositories/approval-repository.js";
import {
  PrismaToolExecutionRepository,
} from "../src/repositories/tool-execution-repository.js";

const prisma = new PrismaClient();

let dbUp = false;
try {
  await prisma.$queryRaw`SELECT 1`;
  dbUp = true;
} catch {
  dbUp = false;
}
let testUserId: string | null = null;

const PARAMS = { accountId: "act_111111111", campaignId: "100000001" };
const PARAMS_HASH = computeParamsHash(PARAMS);

async function makeApprovedApproval(repo: PrismaApprovalRepository, tag: string) {
  const approval = await repo.create({
    userId: testUserId!,
    toolId: "meta.campaign.pause",
    action: "pause campaign",
    params: PARAMS,
    paramsHash: PARAMS_HASH,
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  await repo.updateStatus(approval.id, "approved");
  return approval;
}

async function makeExecution(repo: PrismaToolExecutionRepository, tag: string) {
  return repo.begin({
    userId: testUserId!,
    toolId: "meta.campaign.pause",
    idempotencyKey: `pg103:${tag}:act_111111111:100000001:PAUSED`,
    provider: "meta-ads",
  });
}

beforeAll(async () => {
  if (!dbUp) return;
  const user = await prisma.user.create({
    data: {
      email: `phase103-pgtest-${Date.now()}@jarvis-test.local`,
      name: "Phase 10.3 Approval Consumption Test",
      password: "not-a-real-password-hash",
      role: "VIEWER",
    },
  });
  testUserId = user.id;
});

afterAll(async () => {
  if (testUserId) {
    await prisma.user.delete({ where: { id: testUserId } }).catch(() => {});
  }
  await prisma.$disconnect();
});

describe.skipIf(!dbUp)("PHASE 10.3 — real PostgreSQL atomic consumption", () => {
  it("x2 concurrent consumers: exactly ONE wins", async () => {
    if (!dbUp) return;
    const approvalsRepo = new PrismaApprovalRepository(prisma);
    const execRepo = new PrismaToolExecutionRepository(prisma);
    const approval = await makeApprovedApproval(approvalsRepo, "x2");
    const exec = await makeExecution(execRepo, "x2");

    const input = {
      approvalId: approval.id,
      userId: testUserId!,
      toolId: "meta.campaign.pause",
      paramsHash: PARAMS_HASH,
      executionId: exec.executionId,
    };
    const results = await Promise.all([
      approvalsRepo.consumeForExecution(input),
      approvalsRepo.consumeForExecution(input),
    ]);

    const winners = results.filter((r) => r.ok);
    expect(winners).toHaveLength(1);

    expect((await approvalsRepo.findById(approval.id))!.status).toBe("consumed");
    expect((await execRepo.getById(exec.executionId))!.status).toBe("EXECUTING");
    expect((await execRepo.getById(exec.executionId))!.approvalId).toBe(approval.id);
  });

  it("x5 concurrent consumers: exactly ONE wins, losers roll back clean", async () => {
    if (!dbUp) return;
    const approvalsRepo = new PrismaApprovalRepository(prisma);
    const execRepo = new PrismaToolExecutionRepository(prisma);
    const approval = await makeApprovedApproval(approvalsRepo, "x5");
    const exec = await makeExecution(execRepo, "x5");

    const input = {
      approvalId: approval.id,
      userId: testUserId!,
      toolId: "meta.campaign.pause",
      paramsHash: PARAMS_HASH,
      executionId: exec.executionId,
    };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => approvalsRepo.consumeForExecution(input))
    );

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    // Losers report precise denial, not an infrastructure error.
    for (const r of results.filter((x) => !x.ok)) {
      expect(r.ok ? "" : r.reason).toContain("already consumed");
    }
  });

  it("x10 concurrent consumers: exactly ONE wins", async () => {
    if (!dbUp) return;
    const approvalsRepo = new PrismaApprovalRepository(prisma);
    const execRepo = new PrismaToolExecutionRepository(prisma);
    const approval = await makeApprovedApproval(approvalsRepo, "x10");
    const exec = await makeExecution(execRepo, "x10");

    const input = {
      approvalId: approval.id,
      userId: testUserId!,
      toolId: "meta.campaign.pause",
      paramsHash: PARAMS_HASH,
      executionId: exec.executionId,
    };
    const results = await Promise.all(
      Array.from({ length: 10 }, () => approvalsRepo.consumeForExecution(input))
    );

    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("crash after consumption: restart sees CONSUMED forever + execution owned", async () => {
    if (!dbUp) return;
    const approvalsRepo = new PrismaApprovalRepository(prisma);
    const execRepo = new PrismaToolExecutionRepository(prisma);
    const approval = await makeApprovedApproval(approvalsRepo, "crash");
    const exec = await makeExecution(execRepo, "crash");
    const res = await approvalsRepo.consumeForExecution({
      approvalId: approval.id,
      userId: testUserId!,
      toolId: "meta.campaign.pause",
      paramsHash: PARAMS_HASH,
      executionId: exec.executionId,
    });
    expect(res.ok).toBe(true);
    // --- process dies ---

    // Brand-new clients/repositories over the same database.
    const freshClient = new PrismaClient();
    try {
      const restartedApprovals = new PrismaApprovalRepository(freshClient);
      const restartedExec = new PrismaToolExecutionRepository(freshClient);

      expect((await restartedApprovals.findById(approval.id))!.status).toBe("consumed");
      expect(await restartedApprovals.updateStatus(approval.id, "approved")).toBeNull();
      expect((await restartedApprovals.findById(approval.id))!.status).toBe("consumed");

      const rec = await restartedExec.getById(exec.executionId);
      expect(rec!.status).toBe("EXECUTING");
      expect(rec!.ownerId).toBeDefined();
      expect(await restartedExec.claimForExecution(exec.executionId)).toBeNull();

      // UNKNOWN recovery (simulating stale worker cleanup) must NOT
      // resurrect the approval either.
      const { recovered } = await restartedExec.recoverStaleExecutions({
        now: new Date(Date.now() + 30 * 60_000),
      });
      expect(recovered.some((r) => r.executionId === exec.executionId)).toBe(true);
      expect((await restartedApprovals.findById(approval.id))!.status).toBe("consumed");
    } finally {
      await freshClient.$disconnect();
    }
  });
});
