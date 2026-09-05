import type { PrismaClient } from "@prisma/client";
import type {
  IN8nRepository,
  N8nWorkflowRecord,
  N8nExecutionRecord,
  N8nExecutionStatus,
  N8nCallbackEvent,
  RecordCallbackResult,
} from "@jarvis/core";

// ---------------------------------------------------------------------------
// PrismaN8nRepository (Sprint 5.4)
// ---------------------------------------------------------------------------
// Three invariants live here:
//
//  1. TENANT ISOLATION. Every lookup is filtered by userId. A workflow or
//     execution belonging to another user reads as "not found", never as
//     "forbidden" — IDOR-safe, and it does not confirm the id exists.
//
//  2. OUTBOUND IDEMPOTENCY. beginExecution relies on the unique constraint on
//     idempotency_key rather than a read-then-write check, which would race
//     under concurrent triggers and start two workflow runs.
//
//  3. INBOUND IDEMPOTENCY. applyCallback claims callback_event_id in the same
//     UPDATE that writes the result, and only for a row that has not already
//     been completed. A redelivered callback therefore matches no row.
// ---------------------------------------------------------------------------

const UNIQUE_CONSTRAINT = "P2002";

function toWorkflow(row: {
  id: string;
  userId: string;
  name: string;
  webhookPath: string;
  isActive: boolean;
  createdAt: Date;
}): N8nWorkflowRecord {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    webhookPath: row.webhookPath,
    isActive: row.isActive,
    createdAt: row.createdAt,
  };
}

function toExecution(row: {
  id: string;
  userId: string;
  workflowId: string;
  idempotencyKey: string;
  remoteExecutionId: string | null;
  status: string;
  payloadHash: string;
  callbackEventId: string | null;
  resultSummary: string | null;
  errorCode: string | null;
  traceId: string;
  triggeredAt: Date;
  completedAt: Date | null;
}): N8nExecutionRecord {
  return {
    id: row.id,
    userId: row.userId,
    workflowId: row.workflowId,
    idempotencyKey: row.idempotencyKey,
    remoteExecutionId: row.remoteExecutionId,
    status: row.status as N8nExecutionStatus,
    payloadHash: row.payloadHash,
    callbackEventId: row.callbackEventId,
    resultSummary: row.resultSummary,
    errorCode: row.errorCode,
    traceId: row.traceId,
    triggeredAt: row.triggeredAt,
    completedAt: row.completedAt,
  };
}

export class PrismaN8nRepository implements IN8nRepository {
  constructor(private prisma: PrismaClient) {}

  async findWorkflowForUser(
    userId: string,
    workflowId: string
  ): Promise<N8nWorkflowRecord | null> {
    const row = await this.prisma.n8nWorkflow.findFirst({
      // userId is part of the filter, not a post-hoc check.
      where: { id: workflowId, userId, isActive: true },
    });
    return row ? toWorkflow(row) : null;
  }

  async listWorkflowsForUser(userId: string): Promise<N8nWorkflowRecord[]> {
    const rows = await this.prisma.n8nWorkflow.findMany({
      where: { userId, isActive: true },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toWorkflow);
  }

  async beginExecution(input: {
    userId: string;
    workflowId: string;
    idempotencyKey: string;
    payloadHash: string;
    traceId: string;
  }): Promise<{ record: N8nExecutionRecord; created: boolean }> {
    try {
      const row = await this.prisma.n8nExecution.create({
        data: {
          userId: input.userId,
          workflowId: input.workflowId,
          idempotencyKey: input.idempotencyKey,
          payloadHash: input.payloadHash,
          traceId: input.traceId,
          status: "TRIGGERED",
        },
      });
      return { record: toExecution(row), created: true };
    } catch (err) {
      if ((err as { code?: string }).code !== UNIQUE_CONSTRAINT) throw err;

      // Someone already claimed this exact (user, workflow, payload). Return
      // the existing row so the caller reports the original run instead of
      // starting a second one.
      const existing = await this.prisma.n8nExecution.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (!existing) throw err;
      return { record: toExecution(existing), created: false };
    }
  }

  async markTriggered(
    executionId: string,
    remoteExecutionId: string | null,
    responseSummary: string | null
  ): Promise<void> {
    await this.prisma.n8nExecution.update({
      where: { id: executionId },
      data: { remoteExecutionId, resultSummary: responseSummary, status: "TRIGGERED" },
    });
  }

  async markFailed(executionId: string, errorCode: string, message: string): Promise<void> {
    await this.prisma.n8nExecution.update({
      where: { id: executionId },
      data: {
        status: "FAILED",
        errorCode,
        resultSummary: message,
        completedAt: new Date(),
      },
    });
  }

  async applyCallback(event: N8nCallbackEvent): Promise<RecordCallbackResult> {
    const existing = await this.prisma.n8nExecution.findUnique({
      where: { id: event.executionId },
    });
    if (!existing) {
      return { applied: false, duplicate: false, notFound: true };
    }
    // Attribution comes from the row JARVIS created, never from the payload.
    const owner = { userId: existing.userId, traceId: existing.traceId };

    // Already carries a callback: this is a redelivery of a result we applied.
    if (existing.callbackEventId !== null) {
      return { applied: false, duplicate: true, notFound: false, ...owner };
    }

    try {
      // The conditional updateMany is what makes this atomic: two concurrent
      // callbacks race on `callbackEventId: null` and exactly one wins.
      const result = await this.prisma.n8nExecution.updateMany({
        where: { id: event.executionId, callbackEventId: null },
        data: {
          callbackEventId: event.eventId,
          status: event.status === "success" ? "SUCCEEDED" : "FAILED",
          resultSummary: event.summary ?? existing.resultSummary,
          errorCode: event.status === "error" ? "WORKFLOW_FAILED" : null,
          remoteExecutionId: event.remoteExecutionId ?? existing.remoteExecutionId,
          completedAt: new Date(),
        },
      });
      if (result.count === 0) {
        return { applied: false, duplicate: true, notFound: false, ...owner };
      }
      return { applied: true, duplicate: false, notFound: false, ...owner };
    } catch (err) {
      // The unique index on callback_event_id caught a replay of the SAME event
      // id against a different execution.
      if ((err as { code?: string }).code === UNIQUE_CONSTRAINT) {
        return { applied: false, duplicate: true, notFound: false, ...owner };
      }
      throw err;
    }
  }

  async listExecutionsForUser(
    userId: string,
    options?: { workflowId?: string; limit?: number }
  ): Promise<N8nExecutionRecord[]> {
    const rows = await this.prisma.n8nExecution.findMany({
      where: { userId, ...(options?.workflowId ? { workflowId: options.workflowId } : {}) },
      orderBy: { triggeredAt: "desc" },
      take: Math.min(Math.max(options?.limit ?? 50, 1), 200),
    });
    return rows.map(toExecution);
  }

  async findExecutionForUser(
    userId: string,
    executionId: string
  ): Promise<N8nExecutionRecord | null> {
    const row = await this.prisma.n8nExecution.findFirst({
      where: { id: executionId, userId },
    });
    return row ? toExecution(row) : null;
  }
}
