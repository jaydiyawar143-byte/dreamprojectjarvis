// PHASE 10.4 — timeout/abort classification SURVIVES journal persistence.
// Real PostgreSQL (skipped when DB is down): FAILED(CANCELLED_BEFORE_SEND),
// UNKNOWN(AMBIGUOUS_OUTCOME) and SUCCEEDED transitions persist with error
// codes, traceId, provider and timestamps — and secrets are redacted.
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
      email: `phase104-pgtest-${Date.now()}@jarvis-test.local`,
      name: "Phase 10.4 Timeout Classification Test",
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

describe.skipIf(!dbUp)("PHASE 10.4 — classification survives persistence", () => {
  it("pre-send cancellation persists as FAILED CANCELLED_BEFORE_SEND with traceId", async () => {
    if (!dbUp) return;
    const repo = new PrismaToolExecutionRepository(prisma);
    const rec = await repo.begin({
      userId: testUserId!,
      toolId: "meta.campaign.pause",
      idempotencyKey: `pg104-presend:${Date.now()}`,
      provider: "meta-ads",
      traceId: "trace-104-a",
    });
    expect(await repo.claimForExecution(rec.executionId, { ownerId: "w1", leaseMs: 60_000 })).not.toBeNull();
    await repo.markFailed(rec.executionId, {
      code: "CANCELLED_BEFORE_SEND",
      message: "Meta request aborted before transmission",
    });
    const done = await repo.getById(rec.executionId);
    expect(done!.status).toBe("FAILED");
    expect(done!.errorCode).toBe("CANCELLED_BEFORE_SEND");
    expect(done!.traceId).toBe("trace-104-a");
    expect(done!.provider).toBe("meta-ads");
    expect(done!.completedAt).toBeInstanceOf(Date);
  });

  it("ambiguous in-flight abort persists as UNKNOWN AMBIGUOUS_OUTCOME", async () => {
    if (!dbUp) return;
    const repo = new PrismaToolExecutionRepository(prisma);
    const rec = await repo.begin({
      userId: testUserId!,
      toolId: "meta.campaign.pause",
      idempotencyKey: `pg104-unknown:${Date.now()}`,
      provider: "meta-ads",
      traceId: "trace-104-b",
    });
    await repo.claimForExecution(rec.executionId, { ownerId: "w1", leaseMs: 60_000 });
    await repo.markUnknown(rec.executionId, {
      code: "AMBIGUOUS_OUTCOME",
      message: "Meta POST request aborted in flight; provider outcome uncertain",
    });
    const done = await repo.getById(rec.executionId);
    expect(done!.status).toBe("UNKNOWN");
    expect(done!.errorCode).toBe("AMBIGUOUS_OUTCOME");
    expect(done!.completedAt).toBeInstanceOf(Date);
  });

  it("secrets embedded in transport errors are redacted before persistence", async () => {
    if (!dbUp) return;
    const repo = new PrismaToolExecutionRepository(prisma);
    const rec = await repo.begin({
      userId: testUserId!,
      toolId: "meta.campaign.pause",
      idempotencyKey: `pg104-secret:${Date.now()}`,
      provider: "meta-ads",
    });
    await repo.claimForExecution(rec.executionId, { ownerId: "w1", leaseMs: 60_000 });
    await repo.markUnknown(rec.executionId, {
      code: "AMBIGUOUS_OUTCOME",
      message: "timeout after send access_token=EAAsupersecret123 value",
    });
    const done = await repo.getById(rec.executionId);
    expect(done!.errorMessage).not.toContain("EAAsupersecret123");
    expect(done!.errorMessage).not.toContain("access_token=");
  });

  it("success classification persists as SUCCEEDED with external resource id", async () => {
    if (!dbUp) return;
    const repo = new PrismaToolExecutionRepository(prisma);
    const rec = await repo.begin({
      userId: testUserId!,
      toolId: "meta.campaign.pause",
      idempotencyKey: `pg104-success:${Date.now()}`,
      provider: "meta-ads",
    });
    await repo.claimForExecution(rec.executionId, { ownerId: "w1", leaseMs: 60_000 });
    await repo.markSucceeded(rec.executionId, "100000001");
    const done = await repo.getById(rec.executionId);
    expect(done!.status).toBe("SUCCEEDED");
    expect(done!.externalResourceId).toBe("100000001");
    expect(done!.leaseUntil).toBeUndefined();
  });

  it("UNKNOWN persisted rows are never claimable again (no auto retry)", async () => {
    if (!dbUp) return;
    const repo = new PrismaToolExecutionRepository(prisma);
    const rec = await repo.begin({
      userId: testUserId!,
      toolId: "meta.campaign.pause",
      idempotencyKey: `pg104-noretry:${Date.now()}`,
      provider: "meta-ads",
    });
    await repo.claimForExecution(rec.executionId, { ownerId: "w1", leaseMs: 60_000 });
    await repo.markUnknown(rec.executionId, { code: "AMBIGUOUS_OUTCOME" });
    expect(await repo.claimForExecution(rec.executionId, { ownerId: "w2" })).toBeNull();
  });
});
