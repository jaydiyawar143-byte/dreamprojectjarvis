// ---------------------------------------------------------------------------
// n8n automation domain types (Sprint 5.4)
// ---------------------------------------------------------------------------
// The integration model is the one docs/ARCHITECTURE.md §9.1 already specifies:
//
//   - n8n runs as a separate service
//   - JARVIS communicates via REST webhooks
//   - JARVIS triggers workflows and receives results
//
// That last clause is why this is bidirectional: an outbound trigger starts a
// workflow, and n8n calls back asynchronously with the result. Both directions
// need their own authentication, and they use DIFFERENT secrets in opposite
// directions (see packages/n8n/src/config.ts).
// ---------------------------------------------------------------------------

/**
 * Lifecycle of one workflow run.
 *
 * TRIGGERED is the ambiguous state: the request left JARVIS but no callback has
 * arrived. It is deliberately NOT treated as failure — an automation may have
 * side effects even if we never hear back, so it must never be auto-retried.
 * This mirrors the UNKNOWN status in the Phase 10 tool execution journal.
 */
export type N8nExecutionStatus = "TRIGGERED" | "SUCCEEDED" | "FAILED" | "TIMED_OUT";

export interface N8nWorkflowRecord {
  id: string;
  userId: string;
  /** Operator-facing name. */
  name: string;
  /** n8n webhook path segment, e.g. "abc-123-def". Never a full URL. */
  webhookPath: string;
  isActive: boolean;
  createdAt: Date;
}

export interface N8nExecutionRecord {
  id: string;
  userId: string;
  workflowId: string;
  /** Deterministic key making a retried trigger a no-op. */
  idempotencyKey: string;
  /** n8n's own execution id, when it reports one. */
  remoteExecutionId: string | null;
  status: N8nExecutionStatus;
  /** SHA-256 of the request payload — auditable without storing the payload. */
  payloadHash: string;
  /** Callback event id, once a result has been applied. Blocks replay. */
  callbackEventId: string | null;
  resultSummary: string | null;
  errorCode: string | null;
  traceId: string;
  triggeredAt: Date;
  completedAt: Date | null;
}

export interface N8nTriggerResult {
  /** n8n execution id when the instance returns one; null for fire-and-forget. */
  remoteExecutionId: string | null;
  /** Response body n8n returned synchronously, already size-bounded. */
  responseSummary: string | null;
}

/** Result payload posted back by an n8n workflow when it finishes. */
export interface N8nCallbackEvent {
  /** Unique per delivery. The replay/dedup key. */
  eventId: string;
  /** JARVIS execution id this result belongs to. */
  executionId: string;
  status: "success" | "error";
  remoteExecutionId: string | null;
  /** Free-form summary from the workflow, truncated before storage. */
  summary: string | null;
  errorMessage: string | null;
  timestamp: Date;
}

export interface RecordCallbackResult {
  applied: boolean;
  duplicate: boolean;
  /** True when no execution with this id exists. */
  notFound: boolean;
  /**
   * Owning tenant and trace of the affected execution, when one was found.
   *
   * The repository returns these because the callback itself cannot be trusted
   * to name a tenant: attribution must come from the row JARVIS created when it
   * triggered the workflow, never from the inbound payload.
   */
  userId?: string;
  traceId?: string;
}

export interface IN8nRepository {
  /**
   * Resolves a workflow the user is allowed to trigger. Returns null when the
   * workflow does not exist OR belongs to another user — the caller must not be
   * able to tell those apart.
   */
  findWorkflowForUser(userId: string, workflowId: string): Promise<N8nWorkflowRecord | null>;

  listWorkflowsForUser(userId: string): Promise<N8nWorkflowRecord[]>;

  /**
   * Claims an execution slot. A repeated idempotencyKey returns the EXISTING
   * row with created=false, so a retried trigger never starts a second run.
   */
  beginExecution(input: {
    userId: string;
    workflowId: string;
    idempotencyKey: string;
    payloadHash: string;
    traceId: string;
  }): Promise<{ record: N8nExecutionRecord; created: boolean }>;

  /** Records what n8n returned synchronously. */
  markTriggered(
    executionId: string,
    remoteExecutionId: string | null,
    responseSummary: string | null
  ): Promise<void>;

  /** Records a trigger that never reached, or was rejected by, n8n. */
  markFailed(executionId: string, errorCode: string, message: string): Promise<void>;

  /** Applies an async result. Idempotent on callbackEventId. */
  applyCallback(event: N8nCallbackEvent): Promise<RecordCallbackResult>;

  /** Tenant-scoped audit read. Never returns another user's executions. */
  listExecutionsForUser(
    userId: string,
    options?: { workflowId?: string; limit?: number }
  ): Promise<N8nExecutionRecord[]>;

  findExecutionForUser(userId: string, executionId: string): Promise<N8nExecutionRecord | null>;
}
