import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), "../../.env") });

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaN8nRepository } from "../src/repositories/n8n-repository.js";

// ---------------------------------------------------------------------------
// Sprint 5.4 — n8n persistence against real PostgreSQL.
//
// Both idempotency guarantees ARE unique constraints, so they can only be
// proven by the database rejecting the second write. A fake repository would
// assert its own implementation, not the invariant.
// ---------------------------------------------------------------------------

const prisma = new PrismaClient();

let dbUp = false;
try {
  await prisma.$queryRaw`SELECT 1`;
  dbUp = true;
} catch {
  dbUp = false;
}

let userA: string | null = null;
let userB: string | null = null;
let workflowA: string | null = null;
let workflowB: string | null = null;

async function makeUser(label: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `sprint54-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@jarvis-test.local`,
      name: `Sprint 5.4 ${label}`,
      password: "not-a-real-password-hash",
      role: "VIEWER",
    },
  });
  return user.id;
}

beforeAll(async () => {
  if (!dbUp) return;
  userA = await makeUser("a");
  userB = await makeUser("b");
  workflowA = (
    await prisma.n8nWorkflow.create({
      data: { userId: userA, name: "A workflow", webhookPath: `path-a-${Date.now()}` },
    })
  ).id;
  workflowB = (
    await prisma.n8nWorkflow.create({
      data: { userId: userB, name: "B workflow", webhookPath: `path-b-${Date.now()}` },
    })
  ).id;
});

afterAll(async () => {
  // FK cascade removes workflows and executions with the user.
  for (const id of [userA, userB]) {
    if (id) await prisma.user.delete({ where: { id } }).catch(() => {});
  }
  await prisma.$disconnect();
});

describe.skipIf(!dbUp)("Sprint 5.4 — PrismaN8nRepository", () => {
  const repo = () => new PrismaN8nRepository(prisma);
  let counter = 0;
  const key = () => `idem-${Date.now()}-${++counter}`;

  beforeEach(async () => {
    await prisma.n8nExecution.deleteMany({ where: { userId: { in: [userA!, userB!] } } });
  });

  const begin = (userId: string, workflowId: string, idempotencyKey: string) =>
    repo().beginExecution({
      userId,
      workflowId,
      idempotencyKey,
      payloadHash: "a".repeat(64),
      traceId: "trace-x",
    });

  describe("workflow allow-list and tenant isolation", () => {
    it("resolves a workflow the user owns", async () => {
      const wf = await repo().findWorkflowForUser(userA!, workflowA!);
      expect(wf).not.toBeNull();
      expect(wf!.name).toBe("A workflow");
    });

    it("returns null for another tenant's workflow", async () => {
      expect(await repo().findWorkflowForUser(userA!, workflowB!)).toBeNull();
      expect(await repo().findWorkflowForUser(userB!, workflowA!)).toBeNull();
    });

    it("returns null for an inactive workflow", async () => {
      await prisma.n8nWorkflow.update({ where: { id: workflowB! }, data: { isActive: false } });
      expect(await repo().findWorkflowForUser(userB!, workflowB!)).toBeNull();
      await prisma.n8nWorkflow.update({ where: { id: workflowB! }, data: { isActive: true } });
    });

    it("lists only the caller's workflows", async () => {
      const forA = await repo().listWorkflowsForUser(userA!);
      expect(forA).toHaveLength(1);
      expect(forA[0].userId).toBe(userA);
    });
  });

  describe("outbound idempotency", () => {
    it("creates an execution on first claim", async () => {
      const { record, created } = await begin(userA!, workflowA!, key());
      expect(created).toBe(true);
      expect(record.status).toBe("TRIGGERED");
    });

    it("returns the EXISTING row for a repeated key", async () => {
      const k = key();
      const first = await begin(userA!, workflowA!, k);
      const second = await begin(userA!, workflowA!, k);

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.record.id).toBe(first.record.id);

      const rows = await prisma.n8nExecution.findMany({ where: { idempotencyKey: k } });
      expect(rows).toHaveLength(1);
    });

    it("converges under CONCURRENT claims — one workflow run, not five", async () => {
      // A read-then-write check would race here and start several runs.
      const k = key();
      const results = await Promise.all(
        Array.from({ length: 5 }, () => begin(userA!, workflowA!, k))
      );

      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(new Set(results.map((r) => r.record.id)).size).toBe(1);

      const rows = await prisma.n8nExecution.findMany({ where: { idempotencyKey: k } });
      expect(rows).toHaveLength(1);
    });

    it("records the payload hash for auditability", async () => {
      const { record } = await begin(userA!, workflowA!, key());
      const row = await prisma.n8nExecution.findUniqueOrThrow({ where: { id: record.id } });
      expect(row.payloadHash).toHaveLength(64);
      expect(row.traceId).toBe("trace-x");
    });
  });

  describe("callback application and inbound idempotency", () => {
    async function seeded() {
      const { record } = await begin(userA!, workflowA!, key());
      return record;
    }

    it("applies a success callback and returns the owning tenant", async () => {
      const record = await seeded();
      const result = await repo().applyCallback({
        eventId: `evt-${Date.now()}`,
        executionId: record.id,
        status: "success",
        remoteExecutionId: "n8n-1",
        summary: "done",
        errorMessage: null,
        timestamp: new Date(),
      });

      expect(result.applied).toBe(true);
      // Attribution must come from the row, not the payload.
      expect(result.userId).toBe(userA);
      expect(result.traceId).toBe("trace-x");

      const row = await prisma.n8nExecution.findUniqueOrThrow({ where: { id: record.id } });
      expect(row.status).toBe("SUCCEEDED");
      expect(row.completedAt).not.toBeNull();
    });

    it("applies an error callback", async () => {
      const record = await seeded();
      await repo().applyCallback({
        eventId: `evt-${Date.now()}-e`,
        executionId: record.id,
        status: "error",
        remoteExecutionId: null,
        summary: null,
        errorMessage: "node failed",
        timestamp: new Date(),
      });
      const row = await prisma.n8nExecution.findUniqueOrThrow({ where: { id: record.id } });
      expect(row.status).toBe("FAILED");
      expect(row.errorCode).toBe("WORKFLOW_FAILED");
    });

    it("suppresses a redelivered callback", async () => {
      const record = await seeded();
      const event = {
        eventId: `evt-dup-${Date.now()}`,
        executionId: record.id,
        status: "success" as const,
        remoteExecutionId: null,
        summary: "first",
        errorMessage: null,
        timestamp: new Date(),
      };
      const first = await repo().applyCallback(event);
      const second = await repo().applyCallback(event);

      expect(first.applied).toBe(true);
      expect(second).toMatchObject({ applied: false, duplicate: true });
    });

    it("suppresses CONCURRENT callbacks — exactly one wins", async () => {
      const record = await seeded();
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          repo().applyCallback({
            eventId: `evt-race-${Date.now()}-${i}`,
            executionId: record.id,
            status: "success",
            remoteExecutionId: null,
            summary: `attempt-${i}`,
            errorMessage: null,
            timestamp: new Date(),
          })
        )
      );
      expect(results.filter((r) => r.applied)).toHaveLength(1);
      expect(results.filter((r) => r.duplicate)).toHaveLength(4);
    });

    it("refuses a second, DIFFERENT event for a completed execution", async () => {
      const record = await seeded();
      await repo().applyCallback({
        eventId: `evt-one-${Date.now()}`,
        executionId: record.id,
        status: "success",
        remoteExecutionId: null,
        summary: "ok",
        errorMessage: null,
        timestamp: new Date(),
      });
      const second = await repo().applyCallback({
        eventId: `evt-two-${Date.now()}`,
        executionId: record.id,
        status: "error",
        remoteExecutionId: null,
        summary: null,
        errorMessage: "late failure",
        timestamp: new Date(),
      });

      expect(second.duplicate).toBe(true);
      const row = await prisma.n8nExecution.findUniqueOrThrow({ where: { id: record.id } });
      expect(row.status).toBe("SUCCEEDED");
    });

    it("reports notFound for an unknown execution id", async () => {
      const result = await repo().applyCallback({
        eventId: "evt-unknown",
        executionId: "does-not-exist",
        status: "success",
        remoteExecutionId: null,
        summary: null,
        errorMessage: null,
        timestamp: new Date(),
      });
      expect(result).toMatchObject({ applied: false, notFound: true });
    });
  });

  describe("failure recording", () => {
    it("marks an execution failed with an error code", async () => {
      const { record } = await begin(userA!, workflowA!, key());
      await repo().markFailed(record.id, "NETWORK_ERROR", "connection refused");

      const row = await prisma.n8nExecution.findUniqueOrThrow({ where: { id: record.id } });
      expect(row.status).toBe("FAILED");
      expect(row.errorCode).toBe("NETWORK_ERROR");
      expect(row.completedAt).not.toBeNull();
    });

    it("records the remote execution id on trigger", async () => {
      const { record } = await begin(userA!, workflowA!, key());
      await repo().markTriggered(record.id, "n8n-42", "accepted");
      const row = await prisma.n8nExecution.findUniqueOrThrow({ where: { id: record.id } });
      expect(row.remoteExecutionId).toBe("n8n-42");
      expect(row.status).toBe("TRIGGERED");
    });
  });

  describe("tenant isolation on read", () => {
    beforeEach(async () => {
      await begin(userA!, workflowA!, key());
      await begin(userB!, workflowB!, key());
    });

    it("lists only the caller's executions", async () => {
      const forA = await repo().listExecutionsForUser(userA!);
      expect(forA.length).toBeGreaterThan(0);
      expect(forA.every((e) => e.userId === userA)).toBe(true);
    });

    it("does not return another tenant's execution by id", async () => {
      const forB = await repo().listExecutionsForUser(userB!);
      const theirId = forB[0].id;
      expect(await repo().findExecutionForUser(userA!, theirId)).toBeNull();
      expect(await repo().findExecutionForUser(userB!, theirId)).not.toBeNull();
    });

    it("clamps the limit to a sane range", async () => {
      expect((await repo().listExecutionsForUser(userA!, { limit: 100000 })).length).toBeLessThan(201);
      expect((await repo().listExecutionsForUser(userA!, { limit: -5 })).length).toBeGreaterThan(0);
    });
  });
});
