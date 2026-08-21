// PHASE 10.2 — REAL PostgreSQL concurrency & atomicity verification.
// Proves single-winner claims, begin() convergence and crash recovery against
// the actual database (not an emulation). Uses a dedicated test user that is
// fully removed afterwards (FK cascade cleans ToolExecution rows).
// Skips automatically when the database is unreachable.
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), "../../.env") });
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaToolExecutionRepository } from "../src/repositories/tool-execution-repository.js";

const prisma = new PrismaClient();

// Connectivity probe must run at module evaluation time: describe.skipIf()
// decides during collection, before any beforeAll hook.
let dbUp = false;
try {
  await prisma.$queryRaw`SELECT 1`;
  dbUp = true;
} catch {
  dbUp = false;
}
let testUserId: string | null = null;

const input = (n: number) => ({
  userId: testUserId!,
  toolId: "meta.campaign.pause",
  idempotencyKey: `pgtest:meta.campaign.pause:act_1:1000000${n}:PAUSED`,
});

beforeAll(async () => {
  if (!dbUp) return;
  const user = await prisma.user.create({
    data: {
      email: `phase102-pgtest-${Date.now()}@jarvis-test.local`,
      name: "Phase 10.2 PG Concurrency Test",
      password: "not-a-real-password-hash",
      role: "VIEWER",
    },
  });
  testUserId = user.id;
});

afterAll(async () => {
  if (testUserId) {
    // FK cascade removes all ToolExecution rows created by this suite.
    await prisma.user.delete({ where: { id: testUserId } }).catch(() => {});
  }
  await prisma.$disconnect();
});

describe.skipIf(!dbUp)("PHASE 10.2 — real PostgreSQL concurrency", () => {
  it("concurrent x2 same request: ONE execution record, ONE claim winner", async () => {
    const repo = new PrismaToolExecutionRepository(prisma);
    const key = input(1);

    const [a, b] = await Promise.all([repo.begin(key), repo.begin(key)]);
    expect(a.executionId).toBe(b.executionId);

    const [ca, cb] = await Promise.all([
      repo.claimForExecution(a.executionId, { ownerId: "w-A", leaseMs: 60_000 }),
      repo.claimForExecution(b.executionId, { ownerId: "w-B", leaseMs: 60_000 }),
    ]);
    const winners = [ca, cb].filter((r) => r !== null);
    expect(winners).toHaveLength(1); // => external provider invoked exactly once
    expect(winners[0]!.ownerId).toBeDefined();
    expect(winners[0]!.leaseUntil).toBeInstanceOf(Date);
  });

  it("concurrent x5 same request: exactly one winner", async () => {
    const repo = new PrismaToolExecutionRepository(prisma);
    const rec = await repo.begin(input(2));

    const claims = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        repo.claimForExecution(rec.executionId, { ownerId: `w-${i}`, leaseMs: 60_000 })
      )
    );
    const winners = claims.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(await repo.getById(rec.executionId)!.then((r) => r!.status)).toBe("EXECUTING");
  });

  it("concurrent x10 same request: one record, one winner, nine losers", async () => {
    const repo = new PrismaToolExecutionRepository(prisma);
    const begins = await Promise.all(Array.from({ length: 10 }, () => repo.begin(input(3))));
    const ids = new Set(begins.map((b) => b.executionId));
    expect(ids.size).toBe(1); // DB uniqueness converges every caller

    const executionId = begins[0]!.executionId;
    const claims = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        repo.claimForExecution(executionId, { ownerId: `w-${i}`, leaseMs: 60_000 })
      )
    );
    expect(claims.filter((r) => r !== null)).toHaveLength(1);

    // Losers cannot re-claim while EXECUTING.
    const lateClaims = await Promise.all(
      Array.from({ length: 9 }, () => repo.claimForExecution(executionId))
    );
    expect(lateClaims.every((r) => r === null)).toBe(true);
  });

  it("crash + restart recovery against live database", async () => {
    const first = new PrismaToolExecutionRepository(prisma);
    const rec = await first.begin(input(4));
    await first.claimForExecution(rec.executionId, { ownerId: "crashed-worker", leaseMs: 60_000 });
    // --- process disappears ---

    // New process, brand-new client + repository over the same database.
    const freshClient = new PrismaClient();
    try {
      const restarted = new PrismaToolExecutionRepository(freshClient);
      const revived = await restarted.getById(rec.executionId);
      expect(revived!.status).toBe("EXECUTING");

      const future = new Date(Date.now() + 5 * 60_000);
      const stale = await restarted.findStaleExecutions({ now: future });
      expect(stale.some((r) => r.executionId === rec.executionId)).toBe(true);

      const { recovered } = await restarted.recoverStaleExecutions({ now: future });
      expect(recovered.some((r) => r.executionId === rec.executionId)).toBe(true);

      const after = await restarted.getById(rec.executionId);
      expect(after!.status).toBe("UNKNOWN"); // uncertain outcome, never FAILED
      expect(after!.errorCode).toBe("STALE_EXECUTION_RECOVERED");

      // UNKNOWN can never be claimed again.
      expect(await restarted.claimForExecution(rec.executionId)).toBeNull();

      // Idempotent: recovery rerun does nothing.
      const rerun = await restarted.recoverStaleExecutions({ now: future });
      expect(rerun.recovered.filter((r) => r.executionId === rec.executionId)).toHaveLength(0);
    } finally {
      await freshClient.$disconnect();
    }
  });

  it("user isolation on real database", async () => {
    const repo = new PrismaToolExecutionRepository(prisma);
    const other = await prisma.user.create({
      data: {
        email: `phase102-pgtest-other-${Date.now()}@jarvis-test.local`,
        name: "Phase 10.2 Isolation Test",
        password: "not-a-real-password-hash",
        role: "VIEWER",
      },
    });
    try {
      // Before any activity: the other user cannot see user A's execution.
      expect(
        await repo.findByIdempotentKey(other.id, input(5).toolId, input(5).idempotencyKey)
      ).toBeNull();

      const a = await repo.begin(input(5));
      const b = await repo.begin({ ...input(5), userId: other.id });
      expect(b.executionId).not.toBe(a.executionId);

      await repo.claimForExecution(a.executionId, { ownerId: "w-A", leaseMs: 60_000 });
      const claimB = await repo.claimForExecution(b.executionId, { ownerId: "w-B", leaseMs: 60_000 });
      expect(claimB).not.toBeNull(); // independent ownership
    } finally {
      await prisma.user.delete({ where: { id: other.id } }).catch(() => {});
    }
  });

  it("heartbeat ownership arbitration on real database", async () => {
    const repo = new PrismaToolExecutionRepository(prisma);
    const rec = await repo.begin(input(6));
    await repo.claimForExecution(rec.executionId, { ownerId: "w-real", leaseMs: 60_000 });

    expect(await repo.heartbeat(rec.executionId, "w-intruder", 60_000)).toBeNull();
    const renewed = await repo.heartbeat(rec.executionId, "w-real", 120_000);
    expect(renewed).not.toBeNull();
    expect(renewed!.leaseUntil!.getTime()).toBeGreaterThan(Date.now() + 110_000);
  });
});
