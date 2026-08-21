// PHASE 10.2 — Durable execution ownership: lease, heartbeat, stale scan,
// idempotent crash recovery. Runs against a faithful in-memory emulation of
// the Prisma ToolExecution delegate (real-PG coverage lives in the
// phase102-concurrency-pg integration suite).
import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { PrismaToolExecutionRepository } from "../src/repositories/tool-execution-repository.js";

interface Row {
  executionId: string;
  userId: string;
  toolId: string;
  idempotencyKey: string;
  paramsHash: string | null;
  status: string;
  provider: string | null;
  externalResourceId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  traceId: string | null;
  ownerId: string | null;
  leaseUntil: Date | null;
  heartbeatAt: Date | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

function composite(w: { userId: string; toolId: string; idempotencyKey: string }): string {
  return `${w.userId}::${w.toolId}::${w.idempotencyKey}`;
}

function createMockPrismaClient() {
  const rows = new Map<string, Row>();
  let seq = 0;
  const client = {
    toolExecution: {
      async create({ data }: { data: Partial<Row> }): Promise<Row> {
        const key = composite({
          userId: data.userId!,
          toolId: data.toolId!,
          idempotencyKey: data.idempotencyKey!,
        });
        if (rows.has(key)) {
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
            code: "P2002",
            clientVersion: "test",
          });
        }
        const row: Row = {
          executionId: data.executionId ?? `exec_${++seq}`,
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
          ownerId: null,
          leaseUntil: null,
          heartbeatAt: null,
          createdAt: new Date(),
          startedAt: null,
          completedAt: null,
        };
        rows.set(key, row);
        return row;
      },
      async findUnique({ where }: { where: Record<string, unknown> }): Promise<Row | null> {
        const c = where.userId_toolId_idempotencyKey as
          | { userId: string; toolId: string; idempotencyKey: string }
          | undefined;
        if (c) return rows.get(composite(c)) ?? null;
        const byId = where.executionId as string | undefined;
        if (byId) for (const r of rows.values()) if (r.executionId === byId) return r;
        return null;
      },
      async findMany({ where, take }: {
        where?: {
          status?: string;
          leaseUntil?: { lt?: Date };
        };
        take?: number;
      }): Promise<Row[]> {
        let out = [...rows.values()];
        if (where?.status) out = out.filter((r) => r.status === where.status);
        if (where?.leaseUntil?.lt) {
          const lt = where.leaseUntil.lt;
          out = out.filter((r) => r.leaseUntil !== null && r.leaseUntil < lt);
        }
        out.sort(
          (a, b) => (a.leaseUntil?.getTime() ?? 0) - (b.leaseUntil?.getTime() ?? 0)
        );
        return take !== undefined ? out.slice(0, take) : out;
      },
      async updateMany({
        where,
        data,
      }: {
        where: { executionId?: string; status?: { in?: string[] } | string; ownerId?: string };
        data: Partial<Row>;
      }): Promise<{ count: number }> {
        let count = 0;
        for (const r of rows.values()) {
          if (where.executionId && r.executionId !== where.executionId) continue;
          if (where.status) {
            const allowed =
              typeof where.status === "string" ? [where.status] : where.status.in ?? [];
            if (!allowed.includes(r.status)) continue;
          }
          if (where.ownerId !== undefined && r.ownerId !== where.ownerId) continue;
          Object.assign(r, data);
          count++;
        }
        return { count };
      },
    },
  };
  return { client: client as unknown as PrismaClient, rows };
}

function makeRepo() {
  const { client, rows } = createMockPrismaClient();
  return { repo: new PrismaToolExecutionRepository(client), rows, client };
}

const baseInput = {
  userId: "user-1",
  toolId: "meta.campaign.pause",
  idempotencyKey: "meta.campaign.pause:act_1:100000001:PAUSED",
};

const MIN = 60_000;

describe("PHASE 10.2 — lease acquisition & heartbeat", () => {
  it("claim writes owner, lease and heartbeat atomically with EXECUTING", async () => {
    const { repo } = makeRepo();
    const rec = await repo.begin(baseInput);
    const claimed = await repo.claimForExecution(rec.executionId, {
      ownerId: "worker-A",
      leaseMs: 5 * MIN,
    });
    expect(claimed).not.toBeNull();
    expect(claimed!.status).toBe("EXECUTING");
    expect(claimed!.ownerId).toBe("worker-A");
    expect(claimed!.heartbeatAt).toBeInstanceOf(Date);
    expect(claimed!.leaseUntil!.getTime()).toBeGreaterThan(Date.now() + 4 * MIN);
  });

  it("heartbeat renews the lease only for the current owner", async () => {
    const { repo } = makeRepo();
    const rec = await repo.begin(baseInput);
    await repo.claimForExecution(rec.executionId, { ownerId: "worker-A", leaseMs: MIN });

    const intruder = await repo.heartbeat(rec.executionId, "worker-B", MIN);
    expect(intruder).toBeNull(); // non-owner denied

    const renewed = await repo.heartbeat(rec.executionId, "worker-A", 10 * MIN);
    expect(renewed).not.toBeNull();
    expect(renewed!.ownerId).toBe("worker-A");
    expect(renewed!.leaseUntil!.getTime()).toBeGreaterThan(Date.now() + 9 * MIN);
  });

  it("heartbeat fails once the record left EXECUTING", async () => {
    const { repo } = makeRepo();
    const rec = await repo.begin(baseInput);
    await repo.claimForExecution(rec.executionId, { ownerId: "worker-A", leaseMs: MIN });
    await repo.markSucceeded(rec.executionId, "camp_9");
    expect(await repo.heartbeat(rec.executionId, "worker-A", MIN)).toBeNull();
  });

  it("terminal transitions clear lease ownership", async () => {
    const { repo } = makeRepo();
    const rec = await repo.begin(baseInput);
    await repo.claimForExecution(rec.executionId, { ownerId: "worker-A", leaseMs: MIN });
    const done = await repo.markSucceeded(rec.executionId);
    expect(done!.ownerId).toBeUndefined();
    expect(done!.leaseUntil).toBeUndefined();
    expect(done!.heartbeatAt).toBeUndefined();
  });
});

describe("PHASE 10.2 — stale detection & crash recovery", () => {
  it("live worker with valid lease is NOT stale", async () => {
    const { repo } = makeRepo();
    const rec = await repo.begin(baseInput);
    await repo.claimForExecution(rec.executionId, { ownerId: "worker-A", leaseMs: 10 * MIN });
    // Heartbeat keeps it alive even close to evaluation time.
    await repo.heartbeat(rec.executionId, "worker-A", 10 * MIN);
    expect(await repo.findStaleExecutions()).toHaveLength(0);
  });

  it("expired lease is detected deterministically (no wall-clock sleeps)", async () => {
    const { repo } = makeRepo();
    const rec = await repo.begin({ ...baseInput, traceId: "trace-crash-1" });
    await repo.claimForExecution(rec.executionId, { ownerId: "worker-A", leaseMs: MIN });

    const future = new Date(Date.now() + 2 * MIN);
    const stale = await repo.findStaleExecutions({ now: future });
    expect(stale).toHaveLength(1);
    expect(stale[0]!.executionId).toBe(rec.executionId);
    expect(stale[0]!.status).toBe("EXECUTING");
  });

  it("crash recovery maps stale EXECUTING -> UNKNOWN (never FAILED)", async () => {
    const { repo } = makeRepo();
    const rec = await repo.begin(baseInput);
    await repo.claimForExecution(rec.executionId, { ownerId: "worker-A", leaseMs: MIN });
    // --- worker dies here ---

    const future = new Date(Date.now() + 2 * MIN);
    const { recovered } = await repo.recoverStaleExecutions({ now: future });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.status).toBe("UNKNOWN");
    expect(recovered[0]!.errorCode).toBe("STALE_EXECUTION_RECOVERED");

    const after = await repo.getById(rec.executionId);
    expect(after!.status).toBe("UNKNOWN");
    expect(after!.completedAt).toBeInstanceOf(Date);
  });

  it("recovery is idempotent: second invocation does nothing", async () => {
    const { repo } = makeRepo();
    const rec = await repo.begin(baseInput);
    await repo.claimForExecution(rec.executionId, { ownerId: "worker-A", leaseMs: MIN });

    const future = new Date(Date.now() + 2 * MIN);
    const first = await repo.recoverStaleExecutions({ now: future });
    expect(first.recovered).toHaveLength(1);

    const second = await repo.recoverStaleExecutions({ now: future });
    expect(second.recovered).toHaveLength(0);

    const third = await repo.recoverStaleExecutions({ now: future });
    expect(third.recovered).toHaveLength(0);

    expect((await repo.getById(rec.executionId))!.status).toBe("UNKNOWN");
  });

  it("recovered (UNKNOWN) execution can never be claimed or re-executed", async () => {
    const { repo } = makeRepo();
    const rec = await repo.begin(baseInput);
    await repo.claimForExecution(rec.executionId, { ownerId: "worker-A", leaseMs: MIN });
    await repo.recoverStaleExecutions({ now: new Date(Date.now() + 2 * MIN) });

    expect(await repo.claimForExecution(rec.executionId)).toBeNull();
    expect((await repo.getById(rec.executionId))!.status).toBe("UNKNOWN");
  });

  it("recovery respects batchSize and leaves the rest for the next pass", async () => {
    const { repo } = makeRepo();
    for (let i = 0; i < 3; i++) {
      const rec = await repo.begin({
        ...baseInput,
        idempotencyKey: `${baseInput.idempotencyKey}-${i}`,
      });
      await repo.claimForExecution(rec.executionId, { ownerId: "w", leaseMs: MIN });
    }
    const future = new Date(Date.now() + 2 * MIN);
    const pass1 = await repo.recoverStaleExecutions({ now: future, batchSize: 2 });
    expect(pass1.recovered).toHaveLength(2);
    const pass2 = await repo.recoverStaleExecutions({ now: future });
    expect(pass2.recovered).toHaveLength(1);
    expect(await repo.findStaleExecutions({ now: future })).toHaveLength(0);
  });

  it("recovery audit trail: full context preserved, no secrets", async () => {
    const { repo } = makeRepo();
    const rec = await repo.begin({
      ...baseInput,
      traceId: "trace-recovery-audit",
      provider: "meta-ads",
    });
    await repo.claimForExecution(rec.executionId, { ownerId: "worker-A", leaseMs: MIN });

    const future = new Date(Date.now() + 2 * MIN);
    const { recovered } = await repo.recoverStaleExecutions({ now: future });
    const audit = recovered[0]!;
    expect(audit.executionId).toBe(rec.executionId);
    expect(audit.userId).toBe("user-1");
    expect(audit.toolId).toBe("meta.campaign.pause");
    expect(audit.traceId).toBe("trace-recovery-audit");
    expect(audit.provider).toBe("meta-ads");
    expect(audit.status).toBe("UNKNOWN"); // state transition result
    expect(audit.completedAt).toBeInstanceOf(Date);
    expect(audit.errorMessage).toMatch(/lease expired|uncertain/i);
    expect(audit.errorMessage).not.toMatch(/password|api_key|sk-/i);
  });

  it("restart recovery: a brand-new repository instance over the same store recovers safely", async () => {
    const { client, rows } = createMockPrismaClient();
    const first = new PrismaToolExecutionRepository(client);
    const rec = await first.begin(baseInput);
    await first.claimForExecution(rec.executionId, { ownerId: "worker-A", leaseMs: MIN });
    // --- process crash ---

    const restarted = new PrismaToolExecutionRepository(client);
    const revived = await restarted.getById(rec.executionId);
    expect(revived).not.toBeNull();
    expect(revived!.status).toBe("EXECUTING");
    expect(revived!.startedAt).not.toBeNull();

    const { recovered } = await restarted.recoverStaleExecutions({
      now: new Date(Date.now() + 2 * MIN),
    });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.status).toBe("UNKNOWN");
    expect(rows.size).toBe(1); // no duplicate records created across restart
  });
});
