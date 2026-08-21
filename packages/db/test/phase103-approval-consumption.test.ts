// PHASE 10.3 — Atomic approval consumption + one-time execution.
// Unit tests against a faithful in-memory Prisma emulation (real-PG
// concurrency lives in the phase103-approval-pg integration suite).
import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { computeParamsHash } from "@jarvis/core";
import {
  PrismaApprovalRepository,
} from "../src/repositories/approval-repository.js";
import {
  PrismaToolExecutionRepository,
} from "../src/repositories/tool-execution-repository.js";

type ApprovalRow = {
  id: string;
  userId: string;
  agentId: string | null;
  toolId: string;
  action: string;
  params: unknown;
  paramsHash: string | null;
  status: "PENDING" | "APPROVED" | "CONSUMED" | "REJECTED" | "EXPIRED";
  expiresAt: Date;
  resolvedAt: Date | null;
  createdAt: Date;
};

type ExecRow = Record<string, unknown> & {
  executionId: string;
  status: string;
};

function cloneMap<T extends object>(m: Map<string, T>): Map<string, T> {
  return new Map([...m].map(([k, v]) => [k, { ...v }]));
}

function createMockPrismaClient() {
  const approvals = new Map<string, ApprovalRow>();
  const executions = new Map<string, ExecRow>();
  let seq = 0;

  const client = {
    approval: {
      async create({ data }: { data: Partial<ApprovalRow> }): Promise<ApprovalRow> {
        const row: ApprovalRow = {
          id: data.id ?? `appr_${++seq}`,
          userId: data.userId!,
          agentId: data.agentId ?? null,
          toolId: data.toolId!,
          action: data.action ?? "execute",
          params: data.params ?? {},
          paramsHash: data.paramsHash ?? null,
          status: data.status ?? "PENDING",
          expiresAt: data.expiresAt!,
          resolvedAt: null,
          createdAt: new Date(),
        };
        approvals.set(row.id, row);
        return row;
      },
      async findUnique({ where }: { where: { id: string } }): Promise<ApprovalRow | null> {
        return approvals.get(where.id) ?? null;
      },
      async findMany({ where }: { where?: { status?: string; userId?: string } } = {}): Promise<ApprovalRow[]> {
        let out = [...approvals.values()];
        if (where?.status) out = out.filter((r) => r.status === where.status);
        if (where?.userId) out = out.filter((r) => r.userId === where.userId);
        return out;
      },
      async updateMany({
        where,
        data,
      }: {
        where: {
          id?: string;
          userId?: string;
          toolId?: string;
          paramsHash?: string;
          status?: string | { not?: string };
          expiresAt?: { gt?: Date };
        };
        data: Partial<ApprovalRow>;
      }): Promise<{ count: number }> {
        let count = 0;
        for (const r of approvals.values()) {
          if (where.id !== undefined && r.id !== where.id) continue;
          if (where.userId !== undefined && r.userId !== where.userId) continue;
          if (where.toolId !== undefined && r.toolId !== where.toolId) continue;
          if (where.paramsHash !== undefined && r.paramsHash !== where.paramsHash) continue;
          if (typeof where.status === "string") {
            if (r.status !== where.status) continue;
          } else if (where.status?.not !== undefined && r.status === where.status.not) continue;
          if (where.expiresAt?.gt && !(r.expiresAt > where.expiresAt.gt)) continue;
          Object.assign(r, data);
          count++;
        }
        return { count };
      },
    },
    toolExecution: {
      async create({ data }: { data: Partial<ExecRow & { userId: string; toolId: string; idempotencyKey: string }> }): Promise<ExecRow> {
        const key = `${data.userId!}::${data.toolId!}::${data.idempotencyKey!}`;
        for (const r of executions.values()) {
          if (`${r.userId}::${r.toolId}::${r.idempotencyKey}` === key) {
            throw new Prisma.PrismaClientKnownRequestError("dup", {
              code: "P2002",
              clientVersion: "test",
            });
          }
        }
        const row: ExecRow = {
          executionId: `exec_${++seq}`,
          userId: data.userId!,
          toolId: data.toolId!,
          idempotencyKey: data.idempotencyKey!,
          paramsHash: data.paramsHash ?? null,
          status: data.status ?? "PENDING",
          provider: data.provider ?? null,
          externalResourceId: null,
          errorCode: null,
          errorMessage: null,
          traceId: data.traceId ?? null,
          ownerId: data.ownerId ?? null,
          leaseUntil: data.leaseUntil ?? null,
          heartbeatAt: data.heartbeatAt ?? null,
          approvalId: data.approvalId ?? null,
          createdAt: new Date(),
          startedAt: data.startedAt ?? null,
          completedAt: null,
        };
        executions.set(row.executionId as string, row);
        return row;
      },
      async findUnique({ where }: { where: { executionId: string } }): Promise<ExecRow | null> {
        return executions.get(where.executionId) ?? null;
      },
      async updateMany({
        where,
        data,
      }: {
        where: { executionId?: string; status?: string | { in?: string[] }; ownerId?: string };
        data: Partial<ExecRow>;
      }): Promise<{ count: number }> {
        let count = 0;
        for (const r of executions.values()) {
          if (where.executionId && r.executionId !== where.executionId) continue;
          if (typeof where.status === "string") {
            if (r.status !== where.status) continue;
          } else if (where.status?.in && !where.status.in.includes(r.status)) continue;
          if (where.ownerId !== undefined && r.ownerId !== where.ownerId) continue;
          Object.assign(r, data);
          count++;
        }
        return { count };
      },
    },
    // Interactive-transaction emulation with faithful ROLLBACK semantics:
    // on error the whole snapshot is restored before rethrowing.
    async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      const snapA = cloneMap(approvals);
      const snapE = cloneMap(executions);
      try {
        return await fn(client);
      } catch (err) {
        approvals.clear();
        for (const [k, v] of snapA) approvals.set(k, v);
        executions.clear();
        for (const [k, v] of snapE) executions.set(k, v);
        throw err;
      }
    },
  };
  return { client: client as unknown as PrismaClient, approvals, executions };
}

function makeFixture(opts?: { ttlMs?: number }) {
  const { client, approvals, executions } = createMockPrismaClient();
  const approvalsRepo = new PrismaApprovalRepository(client);
  const execRepo = new PrismaToolExecutionRepository(client);
  const futureIso = new Date(Date.now() + (opts?.ttlMs ?? 10 * 60_000)).toISOString();
  return { client, approvalsRepo, execRepo, approvals, executions, futureIso };
}

async function approvedExecutionSetup(f: ReturnType<typeof makeFixture>, opts?: {
  params?: Record<string, unknown>;
  legacy?: boolean;
}) {
  const params = opts?.params ?? { accountId: "act_111111111", campaignId: "100000001" };
  const approval = await f.approvalsRepo.create({
    userId: "user-1",
    toolId: "meta.campaign.pause",
    action: "pause campaign",
    params,
    paramsHash: opts?.legacy ? undefined : computeParamsHash(params),
    expiresAt: f.futureIso,
  });
  await f.approvalsRepo.updateStatus(approval.id, "approved");
  const exec = await f.execRepo.begin({
    userId: "user-1",
    toolId: "meta.campaign.pause",
    idempotencyKey: "meta.campaign.pause:act_111111111:100000001:PAUSED",
    provider: "meta-ads",
  });
  return { approval, exec, params };
}

describe("PHASE 10.3 — atomic consumption", () => {
  it("valid consumption burns the approval and claims the execution in one step", async () => {
    const f = makeFixture();
    const { approval, exec } = await approvedExecutionSetup(f);

    const res = await f.approvalsRepo.consumeForExecution({
      approvalId: approval.id,
      userId: "user-1",
      toolId: "meta.campaign.pause",
      paramsHash: computeParamsHash({ accountId: "act_111111111", campaignId: "100000001" }),
      executionId: exec.executionId,
    });

    expect(res).toEqual({ ok: true });
    expect((await f.approvalsRepo.findById(approval.id))!.status).toBe("consumed");
    expect((await f.approvalsRepo.findById(approval.id))!.resolvedAt).not.toBeNull();

    const after = await f.execRepo.getById(exec.executionId);
    expect(after!.status).toBe("EXECUTING");
    expect(after!.approvalId).toBe(approval.id); // durable audit linkage
    expect(after!.ownerId).toBeDefined();
    expect(after!.leaseUntil).toBeInstanceOf(Date);
    expect(after!.startedAt).toBeInstanceOf(Date);
  });

  it("second consumption is DENIED — approval is one-time", async () => {
    const f = makeFixture();
    const { approval, exec } = await approvedExecutionSetup(f);
    const input = {
      approvalId: approval.id,
      userId: "user-1",
      toolId: "meta.campaign.pause",
      paramsHash: computeParamsHash({ accountId: "act_111111111", campaignId: "100000001" }),
      executionId: exec.executionId,
    };

    expect(await f.approvalsRepo.consumeForExecution(input)).toEqual({ ok: true });
    const second = await f.approvalsRepo.consumeForExecution(input);
    expect(second.ok).toBe(false);
    expect(second.ok ? "" : second.reason).toContain("already consumed");
    expect(await f.approvalsRepo.findById(approval.id)!.then((a) => a!.status)).toBe("consumed");
  });

  it("paramsHash mismatch DENIES without consuming", async () => {
    const f = makeFixture();
    const { approval, exec } = await approvedExecutionSetup(f);

    const res = await f.approvalsRepo.consumeForExecution({
      approvalId: approval.id,
      userId: "user-1",
      toolId: "meta.campaign.pause",
      paramsHash: computeParamsHash({ accountId: "act_111111111", campaignId: "100000002" }),
      executionId: exec.executionId,
    });

    expect(res.ok).toBe(false);
    expect(res.ok ? "" : res.reason).toContain("hash mismatch");
    expect((await f.approvalsRepo.findById(approval.id))!.status).toBe("approved");
    expect((await f.execRepo.getById(exec.executionId))!.status).toBe("PENDING");
  });

  it("legacy approval WITHOUT paramsHash fails closed", async () => {
    const f = makeFixture();
    const { approval, exec } = await approvedExecutionSetup(f, { legacy: true });

    const res = await f.approvalsRepo.consumeForExecution({
      approvalId: approval.id,
      userId: "user-1",
      toolId: "meta.campaign.pause",
      paramsHash: computeParamsHash({ accountId: "act_111111111", campaignId: "100000001" }),
      executionId: exec.executionId,
    });

    expect(res.ok).toBe(false);
    expect((await f.approvalsRepo.findById(approval.id))!.status).toBe("approved");
  });

  it.each([
    ["different user", { override: { userId: "attacker" }, reason: "different user" }],
    ["different tool", { override: { toolId: "meta.campaign.create" }, reason: "different tool" }],
  ])("$label denies", async (_name, { override, reason }: { override: { userId?: string; toolId?: string }; reason: string }) => {
    const f = makeFixture();
    const { approval, exec } = await approvedExecutionSetup(f);

    const res = await f.approvalsRepo.consumeForExecution({
      approvalId: approval.id,
      userId: override.userId ?? "user-1",
      toolId: override.toolId ?? "meta.campaign.pause",
      paramsHash: computeParamsHash({ accountId: "act_111111111", campaignId: "100000001" }),
      executionId: exec.executionId,
    });
    expect(res.ok).toBe(false);
    expect(res.ok ? "" : res.reason).toContain(reason);
    expect((await f.approvalsRepo.findById(approval.id))!.status).toBe("approved");
  });

  it("expired approval denies", async () => {
    const f = makeFixture();
    const { approval, exec } = await approvedExecutionSetup(f);
    // Force expiry by rewriting the timestamp directly.
    const row = f.approvals.get(approval.id)!;
    row.expiresAt = new Date(Date.now() - 1000);

    const res = await f.approvalsRepo.consumeForExecution({
      approvalId: approval.id,
      userId: "user-1",
      toolId: "meta.campaign.pause",
      paramsHash: computeParamsHash({ accountId: "act_111111111", campaignId: "100000001" }),
      executionId: exec.executionId,
    });
    expect(res.ok).toBe(false);
    expect(res.ok ? "" : res.reason).toContain("expired");
  });

  it("rejected approval denies", async () => {
    const f = makeFixture();
    const { approval, exec } = await approvedExecutionSetup(f);
    await f.approvalsRepo.updateStatus(approval.id, "rejected");

    const res = await f.approvalsRepo.consumeForExecution({
      approvalId: approval.id,
      userId: "user-1",
      toolId: "meta.campaign.pause",
      paramsHash: computeParamsHash({ accountId: "act_111111111", campaignId: "100000001" }),
      executionId: exec.executionId,
    });
    expect(res.ok).toBe(false);
    expect(res.ok ? "" : res.reason).toContain("rejected");
  });

  it("pending approval denies (must be APPROVED first)", async () => {
    const f = makeFixture();
    const params = { accountId: "act_111111111", campaignId: "100000001" };
    const approval = await f.approvalsRepo.create({
      userId: "user-1",
      toolId: "meta.campaign.pause",
      action: "pause campaign",
      params,
      paramsHash: computeParamsHash(params),
      expiresAt: f.futureIso,
    });
    const exec = await f.execRepo.begin({
      userId: "user-1",
      toolId: "meta.campaign.pause",
      idempotencyKey: "k-pending",
    });

    const res = await f.approvalsRepo.consumeForExecution({
      approvalId: approval.id,
      userId: "user-1",
      toolId: "meta.campaign.pause",
      paramsHash: computeParamsHash(params),
      executionId: exec.executionId,
    });
    expect(res.ok).toBe(false);
    expect(res.ok ? "" : res.reason).toContain("pending");
  });

  it("unknown approval id denies", async () => {
    const f = makeFixture();
    const res = await f.approvalsRepo.consumeForExecution({
      approvalId: "does-not-exist",
      userId: "user-1",
      toolId: "meta.campaign.pause",
      paramsHash: "deadbeef",
      executionId: "exec-x",
    });
    expect(res.ok).toBe(false);
    expect(res.ok ? "" : res.reason).toContain("not found");
  });

  it("non-claimable execution rolls back the burn — approval NOT lost", async () => {
    const f = makeFixture();
    const { approval, exec } = await approvedExecutionSetup(f);
    // Execution already terminal: claim then succeed.
    await f.execRepo.claimForExecution(exec.executionId);
    await f.execRepo.markSucceeded(exec.executionId);

    const res = await f.approvalsRepo.consumeForExecution({
      approvalId: approval.id,
      userId: "user-1",
      toolId: "meta.campaign.pause",
      paramsHash: computeParamsHash({ accountId: "act_111111111", campaignId: "100000001" }),
      executionId: exec.executionId,
    });

    expect(res.ok).toBe(false);
    expect(res.ok ? "" : res.reason).toContain("claimable");
    // Rollback: the approval was NOT consumed.
    expect((await f.approvalsRepo.findById(approval.id))!.status).toBe("approved");
  });
});

describe("PHASE 10.3 — CONSUMED is terminal", () => {
  it("updateStatus can never resurrect a CONSUMED approval", async () => {
    const f = makeFixture();
    const { approval, exec } = await approvedExecutionSetup(f);
    await f.approvalsRepo.consumeForExecution({
      approvalId: approval.id,
      userId: "user-1",
      toolId: "meta.campaign.pause",
      paramsHash: computeParamsHash({ accountId: "act_111111111", campaignId: "100000001" }),
      executionId: exec.executionId,
    });

    for (const status of ["pending", "approved", "rejected", "expired"] as const) {
      expect(await f.approvalsRepo.updateStatus(approval.id, status)).toBeNull();
      expect((await f.approvalsRepo.findById(approval.id))!.status).toBe("consumed");
    }
  });

  it("restart recovery: fresh repository over the same store sees CONSUMED forever", async () => {
    const f = makeFixture();
    const { approval, exec } = await approvedExecutionSetup(f);
    const input = {
      approvalId: approval.id,
      userId: "user-1",
      toolId: "meta.campaign.pause",
      paramsHash: computeParamsHash({ accountId: "act_111111111", campaignId: "100000001" }),
      executionId: exec.executionId,
    };
    await f.approvalsRepo.consumeForExecution(input);

    // New process, brand-new repositories, same underlying store.
    const restartedApprovals = new PrismaApprovalRepository(f.client);
    const restartedExec = new PrismaToolExecutionRepository(f.client);

    expect((await restartedApprovals.findById(approval.id))!.status).toBe("consumed");
    // The claimed execution is owned and unclaimable by anyone else.
    expect(await restartedExec.claimForExecution(exec.executionId)).toBeNull();
    // Re-consumption attempt through the new instance still denied.
    const again = await restartedApprovals.consumeForExecution(input);
    expect(again.ok).toBe(false);
  });
});
