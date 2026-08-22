// PHASE 10.5 — durable reconciliation semantics against real PostgreSQL.
// Skipped when DB is down. Proves: single-winner claims, ownership-guarded
// finalization, persistence of SUCCEEDED / SAFE_TO_RETRY / UNKNOWN outcomes,
// crash recovery (stale RECONCILING -> UNKNOWN, never FAILED), attempt
// counters and secret redaction.
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), "../../.env") });
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaToolExecutionRepository } from "../src/repositories/tool-execution-repository.js";

const prisma = new PrismaClient();

let dbUp = false;
try {
  await prisma.$queryRaw`SELECT 1`;
  dbUp = true;
} catch {
  dbUp = false;
}
let testUserId: string | null = null;

beforeAll(async () => {
  if (!dbUp) return;
  const user = await prisma.user.create({
    data: {
      email: `phase105-pgtest-${Date.now()}@jarvis-test.local`,
      name: "Phase 10.5 Reconciliation Test",
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

async function seedUnknown(
  repo: PrismaToolExecutionRepository,
  suffix: string,
  paramsHash = "hash-abc"
) {
  const rec = await repo.begin({
    userId: testUserId!,
    toolId: "meta.campaign.create",
    idempotencyKey: `pg105-${suffix}:${Date.now()}-${Math.random().toString(36).slice(2)}`,
    paramsHash,
    provider: "meta-ads",
    traceId: "trace-pg105",
  });
  const claimed = await repo.claimForExecution(rec.executionId, { ownerId: "seed" });
  expect(claimed).not.toBeNull();
  const unknowned = await repo.markUnknown(rec.executionId, {
    code: "AMBIGUOUS_OUTCOME",
    message: "seeded ambiguous write",
  });
  expect(unknowned!.status).toBe("UNKNOWN");
  return rec.executionId;
}

describe.skipIf(!dbUp)("PHASE 10.5 — reconciliation persistence", () => {
  it("claimForReconciliation: exactly one concurrent winner from UNKNOWN", async () => {
    if (!dbUp) return;
    const repo = new PrismaToolExecutionRepository(prisma);
    const id = await seedUnknown(repo, "concurrent");
    const [a, b, c] = await Promise.all([
      repo.claimForReconciliation(id, { ownerId: "w1" }),
      repo.claimForReconciliation(id, { ownerId: "w2" }),
      repo.claimForReconciliation(id, { ownerId: "w3" }),
    ]);
    const winners = [a, b, c].filter((r) => r !== null);
    expect(winners.length).toBe(1);
    expect(winners[0]!.status).toBe("RECONCILING");
    expect(winners[0]!.ownerId).toBeDefined();
    expect(winners[0]!.leaseUntil).toBeInstanceOf(Date);
  });

  it("claimForReconciliation refuses every state except UNKNOWN", async () => {
    if (!dbUp) return;
    const repo = new PrismaToolExecutionRepository(prisma);
    // SUCCEEDED
    const okId = await seedUnknown(repo, "refuse-ok");
    await repo.claimForReconciliation(okId, { ownerId: "w" });
    await repo.finalizeReconciliation(okId, "w", {
      status: "SUCCEEDED",
      outcome: "FOUND",
      externalResourceId: "cmp_1",
    });
    expect(await repo.claimForReconciliation(okId, { ownerId: "w2" })).toBeNull();
    // FAILED is not reconciliation-eligible either
    const failedRec = await repo.begin({
      userId: testUserId!,
      toolId: "meta.campaign.create",
      idempotencyKey: `pg105-failed-${Date.now()}`,
      provider: "meta-ads",
    });
    await repo.claimForExecution(failedRec.executionId, { ownerId: "s" });
    await repo.markFailed(failedRec.executionId, { code: "EXECUTION_ERROR" });
    expect(await repo.claimForReconciliation(failedRec.executionId, { ownerId: "w" })).toBeNull();
    // PENDING (fresh begin, never executed)
    const pendingRec = await repo.begin({
      userId: testUserId!,
      toolId: "meta.campaign.create",
      idempotencyKey: `pg105-pending-${Date.now()}`,
      provider: "meta-ads",
    });
    expect(await repo.claimForReconciliation(pendingRec.executionId, { ownerId: "w" })).toBeNull();
  });

  it("FOUND persists SUCCEEDED with external resource id, attempts counter and metadata", async () => {
    if (!dbUp) return;
    const repo = new PrismaToolExecutionRepository(prisma);
    const id = await seedUnknown(repo, "found");
    await repo.claimForReconciliation(id, { ownerId: "w1" });
    const done = await repo.finalizeReconciliation(id, "w1", {
      status: "SUCCEEDED",
      outcome: "FOUND",
      externalResourceId: "100200300",
    });
    expect(done!.status).toBe("SUCCEEDED");
    expect(done!.externalResourceId).toBe("100200300");
    expect(done!.reconciliationAttempts).toBe(1);
    expect(done!.lastReconciliationResult).toBe("FOUND");
    expect(done!.lastReconciliationAt).toBeInstanceOf(Date);
    expect(done!.completedAt).toBeInstanceOf(Date);
    expect(done!.ownerId).toBeUndefined();
    expect(done!.leaseUntil).toBeUndefined();
  });

  it("authoritative NOT_FOUND persists SAFE_TO_RETRY", async () => {
    if (!dbUp) return;
    const repo = new PrismaToolExecutionRepository(prisma);
    const id = await seedUnknown(repo, "notfound");
    await repo.claimForReconciliation(id, { ownerId: "w1" });
    const done = await repo.finalizeReconciliation(id, "w1", {
      status: "SAFE_TO_RETRY",
      outcome: "NOT_FOUND",
      error: { code: "RESOLVED_NOT_FOUND", message: "Authoritative absence" },
    });
    expect(done!.status).toBe("SAFE_TO_RETRY");
    expect(done!.reconciliationAttempts).toBe(1);
    expect(await repo.claimForExecution(id, { ownerId: "auto" })).toBeNull();
  });

  it("UNCERTAIN persists UNKNOWN and increments attempts across cycles", async () => {
    if (!dbUp) return;
    const repo = new PrismaToolExecutionRepository(prisma);
    const id = await seedUnknown(repo, "uncertain");

    await repo.claimForReconciliation(id, { ownerId: "w1" });
    const first = await repo.finalizeReconciliation(id, "w1", {
      status: "UNKNOWN",
      outcome: "UNCERTAIN",
      error: { code: "RATE_LIMITED", message: "rate limited" },
    });
    expect(first!.status).toBe("UNKNOWN");
    expect(first!.errorCode).toBe("RATE_LIMITED");

    await repo.claimForReconciliation(id, { ownerId: "w2" });
    const second = await repo.finalizeReconciliation(id, "w2", {
      status: "UNKNOWN",
      outcome: "PROVIDER_ERROR",
      error: { code: "PROVIDER_INTERNAL_ERROR", message: "500" },
    });
    expect(second!.status).toBe("UNKNOWN");
    expect(second!.reconciliationAttempts).toBe(2);
    expect(second!.lastReconciliationResult).toBe("PROVIDER_ERROR");
  });

  it("finalization is ownership-guarded: wrong owner can never apply a decision", async () => {
    if (!dbUp) return;
    const repo = new PrismaToolExecutionRepository(prisma);
    const id = await seedUnknown(repo, "ownership");
    await repo.claimForReconciliation(id, { ownerId: "real-owner" });
    expect(
      await repo.finalizeReconciliation(id, "fake-owner", {
        status: "SUCCEEDED",
        outcome: "FOUND",
        externalResourceId: "cmp_wrong",
      })
    ).toBeNull();
    const rec = await repo.getById(id);
    expect(rec!.status).toBe("RECONCILING");
    expect(rec!.externalResourceId).toBeUndefined();
  });

  it("second finalization after a terminal decision is a no-op", async () => {
    if (!dbUp) return;
    const repo = new PrismaToolExecutionRepository(prisma);
    const id = await seedUnknown(repo, "noop");
    await repo.claimForReconciliation(id, { ownerId: "w1" });
    await repo.finalizeReconciliation(id, "w1", {
      status: "SAFE_TO_RETRY",
      outcome: "NOT_FOUND",
    });
    expect(
      await repo.finalizeReconciliation(id, "w1", {
        status: "SUCCEEDED",
        outcome: "FOUND",
        externalResourceId: "cmp_second",
      })
    ).toBeNull();
    const rec = await repo.getById(id);
    expect(rec!.status).toBe("SAFE_TO_RETRY");
    expect(rec!.externalResourceId).toBeUndefined();
    expect(rec!.lastReconciliationResult).toBe("NOT_FOUND");
  });

  it("crash during RECONCILING: stale lease recovers to UNKNOWN (never FAILED), then re-claims", async () => {
    if (!dbUp) return;
    const repo = new PrismaToolExecutionRepository(prisma);
    const id = await seedUnknown(repo, "crash");
    await repo.claimForReconciliation(id, { ownerId: "crashed-worker", leaseMs: 50 });

    // Force lease expiry deterministically.
    await prisma.toolExecution.update({
      where: { executionId: id },
      data: { leaseUntil: new Date(Date.now() - 1000) },
    });

    const recovered = await repo.recoverStaleReconciliations({});
    const mine = recovered.recovered.find((r) => r.executionId === id);
    expect(mine).toBeDefined();
    expect(mine!.status).toBe("UNKNOWN");
    expect(mine!.errorCode).toBe("RECONCILIATION_LEASE_EXPIRED");

    // Eligible again for a fresh single-winner claim.
    expect(await repo.claimForReconciliation(id, { ownerId: "w2" })).not.toBeNull();
  });

  it("recoverStaleReconciliations is idempotent and skips live leases", async () => {
    if (!dbUp) return;
    const repo = new PrismaToolExecutionRepository(prisma);
    const liveId = await seedUnknown(repo, "live-lease");
    await repo.claimForReconciliation(liveId, { ownerId: "w-live", leaseMs: 600_000 });
    const staleId = await seedUnknown(repo, "stale-lease");
    await repo.claimForReconciliation(staleId, { ownerId: "w-stale", leaseMs: 600_000 });
    await prisma.toolExecution.update({
      where: { executionId: staleId },
      data: { leaseUntil: new Date(Date.now() - 1000) },
    });

    const firstPass = await repo.recoverStaleReconciliations({});
    expect(firstPass.recovered.map((r) => r.executionId)).toContain(staleId);
    expect(firstPass.recovered.map((r) => r.executionId)).not.toContain(liveId);

    const secondPass = await repo.recoverStaleReconciliations({});
    expect(secondPass.recovered.length).toBe(0);
    expect((await repo.getById(liveId))!.status).toBe("RECONCILING");
    expect((await repo.getById(staleId))!.status).toBe("UNKNOWN");
  });

  it("secrets in reconciliation errors are redacted before persistence", async () => {
    if (!dbUp) return;
    const repo = new PrismaToolExecutionRepository(prisma);
    const id = await seedUnknown(repo, "redact");
    await repo.claimForReconciliation(id, { ownerId: "w1" });
    await repo.finalizeReconciliation(id, "w1", {
      status: "UNKNOWN",
      outcome: "PROVIDER_ERROR",
      error: {
        code: "AUTHENTICATION_FAILED",
        message: "token rejected access_token=EAAsupersecret456 value",
      },
    });
    const rec = await repo.getById(id);
    expect(rec!.errorMessage).not.toContain("EAAsupersecret456");
    expect(rec!.errorMessage).not.toContain("access_token=");
  });
});
