import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { PrismaToolExecutionRepository } from "../src/repositories/tool-execution-repository.js";
import type { ExecutionJournalPort } from "@jarvis/core";

// ---------------------------------------------------------------------------
// Faithful in-memory emulation of the Prisma ToolExecution delegate:
//  - INSERT enforces UNIQUE(user_id, tool_id, idempotency_key) via P2002
//  - updateMany applies conditional status transitions sequentially
//    (mirrors PostgreSQL row-lock serialization: exactly one winner)
// ---------------------------------------------------------------------------

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
          throw new Prisma.PrismaClientKnownRequestError(
            "Unique constraint failed on the fields: (`user_id`,`tool_id`,`idempotency_key`)",
            { code: "P2002", clientVersion: "test" }
          );
        }
        const row: Row = {
          executionId: data.executionId ?? `exec_${++seq}`,
          userId: data.userId!,
          toolId: data.toolId!,
          idempotencyKey: data.idempotencyKey!,
          paramsHash: data.paramsHash ?? null,
          status: data.status ?? "PENDING",
          provider: data.provider ?? null,
          externalResourceId: data.externalResourceId ?? null,
          errorCode: data.errorCode ?? null,
          errorMessage: data.errorMessage ?? null,
          traceId: data.traceId ?? null,
          createdAt: data.createdAt ?? new Date(),
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
        if (byId) {
          for (const r of rows.values()) if (r.executionId === byId) return r;
        }
        return null;
      },

      async updateMany({
        where,
        data,
      }: {
        where: { executionId?: string; status?: { in?: string[] } | string };
        data: Partial<Row>;
      }): Promise<{ count: number }> {
        let count = 0;
        for (const r of rows.values()) {
          if (where.executionId && r.executionId !== where.executionId) continue;
          if (where.status) {
            const allowed =
              typeof where.status === "string"
                ? [where.status]
                : where.status.in ?? [];
            if (!allowed.includes(r.status)) continue;
          }
          Object.assign(r, data);
          count++;
        }
        return { count };
      },
    },
  };

  return { client: client as unknown as PrismaClient, rows };
}

function makeRepo(): { repo: ExecutionJournalPort; rows: Map<string, Row> } {
  const { client, rows } = createMockPrismaClient();
  return { repo: new PrismaToolExecutionRepository(client), rows };
}

const baseInput = {
  userId: "user-1",
  toolId: "meta.campaign.create",
  idempotencyKey: "meta.campaign.create:act_111111111:proposal:Q1:OUTCOME_AWARENESS",
};

// ===========================================================================

describe("Phase 10.1 Execution Journal — repository", () => {
  it("1. creates an execution record with all journal fields", async () => {
    const { repo } = makeRepo();
    const rec = await repo.begin({
      ...baseInput,
      paramsHash: "abc123",
      provider: "meta-ads",
      traceId: "trace-1",
    });
    expect(rec.status).toBe("PENDING");
    expect(rec.executionId).toBeTruthy();
    expect(rec.paramsHash).toBe("abc123");
    expect(rec.provider).toBe("meta-ads");
    expect(rec.traceId).toBe("trace-1");
    expect(rec.createdAt).toBeInstanceOf(Date);

    const fetched = await repo.getById(rec.executionId);
    expect(fetched).not.toBeNull();
    expect(fetched!.toolId).toBe(baseInput.toolId);
    expect(fetched!.userId).toBe("user-1");
  });

  it("2. duplicate idempotency key returns the same execution", async () => {
    const { repo } = makeRepo();
    const first = await repo.begin(baseInput);
    const second = await repo.begin({ ...baseInput, paramsHash: "different" });
    expect(second.executionId).toBe(first.executionId);
    expect(second.status).toBe(first.status);
    // original record is authoritative — its fields are unchanged
    expect(first.paramsHash).toBeUndefined();
  });

  it("3. concurrent same-key executions resolve to one execution with a single claim winner", async () => {
    const { repo } = makeRepo();
    const [a, b] = await Promise.all([
      repo.begin(baseInput),
      repo.begin(baseInput),
    ]);
    expect(a.executionId).toBe(b.executionId);

    const [claimA, claimB] = await Promise.all([
      repo.claimForExecution(a.executionId),
      repo.claimForExecution(a.executionId),
    ]);
    const winners = [claimA, claimB].filter((r) => r !== null);
    expect(winners.length).toBe(1);
    expect(winners[0]!.status).toBe("EXECUTING");
  });

  it("4. same key for different users creates independent executions", async () => {
    const { repo } = makeRepo();
    const a = await repo.begin(baseInput);
    const b = await repo.begin({ ...baseInput, userId: "user-2" });
    expect(a.executionId).not.toBe(b.executionId);
    expect(b.userId).toBe("user-2");

    const claimA = await repo.claimForExecution(a.executionId);
    expect(claimA).not.toBeNull();
    const claimB = await repo.claimForExecution(b.executionId);
    expect(claimB).not.toBeNull();
  });

  it("5. same key for different tools creates independent executions", async () => {
    const { repo } = makeRepo();
    const a = await repo.begin(baseInput);
    const b = await repo.begin({
      ...baseInput,
      toolId: "meta.campaign.pause",
    });
    expect(a.executionId).not.toBe(b.executionId);
  });

  it("6. persists paramsHash verbatim", async () => {
    const { repo } = makeRepo();
    const rec = await repo.begin({ ...baseInput, paramsHash: "deadbeef01" });
    const fetched = await repo.findByIdempotentKey(
      rec.userId,
      rec.toolId,
      rec.idempotencyKey
    );
    expect(fetched!.paramsHash).toBe("deadbeef01");
  });

  it("7. claims PENDING -> EXECUTING atomically with startedAt", async () => {
    const { repo } = makeRepo();
    const rec = await repo.begin(baseInput);
    const claimed = await repo.claimForExecution(rec.executionId);
    expect(claimed!.status).toBe("EXECUTING");
    expect(claimed!.startedAt).toBeInstanceOf(Date);

    const second = await repo.claimForExecution(rec.executionId);
    expect(second).toBeNull();
  });

  it("8. transitions EXECUTING -> SUCCEEDED with externalResourceId and completedAt", async () => {
    const { repo } = makeRepo();
    const rec = await repo.begin(baseInput);
    await repo.claimForExecution(rec.executionId);
    const done = await repo.markSucceeded(rec.executionId, "camp_987654321");
    expect(done!.status).toBe("SUCCEEDED");
    expect(done!.externalResourceId).toBe("camp_987654321");
    expect(done!.completedAt).toBeInstanceOf(Date);
  });

  it("9. transitions EXECUTING -> UNKNOWN with error context", async () => {
    const { repo } = makeRepo();
    const rec = await repo.begin(baseInput);
    await repo.claimForExecution(rec.executionId);
    const unk = await repo.markUnknown(rec.executionId, {
      code: "AMBIGUOUS_OUTCOME",
      message: "Request timed out after transmission",
    });
    expect(unk!.status).toBe("UNKNOWN");
    expect(unk!.errorCode).toBe("AMBIGUOUS_OUTCOME");
    expect(unk!.errorMessage).toContain("timed out");
  });

  it("10. UNKNOWN cannot auto-retry: no claim or terminal transition is possible", async () => {
    const { repo } = makeRepo();
    const rec = await repo.begin(baseInput);
    await repo.claimForExecution(rec.executionId);
    await repo.markUnknown(rec.executionId, { code: "AMBIGUOUS_OUTCOME" });

    expect(await repo.claimForExecution(rec.executionId)).toBeNull();
    expect(await repo.markFailed(rec.executionId)).toBeNull();
    expect(await repo.markSucceeded(rec.executionId)).toBeNull();

    const still = await repo.getById(rec.executionId);
    expect(still!.status).toBe("UNKNOWN");
  });

  it("11. state survives repository 'restart' (new instance, same store)", async () => {
    const { client, rows } = createMockPrismaClient();
    const first = new PrismaToolExecutionRepository(client);
    const rec = await first.begin(baseInput);
    await first.claimForExecution(rec.executionId);

    // Simulate crash + restart: brand-new repository over the same database.
    const second = new PrismaToolExecutionRepository(client);
    const revived = await second.getById(rec.executionId);
    expect(revived).not.toBeNull();
    expect(revived!.status).toBe("EXECUTING");
    expect(revived!.startedAt).not.toBeNull();
    expect(rows.size).toBe(1);
  });

  it("12. invalid state transitions are rejected (null, no mutation)", async () => {
    const { repo } = makeRepo();

    const pending = await repo.begin(baseInput);
    expect(await repo.markSucceeded(pending.executionId)).toBeNull();
    expect((await repo.getById(pending.executionId))!.status).toBe("PENDING");

    await repo.claimForExecution(pending.executionId);
    expect(await repo.claimForExecution(pending.executionId)).toBeNull();
    await repo.markSucceeded(pending.executionId);
    expect(await repo.markUnknown(pending.executionId)).toBeNull();
    expect(await repo.markFailed(pending.executionId)).toBeNull();
    expect((await repo.getById(pending.executionId))!.status).toBe("SUCCEEDED");
  });

  it("13. completed execution cannot execute again", async () => {
    const { repo } = makeRepo();
    const rec = await repo.begin(baseInput);
    await repo.claimForExecution(rec.executionId);
    await repo.markSucceeded(rec.executionId, "camp_1");

    expect(await repo.claimForExecution(rec.executionId)).toBeNull();
    const final = await repo.getById(rec.executionId);
    expect(final!.status).toBe("SUCCEEDED");
  });

  it("14. enforces database uniqueness: duplicate INSERT raises P2002 and resolves to existing row", async () => {
    const { client, rows } = createMockPrismaClient();
    // Raw duplicate INSERT violates the unique constraint...
    await client.toolExecution.create({
      data: { ...baseInput, status: "PENDING" },
    });
    await expect(
      client.toolExecution.create({ data: { ...baseInput } })
    ).rejects.toMatchObject({ code: "P2002" });
    expect(rows.size).toBe(1);

    // ...and the repository resolves the conflict to the existing execution.
    const repo = new PrismaToolExecutionRepository(client);
    const original = await repo.begin(baseInput);
    const loser = await repo.begin(baseInput);
    expect(loser.executionId).toBe(original.executionId);
    expect(rows.size).toBe(1);
  });

  it("15. redacts secrets from persisted error messages", async () => {
    const { repo } = makeRepo();
    const rec = await repo.begin(baseInput);
    await repo.claimForExecution(rec.executionId);
    const failed = await repo.markFailed(rec.executionId, {
      code: "sk-proj-VERYSECRETKEY1234567890",
      message:
        "auth failed: password=hunter2 api_key=AKIAIOSFODNN7 Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ999 token=EAAabc123456789012345678",
    });
    const msg = failed!.errorMessage!;
    expect(msg).not.toContain("hunter2");
    expect(msg).not.toContain("AKIAIOSFODNN7");
    expect(msg).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ999");
    expect(msg).not.toContain("EAAabc123456789012345678");
    expect(msg).toContain("[REDACTED]");
    expect(failed!.errorCode).toBe("[REDACTED]");
  });

  it("16. isolates users: lookups are scoped and foreign rows are invisible", async () => {
    const { repo } = makeRepo();
    const a = await repo.begin(baseInput);
    await repo.claimForExecution(a.executionId);

    const bView = await repo.findByIdempotentKey(
      "user-2",
      baseInput.toolId,
      baseInput.idempotencyKey
    );
    expect(bView).toBeNull();

    const own = await repo.findByIdempotentKey(
      "user-1",
      baseInput.toolId,
      baseInput.idempotencyKey
    );
    expect(own!.executionId).toBe(a.executionId);
  });
});
