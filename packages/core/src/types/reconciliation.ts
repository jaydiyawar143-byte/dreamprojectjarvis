// ---------------------------------------------------------------------------
// Reconciliation contract (Phase 10.5) — provider-agnostic
// ---------------------------------------------------------------------------
// An UNKNOWN journal record means a real external write MAY have executed but
// its outcome could not be observed. Before any retry can ever be considered,
// the actual external state must be determined by querying the provider.
//
// This module defines the provider-neutral vocabulary ONLY:
//   - core owns the result shapes and the state machine (tool-execution.ts)
//   - meta-graph implements provider-specific matching (campaign correlation)
//   - tools orchestrate claims/leases/finalization/audit
// Core must never import Meta specifics.
//
// HARD RULES:
//   - UNKNOWN is never blindly retried.
//   - Only an AUTHORITATIVE absence produces NOT_FOUND.
//   - A timeout/rate-limit/malformed response is NEVER NOT_FOUND.
//   - A false-positive FOUND is worse than remaining UNKNOWN; when exact
//     correlation cannot be guaranteed, report UNCERTAIN instead of guessing.
// ---------------------------------------------------------------------------

/** Deterministic result of one provider reconciliation query. */
export type ReconciliationOutcome =
  | "FOUND"
  | "NOT_FOUND"
  | "UNCERTAIN"
  | "PROVIDER_ERROR";

/**
 * Sanitized reason codes recorded in audit trails and journal metadata.
 * Never embed raw provider payloads or credentials here.
 */
export type ReconciliationReasonCode =
  // FOUND evidence quality
  | "MATCHED_SINGLE_CANDIDATE"
  // authoritative absence
  | "NO_CANDIDATES"
  // ambiguity — stay UNKNOWN
  | "MULTIPLE_CANDIDATES"
  | "INSUFFICIENT_EVIDENCE"
  | "PARTIAL_PAGE"
  | "TIMEOUT"
  | "NETWORK_FAILURE"
  | "RATE_LIMITED"
  | "MALFORMED_RESPONSE"
  // provider errors — stay UNKNOWN
  | "AUTHENTICATION_FAILED"
  | "AUTHORIZATION_FAILED"
  | "PROVIDER_INTERNAL_ERROR"
  | "ACCOUNT_MISMATCH"
  // orchestration-level refusals — stay UNKNOWN
  | "PARAMS_HASH_MISSING"
  | "UNSUPPORTED_OPERATION"
  | "JOURNAL_UNAVAILABLE";

/** Operation-specific secondary correlation metadata (from original params). */
export interface ReconciliationResourceEvidence {
  kind: "campaign";
  /** Exact campaign name as sent to the provider. Secondary evidence only —
   *  names are not unique and may be renamed, so name alone never matches. */
  name?: string;
  objective?: string;
  /** Budgets exactly as transmitted (minor units, provider format). */
  dailyBudgetCents?: string;
  lifetimeBudgetCents?: string;
  buyingType?: string;
}

/**
 * Everything a reconciler may use to correlate an external resource with a
 * specific execution. Account isolation is enforced upstream (orchestration);
 * the evidence account is always the VERIFIED execution/configured account.
 */
export interface ReconciliationEvidence {
  executionId: string;
  userId: string;
  toolId: string;
  provider?: string;
  idempotencyKey: string;
  /** Required: executions without a bound paramsHash are refused (fail-closed). */
  paramsHash?: string;
  accountId: string;
  resource: ReconciliationResourceEvidence;
  /**
   * Correlation time window derived from durable journal timestamps. External
   * resources created outside this window cannot belong to this execution.
   */
  createdAfter?: Date;
  createdBefore?: Date;
}

export interface ReconciliationResult {
  outcome: ReconciliationOutcome;
  /** Provider resource ID — present ONLY for FOUND. */
  externalResourceId?: string;
  /**
   * true when the underlying query was complete and authoritative (full
   * result set retrieved, no degradation). Only `authoritative === true`
   * NOT_FOUND results may ever mark an execution safe-to-retry.
   */
  authoritative: boolean;
  reasonCode?: ReconciliationReasonCode;
  /** Short redacted human-readable detail for audit logs. */
  detail?: string;
}

/**
 * Implemented by provider packages (e.g. meta-graph). Must be read-only:
 * a reconciler queries external state and classifies; it never writes.
 */
export interface ExecutionReconciler {
  reconcile(evidence: ReconciliationEvidence): Promise<ReconciliationResult>;
}
