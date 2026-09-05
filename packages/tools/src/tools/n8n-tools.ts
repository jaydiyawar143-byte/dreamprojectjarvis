import { BaseTool } from "../base-tool.js";
import type {
  ToolResult,
  ToolContext,
  IN8nRepository,
  N8nTriggerResult,
} from "@jarvis/core";

// ---------------------------------------------------------------------------
// n8n workflow trigger tool (Sprint 5.4)
// ---------------------------------------------------------------------------
// Triggering an automation is the broadest external side effect in JARVIS: the
// workflow on the other side can send email, move money, or call any API its
// author wired up. JARVIS cannot know what it does, so the tool is declared
// EXTERNAL_SIDE_EFFECT with requiresApproval and is gated by the existing
// RISK_REQUIRES_APPROVAL table in ToolApprovalService — the same mechanism as
// the Meta write tools and whatsapp.send, with no n8n-specific exemption.
//
// The caller supplies a JARVIS workflowId, never a URL or webhook path. The
// path is resolved server-side from the per-user allow-list, so a caller can
// neither reach another tenant's workflow nor aim the trigger at an arbitrary
// host.
// ---------------------------------------------------------------------------

export interface N8nTriggerOptions {
  signal?: AbortSignal;
}

/** Transport contract. The concrete implementation lives in @jarvis/n8n. */
export interface N8nTriggerProvider {
  triggerWorkflow(
    webhookPath: string,
    payload: Record<string, unknown>,
    correlation: { executionId: string; traceId: string },
    options?: N8nTriggerOptions
  ): Promise<N8nTriggerResult>;
}

/** Hashing + key derivation, injected so @jarvis/tools need not depend on @jarvis/n8n. */
export interface N8nKeyDeriver {
  hashPayload(payload: unknown): string;
  buildIdempotencyKey(userId: string, workflowId: string, payloadHash: string): string;
}

const MAX_PAYLOAD_BYTES = 64 * 1024;

/** Rejects anything that is not a plain JSON object of bounded size. */
export function validateTriggerPayload(raw: unknown): Record<string, unknown> | null {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  let serialized: string;
  try {
    serialized = JSON.stringify(raw);
  } catch {
    // Circular structures cannot be sent or hashed.
    return null;
  }
  if (typeof serialized !== "string") return null;
  if (Buffer.byteLength(serialized, "utf8") > MAX_PAYLOAD_BYTES) return null;
  return raw as Record<string, unknown>;
}

export class N8nTriggerWorkflowTool extends BaseTool {
  private readonly provider: N8nTriggerProvider;
  private readonly repo: IN8nRepository;
  private readonly keys: N8nKeyDeriver;

  constructor(provider: N8nTriggerProvider, repo: IN8nRepository, keys: N8nKeyDeriver) {
    super(
      "n8n.trigger",
      "Trigger n8n Workflow",
      "Start a registered n8n automation workflow. Requires human approval. The workflow may take actions outside JARVIS that cannot be undone.",
      "integration",
      [
        {
          name: "workflowId",
          type: "string",
          description: "JARVIS workflow id from the registered workflow list",
          required: true,
        },
        {
          name: "payload",
          type: "object",
          description: "JSON object passed to the workflow (max 64KB)",
          required: false,
        },
      ],
      true,
      ["read", "write"],
      "EXTERNAL_SIDE_EFFECT",
      "1.0.0",
      true
    );
    this.provider = provider;
    this.repo = repo;
    this.keys = keys;
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const workflowId = typeof params.workflowId === "string" ? params.workflowId.trim() : "";
    if (workflowId.length === 0) return this.failure("workflowId is required");

    const payload = validateTriggerPayload(params.payload);
    if (payload === null) {
      return this.failure("payload must be a JSON object no larger than 64KB");
    }

    // Server-side authorization AND allow-list resolution in one step. A
    // workflow belonging to another user is reported as not found, so this
    // cannot be used to probe which workflow ids exist.
    const workflow = await this.repo.findWorkflowForUser(context.userId, workflowId);
    if (!workflow) {
      return this.failure("Workflow not found or not available to this user");
    }

    // traceId is optional on ToolContext, but an execution row without one is
    // not auditable. Derive a stable fallback rather than storing an empty
    // string, so every run can still be correlated in the audit log.
    const traceId = context.traceId ?? `n8n-${context.userId}-${Date.now()}`;

    const payloadHash = this.keys.hashPayload(payload);
    const idempotencyKey = this.keys.buildIdempotencyKey(
      context.userId,
      workflow.id,
      payloadHash
    );

    // Claim an execution slot BEFORE contacting n8n, so a crash between the
    // claim and the request still leaves an auditable record.
    const { record, created } = await this.repo.beginExecution({
      userId: context.userId,
      workflowId: workflow.id,
      idempotencyKey,
      payloadHash,
      traceId,
    });

    if (!created) {
      // An identical trigger already ran. Report the original rather than
      // starting the workflow a second time.
      return this.success(
        {
          action: "n8n_trigger",
          workflowId: workflow.id,
          executionId: record.id,
          status: record.status,
          idempotent: true,
          message: "An identical trigger was already submitted; returning the original execution",
        },
        { toolId: this.id, risk: this.risk, userId: context.userId }
      );
    }

    let result: N8nTriggerResult;
    try {
      result = await this.provider.triggerWorkflow(
        workflow.webhookPath,
        payload,
        { executionId: record.id, traceId },
        { signal: context.signal }
      );
    } catch (err) {
      const classified = (err as { classified?: { code: string; sideEffectPossible: boolean } })
        .classified;
      const message = err instanceof Error ? err.message : "n8n trigger failed";

      // A transmitted request may have started a workflow. Recording it as
      // FAILED would invite a retry that double-fires; the row stays TRIGGERED
      // (ambiguous) exactly as the Phase 10 journal treats UNKNOWN.
      if (classified?.sideEffectPossible) {
        return this.failure(
          `${message} — the workflow may have started; check the n8n execution log before retrying`
        );
      }

      await this.repo
        .markFailed(record.id, classified?.code ?? "INTERNAL_ERROR", message)
        .catch(() => {});
      return this.failure(message);
    }

    await this.repo
      .markTriggered(record.id, result.remoteExecutionId, result.responseSummary)
      .catch(() => {
        // The workflow HAS started. A bookkeeping failure must not be reported
        // as a trigger failure, which would invite a duplicate run.
      });

    return this.success(
      {
        action: "n8n_trigger",
        workflowId: workflow.id,
        workflowName: workflow.name,
        executionId: record.id,
        remoteExecutionId: result.remoteExecutionId,
        status: "TRIGGERED",
        idempotent: false,
      },
      { toolId: this.id, risk: this.risk, userId: context.userId }
    );
  }
}
