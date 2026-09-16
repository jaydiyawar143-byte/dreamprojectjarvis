import type {
  AuditLogger,
  IApprovalManager,
  IToolExecutor,
  ExternalEntityState,
  OutcomeStorePort,
  PerformanceSummary,
  RecommendationAction,
  RecommendationRecord,
  RecommendationStatus,
  Role,
} from "@jarvis/core";
import {
  DiagnosisCategorySchema,
  RecommendationRecordSchema,
  SERVICE_SHUTTING_DOWN_ERROR,
  baselineKpisFromEvidence,
  buildExecutableParams,
  captureBaselineSnapshot,
  computeParamsHash,
  derivePrimaryMetric,
  measureOutcome,
  redactSecrets,
  verifyRecommendationFreshness,
} from "@jarvis/core";
import type { MetaAccountAuthorizer } from "./tools/meta-ads-provider.js";
import { parseBudgetValue } from "./tools/meta-ads-validators.js";

// ---------------------------------------------------------------------------
// Phase 11.6A — Recommendation -> Safe Execution Bridge
// ---------------------------------------------------------------------------
// A recommendation is a DECISION ARTIFACT; ToolExecution remains the
// EXECUTION AUTHORITY. This adapter converts an approved recommendation into
// a request for an EXISTING Phase 10 tool and delegates every hard guarantee
// to the infrastructure that already owns it:
//
//   approval binding + one-time consumption .... ApprovalService +
//                                                PrismaApprovalRepository via
//                                                executor + tool consumption
//   idempotency / concurrency / UNKNOWN ........ ExecutionJournal (via tools)
//   timeouts / draining / audit ................ ToolExecutor lifecycle gate
//   account authorization ...................... MetaAccountAuthorizer inside
//                                                each tool (+ early check here)
//
// The bridge NEVER imports a Graph API client and NEVER invokes any HTTP
// transport directly. Live state is observed through
// READ-ONLY Meta tools executed by the same ToolExecutor (see
// createExecutorBackedExternalStatePort). An architectural test enforces this.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Explicit server-side action -> existing-tool allowlist
// ---------------------------------------------------------------------------

/** Static portion of the allowlist. Budget actions map onto TWO existing
 *  tools depending on the target level — resolved by resolveToolForAction. */
export const RECOMMENDATION_ACTION_TOOLS: Readonly<
  Record<RecommendationAction, string | { campaign: string; adSet: string }>
> = Object.freeze({
  PAUSE_CAMPAIGN: "meta.campaign.pause",
  RESUME_CAMPAIGN: "meta.campaign.resume",
  PAUSE_AD_SET: "meta.adset.pause",
  RESUME_AD_SET: "meta.adset.resume",
  PAUSE_AD: "meta.ad.pause",
  RESUME_AD: "meta.ad.resume",
  INCREASE_BUDGET: {
    campaign: "meta.campaign.budget.update",
    adSet: "meta.adset.budget.update",
  },
  DECREASE_BUDGET: {
    campaign: "meta.campaign.budget.update",
    adSet: "meta.adset.budget.update",
  },
});

export type AllowlistResolution =
  | { ok: true; toolId: string }
  | { ok: false; reason: "UNKNOWN_ACTION" | "UNSUPPORTED_LEVEL"; detail: string };

/** The ONE entity level each static action may ever target. */
const STATIC_ACTION_LEVELS: Readonly<
  Record<Exclude<RecommendationAction, "INCREASE_BUDGET" | "DECREASE_BUDGET">, string>
> = Object.freeze({
  PAUSE_CAMPAIGN: "CAMPAIGN",
  RESUME_CAMPAIGN: "CAMPAIGN",
  PAUSE_AD_SET: "AD_SET",
  RESUME_AD_SET: "AD_SET",
  PAUSE_AD: "AD",
  RESUME_AD: "AD",
});

/**
 * Resolve the ONE existing tool a recommendation may run through.
 * Unknown actions and unsupported levels are rejected — never mapped onto an
 * arbitrary tool name.
 */
export function resolveToolForAction(
  actionType: RecommendationAction,
  entityLevel: string
): AllowlistResolution {
  const entry = RECOMMENDATION_ACTION_TOOLS[actionType];
  if (!entry) {
    return {
      ok: false,
      reason: "UNKNOWN_ACTION",
      detail: `Action ${String(actionType)} is not on the execution allowlist`,
    };
  }
  if (typeof entry === "string") {
    const requiredLevel = STATIC_ACTION_LEVELS[actionType as keyof typeof STATIC_ACTION_LEVELS];
    if (entityLevel !== requiredLevel) {
      return {
        ok: false,
        reason: "UNSUPPORTED_LEVEL",
        detail: `${String(actionType)} applies to entity level ${requiredLevel}, got ${entityLevel}`,
      };
    }
    return { ok: true, toolId: entry };
  }
  if (entityLevel === "CAMPAIGN") return { ok: true, toolId: entry.campaign };
  if (entityLevel === "AD_SET") return { ok: true, toolId: entry.adSet };
  return {
    ok: false,
    reason: "UNSUPPORTED_LEVEL",
    detail: `No budget tool exists for entity level ${entityLevel}`,
  };
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** Store surface required by the bridge (satisfied by
 *  PrismaRecommendationRepository). */
export interface RecommendationExecutionStorePort {
  getForUser(id: string, userId: string): Promise<RecommendationRecord | null>;
  transition(
    id: string,
    userId: string,
    fromStatuses: readonly RecommendationStatus[],
    to: RecommendationStatus,
    patch?: { approvalId?: string; executionId?: string; staleReasons?: string[] }
  ): Promise<boolean>;
  linkExecution(
    id: string,
    userId: string,
    approvalId: string,
    executionId: string
  ): Promise<boolean>;
}

export interface RecommendationExecutionDeps {
  /** The ONE execution authority (Phase 10). */
  executor: Pick<IToolExecutor, "execute">;
  recommendations: RecommendationExecutionStorePort;
  /**
   * Durable-journal READ model used for authoritative outcome classification.
   * Journal row ids are owned by the tools layer (NOT the executor's request
   * id), so ambiguity checks locate rows by (userId, toolId, paramsHash).
   */
  journal?: {
    getById(id: string): Promise<import("@jarvis/core").ToolExecutionRecord | null>;
    findRecentByTool(
      userId: string,
      toolId: string,
      limit?: number
    ): Promise<import("@jarvis/core").ToolExecutionRecord[]>;
  };
  /**
   * Approval read surface (same Phase 10 manager the executor uses). Used to
   * recover WHICH approval was consumed for a completed execution so the
   * recommendation row can durably link approvalId + executionId.
   */
  approvals?: Pick<IApprovalManager, "findExistingForTool">;
  /**
   * Live external state for the requesting user — MUST be backed by the read
   * tools / provider abstraction, never a direct client (architectural test).
   */
  stateOf: (
    accountId: string,
    entityId: string,
    input: { userId: string; role: string }
  ) => Promise<ExternalEntityState | null>;
  /** Early authorization classification; the tool re-checks authoritatively. */
  authorizer?: Pick<MetaAccountAuthorizer, "isAuthorized">;
  /** Bridge-level linkage audit; executor/tool/approval audits stay intact. */
  audit?: AuditLogger;
  /**
   * R-32 — where an executed recommendation's outcome record is persisted.
   *
   * Optional, so every existing caller keeps working unchanged and a
   * deployment without it simply creates no outcome records. Creation runs
   * AFTER the advertising write has already succeeded and can never fail it:
   * a missing baseline or a failed write to this port is audited and
   * swallowed, because the external change has already happened and must not
   * be reported as anything but EXECUTED.
   */
  outcomes?: Pick<OutcomeStorePort, "create">;
  nowFn?: () => Date;
}

export interface RecommendationExecutionInput {
  recommendationId: string;
  userId: string;
  role: Role;
  traceId?: string;
  ipAddress?: string;
  agentId?: string;
  conversationId?: string;
  /**
   * Dry-run: perform EVERY validation (ownership, status, expiry, paramsHash,
   * state binding, guardrails, authorization), build the exact executable
   * request, then STOP at the ToolExecutor boundary. No tool invocation, no
   * approval consumption, no provider call.
   */
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Outcome taxonomy — deterministic, safe errors only
// ---------------------------------------------------------------------------

export type RecommendationExecutionOutcome =
  | {
      status: "EXECUTED";
      recommendationId: string;
      executionId: string;
      approvalId?: string;
      toolId: string;
      result: unknown;
    }
  | {
      /** Known post-claim provider failure. Recommendation -> FAILED. */
      status: "EXECUTION_FAILED";
      recommendationId: string;
      executionId: string;
      error: string;
    }
  | {
      /** Ambiguous transport outcome: journal owns resolution; the
       *  recommendation stays EXECUTING and NEVER claims success. */
      status: "AMBIGUOUS_OUTCOME";
      recommendationId: string;
      executionId: string;
    }
  | { status: "APPROVAL_PENDING"; recommendationId: string; approvalId?: string }
  | { status: "APPROVAL_DENIED"; recommendationId: string; detail: string }
  | { status: "APPROVAL_ALREADY_CONSUMED"; recommendationId: string }
  | { status: "ALREADY_EXECUTED"; recommendationId: string }
  | {
      status: "NOT_EXECUTABLE";
      recommendationId: string;
      recStatus: RecommendationStatus;
      detail: string;
    }
  | { status: "RECOMMENDATION_EXPIRED"; recommendationId: string }
  | { status: "RECOMMENDATION_NOT_FOUND" }
  | { status: "PARAMS_HASH_MISMATCH"; recommendationId: string; detail: string }
  | { status: "STALE_RECOMMENDATION"; recommendationId: string; reasons: string[] }
  | { status: "INVALID_RECOMMENDATION"; recommendationId: string; reasons: string[] }
  | { status: "AUTHORIZATION_DENIED"; recommendationId: string }
  | { status: "PERMISSION_DENIED"; recommendationId: string; detail: string }
  | { status: "DUPLICATE_EXECUTION_BLOCKED"; recommendationId: string; detail: string }
  | { status: "UNKNOWN_ACTION"; recommendationId: string; detail: string }
  | { status: "DRAINING"; recommendationId: string }
  | { status: "INFRASTRUCTURE_UNAVAILABLE"; recommendationId: string; detail: string }
  | {
      /** Deterministic tool-layer refusal BEFORE consumption/claim (e.g.
       *  entity missing, invalid transition, guardrail rejection). Nothing
       *  happened externally; the recommendation stays recoverable. */
      status: "EXECUTION_BLOCKED";
      recommendationId: string;
      detail: string;
    }
  | {
      status: "DRY_RUN_OK";
      recommendationId: string;
      toolId: string;
      params: Record<string, unknown>;
      stateHashVerified: true;
    };

const EXECUTABLE_STATUSES: readonly RecommendationStatus[] = ["PROPOSED", "APPROVED"];

function executableParamsOf(record: RecommendationRecord): Record<string, unknown> {
  return buildExecutableParams(
    record.actionType,
    record.accountId,
    record.entityId,
    typeof record.proposedState["dailyBudget"] === "number"
      ? (record.proposedState["dailyBudget"] as number)
      : undefined,
    record.entityLevel
  );
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class RecommendationExecutionService {
  constructor(private readonly deps: RecommendationExecutionDeps) {}

  async execute(input: RecommendationExecutionInput): Promise<RecommendationExecutionOutcome> {
    const now = this.deps.nowFn ?? (() => new Date());
    const at = now().toISOString();

    // 1. Load + ownership (user-scoped accessor: IDOR-safe).
    const record = await this.deps.recommendations.getForUser(
      input.recommendationId,
      input.userId
    );
    if (!record) return { status: "RECOMMENDATION_NOT_FOUND" };
    const rid = record.recommendationId;

    // Contract re-validation: a corrupted/forged row can never cross here.
    const parsed = RecommendationRecordSchema.safeParse(record);
    if (!parsed.success) {
      await this.auditAttempt(input, record, at, "INVALID_RECOMMENDATION", "rejected");
      return {
        status: "INVALID_RECOMMENDATION",
        recommendationId: rid,
        reasons: parsed.error.issues.slice(0, 3).map((i) => i.message),
      };
    }

    // 2. Lifecycle gate (deterministic; terminal rows are refused, not fixed).
    if (!EXECUTABLE_STATUSES.includes(record.status)) {
      if (record.status === "EXECUTED") {
        await this.auditAttempt(input, record, at, "ALREADY_EXECUTED", "rejected");
        return { status: "ALREADY_EXECUTED", recommendationId: rid };
      }
      if (record.status === "EXPIRED") {
        await this.auditAttempt(input, record, at, "RECOMMENDATION_EXPIRED", "rejected");
        return { status: "RECOMMENDATION_EXPIRED", recommendationId: rid };
      }
      const outcome: RecommendationExecutionOutcome = {
        status: "NOT_EXECUTABLE",
        recommendationId: rid,
        recStatus: record.status,
        detail: `Recommendation is ${record.status}`,
      };
      await this.auditAttempt(input, record, at, outcome.status, "rejected");
      return outcome;
    }

    // Single TTL check; expired rows are durably quarantined.
    if (new Date(record.expiresAt).getTime() <= now().getTime()) {
      await this.deps.recommendations.transition(
        rid,
        input.userId,
        EXECUTABLE_STATUSES,
        "EXPIRED"
      );
      await this.auditAttempt(input, record, at, "RECOMMENDATION_EXPIRED", "rejected");
      return { status: "RECOMMENDATION_EXPIRED", recommendationId: rid };
    }

    // 3. Explicit allowlist — tool names NEVER derive from data.
    const resolved = resolveToolForAction(record.actionType, record.entityLevel);
    if (!resolved.ok) {
      const outcome: RecommendationExecutionOutcome =
        resolved.reason === "UNKNOWN_ACTION"
          ? { status: "UNKNOWN_ACTION", recommendationId: rid, detail: resolved.detail }
          : { status: "INVALID_RECOMMENDATION", recommendationId: rid, reasons: [resolved.detail] };
      await this.auditAttempt(input, record, at, outcome.status, "rejected");
      return outcome;
    }

    // 4. Rebuild the EXACT executable parameters and verify the binding.
    //    A client-supplied paramsHash is never consulted anywhere.
    let params: Record<string, unknown>;
    try {
      params = executableParamsOf(record);
    } catch (err) {
      const outcome: RecommendationExecutionOutcome = {
        status: "INVALID_RECOMMENDATION",
        recommendationId: rid,
        reasons: [err instanceof Error ? err.message : "params unbuildable"],
      };
      await this.auditAttempt(input, record, at, outcome.status, "failure");
      return outcome;
    }
    if (computeParamsHash(params) !== record.paramsHash) {
      const outcome: RecommendationExecutionOutcome = {
        status: "PARAMS_HASH_MISMATCH",
        recommendationId: rid,
        detail: "Stored paramsHash does not match rebuilt executable parameters",
      };
      await this.auditAttempt(input, record, at, outcome.status, "rejected");
      return outcome;
    }

    // 5. Early account authorization (server-side authorizer remains the
    //    authority; each tool re-checks during execution regardless).
    if (this.deps.authorizer) {
      const authorized = await this.deps.authorizer.isAuthorized(
        input.userId,
        record.accountId
      );
      if (!authorized) {
        await this.auditAttempt(input, record, at, "AUTHORIZATION_DENIED", "rejected");
        return { status: "AUTHORIZATION_DENIED", recommendationId: rid };
      }
    }

    // 6. Fresh-state validation through the SAME state abstraction used at
    //    proposal time. Deleted/changed entities fail closed here.
    const liveState = await this.deps.stateOf(record.accountId, record.entityId, {
      userId: input.userId,
      role: input.role,
    });

    // 7. Dry-run stops exactly at the ToolExecutor boundary.
    if (input.dryRun) {
      const staleOutcome = await this.staleBlockOutcome(record, liveState);
      if (staleOutcome) {
        await this.auditAttempt(input, record, at, staleOutcome.status, "rejected");
        return staleOutcome;
      }
      const outcome: RecommendationExecutionOutcome = {
        status: "DRY_RUN_OK",
        recommendationId: rid,
        toolId: resolved.toolId,
        params,
        stateHashVerified: true,
      };
      await this.auditAttempt(input, record, at, outcome.status, "success");
      return outcome;
    }

    const staleOutcome = await this.staleBlockOutcome(record, liveState);
    if (staleOutcome) {
      await this.auditAttempt(input, record, at, staleOutcome.status, "rejected");
      return staleOutcome;
    }

    // 8. Hand over to the Phase 10 executor — the ONLY side-effect path.
    const execution = await this.deps.executor.execute({
      toolId: resolved.toolId,
      params,
      userId: input.userId,
      role: input.role,
      agentId: input.agentId,
      conversationId: input.conversationId,
      traceId: input.traceId ?? crypto.randomUUID(),
      ipAddress: input.ipAddress,
    });

    // 9. Map the executor outcome onto legal lifecycle transitions.
    switch (execution.status) {
      case "approval_pending":
      case "approval_required":
        // Nothing consumed, nothing written; recommendation stays PROPOSED.
        await this.auditAttempt(input, record, at, "APPROVAL_PENDING", "pending");
        return {
          status: "APPROVAL_PENDING",
          recommendationId: rid,
          approvalId: execution.approvalId,
        };

      case "approval_denied":
        // A human explicitly rejected the approval. Nothing consumed, nothing
        // written; the recommendation stays recoverable (PROPOSED).
        await this.auditAttempt(input, record, at, "APPROVAL_DENIED", "rejected");
        return {
          status: "APPROVAL_DENIED",
          recommendationId: rid,
          detail: execution.error ?? "approval was rejected",
        };

      case "permission_denied":
        await this.auditAttempt(input, record, at, "PERMISSION_DENIED", "rejected");
        return {
          status: "PERMISSION_DENIED",
          recommendationId: rid,
          detail: execution.error ?? "missing permission",
        };

      default:
        break;
    }
    return this.settleExecution(record, input, execution, at, resolved.toolId);
  }

  // -------------------------------------------------------------------------
  // Settlement: classify the executor result and drive the recommendation
  // through its legal lifecycle edges (PROPOSED->APPROVED->EXECUTING->...).
  // Every transition is single-winner; deterministic pre-claim refusals from
  // the Phase 10 layer are classified WITHOUT touching lifecycle state.
  // -------------------------------------------------------------------------
  private async settleExecution(
    record: RecommendationRecord,
    input: RecommendationExecutionInput,
    execution: Awaited<ReturnType<IToolExecutor["execute"]>>,
    at: string,
    toolId: string
  ): Promise<RecommendationExecutionOutcome> {
    const rid = record.recommendationId;

    // Draining: refused BEFORE any approval consumption or journal mutation —
    // both the approval and the approved action remain fully recoverable.
    if (execution.error === SERVICE_SHUTTING_DOWN_ERROR) {
      await this.auditAttempt(input, record, at, "DRAINING", "rejected");
      return { status: "DRAINING", recommendationId: rid };
    }

    // Deterministic pre-claim refusals produced by the executor/tools layer.
    const err = execution.error ?? "";
    if (err.startsWith("Approval denied:")) {
      const reason = err.slice("Approval denied:".length).trim();
      const outcome: RecommendationExecutionOutcome =
        reason === "approval already consumed"
          ? { status: "APPROVAL_ALREADY_CONSUMED", recommendationId: rid }
          : { status: "APPROVAL_DENIED", recommendationId: rid, detail: reason };
      await this.auditAttempt(input, record, at, outcome.status, "rejected");
      return outcome;
    }
    if (err.startsWith("Execution already")) {
      const outcome: RecommendationExecutionOutcome = {
        status: "DUPLICATE_EXECUTION_BLOCKED",
        recommendationId: rid,
        detail: err,
      };
      await this.auditAttempt(input, record, at, outcome.status, "rejected");
      return outcome;
    }

    // Authoritative ambiguity check BEFORE any lifecycle mutation: when the
    // durable journal says UNKNOWN/RECONCILING, the write MAY have happened —
    // the recommendation must stay EXECUTING and reconciliation owns
    // resolution. Journal row ids belong to the tools layer, so the row is
    // located by (userId, toolId, paramsHash).
    let journalStatus: string | undefined;
    let journalExecutionId: string | undefined;
    if (this.deps.journal) {
      try {
        const rows = await this.deps.journal.findRecentByTool(input.userId, toolId, 25);
        const expectedParamsHash = computeParamsHash(
          executableParamsOf(record)
        );
        const matched =
          rows.find((r) => r.paramsHash === expectedParamsHash) ?? undefined;
        journalStatus = matched?.status;
        journalExecutionId = matched?.executionId;
      } catch {
        journalStatus = undefined;
        journalExecutionId = undefined;
      }
    }

    if (/unavailable/i.test(err) && !journalStatus) {
      // Infra outage BEFORE ownership/consumption (no journal record yet):
      // recoverable, nothing burned.
      const outcome: RecommendationExecutionOutcome = {
        status: "INFRASTRUCTURE_UNAVAILABLE",
        recommendationId: rid,
        detail: err,
      };
      await this.auditAttempt(input, record, at, outcome.status, "failure");
      return outcome;
    }

    if (journalStatus === "PENDING" || journalStatus === "APPROVED") {
      // The tool refused deterministically BEFORE consumption and claim
      // (entity missing, invalid transition, guardrail rejection…). Nothing
      // happened externally — the approval was never burned and the journal
      // row was never claimed, so the recommendation stays recoverable.
      const outcome: RecommendationExecutionOutcome = {
        status: "EXECUTION_BLOCKED",
        recommendationId: rid,
        detail: err || "tool refused before claim",
      };
      await this.auditAttempt(input, record, at, outcome.status, "rejected");
      return outcome;
    }

    // From here on an approval was consumed and the journal claimed, so the
    // recommendation moves PROPOSED->APPROVED->EXECUTING first. Rows already
    // APPROVED skip the first edge legally (crash-recovery resume). These
    // intermediate edges are a shared baton: two concurrent attempts may
    // split them between themselves, so their individual results are NOT
    // ownership signals. Single-winner is enforced once, below, on the
    // terminal EXECUTING -> EXECUTED edge.
    const consumedApprovalId = await this.resolveConsumedApprovalId(
      record,
      toolId,
      input,
      execution
    );
    await this.deps.recommendations.transition(rid, input.userId, ["PROPOSED"], "APPROVED");
    await this.deps.recommendations.transition(rid, input.userId, ["APPROVED"], "EXECUTING", {
      approvalId: consumedApprovalId,
    });

    if (execution.status === "completed" && execution.result?.success) {
      // Terminal edge = the ONLY single-winner gate. Losing it means a
      // concurrent duplicate already drove this recommendation to EXECUTED;
      // this attempt must not also claim success (even if its own tool call
      // observed the winner's completed external work as an idempotent no-op).
      const done = await this.deps.recommendations.transition(
        rid,
        input.userId,
        ["EXECUTING"],
        "EXECUTED"
      );
      if (!done) {
        const outcome: RecommendationExecutionOutcome = {
          status: "DUPLICATE_EXECUTION_BLOCKED",
          recommendationId: rid,
          detail:
            err ||
            "recommendation already executed by a concurrent request",
        };
        await this.auditAttempt(input, record, at, outcome.status, "rejected");
        return outcome;
      }
      if (consumedApprovalId) {
        await this.deps.recommendations.linkExecution(
          rid,
          input.userId,
          consumedApprovalId,
          journalExecutionId ?? execution.executionId
        );
      }
      await this.auditAttempt(input, record, at, "EXECUTED", "success");
      // R-32 — the write succeeded; record what it is measured against.
      // Deliberately AFTER the audit above and outside the success path's
      // control flow: whatever happens here, this execution is EXECUTED.
      await this.createOutcomeRecord(
        input,
        record,
        at,
        journalExecutionId ?? execution.executionId
      );
      return {
        status: "EXECUTED",
        recommendationId: rid,
        executionId: journalExecutionId ?? execution.executionId,
        approvalId: consumedApprovalId,
        toolId: execution.toolId,
        result: execution.result?.data,
      };
    }

    if (
      execution.status === "timed_out" ||
      journalStatus === "UNKNOWN" ||
      journalStatus === "RECONCILING"
    ) {
      // Ambiguous: never FAILED, never EXECUTED. Reconciliation owns truth.
      await this.auditAttempt(input, record, at, "AMBIGUOUS_OUTCOME", "failure");
      return {
        status: "AMBIGUOUS_OUTCOME",
        recommendationId: rid,
        executionId: journalExecutionId ?? execution.executionId,
      };
    }

    // Known post-claim failure (provider rejected / verification failed):
    // recommendation FAILED, ToolExecution stays FAILED in the journal.
    await this.deps.recommendations.transition(rid, input.userId, ["EXECUTING"], "FAILED");
    const outcome: RecommendationExecutionOutcome = {
      status: "EXECUTION_FAILED",
      recommendationId: rid,
      executionId: journalExecutionId ?? execution.executionId,
      error: err || "tool reported failure",
    };
    await this.auditAttempt(input, record, at, outcome.status, "failure");
    return outcome;
  }

  /**
   * Recover the approval id that was actually consumed for this attempt.
   * The executor does not echo it on completed results, so after a claim we
   * look it up through the SAME Phase 10 manager and re-verify the binding.
   */
  private async resolveConsumedApprovalId(
    record: RecommendationRecord,
    toolId: string,
    input: RecommendationExecutionInput,
    execution: Awaited<ReturnType<IToolExecutor["execute"]>>
  ): Promise<string | undefined> {
    if (execution.approvalId) return execution.approvalId;
    if (!this.deps.approvals) return undefined;
    try {
      const existing = await this.deps.approvals.findExistingForTool(
        toolId,
        input.userId
      );
      if (!existing) return undefined;
      const expectedParamsHash = computeParamsHash(executableParamsOf(record));
      // The consumption port atomically flips the row to CONSUMED while
      // pairing the journal claim, so a just-consumed approval is reported
      // as "consumed". Accept both it and "approved" — identity is proven
      // by the paramsHash + user + tool binding, not by lifecycle state.
      if (
        existing.paramsHash === expectedParamsHash &&
        (existing.status === "approved" || existing.status === "consumed")
      ) {
        return existing.id;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /** STALE blocking (deleted entity, state drift) with durable quarantine. */
  private async staleBlockOutcome(
    record: RecommendationRecord,
    liveState: ExternalEntityState | null
  ): Promise<RecommendationExecutionOutcome | null> {
    const verdict = verifyRecommendationFreshness({
      record,
      liveState,
      requestingUserId: record.userId, // ownership already proven by getForUser
    });
    if (verdict.ok) return null;
    if (verdict.result === "EXPIRED") {
      return { status: "RECOMMENDATION_EXPIRED", recommendationId: record.recommendationId };
    }
    if (verdict.result === "INVALID") {
      return {
        status: "INVALID_RECOMMENDATION",
        recommendationId: record.recommendationId,
        reasons: verdict.reasons,
      };
    }
    // Durable quarantine for genuinely stale rows (never for tamper-invalid).
    // Awaited: the STALE status must be observable before this attempt returns.
    try {
      await this.deps.recommendations.transition(
        record.recommendationId,
        record.userId,
        EXECUTABLE_STATUSES,
        "STALE",
        { staleReasons: verdict.reasons.slice(0, 10) }
      );
    } catch {
      /* quarantine best-effort; verdict already blocks execution */
    }
    return {
      status: "STALE_RECOMMENDATION",
      recommendationId: record.recommendationId,
      reasons: verdict.reasons,
    };
  }

  /**
   * R-32 — create the outcome record for a write that has already succeeded.
   *
   * The baseline is the recommendation's OWN evidence snapshot: the metrics
   * that were true before the action, captured when the recommendation was
   * generated. That is a genuine pre-action baseline and costs no provider
   * call, which matters because this runs on the write path, after money has
   * already moved.
   *
   * Three things this deliberately does NOT do:
   *
   *   - It never invents a KPI. `currentMetrics` is a loose record and every
   *     value in it may be null, so when a required counter is missing the
   *     record is NOT created. Zero-filling would fabricate a baseline and
   *     every later comparison against it would be wrong.
   *   - It never changes the caller's result. A skip or a failed write is
   *     audited and swallowed; the advertising write already happened and
   *     reporting it as anything but EXECUTED would be a lie.
   *   - It never throws.
   *
   * Every path here leaves an audit row, so a skipped outcome is visible in
   * the same trail as the execution rather than being silent.
   */
  private async createOutcomeRecord(
    input: RecommendationExecutionInput,
    record: RecommendationRecord,
    at: string,
    executionId: string
  ): Promise<void> {
    const outcomes = this.deps.outcomes;
    if (!outcomes) return;

    try {
      const evidence = record.evidence;
      const kpis = baselineKpisFromEvidence(evidence.currentMetrics);

      if (!kpis) {
        await this.auditAttempt(
          input,
          record,
          at,
          "OUTCOME_RECORD_SKIPPED_INCOMPLETE_BASELINE",
          "pending"
        );
        return;
      }

      const summary: PerformanceSummary = {
        accountId: record.accountId,
        level: record.entityLevel,
        entityId: record.entityId,
        currency: evidence.currency,
        timezone: evidence.timezone,
        window: {
          type: "custom",
          startDate: evidence.performanceWindow.startDate,
          endDate: evidence.performanceWindow.endDate,
        },
        // The evidence snapshot is one aggregated window, not a row per day.
        recordCount: 1,
        kpis,
        quality: evidence.dataQuality,
        // The baseline was true as of the evidence, but it is FETCHED now, at
        // execution time — that is what the measurement window counts from.
        fetchedAt: at,
        source: "recommendation-evidence",
      };

      // The recommendation's category is a loose string; the outcome's is the
      // enum. Narrow rather than cast, so a legacy or malformed value becomes
      // null instead of an invalid category nothing can filter on.
      const parsedCategory = DiagnosisCategorySchema.safeParse(record.diagnosisCategory);

      const measured = measureOutcome({
        recommendationId: record.recommendationId,
        executionId,
        accountId: record.accountId,
        diagnosisCategory: parsedCategory.success ? parsedCategory.data : null,
        entityType: record.entityLevel,
        entityId: record.entityId,
        actionType: record.actionType,
        objective: evidence.objective ?? null,
        primaryMetric: derivePrimaryMetric(evidence),
        baseline: captureBaselineSnapshot(summary, { fetchedAt: at }),
        executedAtIso: at,
        userId: input.userId,
      });

      await outcomes.create(measured.outcomeRecord);
      await this.auditAttempt(input, record, at, "OUTCOME_RECORD_CREATED", "success");
    } catch {
      // Includes the duplicate-outcome case: one recommendation carries one
      // outcome, so a retried execution finding an existing row is correct
      // behaviour, not a failure of this execution.
      await this.auditAttempt(input, record, at, "OUTCOME_RECORD_PERSIST_FAILED", "failure");
    }
  }

  private async auditAttempt(
    input: RecommendationExecutionInput,
    record: RecommendationRecord,
    at: string,
    outcome: string,
    result: "success" | "failure" | "rejected" | "pending"
  ): Promise<void> {
    if (!this.deps.audit) return;
    const payload = {
      at,
      outcome,
      recommendationId: record.recommendationId,
      userId: input.userId,
      accountId: record.accountId,
      entityId: record.entityId,
      entityLevel: record.entityLevel,
      actionType: record.actionType,
      paramsHash: record.paramsHash,
      stateHash: record.stateHash,
      traceId: input.traceId,
      dryRun: input.dryRun === true,
    };
    try {
      await this.deps.audit.log({
        userId: input.userId,
        agentId: input.agentId,
        toolId: "recommendation.execute",
        action: "recommendation.execute",
        parameters: JSON.parse(redactSecrets(JSON.stringify(payload))) as Record<string, unknown>,
        result,
        traceId: input.traceId,
        ipAddress: input.ipAddress,
      });
    } catch {
      // Audit failure must never crash the bridge after the fact.
    }
  }
}

// ---------------------------------------------------------------------------
// Executor-backed live-state observation (READ-ONLY path)
// ---------------------------------------------------------------------------
// Implements the same state view the proposal engine consumed, but routed
// through READ-ONLY Meta tools executed by the ToolExecutor — so account
// authorization applies and no direct client/provider import exists here.

export interface StatePortContext {
  executor: Pick<IToolExecutor, "execute">;
  userId: string;
  role: Role;
}

function metaStatusToEntityStatus(status: string): ExternalEntityState["status"] | null {
  switch (status) {
    case "ACTIVE":
      return "ACTIVE";
    case "PAUSED":
      return "PAUSED";
    case "DELETED":
      return "DELETED";
    case "ARCHIVED":
      return "ARCHIVED";
    default:
      // IN_PROCESS / WITH_ISSUES etc. are not representable — fail closed.
      return null;
  }
}

/**
 * Build a live-state loader for one authenticated request. Reads go through
 * meta.campaigns / meta.adsets / meta.ads (READ_ONLY tools) via the executor.
 */
export function createExecutorBackedExternalStatePort(
  ctx: StatePortContext
): RecommendationExecutionDeps["stateOf"] {
  return async (accountId, entityId) => {
    const readList = async (
      toolId: string,
      params: Record<string, unknown>,
      listKey: string
    ): Promise<Record<string, unknown>[] | null> => {
      const res = await ctx.executor.execute({
        toolId,
        params,
        userId: ctx.userId,
        role: ctx.role,
        traceId: crypto.randomUUID(),
      });
      if (res.status !== "completed" || !res.result?.success) return null;
      const payload = res.result.data as Record<string, unknown> | null;
      const list = payload?.[listKey];
      return Array.isArray(list) ? (list as Record<string, unknown>[]) : null;
    };

    // PHASE 11.6B FIX: an entity may live at ANY level. A readable campaigns
    // list that lacks the id must NOT short-circuit the ad-set/ad fallbacks —
    // previously `findIn` returning null (readable, absent) satisfied neither
    // the retry guard (=== undefined) nor produced a hit, so AD-level state
    // resolution always failed with ENTITY_NOT_FOUND once /campaigns was
    // fetchable. Now each readable level is searched in order; the FIRST hit
    // wins; unreadable lists simply cannot contribute.
    let raw: Record<string, unknown> | null = null;

    const campaigns = await readList("meta.campaigns", { accountId }, "campaigns");
    if (campaigns) raw = findIn(campaigns, "campaignId", entityId);

    if (!raw) {
      const adSets = await readList("meta.adsets", { accountId }, "adSets");
      if (adSets) raw = findIn(adSets, "adSetId", entityId);
    }
    if (!raw) {
      const ads = await readList("meta.ads", { accountId }, "ads");
      if (ads) raw = findIn(ads, "adId", entityId);
    }
    if (!raw) return null; // absent entity (or account wholly unreadable)

    const status = metaStatusToEntityStatus(String(raw["status"] ?? ""));
    if (!status) return null;
    return {
      status,
      objective: typeof raw["objective"] === "string" ? raw["objective"] : null,
      dailyBudget: parseBudgetValue(raw["dailyBudget"]),
      lifetimeBudget: parseBudgetValue(raw["lifetimeBudget"]),
      targetingFingerprint: null,
    };
  };
}

/** undefined = list unavailable; null = list readable, entity absent. */
function findIn(
  list: Record<string, unknown>[],
  idKey: string,
  entityId: string
): Record<string, unknown> | null {
  const found = list.find((e) => e[idKey] === entityId);
  return found ?? null;
}
