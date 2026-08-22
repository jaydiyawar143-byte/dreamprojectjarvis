import type {
  ExecutionJournalPort,
  ExecutionReconciler,
  IAuditRepository,
  ReconciliationClaimOptions,
  ReconciliationEvidence,
  ReconciliationOutcome,
  ReconciliationReasonCode,
  RecoveryOptions,
  RecoveryResult,
} from "@jarvis/core";
import { DEFAULT_LEASE_MS, redactSecrets } from "@jarvis/core";

// ---------------------------------------------------------------------------
// ReconciliationService â€” Phase 10.5 orchestration
// ---------------------------------------------------------------------------
// Turns UNKNOWN into a determined outcome WITHOUT ever executing a new Meta
// write:
//
//   UNKNOWN --claim--> RECONCILING --query--> SUCCEEDED     (FOUND)
//                                          -> SAFE_TO_RETRY (authoritative
//                                                           NOT_FOUND; NO
//                                                           automatic retry
//                                                           happens here)
//                                          -> UNKNOWN       (UNCERTAIN /
//                                                           PROVIDER_ERROR)
//
// Safety properties enforced here:
//   * Isolation chain before every query: requester === record owner,
//     account parsed from the durable idempotency key (never AI-supplied),
//     account authorized for the user, account equals the server-configured
//     account. Any gap refuses the attempt and leaves state untouched.
//   * Single worker per execution via the durable journal lease; concurrent
//     attempts converge on exactly one RECONCILING claim.
//   * The provider query runs AT MOST ONCE per active lease.
//   * Every attempt (including refusals) produces a sanitized audit record.
//   * Crashes mid-reconciliation are recovered by recoverStaleReconciliations
//     (stale RECONCILING -> UNKNOWN); nothing ever becomes FAILED implicitly
//     and nothing is retried automatically.
// ---------------------------------------------------------------------------

/** Only campaign creation is reconcilable in Phase 10.5 (highest-risk proven write). */
const RECONCILABLE_TOOLS: ReadonlyMap<string, ReconciliationResourceKind> = new Map([
  ["meta.campaign.create", "campaign"],
]);

type ReconciliationResourceKind = "campaign";

export interface ReconciliationRequest {
  executionId: string;
  /** The user on whose behalf reconciliation runs â€” must own the record. */
  requestedByUserId: string;
  traceId?: string;
}

export interface ReconciliationAttemptResult {
  /** Terminal journal state after the attempt (or current state when refused). */
  status:
    | "SUCCEEDED"
    | "SAFE_TO_RETRY"
    | "UNKNOWN"
    | "RECONCILING"
    | "NOT_ELIGIBLE"
    | "REFUSED";
  outcome?: ReconciliationOutcome;
  reasonCode?: ReconciliationReasonCode;
  executionId: string;
  externalResourceId?: string;
  detail: string;
}

export interface ReconciliationServiceDeps {
  journal: ExecutionJournalPort;
  reconciler: ExecutionReconciler;
  /**
   * Account authorization port. `getAuthorizedAccountIds`/`isAuthorized` are
   * consulted server-side; AI-supplied account IDs can never steer
   * reconciliation because the target account is derived from the durable
   * idempotency key and cross-checked against `configuredAccountId`.
   */
  authorizer: {
    isAuthorized(userId: string, accountId: string): Promise<boolean>;
  };
  /** Optional structured audit sink; every attempt is recorded when present. */
  audit?: Pick<IAuditRepository, "create">;
  /**
   * Server-configured ad account. When set, executions whose derived account
   * differs are refused outright (account isolation hard stop).
   */
  configuredAccountId?: string;
  ownerIdPrefix?: string;
  leaseMs?: number;
  now?: () => Date;
}

/**
 * Extracts reconciliation evidence from the durable idempotency key of the
 * campaign-creation tool.
 *
 * Key format (buildIdempotencyKey):
 *   meta.campaign.create:act_<digits>:proposal:<name>:<objective>
 * Names may contain colons; everything between "proposal:" and the final
 * segment round-trips losslessly.
 *
 * The account comes from the KEY â€” written at begin() time from validated,
 * server-checked parameters â€” never from caller input.
 */
export function parseCreateCampaignEvidence(
  idempotencyKey: string
): { accountId: string; campaignName: string; objective: string } | null {
  const segments = idempotencyKey.split(":");
  const [toolId, accountId] = segments;
  if (toolId !== "meta.campaign.create") return null;
  if (!accountId || !/^act_\d+$/.test(accountId)) return null;
  if (segments[2] !== "proposal" || segments.length < 5) return null;
  const objective = segments[segments.length - 1];
  const campaignName = segments.slice(3, -1).join(":");
  if (!campaignName || !objective) return null;
  return { accountId, campaignName, objective };
}

export class ReconciliationService {
  private readonly deps: Required<Omit<ReconciliationServiceDeps, "audit" | "configuredAccountId">> &
    Pick<ReconciliationServiceDeps, "audit" | "configuredAccountId">;

  constructor(deps: ReconciliationServiceDeps) {
    this.deps = {
      ...deps,
      ownerIdPrefix: deps.ownerIdPrefix ?? "reconcile",
      leaseMs: deps.leaseMs ?? DEFAULT_LEASE_MS,
      now: deps.now ?? (() => new Date()),
    };
  }

  async reconcile(request: ReconciliationRequest): Promise<ReconciliationAttemptResult> {
    const startedAt = this.deps.now();
    const { journal } = this.deps;
    const base = {
      executionId: request.executionId,
      traceId: request.traceId,
      toolId: undefined as string | undefined,
    };

    // ---- Load -------------------------------------------------------------
    const record = await journal.getById(request.executionId);
    if (!record) {
      return {
        status: "REFUSED",
        executionId: request.executionId,
        detail: "Execution record not found",
      };
    }
    base.toolId = record.toolId;
    // Snapshot: journal records are live objects; the status read here must
    // describe the state BEFORE the attempt, even after finalization mutates
    // the underlying row.
    const previousStatus = record.status;

    // ---- Isolation guard 1: ownership -------------------------------------
    if (record.userId !== request.requestedByUserId) {
      return this.refuse(base, record.status, "AUTHORIZATION_FAILED", {
        code: "RECONCILE_WRONG_USER",
        message: "Execution belongs to a different user",
        auditUser: request.requestedByUserId,
        startedAt,
      });
    }

    // ---- Guard: paramsHash binding ----------------------------------------
    if (!record.paramsHash) {
      return this.refuse(base, record.status, "PARAMS_HASH_MISSING", {
        code: "RECONCILE_NO_PARAMS_HASH",
        message: "Execution has no bound paramsHash; reconciliation is refused (fail-closed)",
        auditUser: request.requestedByUserId,
        startedAt,
      });
    }

    // ---- Idempotent eligibility: only UNKNOWN reconciles -------------------
    // SUCCEEDED / SAFE_TO_RETRY / FAILED / CANCELLED / PENDING / APPROVED /
    // EXECUTING / RECONCILING are all left untouched by a second call.
    if (record.status !== "UNKNOWN") {
      return {
        status: "NOT_ELIGIBLE",
        executionId: record.executionId,
        detail: `Execution is ${record.status}; only UNKNOWN executions are reconciliation-eligible`,
      };
    }

    // ---- Evidence derivation (durable key only â€” never caller input) -------
    const kind = RECONCILABLE_TOOLS.get(record.toolId);
    if (!kind || kind !== "campaign") {
      return this.refuse(base, record.status, "UNSUPPORTED_OPERATION", {
        code: "RECONCILE_UNSUPPORTED_TOOL",
        message: `Tool ${record.toolId} has no reconciliation implementation in this phase`,
        auditUser: request.requestedByUserId,
        startedAt,
      });
    }
    const parsed = parseCreateCampaignEvidence(record.idempotencyKey);
    if (!parsed) {
      return this.refuse(base, record.status, "INSUFFICIENT_EVIDENCE", {
        code: "RECONCILE_UNPARSEABLE_KEY",
        message: "Idempotency key does not carry correlation evidence",
        auditUser: request.requestedByUserId,
        startedAt,
      });
    }

    // ---- Isolation guard 2: account chain ----------------------------------
    // userId -> authorized account -> execution account -> configured account.
    if (
      this.deps.configuredAccountId !== undefined &&
      normalizeAccount(parsed.accountId) !== normalizeAccount(this.deps.configuredAccountId)
    ) {
      return this.refuse(base, record.status, "ACCOUNT_MISMATCH", {
        code: "RECONCILE_ACCOUNT_MISMATCH",
        message: "Execution account does not match the configured reconciliation account",
        auditUser: request.requestedByUserId,
        startedAt,
      });
    }
    const authorized = await this.deps.authorizer.isAuthorized(
      request.requestedByUserId,
      parsed.accountId
    );
    if (!authorized) {
      return this.refuse(base, record.status, "AUTHORIZATION_FAILED", {
        code: "RECONCILE_ACCOUNT_NOT_AUTHORIZED",
        message: "User is not authorized for the execution account",
        auditUser: request.requestedByUserId,
        startedAt,
      });
    }

    // ---- Atomic single-winner claim ----------------------------------------
    const claimOptions: ReconciliationClaimOptions = {
      ownerId: `${this.deps.ownerIdPrefix}:${crypto.randomUUID()}`,
      leaseMs: this.deps.leaseMs,
    };
    let claimed;
    try {
      claimed = await journal.claimForReconciliation(record.executionId, claimOptions);
    } catch {
      return this.refuse(base, record.status, "JOURNAL_UNAVAILABLE", {
        code: "RECONCILE_JOURNAL_UNAVAILABLE",
        message: "Execution journal unavailable; nothing was claimed",
        auditUser: request.requestedByUserId,
        startedAt,
      });
    }
    if (!claimed) {
      return {
        status: "NOT_ELIGIBLE",
        executionId: record.executionId,
        detail:
          "Another worker owns the reconciliation claim, or the execution left the UNKNOWN state",
      };
    }

    // ---- Provider query: AT MOST ONCE per active lease ---------------------
    const evidence: ReconciliationEvidence = {
      executionId: record.executionId,
      userId: record.userId,
      toolId: record.toolId,
      provider: record.provider,
      idempotencyKey: record.idempotencyKey,
      paramsHash: record.paramsHash,
      accountId: parsed.accountId,
      resource: {
        kind: "campaign",
        name: parsed.campaignName,
        objective: parsed.objective,
      },
      createdAfter: record.startedAt ?? record.createdAt,
      createdBefore: this.deps.now(),
    };

    let result;
    try {
      result = await this.deps.reconciler.reconcile(evidence);
    } catch (err) {
      // Reconcilers should catch their own transport errors; a throw here is
      // treated as network uncertainty â€” NEVER absence.
      result = {
        outcome: "UNCERTAIN" as const,
        authoritative: false,
        reasonCode: "NETWORK_FAILURE" as ReconciliationReasonCode,
        detail: redactSecrets(err instanceof Error ? err.message : String(err)),
      };
    }

    // ---- Deterministic classification -> atomic finalization ---------------
    const decision =
      result.outcome === "FOUND" &&
      result.authoritative &&
      result.externalResourceId !== undefined
        ? {
            status: "SUCCEEDED" as const,
            outcome: result.outcome,
            externalResourceId: result.externalResourceId,
          }
        : result.outcome === "NOT_FOUND" && result.authoritative
          ? {
              status: "SAFE_TO_RETRY" as const,
              outcome: result.outcome,
              error: {
                code: "RESOLVED_NOT_FOUND",
                message: redactSecrets(result.detail ?? "Authoritative NOT_FOUND"),
              },
            }
          : {
              status: "UNKNOWN" as const,
              outcome: result.outcome,
              error: {
                code: result.reasonCode ?? "RECONCILIATION_INCONCLUSIVE",
                message: redactSecrets(result.detail ?? "Reconciliation could not determine the external outcome"),
              },
            };

    let finalized;
    try {
      finalized = await journal.finalizeReconciliation(
        record.executionId,
        claimOptions.ownerId!,
        decision
      );
    } catch {
      // Journal unavailable mid-reconciliation: the row remains RECONCILING
      // until stale-recovery maps it back to UNKNOWN. Never escape as success.
      await this.writeAudit({
        userId: request.requestedByUserId,
        toolId: record.toolId,
        action: "tool.execution.reconcile",
        result: "failure",
        traceId: request.traceId,
        parameters: this.auditParams(record, undefined, "JOURNAL_UNAVAILABLE", startedAt, previousStatus),
        metadata: { executionId: record.executionId },
      });
      return {
        status: "RECONCILING",
        outcome: result.outcome,
        reasonCode: "JOURNAL_UNAVAILABLE",
        executionId: record.executionId,
        detail:
          "Provider query completed but finalization failed; the record stays leased and will be recovered to UNKNOWN",
      };
    }

    if (!finalized) {
      // Lost the lease between query and finalization (crash recovery raced).
      return {
        status: "NOT_ELIGIBLE",
        outcome: result.outcome,
        executionId: record.executionId,
        detail: "Reconciliation lease was lost before finalization; another worker owns the record",
      };
    }

    await this.writeAudit({
      userId: request.requestedByUserId,
      toolId: record.toolId,
      action: "tool.execution.reconcile",
      result: decision.status === "UNKNOWN" ? "failure" : "success",
      traceId: request.traceId,
      parameters: this.auditParams(record, result.outcome, result.reasonCode, startedAt, previousStatus),
      metadata: {
        executionId: record.executionId,
        externalResourceId:
          decision.externalResourceId !== undefined ? decision.externalResourceId : undefined,
      },
    });

    return {
      status:
        finalized.status === "SUCCEEDED"
          ? "SUCCEEDED"
          : finalized.status === "SAFE_TO_RETRY"
            ? "SAFE_TO_RETRY"
            : "UNKNOWN",
      outcome: result.outcome,
      reasonCode: result.reasonCode,
      executionId: finalized.executionId,
      externalResourceId: finalized.externalResourceId,
      detail: redactSecrets(result.detail ?? "reconciliation complete"),
    };
  }

  /**
   * Crash-recovery pass: stale RECONCILING rows become UNKNOWN again after
   * lease expiry. Never FAILED, never retried. Safe to run repeatedly and
   * concurrently with reconcile().
   */
  async recoverStaleReconciliations(options?: RecoveryOptions): Promise<RecoveryResult> {
    return this.deps.journal.recoverStaleReconciliations(options);
  }

  private async refuse(
    base: { executionId: string; traceId?: string; toolId?: string },
    previousStatus: string,
    reasonCode: ReconciliationReasonCode,
    info: {
      code: string;
      message: string;
      auditUser: string;
      startedAt: Date;
    }
  ): Promise<ReconciliationAttemptResult> {
    await this.writeAudit({
      userId: info.auditUser,
      toolId: base.toolId,
      action: "tool.execution.reconcile",
      result: "rejected",
      traceId: base.traceId,
      parameters: {
        toolId: base.toolId ?? "",
        provider: "meta-ads",
        previousStatus,
        outcome: undefined,
        reasonCode,
        durationMs: Math.max(0, this.deps.now().getTime() - info.startedAt.getTime()),
      },
      metadata: { executionId: base.executionId },
    });
    return {
      status: "REFUSED",
      reasonCode,
      executionId: base.executionId,
      detail: info.message,
    };
  }

  private auditParams(
    record: { toolId: string; status: string; provider?: string },
    outcome: ReconciliationOutcome | undefined,
    reasonCode: ReconciliationReasonCode | undefined,
    startedAt: Date,
    previousStatusOverride?: string
  ): Record<string, unknown> {
    return {
      toolId: record.toolId,
      provider: record.provider ?? "meta-ads",
      previousStatus: previousStatusOverride ?? record.status,
      outcome,
      reasonCode,
      durationMs: Math.max(0, this.deps.now().getTime() - startedAt.getTime()),
    };
  }

  private async writeAudit(entry: {
    userId: string;
    toolId?: string;
    action: string;
    result: "success" | "failure" | "rejected";
    traceId?: string;
    parameters?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    if (!this.deps.audit) return;
    try {
      await this.deps.audit.create({
        userId: entry.userId,
        toolId: entry.toolId,
        action: entry.action,
        result: entry.result,
        traceId: entry.traceId,
        parameters: entry.parameters,
        metadata: entry.metadata,
      });
    } catch {
      // Audit unavailability must never corrupt reconciliation outcomes.
    }
  }
}

function normalizeAccount(accountId: string): string {
  const trimmed = accountId.trim();
  return /^act_\d+$/.test(trimmed) ? trimmed : /^\d+$/.test(trimmed) ? `act_${trimmed}` : trimmed;
}
