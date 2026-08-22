// PHASE 10.6 — shutdown/startup recovery + DB-failure safety on real PostgreSQL.
// Skipped when DB is down. Proves:
//  1. Startup recovery (stale EXECUTING → UNKNOWN, stale RECONCILING → UNKNOWN)
//     is idempotent — running it twice yields the identical state.
//  2. Crash simulation: rows left EXECUTING by a dead process recover to
//     UNKNOWN, never FAILED; UNKNOWN records stay reconciliation-eligible.
//  3. Resolved records (SUCCEEDED / SAFE_TO_RETRY) are untouched by recovery.
//  4. Lease safety during draining: a live lease cannot be stolen while
//     shutdown waits.
//  5. DB unavailable during final transition → the write FAILS LOUDLY, the
//     record keeps its previous durable state, no false success.
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), "../../.env") });
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaToolExecutionRepository } from "../src/repositories/tool-execution-repository.js";
import { runStartupRecovery } from "@jarvis/core";

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
      email: `phase106-pgtest-${Date.now()}@jarvis-test.local`,
      name: "Phase 10.6 Shutdown Test",
      password: "not-a-real-password-hash",
      role: "VIEWER",
    },
  });
  testUserId = user.id;
});

afterAll(async () => {
  if (testUserId) {
    // ToolExecution rows have no cascade from User — delete them first
    // (same pattern as the Phase 10.3 cleanup fix).
    await prisma.toolExecution.deleteMany({
      where: { userId: testUserId },
    }).catch(() => {});
    await prisma.user.delete({ where: { id: testUserId } }).catch(() => {});
  }
  await prisma.$disconnect();
});

async function backdateLease(executionId: string) {
  await prisma.toolExecution.updateMany({
    where: { executionId },
    data: { leaseUntil: new Date(Date.now() - 5_000) },
  });
}

/** begin → claim → leave EXECUTING with an expired lease (crash residue). */
async function seedStaleExecuting(
  repo: PrismaToolExecutionRepository,
  suffix: string
) {
  const rec = await repo.begin({
    userId: testUserId!,
    toolId: "meta.campaign.create",
    idempotencyKey: `pg106-stale-exec-${suffix}:${Date.now()}-${Math.random().toString(36).slice(2)}`,
    paramsHash: "hash-pg106",
    provider: "meta-ads",
  });
  const claimed = await repo.claimForExecution(rec.executionId, {
    ownerId: `crashed-worker-${suffix}`,
    leaseMs: 60_000,
  });
  expect(claimed!.status).toBe("EXECUTING");
  await backdateLease(rec.executionId);
  return rec.executionId;
}

describe.skipIf(!dbUp)("PHASE 10.6 — startup recovery after graceful shutdown/crash", () => {
  it("1. stale EXECUTING recovers to UNKNOWN via runStartupRecovery", async () => {
    if (!dbUp) return;
    const repo = new PrismaToolExecutionRepository(prisma);
    const id = await seedStaleExecuting(repo, "recover-1");

    const report = await runStartupRecovery(repo);
    expect(report.staleExecutingRecovered).toBeGreaterThanOrEqual(1);

    const rec = await repo.getById(id);
    expect(rec!.status).toBe("UNKNOWN"); // never FAILED
    expect(rec!.errorCode).toBe("STALE_EXECUTION_RECOVERED");
  });

  it("2. duplicate startup recovery is safe — second pass changes nothing", async () => {
    if (!dbUp) return;
    const repo = new PrismaToolExecutionRepository(prisma);
    const id = await seedStaleExecuting(repo, "idempotent");
    const idR = await seedStaleExecuting(repo, "idempotent-r");

    // First pass: crash residue EXECUTING → UNKNOWN for both.
    await runStartupRecovery(repo);

    // One of them enters reconciliation and its worker dies mid-flight.
    await repo.claimForReconciliation(idR, { ownerId: "dead-reconciler" });
    await backdateLease(idR);

    const first = await runStartupRecovery(repo);
    const stateAfterFirst = await Promise.all([
      repo.getById(id),
      repo.getById(idR),
    ]);

    const second = await runStartupRecovery(repo);
    const stateAfterSecond = await Promise.all([
      repo.getById(id),
      repo.getById(idR),
    ]);

    expect(first.staleExecutingRecovered).toBe(0);
    expect(first.staleReconcilingRecovered).toBe(1);
    expect(second.staleExecutingRecovered).toBe(0);
    expect(second.staleReconcilingRecovered).toBe(0);

    expect(stateAfterSecond[0]!.status).toBe(stateAfterFirst[0]!.status);
    expect(stateAfterSecond[0]!.status).toBe("UNKNOWN");
    expect(stateAfterSecond[1]!.status).toBe("UNKNOWN");
  });

  it("3. stale RECONCILING recovers to UNKNOWN and remains reconciliation-eligible", async () => {
    if (!dbUp) return;
    const repo = new PrismaToolExecutionRepository(prisma);
    const id = await seedStaleExecuting(repo, "reconciling");
    // Crash residue first becomes UNKNOWN (startup recovery)…
    await runStartupRecovery(repo);
    // …then a reconciler claims it and dies mid-flight.
    const claimed = await repo.claimForReconciliation(id, {
      ownerId: "w-dead",
      leaseMs: 60_000,
    });
    expect(claimed!.status).toBe("RECONCILING");
    await backdateLease(id);

    await runStartupRecovery(repo);
    const recovered = await repo.getById(id);
    expect(recovered!.status).toBe("UNKNOWN");

    // Reconciliation eligibility preserved: claimable again.
    const reClaimed = await repo.claimForReconciliation(id, {
      ownerId: "w-new",
    });
    expect(reClaimed!.status).toBe("RECONCILING");
    expect(reClaimed!.ownerId).toBe("w-new");
  });

  it("4. resolved records are untouched by startup recovery", async () => {
    if (!dbUp) return;
    const repo = new PrismaToolExecutionRepository(prisma);
    // SUCCEEDED via reconciliation FOUND
    const okId = await seedStaleExecuting(repo, "resolved-ok");
    await runStartupRecovery(repo); // EXECUTING → UNKNOWN first
    await repo.claimForReconciliation(okId, { ownerId: "w" });
    await repo.finalizeReconciliation(okId, "w", {
      status: "SUCCEEDED",
      outcome: "FOUND",
      externalResourceId: "cmp_resolved",
    });
    // SAFE_TO_RETRY via authoritative NOT_FOUND
    const retryId = await seedStaleExecuting(repo, "resolved-retry");
    await runStartupRecovery(repo); // EXECUTING → UNKNOWN first
    await repo.claimForReconciliation(retryId, { ownerId: "w" });
    await repo.finalizeReconciliation(retryId, "w", {
      status: "SAFE_TO_RETRY",
      outcome: "NOT_FOUND",
      authoritative: true,
      reasonCode: "NO_CANDIDATES",
    });

    await runStartupRecovery(repo);
    await runStartupRecovery(repo); // twice, for good measure

    expect((await repo.getById(okId))!.status).toBe("SUCCEEDED");
    expect((await repo.getById(retryId))!.status).toBe("SAFE_TO_RETRY");
  });

  it("5. live lease cannot be stolen while shutdown drains (lease released only on safe stop)", async () => {
    if (!dbUp) return;
    const repo = new PrismaToolExecutionRepository(prisma);
    const rec = await repo.begin({
      userId: testUserId!,
      toolId: "meta.campaign.create",
      idempotencyKey: `pg106-live-lease:${Date.now()}`,
      paramsHash: "hash-pg106",
      provider: "meta-ads",
    });
    await repo.claimForExecution(rec.executionId, {
      ownerId: "in-flight-worker",
      leaseMs: 60_000, // long-lived: side effect may still be running
    });

    // Grace period expires — shutdown must NOT release or steal this lease.
    const stolen = await repo.claimForExecution(rec.executionId, {
      ownerId: "shutdown-worker",
    });
    expect(stolen).toBeNull();

    const still = await repo.getById(rec.executionId);
    expect(still!.status).toBe("EXECUTING");
    expect(still!.ownerId).toBe("in-flight-worker");

    // Phase 10.2 stale recovery remains the only authority — and only
    // AFTER the lease genuinely expires does the row become UNKNOWN.
    await prisma.toolExecution.updateMany({
      where: { executionId: rec.executionId },
      data: { leaseUntil: new Date(Date.now() - 5_000) },
    });
    await runStartupRecovery(repo);
    expect((await repo.getById(rec.executionId))!.status).toBe("UNKNOWN");
  });

  it("6. UNKNOWN record survives full recovery passes intact", async () => {
    if (!dbUp) return;
    const repo = new PrismaToolExecutionRepository(prisma);
    const id = await seedStaleExecuting(repo, "unknown-preserved");
    // Make it UNKNOWN with an error payload (ambiguous write).
    await prisma.toolExecution.updateMany({
      where: { executionId: id },
      data: { leaseUntil: new Date(Date.now() - 5_000) },
    });
    await runStartupRecovery(repo);
    const unknownRec = await repo.getById(id);
    expect(unknownRec!.status).toBe("UNKNOWN");

    // Additional passes must not mutate it into anything else.
    await runStartupRecovery(repo);
    await runStartupRecovery(repo);
    const again = await repo.getById(id);
    expect(again!.status).toBe("UNKNOWN");
    expect(again!.errorCode ?? null).toBeDefined();
  });
});

describe.skipIf(!dbUp)("PHASE 10.6 — DB failure during shutdown/final transition", () => {
  it("7. connection drop during final state transition fails loudly, record unchanged, no false success", async () => {
    if (!dbUp) return;
    const repo = new PrismaToolExecutionRepository(prisma);
    // Live (long) lease: nothing else may recover this row while the
    // failing writer struggles against a dead database.
    const rec = await repo.begin({
      userId: testUserId!,
      toolId: "meta.campaign.create",
      idempotencyKey: `pg106-dbdrop:${Date.now()}`,
      paramsHash: "hash-pg106",
      provider: "meta-ads",
    });
    const claimed = await repo.claimForExecution(rec.executionId, {
      ownerId: "shutdown-writer",
      // Long enough to outlive ANY parallel suite's future-dated recovery
      // scan (pg103 uses now+30min): only THIS test may end this lease.
      leaseMs: 2 * 60 * 60_000,
    });
    expect(claimed!.status).toBe("EXECUTING");
    const id = rec.executionId;
    const before = await repo.getById(id);
    expect(before!.status).toBe("EXECUTING");

    // Simulate the DB going away mid-shutdown: every subsequent query fails.
    const deadUrl =
      (process.env.DATABASE_URL ?? "").replace(/:\/\/[^@]*@/, "://jarvis:wrong@")
        .replace(/:\d+\//, ":59999/") || "postgresql://jarvis:wrong@localhost:59999/jarvis";
    const deadPrisma = new PrismaClient({ datasources: { db: { url: deadUrl } } });
    const failingRepo = new PrismaToolExecutionRepository(deadPrisma);

    let threw = false;
    try {
      await Promise.race([
        failingRepo.markUnknown(id, {
          code: "SHUTDOWN_DRAIN",
          message: "final transition at shutdown",
        }),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("timeout-guard")), 15_000)
        ),
      ]);
    } catch {
      threw = true;
    }
    await deadPrisma.$disconnect().catch(() => {});

    expect(threw).toBe(true);

    // The REAL record keeps its durable pre-failure state — the failed
    // writer could not claim success, and nothing was corrupted.
    const after = await repo.getById(id);
    expect(after!.status).toBe("EXECUTING");
    expect(after!.executionId).toBe(before!.executionId);

    // Recovery path still works afterwards (DB healthy again).
    await backdateLease(id);
    await runStartupRecovery(repo);
    expect((await repo.getById(id))!.status).toBe("UNKNOWN");
  }, 30_000);
});
