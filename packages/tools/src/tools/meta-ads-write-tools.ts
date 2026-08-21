import { BaseTool } from "../base-tool.js";
import type {
  ApprovalConsumptionResult,
  BudgetGuardrailsConfig,
  CampaignProposal,
  IApprovalConsumptionPort,
  MetaCampaignInput,
  ToolContext,
  ToolResult,
} from "@jarvis/core";
import {
  BLOCKED_STATUSES,
  CREATE_BLOCKED_STATUSES,
  DEFAULT_LEASE_MS,
  computeParamsHash,
  type ExecutionJournalPort,
  type ExecutionJournalStatus,
} from "@jarvis/core";
import type { MetaAdsProvider, MetaAccountAuthorizer, MetaAdsWriteProvider, MetaAdsBudgetProvider, MetaCampaignCreatorProvider } from "./meta-ads-provider.js";
import { validateAccountId, validateEntityId, parseBudgetValue } from "./meta-ads-validators.js";
import { validateBudgetAmount, validateBudgetTransition, buildBudgetChangeSummary, verifyBudgetResult, DEFAULT_BUDGET_GUARDRAILS } from "./meta-ads-budget-guardrails.js";
import { MemoryExecutionJournal, isAmbiguousWriteError, withSafeTerminalTransitions } from "../execution-journal.js";

// ---------------------------------------------------------------------------
// Execution state machine (durable idempotency via ExecutionJournalPort)
// ---------------------------------------------------------------------------
// Prevents duplicate Meta API side effects for the same action+target.
// Production MUST inject a durable journal (PrismaToolExecutionRepository).
// The module-level MemoryExecutionJournal below exists only as the default
// for unit tests; it must never be relied upon in production.
// ---------------------------------------------------------------------------

/** @deprecated Legacy alias of ExecutionJournalStatus kept for test compat. */
export type MetaExecutionState = ExecutionJournalStatus | "EXPIRED" | "STALE";

const defaultExecutionJournal = new MemoryExecutionJournal();

interface LegacyExecutionRecord {
  state: MetaExecutionState;
  executionId: string;
  timestamp: number;
}

function toLegacyRecord(record: {
  status: string;
  executionId: string;
  createdAt: Date;
}): LegacyExecutionRecord {
  return {
    state: record.status as MetaExecutionState,
    executionId: record.executionId,
    timestamp: record.createdAt.getTime(),
  };
}

/** @deprecated Test seam over the default memory journal. */
export function getExecutionState(idempotencyKey: string): LegacyExecutionRecord | undefined {
  const record = defaultExecutionJournal.findByAnyKey(idempotencyKey);
  if (!record) return undefined;
  return toLegacyRecord(record);
}

/** @deprecated Test seam over the default memory journal. */
export function setExecutionState(
  idempotencyKey: string,
  state: MetaExecutionState,
  userId: string
): void {
  const toolId = idempotencyKey.split(":")[0] ?? "unknown";
  const existing = defaultExecutionJournal.findByAnyKey(idempotencyKey);
  if (existing && existing.userId === userId && existing.toolId === toolId) {
    existing.status =
      state === "EXPIRED" || state === "STALE" ? "CANCELLED" : state;
    return;
  }
  void defaultExecutionJournal
    .begin({
      userId,
      toolId,
      idempotencyKey,
      provider: "meta-ads",
    })
    .then((record) => {
      record.status =
        state === "EXPIRED" || state === "STALE" ? "CANCELLED" : state;
    });
}

export function clearExecutionStore(): void {
  defaultExecutionJournal.clear();
}

export function buildIdempotencyKey(
  toolId: string,
  accountId: string,
  objectId: string,
  targetStatus: string
): string {
  return `${toolId}:${accountId}:${objectId}:${targetStatus}`;
}

// ---------------------------------------------------------------------------
// Shared base for all Meta Ads WRITE tools (Phase 9.1)
// ---------------------------------------------------------------------------
// All write tools:
//   - requireApproval = true
//   - requiredPermissions = ["read", "write"]
//   - risk = "EXTERNAL_SIDE_EFFECT"
//   - category = "marketing"
// ---------------------------------------------------------------------------

type WriteProvider = MetaAdsProvider & MetaAdsWriteProvider;

// ---------------------------------------------------------------------------
// authorizeAndClaim — one-time approval consumption fused with the execution
// claim (Phase 10.3). When an approvalId is present it MUST be atomically
// consumed (verifying user, tool, paramsHash, APPROVED state, expiry) in the
// same durable step that claims the execution record. Denial => no claim,
// no external side effect. Fail-closed when a port is missing.
// ---------------------------------------------------------------------------
async function authorizeAndClaim(
  approvals: IApprovalConsumptionPort | undefined,
  journal: ExecutionJournalPort,
  toolId: string,
  executionId: string,
  params: Record<string, unknown>,
  context: ToolContext
): Promise<{ ok: true; claimed: true } | { ok: false; error: string }> {
  if (!context.approvalId) {
    // No approval in context (unit-test seam / non-gated invocation):
    // plain single-winner claim as before.
    const claimed = await journal.claimForExecution(executionId, {
      ownerId: crypto.randomUUID(),
      leaseMs: DEFAULT_LEASE_MS,
    });
    return claimed ? { ok: true, claimed: true } : { ok: false, error: "Execution already executing" };
  }
  if (!approvals) {
    // An approval id was supplied but no consumption port is wired:
    // NEVER execute — that would bypass one-time enforcement.
    return { ok: false, error: "Approval verification unavailable" };
  }
  let result: ApprovalConsumptionResult;
  try {
    result = await approvals.consumeForExecution({
      approvalId: context.approvalId,
      userId: context.userId,
      toolId,
      paramsHash: computeParamsHash(params),
      executionId,
    });
  } catch {
    // Consumption infrastructure failure: fail closed — no ownership,
    // no external side effect, approval untouched.
    return { ok: false, error: "Approval verification unavailable" };
  }
  if (!result.ok) return { ok: false, error: `Approval denied: ${result.reason}` };
  return { ok: true, claimed: true };
}

abstract class BaseMetaAdsWriteTool extends BaseTool {
  protected readonly provider: WriteProvider;
  protected readonly authorizer: MetaAccountAuthorizer;
  protected readonly journal: ExecutionJournalPort;
  protected readonly approvals?: IApprovalConsumptionPort;

  constructor(
    id: string,
    name: string,
    description: string,
    parameters: { name: string; type: string; description: string; required: boolean }[],
    provider: WriteProvider,
    authorizer: MetaAccountAuthorizer,
    version = "1.0.0",
    journal: ExecutionJournalPort = defaultExecutionJournal,
    approvals?: IApprovalConsumptionPort
  ) {
    super(
      id,
      name,
      description,
      "marketing",
      parameters,
      true,
      ["read", "write"],
      "EXTERNAL_SIDE_EFFECT",
      version,
      true
    );
    this.provider = provider;
    this.authorizer = authorizer;
    // Terminal-transition failures are contained (see withSafeTerminalTransitions):
    // a journal outage after a claim must never cause an unsafe external retry.
    this.journal = withSafeTerminalTransitions(journal);
    this.approvals = approvals;
  }

  protected async checkAccess(userId: string, accountId: string): Promise<ToolResult | null> {
    const validAccount = validateAccountId(accountId);
    if (!validAccount) return this.failure("Invalid account ID format");
    const authorized = await this.authorizer.isAuthorized(userId, validAccount);
    if (!authorized) return this.failure("Not authorized to access this Meta account");
    return null;
  }

  protected validateStatusTransition(
    currentStatus: string,
    targetStatus: string
  ): { valid: boolean; error?: string } {
    const allowed: Record<string, string[]> = {
      ACTIVE: ["PAUSED"],
      PAUSED: ["ACTIVE"],
    };
    const targets = allowed[currentStatus];
    if (!targets) {
      return { valid: false, error: `Cannot change status from ${currentStatus}` };
    }
    if (!targets.includes(targetStatus)) {
      return { valid: false, error: `Cannot transition from ${currentStatus} to ${targetStatus}` };
    }
    return { valid: true };
  }

  protected async ensureExecutable(
    idempotencyKey: string,
    params: Record<string, unknown>,
    context: ToolContext,
    blockedStates: ReadonlySet<ExecutionJournalStatus>
  ): Promise<{ ok: true; executionId: string } | { ok: false; error: string }> {
    let record;
    try {
      record = await this.journal.begin({
        userId: context.userId,
        toolId: this.id,
        idempotencyKey,
        paramsHash: computeParamsHash(params),
        provider: "meta-ads",
        traceId: context.traceId,
        approvalId: context.approvalId,
      });
    } catch {
      // Journal unavailable BEFORE any claim: fail closed, no ownership taken.
      return { ok: false, error: "Execution journal unavailable" };
    }
    if (blockedStates.has(record.status)) {
      return { ok: false, error: `Execution already ${record.status.toLowerCase()}` };
    }
    return { ok: true, executionId: record.executionId };
  }

  protected async claimExecution(executionId: string): Promise<boolean> {
    // Durable single-winner claim with lease ownership.
    return (await this.journal.claimForExecution(executionId, {
      ownerId: crypto.randomUUID(),
      leaseMs: DEFAULT_LEASE_MS,
    })) !== null;
  }
}

// ---------------------------------------------------------------------------
// meta.campaign.pause — Pause an active campaign
// ---------------------------------------------------------------------------

export class MetaPauseCampaignTool extends BaseMetaAdsWriteTool {
  constructor(provider: WriteProvider, authorizer: MetaAccountAuthorizer, journal?: ExecutionJournalPort, approvals?: IApprovalConsumptionPort) {
    super(
      "meta.campaign.pause",
      "Pause Meta Campaign",
      "Pause an active Meta ad campaign. Requires human approval. Reversible action.",
      [
        { name: "accountId", type: "string", description: "Meta ad account ID (e.g. act_123456789)", required: true },
        { name: "campaignId", type: "string", description: "Campaign ID to pause", required: true },
      ],
      provider,
      authorizer,
      "1.0.0",
      journal,
      approvals
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const accountId = params.accountId as string;
    const campaignId = params.campaignId as string;

    const validAccount = validateAccountId(accountId);
    if (!validAccount) return this.failure("Invalid account ID format");
    const validCampaignId = validateEntityId(campaignId);
    if (!validCampaignId) return this.failure("Invalid campaign ID format");

    const accessError = await this.checkAccess(context.userId, validAccount);
    if (accessError) return accessError;

    const idempotencyKey = buildIdempotencyKey(this.id, validAccount, validCampaignId, "PAUSED");
    const ensured = await this.ensureExecutable(idempotencyKey, params, context, BLOCKED_STATUSES);
    if (!ensured.ok) return this.failure(ensured.error);

    let claimed = false;
    try {
      const result = await this.provider.getCampaigns(validAccount);
      const campaign = result.data.find((c) => c.campaignId === validCampaignId);

      if (!campaign) return this.failure("Campaign not found");

      if (campaign.status === "PAUSED") {
        return this.success({
          action: "pause_campaign",
          accountId: validAccount,
          campaignId: validCampaignId,
          previousState: "PAUSED",
          requestedState: "PAUSED",
          actualState: "PAUSED",
          idempotent: true,
          message: "Campaign is already paused",
        }, { toolId: this.id, risk: this.risk, userId: context.userId });
      }

      const transition = this.validateStatusTransition(campaign.status, "PAUSED");
      if (!transition.valid) return this.failure(transition.error!);

      const previousState = campaign.status;
      const claim = await authorizeAndClaim(
        this.approvals,
        this.journal,
        this.id,
        ensured.executionId,
        params,
        context
      );
      if (!claim.ok) return this.failure(claim.error);
      claimed = true;
      const writeResult = await this.provider.updateCampaignStatus(validAccount, validCampaignId, "PAUSED");

      if (!writeResult.success) {
        await this.journal.markFailed(ensured.executionId, {
          code: "PROVIDER_REJECTED",
          message: "Provider reported failure while pausing campaign",
        });
        return this.failure("Failed to pause campaign");
      }

      if (writeResult.campaign.status !== "PAUSED") {
        await this.journal.markFailed(ensured.executionId, {
          code: "VERIFICATION_FAILED",
          message: "Campaign status was not updated to PAUSED",
        });
        return this.failure("Verification failed: campaign status was not updated to PAUSED");
      }

      await this.journal.markSucceeded(ensured.executionId, validCampaignId);
      return this.success({
        action: "pause_campaign",
        accountId: validAccount,
        campaignId: validCampaignId,
        campaignName: writeResult.campaign.name,
        previousState,
        requestedState: "PAUSED",
        actualState: writeResult.campaign.status,
        verified: true,
      }, { toolId: this.id, risk: this.risk, userId: context.userId });
    } catch (err) {
      if (claimed) {
        if (isAmbiguousWriteError(err)) {
          await this.journal.markUnknown(ensured.executionId, {
            code: "AMBIGUOUS_OUTCOME",
            message: err instanceof Error ? err.message : "Uncertain provider outcome",
          });
        } else {
          await this.journal.markFailed(ensured.executionId, {
            code: "EXECUTION_ERROR",
            message: err instanceof Error ? err.message : "Failed to pause campaign",
          });
        }
      }
      const message = err instanceof Error ? err.message : "Failed to pause campaign";
      return this.failure(`Meta API error: ${message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// meta.campaign.resume — Resume a paused campaign
// ---------------------------------------------------------------------------

export class MetaResumeCampaignTool extends BaseMetaAdsWriteTool {
  constructor(provider: WriteProvider, authorizer: MetaAccountAuthorizer, journal?: ExecutionJournalPort, approvals?: IApprovalConsumptionPort) {
    super(
      "meta.campaign.resume",
      "Resume Meta Campaign",
      "Resume a paused Meta ad campaign. Requires human approval. Reversible action.",
      [
        { name: "accountId", type: "string", description: "Meta ad account ID (e.g. act_123456789)", required: true },
        { name: "campaignId", type: "string", description: "Campaign ID to resume", required: true },
      ],
      provider,
      authorizer,
      "1.0.0",
      journal,
      approvals
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const accountId = params.accountId as string;
    const campaignId = params.campaignId as string;

    const validAccount = validateAccountId(accountId);
    if (!validAccount) return this.failure("Invalid account ID format");
    const validCampaignId = validateEntityId(campaignId);
    if (!validCampaignId) return this.failure("Invalid campaign ID format");

    const accessError = await this.checkAccess(context.userId, validAccount);
    if (accessError) return accessError;

    const idempotencyKey = buildIdempotencyKey(this.id, validAccount, validCampaignId, "ACTIVE");
    const ensured = await this.ensureExecutable(idempotencyKey, params, context, BLOCKED_STATUSES);
    if (!ensured.ok) return this.failure(ensured.error);

    let claimed = false;
    try {
      const result = await this.provider.getCampaigns(validAccount);
      const campaign = result.data.find((c) => c.campaignId === validCampaignId);

      if (!campaign) return this.failure("Campaign not found");

      if (campaign.status === "ACTIVE") {
        return this.success({
          action: "resume_campaign",
          accountId: validAccount,
          campaignId: validCampaignId,
          previousState: "ACTIVE",
          requestedState: "ACTIVE",
          actualState: "ACTIVE",
          idempotent: true,
          message: "Campaign is already active",
        }, { toolId: this.id, risk: this.risk, userId: context.userId });
      }

      const transition = this.validateStatusTransition(campaign.status, "ACTIVE");
      if (!transition.valid) return this.failure(transition.error!);

      const previousState = campaign.status;
      const claim = await authorizeAndClaim(
        this.approvals,
        this.journal,
        this.id,
        ensured.executionId,
        params,
        context
      );
      if (!claim.ok) return this.failure(claim.error);
      claimed = true;
      const writeResult = await this.provider.updateCampaignStatus(validAccount, validCampaignId, "ACTIVE");

      if (!writeResult.success) {
        await this.journal.markFailed(ensured.executionId, {
          code: "PROVIDER_REJECTED",
          message: "Provider reported failure while resuming campaign",
        });
        return this.failure("Failed to resume campaign");
      }

      if (writeResult.campaign.status !== "ACTIVE") {
        await this.journal.markFailed(ensured.executionId, {
          code: "VERIFICATION_FAILED",
          message: "Campaign status was not updated to ACTIVE",
        });
        return this.failure("Verification failed: campaign status was not updated to ACTIVE");
      }

      await this.journal.markSucceeded(ensured.executionId, validCampaignId);
      return this.success({
        action: "resume_campaign",
        accountId: validAccount,
        campaignId: validCampaignId,
        campaignName: writeResult.campaign.name,
        previousState,
        requestedState: "ACTIVE",
        actualState: writeResult.campaign.status,
        verified: true,
      }, { toolId: this.id, risk: this.risk, userId: context.userId });
    } catch (err) {
      if (claimed) {
        if (isAmbiguousWriteError(err)) {
          await this.journal.markUnknown(ensured.executionId, {
            code: "AMBIGUOUS_OUTCOME",
            message: err instanceof Error ? err.message : "Uncertain provider outcome",
          });
        } else {
          await this.journal.markFailed(ensured.executionId, {
            code: "EXECUTION_ERROR",
            message: err instanceof Error ? err.message : "Failed to resume campaign",
          });
        }
      }
      const message = err instanceof Error ? err.message : "Failed to resume campaign";
      return this.failure(`Meta API error: ${message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// meta.adset.pause — Pause an active ad set
// ---------------------------------------------------------------------------

export class MetaPauseAdSetTool extends BaseMetaAdsWriteTool {
  constructor(provider: WriteProvider, authorizer: MetaAccountAuthorizer, journal?: ExecutionJournalPort, approvals?: IApprovalConsumptionPort) {
    super(
      "meta.adset.pause",
      "Pause Meta Ad Set",
      "Pause an active Meta ad set. Requires human approval. Reversible action.",
      [
        { name: "accountId", type: "string", description: "Meta ad account ID (e.g. act_123456789)", required: true },
        { name: "adSetId", type: "string", description: "Ad set ID to pause", required: true },
      ],
      provider,
      authorizer,
      "1.0.0",
      journal,
      approvals
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const accountId = params.accountId as string;
    const adSetId = params.adSetId as string;

    const validAccount = validateAccountId(accountId);
    if (!validAccount) return this.failure("Invalid account ID format");
    const validAdSetId = validateEntityId(adSetId);
    if (!validAdSetId) return this.failure("Invalid ad set ID format");

    const accessError = await this.checkAccess(context.userId, validAccount);
    if (accessError) return accessError;

    const idempotencyKey = buildIdempotencyKey(this.id, validAccount, validAdSetId, "PAUSED");
    const ensured = await this.ensureExecutable(idempotencyKey, params, context, BLOCKED_STATUSES);
    if (!ensured.ok) return this.failure(ensured.error);

    let claimed = false;
    try {
      const result = await this.provider.getAdSets(validAccount);
      const adSet = result.data.find((a) => a.adSetId === validAdSetId);

      if (!adSet) return this.failure("Ad set not found");

      if (adSet.status === "PAUSED") {
        return this.success({
          action: "pause_adset",
          accountId: validAccount,
          adSetId: validAdSetId,
          previousState: "PAUSED",
          requestedState: "PAUSED",
          actualState: "PAUSED",
          idempotent: true,
          message: "Ad set is already paused",
        }, { toolId: this.id, risk: this.risk, userId: context.userId });
      }

      const transition = this.validateStatusTransition(adSet.status, "PAUSED");
      if (!transition.valid) return this.failure(transition.error!);

      const previousState = adSet.status;
      const claim = await authorizeAndClaim(
        this.approvals,
        this.journal,
        this.id,
        ensured.executionId,
        params,
        context
      );
      if (!claim.ok) return this.failure(claim.error);
      claimed = true;
      const writeResult = await this.provider.updateAdSetStatus(validAccount, validAdSetId, "PAUSED");

      if (!writeResult.success) {
        await this.journal.markFailed(ensured.executionId, {
          code: "PROVIDER_REJECTED",
          message: "Provider reported failure while pausing ad set",
        });
        return this.failure("Failed to pause ad set");
      }

      if (writeResult.adSet.status !== "PAUSED") {
        await this.journal.markFailed(ensured.executionId, {
          code: "VERIFICATION_FAILED",
          message: "Ad set status was not updated to PAUSED",
        });
        return this.failure("Verification failed: ad set status was not updated to PAUSED");
      }

      await this.journal.markSucceeded(ensured.executionId, validAdSetId);
      return this.success({
        action: "pause_adset",
        accountId: validAccount,
        adSetId: validAdSetId,
        adSetName: writeResult.adSet.name,
        previousState,
        requestedState: "PAUSED",
        actualState: writeResult.adSet.status,
        verified: true,
      }, { toolId: this.id, risk: this.risk, userId: context.userId });
    } catch (err) {
      if (claimed) {
        if (isAmbiguousWriteError(err)) {
          await this.journal.markUnknown(ensured.executionId, {
            code: "AMBIGUOUS_OUTCOME",
            message: err instanceof Error ? err.message : "Uncertain provider outcome",
          });
        } else {
          await this.journal.markFailed(ensured.executionId, {
            code: "EXECUTION_ERROR",
            message: err instanceof Error ? err.message : "Failed to pause ad set",
          });
        }
      }
      const message = err instanceof Error ? err.message : "Failed to pause ad set";
      return this.failure(`Meta API error: ${message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// meta.adset.resume — Resume a paused ad set
// ---------------------------------------------------------------------------

export class MetaResumeAdSetTool extends BaseMetaAdsWriteTool {
  constructor(provider: WriteProvider, authorizer: MetaAccountAuthorizer, journal?: ExecutionJournalPort, approvals?: IApprovalConsumptionPort) {
    super(
      "meta.adset.resume",
      "Resume Meta Ad Set",
      "Resume a paused Meta ad set. Requires human approval. Reversible action.",
      [
        { name: "accountId", type: "string", description: "Meta ad account ID (e.g. act_123456789)", required: true },
        { name: "adSetId", type: "string", description: "Ad set ID to resume", required: true },
      ],
      provider,
      authorizer,
      "1.0.0",
      journal,
      approvals
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const accountId = params.accountId as string;
    const adSetId = params.adSetId as string;

    const validAccount = validateAccountId(accountId);
    if (!validAccount) return this.failure("Invalid account ID format");
    const validAdSetId = validateEntityId(adSetId);
    if (!validAdSetId) return this.failure("Invalid ad set ID format");

    const accessError = await this.checkAccess(context.userId, validAccount);
    if (accessError) return accessError;

    const idempotencyKey = buildIdempotencyKey(this.id, validAccount, validAdSetId, "ACTIVE");
    const ensured = await this.ensureExecutable(idempotencyKey, params, context, BLOCKED_STATUSES);
    if (!ensured.ok) return this.failure(ensured.error);

    let claimed = false;
    try {
      const result = await this.provider.getAdSets(validAccount);
      const adSet = result.data.find((a) => a.adSetId === validAdSetId);

      if (!adSet) return this.failure("Ad set not found");

      if (adSet.status === "ACTIVE") {
        return this.success({
          action: "resume_adset",
          accountId: validAccount,
          adSetId: validAdSetId,
          previousState: "ACTIVE",
          requestedState: "ACTIVE",
          actualState: "ACTIVE",
          idempotent: true,
          message: "Ad set is already active",
        }, { toolId: this.id, risk: this.risk, userId: context.userId });
      }

      const transition = this.validateStatusTransition(adSet.status, "ACTIVE");
      if (!transition.valid) return this.failure(transition.error!);

      const previousState = adSet.status;
      const claim = await authorizeAndClaim(
        this.approvals,
        this.journal,
        this.id,
        ensured.executionId,
        params,
        context
      );
      if (!claim.ok) return this.failure(claim.error);
      claimed = true;
      const writeResult = await this.provider.updateAdSetStatus(validAccount, validAdSetId, "ACTIVE");

      if (!writeResult.success) {
        await this.journal.markFailed(ensured.executionId, {
          code: "PROVIDER_REJECTED",
          message: "Provider reported failure while resuming ad set",
        });
        return this.failure("Failed to resume ad set");
      }

      if (writeResult.adSet.status !== "ACTIVE") {
        await this.journal.markFailed(ensured.executionId, {
          code: "VERIFICATION_FAILED",
          message: "Ad set status was not updated to ACTIVE",
        });
        return this.failure("Verification failed: ad set status was not updated to ACTIVE");
      }

      await this.journal.markSucceeded(ensured.executionId, validAdSetId);
      return this.success({
        action: "resume_adset",
        accountId: validAccount,
        adSetId: validAdSetId,
        adSetName: writeResult.adSet.name,
        previousState,
        requestedState: "ACTIVE",
        actualState: writeResult.adSet.status,
        verified: true,
      }, { toolId: this.id, risk: this.risk, userId: context.userId });
    } catch (err) {
      if (claimed) {
        if (isAmbiguousWriteError(err)) {
          await this.journal.markUnknown(ensured.executionId, {
            code: "AMBIGUOUS_OUTCOME",
            message: err instanceof Error ? err.message : "Uncertain provider outcome",
          });
        } else {
          await this.journal.markFailed(ensured.executionId, {
            code: "EXECUTION_ERROR",
            message: err instanceof Error ? err.message : "Failed to resume ad set",
          });
        }
      }
      const message = err instanceof Error ? err.message : "Failed to resume ad set";
      return this.failure(`Meta API error: ${message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// meta.ad.pause — Pause an active ad
// ---------------------------------------------------------------------------

export class MetaPauseAdTool extends BaseMetaAdsWriteTool {
  constructor(provider: WriteProvider, authorizer: MetaAccountAuthorizer, journal?: ExecutionJournalPort, approvals?: IApprovalConsumptionPort) {
    super(
      "meta.ad.pause",
      "Pause Meta Ad",
      "Pause an active Meta ad. Requires human approval. Reversible action.",
      [
        { name: "accountId", type: "string", description: "Meta ad account ID (e.g. act_123456789)", required: true },
        { name: "adId", type: "string", description: "Ad ID to pause", required: true },
      ],
      provider,
      authorizer,
      "1.0.0",
      journal,
      approvals
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const accountId = params.accountId as string;
    const adId = params.adId as string;

    const validAccount = validateAccountId(accountId);
    if (!validAccount) return this.failure("Invalid account ID format");
    const validAdId = validateEntityId(adId);
    if (!validAdId) return this.failure("Invalid ad ID format");

    const accessError = await this.checkAccess(context.userId, validAccount);
    if (accessError) return accessError;

    const idempotencyKey = buildIdempotencyKey(this.id, validAccount, validAdId, "PAUSED");
    const ensured = await this.ensureExecutable(idempotencyKey, params, context, BLOCKED_STATUSES);
    if (!ensured.ok) return this.failure(ensured.error);

    let claimed = false;
    try {
      const result = await this.provider.getAds(validAccount);
      const ad = result.data.find((a) => a.adId === validAdId);

      if (!ad) return this.failure("Ad not found");

      if (ad.status === "PAUSED") {
        return this.success({
          action: "pause_ad",
          accountId: validAccount,
          adId: validAdId,
          previousState: "PAUSED",
          requestedState: "PAUSED",
          actualState: "PAUSED",
          idempotent: true,
          message: "Ad is already paused",
        }, { toolId: this.id, risk: this.risk, userId: context.userId });
      }

      const transition = this.validateStatusTransition(ad.status, "PAUSED");
      if (!transition.valid) return this.failure(transition.error!);

      const previousState = ad.status;
      const claim = await authorizeAndClaim(
        this.approvals,
        this.journal,
        this.id,
        ensured.executionId,
        params,
        context
      );
      if (!claim.ok) return this.failure(claim.error);
      claimed = true;
      const writeResult = await this.provider.updateAdStatus(validAccount, validAdId, "PAUSED");

      if (!writeResult.success) {
        await this.journal.markFailed(ensured.executionId, {
          code: "PROVIDER_REJECTED",
          message: "Provider reported failure while pausing ad",
        });
        return this.failure("Failed to pause ad");
      }

      if (writeResult.ad.status !== "PAUSED") {
        await this.journal.markFailed(ensured.executionId, {
          code: "VERIFICATION_FAILED",
          message: "Ad status was not updated to PAUSED",
        });
        return this.failure("Verification failed: ad status was not updated to PAUSED");
      }

      await this.journal.markSucceeded(ensured.executionId, validAdId);
      return this.success({
        action: "pause_ad",
        accountId: validAccount,
        adId: validAdId,
        adName: writeResult.ad.name,
        previousState,
        requestedState: "PAUSED",
        actualState: writeResult.ad.status,
        verified: true,
      }, { toolId: this.id, risk: this.risk, userId: context.userId });
    } catch (err) {
      if (claimed) {
        if (isAmbiguousWriteError(err)) {
          await this.journal.markUnknown(ensured.executionId, {
            code: "AMBIGUOUS_OUTCOME",
            message: err instanceof Error ? err.message : "Uncertain provider outcome",
          });
        } else {
          await this.journal.markFailed(ensured.executionId, {
            code: "EXECUTION_ERROR",
            message: err instanceof Error ? err.message : "Failed to pause ad",
          });
        }
      }
      const message = err instanceof Error ? err.message : "Failed to pause ad";
      return this.failure(`Meta API error: ${message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// meta.ad.resume — Resume a paused ad
// ---------------------------------------------------------------------------

export class MetaResumeAdTool extends BaseMetaAdsWriteTool {
  constructor(provider: WriteProvider, authorizer: MetaAccountAuthorizer, journal?: ExecutionJournalPort, approvals?: IApprovalConsumptionPort) {
    super(
      "meta.ad.resume",
      "Resume Meta Ad",
      "Resume a paused Meta ad. Requires human approval. Reversible action.",
      [
        { name: "accountId", type: "string", description: "Meta ad account ID (e.g. act_123456789)", required: true },
        { name: "adId", type: "string", description: "Ad ID to resume", required: true },
      ],
      provider,
      authorizer,
      "1.0.0",
      journal,
      approvals
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const accountId = params.accountId as string;
    const adId = params.adId as string;

    const validAccount = validateAccountId(accountId);
    if (!validAccount) return this.failure("Invalid account ID format");
    const validAdId = validateEntityId(adId);
    if (!validAdId) return this.failure("Invalid ad ID format");

    const accessError = await this.checkAccess(context.userId, validAccount);
    if (accessError) return accessError;

    const idempotencyKey = buildIdempotencyKey(this.id, validAccount, validAdId, "ACTIVE");
    const ensured = await this.ensureExecutable(idempotencyKey, params, context, BLOCKED_STATUSES);
    if (!ensured.ok) return this.failure(ensured.error);

    let claimed = false;
    try {
      const result = await this.provider.getAds(validAccount);
      const ad = result.data.find((a) => a.adId === validAdId);

      if (!ad) return this.failure("Ad not found");

      if (ad.status === "ACTIVE") {
        return this.success({
          action: "resume_ad",
          accountId: validAccount,
          adId: validAdId,
          previousState: "ACTIVE",
          requestedState: "ACTIVE",
          actualState: "ACTIVE",
          idempotent: true,
          message: "Ad is already active",
        }, { toolId: this.id, risk: this.risk, userId: context.userId });
      }

      const transition = this.validateStatusTransition(ad.status, "ACTIVE");
      if (!transition.valid) return this.failure(transition.error!);

      const previousState = ad.status;
      const claim = await authorizeAndClaim(
        this.approvals,
        this.journal,
        this.id,
        ensured.executionId,
        params,
        context
      );
      if (!claim.ok) return this.failure(claim.error);
      claimed = true;
      const writeResult = await this.provider.updateAdStatus(validAccount, validAdId, "ACTIVE");

      if (!writeResult.success) {
        await this.journal.markFailed(ensured.executionId, {
          code: "PROVIDER_REJECTED",
          message: "Provider reported failure while resuming ad",
        });
        return this.failure("Failed to resume ad");
      }

      if (writeResult.ad.status !== "ACTIVE") {
        await this.journal.markFailed(ensured.executionId, {
          code: "VERIFICATION_FAILED",
          message: "Ad status was not updated to ACTIVE",
        });
        return this.failure("Verification failed: ad status was not updated to ACTIVE");
      }

      await this.journal.markSucceeded(ensured.executionId, validAdId);
      return this.success({
        action: "resume_ad",
        accountId: validAccount,
        adId: validAdId,
        adName: writeResult.ad.name,
        previousState,
        requestedState: "ACTIVE",
        actualState: writeResult.ad.status,
        verified: true,
      }, { toolId: this.id, risk: this.risk, userId: context.userId });
    } catch (err) {
      if (claimed) {
        if (isAmbiguousWriteError(err)) {
          await this.journal.markUnknown(ensured.executionId, {
            code: "AMBIGUOUS_OUTCOME",
            message: err instanceof Error ? err.message : "Uncertain provider outcome",
          });
        } else {
          await this.journal.markFailed(ensured.executionId, {
            code: "EXECUTION_ERROR",
            message: err instanceof Error ? err.message : "Failed to resume ad",
          });
        }
      }
      const message = err instanceof Error ? err.message : "Failed to resume ad";
      return this.failure(`Meta API error: ${message}`);
    }
  }
}

// ===========================================================================
// PHASE 9.2 — FINANCIAL CONTROLS (BUDGET)
// ===========================================================================

type BudgetProvider = MetaAdsProvider & MetaAdsBudgetProvider;

// ---------------------------------------------------------------------------
// Shared base for all Meta Ads BUDGET tools (Phase 9.2)
// ---------------------------------------------------------------------------
// All budget tools:
//   - requireApproval = true
//   - requiredPermissions = ["read", "write"]
//   - risk = "FINANCIAL"
//   - category = "marketing"
// ---------------------------------------------------------------------------

abstract class BaseMetaAdsBudgetTool extends BaseTool {
  protected readonly provider: BudgetProvider;
  protected readonly authorizer: MetaAccountAuthorizer;
  protected readonly guardrails: BudgetGuardrailsConfig;
  protected readonly journal: ExecutionJournalPort;
  protected readonly approvals?: IApprovalConsumptionPort;

  constructor(
    id: string,
    name: string,
    description: string,
    parameters: { name: string; type: string; description: string; required: boolean }[],
    provider: BudgetProvider,
    authorizer: MetaAccountAuthorizer,
    guardrails?: BudgetGuardrailsConfig,
    version = "1.0.0",
    journal: ExecutionJournalPort = defaultExecutionJournal,
    approvals?: IApprovalConsumptionPort
  ) {
    super(
      id,
      name,
      description,
      "marketing",
      parameters,
      true,
      ["read", "write"],
      "FINANCIAL",
      version,
      true
    );
    this.provider = provider;
    this.authorizer = authorizer;
    this.guardrails = guardrails ?? DEFAULT_BUDGET_GUARDRAILS;
    // Terminal-transition failures are contained (see withSafeTerminalTransitions).
    this.journal = withSafeTerminalTransitions(journal);
    this.approvals = approvals;
  }

  protected async checkAccess(userId: string, accountId: string): Promise<ToolResult | null> {
    const validAccount = validateAccountId(accountId);
    if (!validAccount) return this.failure("Invalid account ID format");
    const authorized = await this.authorizer.isAuthorized(userId, validAccount);
    if (!authorized) return this.failure("Not authorized to access this Meta account");
    return null;
  }

  protected async ensureExecutable(
    idempotencyKey: string,
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<{ ok: true; executionId: string } | { ok: false; error: string }> {
    let record;
    try {
      record = await this.journal.begin({
        userId: context.userId,
        toolId: this.id,
        idempotencyKey,
        paramsHash: computeParamsHash(params),
        provider: "meta-ads",
        traceId: context.traceId,
        approvalId: context.approvalId,
      });
    } catch {
      // Journal unavailable BEFORE any claim: fail closed, no ownership taken.
      return { ok: false, error: "Execution journal unavailable" };
    }
    if (BLOCKED_STATUSES.has(record.status)) {
      return { ok: false, error: `Execution already ${record.status.toLowerCase()}` };
    }
    return { ok: true, executionId: record.executionId };
  }

  protected async claimExecution(executionId: string): Promise<boolean> {
    // Durable single-winner claim with lease ownership.
    return (await this.journal.claimForExecution(executionId, {
      ownerId: crypto.randomUUID(),
      leaseMs: DEFAULT_LEASE_MS,
    })) !== null;
  }
}

// ---------------------------------------------------------------------------
// meta.campaign.budget.update — Update campaign daily budget
// ---------------------------------------------------------------------------

export class MetaUpdateCampaignBudgetTool extends BaseMetaAdsBudgetTool {
  constructor(
    provider: BudgetProvider,
    authorizer: MetaAccountAuthorizer,
    guardrails?: BudgetGuardrailsConfig,
    journal?: ExecutionJournalPort,
    approvals?: IApprovalConsumptionPort
  ) {
    super(
      "meta.campaign.budget.update",
      "Update Campaign Budget",
      "Update a Meta campaign's daily budget. Requires human approval. Server-enforced guardrails apply.",
      [
        { name: "accountId", type: "string", description: "Meta ad account ID (e.g. act_123456789)", required: true },
        { name: "campaignId", type: "string", description: "Campaign ID to update budget for", required: true },
        { name: "requestedDailyBudget", type: "number", description: "New daily budget amount in account currency", required: true },
      ],
      provider,
      authorizer,
      guardrails,
      "1.0.0",
      journal,
      approvals
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const accountId = params.accountId as string;
    const campaignId = params.campaignId as string;

    const validAccount = validateAccountId(accountId);
    if (!validAccount) return this.failure("Invalid account ID format");
    const validCampaignId = validateEntityId(campaignId);
    if (!validCampaignId) return this.failure("Invalid campaign ID format");

    const accessError = await this.checkAccess(context.userId, validAccount);
    if (accessError) return accessError;

    // Validate requested budget format
    const budgetValidation = validateBudgetAmount(params.requestedDailyBudget);
    if (!budgetValidation.valid) return this.failure(budgetValidation.error!);
    const requestedBudget = budgetValidation.amount!;

    // Idempotency check
    const idempotencyKey = buildIdempotencyKey(this.id, validAccount, validCampaignId, `budget:${requestedBudget}`);
    const ensured = await this.ensureExecutable(idempotencyKey, params, context);
    if (!ensured.ok) return this.failure(ensured.error);

    let claimed = false;
    try {
      // Fetch current state
      const result = await this.provider.getCampaigns(validAccount);
      const campaign = result.data.find((c) => c.campaignId === validCampaignId);
      if (!campaign) return this.failure("Campaign not found");

      // Parse current budget
      const currentBudget = parseBudgetValue(campaign.dailyBudget);
      if (currentBudget === null) {
        return this.failure("Campaign has no daily budget set. Cannot modify budget for campaigns without an existing daily budget.");
      }

      // Snapshot current state before write
      const previousBudget = currentBudget;
      const currency = (await this.provider.getAdAccounts()).data[0]?.currency ?? "USD";

      // Desired state already achieved — idempotent no-op (mirrors the
      // pause/resume tools): succeed without claiming or writing again.
      if (currentBudget === requestedBudget) {
        return this.success({
          action: "update_campaign_budget",
          accountId: validAccount,
          campaignId: validCampaignId,
          campaignName: campaign.name,
          previousBudget,
          requestedBudget,
          actualBudget: currentBudget,
          currency,
          absoluteChange: 0,
          percentChange: 0,
          direction: "unchanged",
          verified: true,
          idempotent: true,
          message: "Campaign daily budget is already set to the requested amount",
        }, { toolId: this.id, risk: this.risk, userId: context.userId });
      }

      // Validate transition against guardrails
      const transition = validateBudgetTransition(previousBudget, requestedBudget, this.guardrails);
      if (!transition.valid) {
        return this.failure(`Budget limit exceeded: ${transition.errors.join("; ")}`);
      }

      // Build change summary
      const summary = buildBudgetChangeSummary(previousBudget, requestedBudget, currency);

      // Execute write
      const claim = await authorizeAndClaim(
        this.approvals,
        this.journal,
        this.id,
        ensured.executionId,
        params,
        context
      );
      if (!claim.ok) return this.failure(claim.error);
      claimed = true;
      const budgetString = requestedBudget.toFixed(2);
      const writeResult = await this.provider.updateCampaignBudget(validAccount, validCampaignId, budgetString);

      if (!writeResult.success) {
        await this.journal.markFailed(ensured.executionId, {
          code: "PROVIDER_REJECTED",
          message: "Provider reported failure while updating campaign budget",
        });
        return this.failure("Failed to update campaign budget");
      }

      // Re-fetch to verify
      const verifyResult = await this.provider.getCampaigns(validAccount);
      const verifiedCampaign = verifyResult.data.find((c) => c.campaignId === validCampaignId);
      if (!verifiedCampaign) {
        await this.journal.markUnknown(ensured.executionId, {
          code: "VERIFICATION_INCONCLUSIVE",
          message: "Campaign not found after budget update; outcome uncertain",
        });
        return this.failure("Campaign not found after budget update");
      }

      const actualBudget = parseBudgetValue(verifiedCampaign.dailyBudget);
      if (actualBudget === null) {
        await this.journal.markUnknown(ensured.executionId, {
          code: "VERIFICATION_INCONCLUSIVE",
          message: "Cannot read budget from updated campaign; outcome uncertain",
        });
        return this.failure("Cannot read budget from updated campaign");
      }

      const verification = verifyBudgetResult(requestedBudget, actualBudget);
      if (!verification.verified) {
        await this.journal.markUnknown(ensured.executionId, {
          code: "VERIFICATION_MISMATCH",
          message: verification.error ?? "Budget mismatch after update; outcome uncertain",
        });
        return this.failure(verification.error!);
      }

      await this.journal.markSucceeded(ensured.executionId, validCampaignId);

      return this.success({
        action: "update_campaign_budget",
        accountId: validAccount,
        campaignId: validCampaignId,
        campaignName: verifiedCampaign.name,
        previousBudget,
        requestedBudget,
        actualBudget,
        currency: summary.currency,
        absoluteChange: summary.absoluteChange,
        percentChange: Math.round(summary.percentChange * 100) / 100,
        direction: summary.direction,
        verified: true,
        guardrails: {
          maxDailyBudget: this.guardrails.maxDailyBudget,
          maxIncreasePercent: this.guardrails.maxIncreasePercent,
          maxIncreaseAbsolute: this.guardrails.maxIncreaseAbsolute,
          maxDecreasePercent: this.guardrails.maxDecreasePercent,
          maxDecreaseAbsolute: this.guardrails.maxDecreaseAbsolute,
        },
      }, { toolId: this.id, risk: this.risk, userId: context.userId });
    } catch (err) {
      if (claimed) {
        if (isAmbiguousWriteError(err)) {
          await this.journal.markUnknown(ensured.executionId, {
            code: "AMBIGUOUS_OUTCOME",
            message: err instanceof Error ? err.message : "Uncertain provider outcome",
          });
        } else {
          await this.journal.markFailed(ensured.executionId, {
            code: "EXECUTION_ERROR",
            message: err instanceof Error ? err.message : "Failed to update campaign budget",
          });
        }
      }
      const message = err instanceof Error ? err.message : "Failed to update campaign budget";
      return this.failure(`Meta API error: ${message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// meta.adset.budget.update — Update ad-set daily budget
// ---------------------------------------------------------------------------

export class MetaUpdateAdSetBudgetTool extends BaseMetaAdsBudgetTool {
  constructor(
    provider: BudgetProvider,
    authorizer: MetaAccountAuthorizer,
    guardrails?: BudgetGuardrailsConfig,
    journal?: ExecutionJournalPort,
    approvals?: IApprovalConsumptionPort
  ) {
    super(
      "meta.adset.budget.update",
      "Update Ad Set Budget",
      "Update a Meta ad set's daily budget. Requires human approval. Server-enforced guardrails apply.",
      [
        { name: "accountId", type: "string", description: "Meta ad account ID (e.g. act_123456789)", required: true },
        { name: "adSetId", type: "string", description: "Ad set ID to update budget for", required: true },
        { name: "requestedDailyBudget", type: "number", description: "New daily budget amount in account currency", required: true },
      ],
      provider,
      authorizer,
      guardrails,
      "1.0.0",
      journal,
      approvals
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const accountId = params.accountId as string;
    const adSetId = params.adSetId as string;

    const validAccount = validateAccountId(accountId);
    if (!validAccount) return this.failure("Invalid account ID format");
    const validAdSetId = validateEntityId(adSetId);
    if (!validAdSetId) return this.failure("Invalid ad set ID format");

    const accessError = await this.checkAccess(context.userId, validAccount);
    if (accessError) return accessError;

    // Validate requested budget format
    const budgetValidation = validateBudgetAmount(params.requestedDailyBudget);
    if (!budgetValidation.valid) return this.failure(budgetValidation.error!);
    const requestedBudget = budgetValidation.amount!;

    // Idempotency check
    const idempotencyKey = buildIdempotencyKey(this.id, validAccount, validAdSetId, `budget:${requestedBudget}`);
    const ensured = await this.ensureExecutable(idempotencyKey, params, context);
    if (!ensured.ok) return this.failure(ensured.error);

    let claimed = false;
    try {
      // Fetch current state
      const result = await this.provider.getAdSets(validAccount);
      const adSet = result.data.find((a) => a.adSetId === validAdSetId);
      if (!adSet) return this.failure("Ad set not found");

      // Parse current budget
      const currentBudget = parseBudgetValue(adSet.dailyBudget);
      if (currentBudget === null) {
        return this.failure("Ad set has no daily budget set. Cannot modify budget for ad sets without an existing daily budget.");
      }

      // Snapshot current state before write
      const previousBudget = currentBudget;
      const currency = (await this.provider.getAdAccounts()).data[0]?.currency ?? "USD";

      // Desired state already achieved — idempotent no-op (mirrors the
      // pause/resume tools): succeed without claiming or writing again.
      if (currentBudget === requestedBudget) {
        return this.success({
          action: "update_adset_budget",
          accountId: validAccount,
          adSetId: validAdSetId,
          adSetName: adSet.name,
          previousBudget,
          requestedBudget,
          actualBudget: currentBudget,
          currency,
          absoluteChange: 0,
          percentChange: 0,
          direction: "unchanged",
          verified: true,
          idempotent: true,
          message: "Ad set daily budget is already set to the requested amount",
        }, { toolId: this.id, risk: this.risk, userId: context.userId });
      }

      // Validate transition against guardrails
      const transition = validateBudgetTransition(previousBudget, requestedBudget, this.guardrails);
      if (!transition.valid) {
        return this.failure(`Budget limit exceeded: ${transition.errors.join("; ")}`);
      }

      // Build change summary
      const summary = buildBudgetChangeSummary(previousBudget, requestedBudget, currency);

      // Execute write
      const claim = await authorizeAndClaim(
        this.approvals,
        this.journal,
        this.id,
        ensured.executionId,
        params,
        context
      );
      if (!claim.ok) return this.failure(claim.error);
      claimed = true;
      const budgetString = requestedBudget.toFixed(2);
      const writeResult = await this.provider.updateAdSetBudget(validAccount, validAdSetId, budgetString);

      if (!writeResult.success) {
        await this.journal.markFailed(ensured.executionId, {
          code: "PROVIDER_REJECTED",
          message: "Provider reported failure while updating ad set budget",
        });
        return this.failure("Failed to update ad set budget");
      }

      // Re-fetch to verify
      const verifyResult = await this.provider.getAdSets(validAccount);
      const verifiedAdSet = verifyResult.data.find((a) => a.adSetId === validAdSetId);
      if (!verifiedAdSet) {
        await this.journal.markUnknown(ensured.executionId, {
          code: "VERIFICATION_INCONCLUSIVE",
          message: "Ad set not found after budget update; outcome uncertain",
        });
        return this.failure("Ad set not found after budget update");
      }

      const actualBudget = parseBudgetValue(verifiedAdSet.dailyBudget);
      if (actualBudget === null) {
        await this.journal.markUnknown(ensured.executionId, {
          code: "VERIFICATION_INCONCLUSIVE",
          message: "Cannot read budget from updated ad set; outcome uncertain",
        });
        return this.failure("Cannot read budget from updated ad set");
      }

      const verification = verifyBudgetResult(requestedBudget, actualBudget);
      if (!verification.verified) {
        await this.journal.markUnknown(ensured.executionId, {
          code: "VERIFICATION_MISMATCH",
          message: verification.error ?? "Budget mismatch after update; outcome uncertain",
        });
        return this.failure(verification.error!);
      }

      await this.journal.markSucceeded(ensured.executionId, validAdSetId);

      return this.success({
        action: "update_adset_budget",
        accountId: validAccount,
        adSetId: validAdSetId,
        adSetName: verifiedAdSet.name,
        previousBudget,
        requestedBudget,
        actualBudget,
        currency: summary.currency,
        absoluteChange: summary.absoluteChange,
        percentChange: Math.round(summary.percentChange * 100) / 100,
        direction: summary.direction,
        verified: true,
        guardrails: {
          maxDailyBudget: this.guardrails.maxDailyBudget,
          maxIncreasePercent: this.guardrails.maxIncreasePercent,
          maxIncreaseAbsolute: this.guardrails.maxIncreaseAbsolute,
          maxDecreasePercent: this.guardrails.maxDecreasePercent,
          maxDecreaseAbsolute: this.guardrails.maxDecreaseAbsolute,
        },
      }, { toolId: this.id, risk: this.risk, userId: context.userId });
    } catch (err) {
      if (claimed) {
        if (isAmbiguousWriteError(err)) {
          await this.journal.markUnknown(ensured.executionId, {
            code: "AMBIGUOUS_OUTCOME",
            message: err instanceof Error ? err.message : "Uncertain provider outcome",
          });
        } else {
          await this.journal.markFailed(ensured.executionId, {
            code: "EXECUTION_ERROR",
            message: err instanceof Error ? err.message : "Failed to update ad set budget",
          });
        }
      }
      const message = err instanceof Error ? err.message : "Failed to update ad set budget";
      return this.failure(`Meta API error: ${message}`);
    }
  }
}

// ===========================================================================
// PHASE 9.3 — AI-ASSISTED CAMPAIGN CREATION
// ===========================================================================

type CampaignProvider = MetaAdsProvider & MetaAdsBudgetProvider & MetaCampaignCreatorProvider;

// ---------------------------------------------------------------------------
// Proposal validation
// ---------------------------------------------------------------------------

const OBJECTIVES = new Set([
  "OUTCOME_AWARENESS",
  "OUTCOME_ENGAGEMENT",
  "OUTCOME_LEADS",
  "OUTCOME_SALES",
  "OUTCOME_TRAFFIC",
]);

const VALID_BUYING_TYPES = new Set(["AUCTION", "RESERVED"]);
const VALID_STATUSES = new Set(["ACTIVE", "PAUSED"]);
const MAX_DAILY_BUDGET = 100_000;
const MAX_LIFETIME_BUDGET = 10_000_000;
const MAX_AD_SETS_PER_PROPOSAL = 50;

interface ProposalValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateCampaignProposal(proposal: unknown): ProposalValidationResult {
  const errors: string[] = [];

  if (!proposal || typeof proposal !== "object") {
    return { valid: false, errors: ["Proposal must be a non-null object"] };
  }

  const p = proposal as Record<string, unknown>;

  if (!p.name || typeof p.name !== "string" || p.name.trim().length === 0) {
    errors.push("Proposal name is required");
  } else if (p.name.length > 400) {
    errors.push("Proposal name must be 400 characters or less");
  }

  if (!p.objective || typeof p.objective !== "string") {
    errors.push("Proposal objective is required");
  } else if (!OBJECTIVES.has(p.objective)) {
    errors.push(`Invalid objective "${p.objective}". Must be one of: ${[...OBJECTIVES].join(", ")}`);
  }

  if (p.buyingType && typeof p.buyingType === "string" && !VALID_BUYING_TYPES.has(p.buyingType)) {
    errors.push(`Invalid buyingType "${p.buyingType}". Must be one of: ${[...VALID_BUYING_TYPES].join(", ")}`);
  }

  if (p.status && typeof p.status === "string" && !VALID_STATUSES.has(p.status)) {
    errors.push(`Invalid status "${p.status}". Must be one of: ${[...VALID_STATUSES].join(", ")}`);
  }

  if (p.dailyBudget !== undefined && p.dailyBudget !== null) {
    if (typeof p.dailyBudget !== "number" || p.dailyBudget <= 0) {
      errors.push("dailyBudget must be a positive number");
    } else if (p.dailyBudget > MAX_DAILY_BUDGET) {
      errors.push(`dailyBudget cannot exceed ${MAX_DAILY_BUDGET}`);
    }
  }

  if (p.lifetimeBudget !== undefined && p.lifetimeBudget !== null) {
    if (typeof p.lifetimeBudget !== "number" || p.lifetimeBudget <= 0) {
      errors.push("lifetimeBudget must be a positive number");
    } else if (p.lifetimeBudget > MAX_LIFETIME_BUDGET) {
      errors.push(`lifetimeBudget cannot exceed ${MAX_LIFETIME_BUDGET}`);
    }
  }

  if (p.currency && typeof p.currency === "string" && p.currency.length !== 3) {
    errors.push("currency must be a 3-letter ISO code");
  }

  if (!Array.isArray(p.adSets) || p.adSets.length === 0) {
    errors.push("At least one adSet is required");
  } else if (p.adSets.length > MAX_AD_SETS_PER_PROPOSAL) {
    errors.push(`Cannot have more than ${MAX_AD_SETS_PER_PROPOSAL} ad sets`);
  } else {
    p.adSets.forEach((adSet: unknown, i: number) => {
      if (!adSet || typeof adSet !== "object") {
        errors.push(`adSet[${i}] must be an object`);
        return;
      }
      const a = adSet as Record<string, unknown>;
      if (!a.name || typeof a.name !== "string" || (a.name as string).trim().length === 0) {
        errors.push(`adSet[${i}].name is required`);
      } else if ((a.name as string).length > 400) {
        errors.push(`adSet[${i}].name must be 400 characters or less`);
      }
      if (!a.optimizationGoal || typeof a.optimizationGoal !== "string") {
        errors.push(`adSet[${i}].optimizationGoal is required`);
      }
      if (a.dailyBudget !== undefined && a.dailyBudget !== null) {
        if (typeof a.dailyBudget !== "number" || a.dailyBudget <= 0) {
          errors.push(`adSet[${i}].dailyBudget must be a positive number`);
        }
      }
      if (a.bidAmount !== undefined && a.bidAmount !== null) {
        if (typeof a.bidAmount !== "number" || a.bidAmount <= 0) {
          errors.push(`adSet[${i}].bidAmount must be a positive number`);
        }
      }
    });
  }

  if (p.confidence !== undefined && p.confidence !== null) {
    if (typeof p.confidence !== "number" || p.confidence < 0 || p.confidence > 1) {
      errors.push("confidence must be a number between 0 and 1");
    }
  }

  if (p.warnings && !Array.isArray(p.warnings)) {
    errors.push("warnings must be an array of strings");
  }

  if (p.assumptions && !Array.isArray(p.assumptions)) {
    errors.push("assumptions must be an array of strings");
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Shared base for campaign creation tools (Phase 9.3)
// ---------------------------------------------------------------------------

abstract class BaseMetaCampaignTool extends BaseTool {
  protected readonly provider: CampaignProvider;
  protected readonly authorizer: MetaAccountAuthorizer;
  protected readonly guardrails: BudgetGuardrailsConfig;
  protected readonly journal: ExecutionJournalPort;
  protected readonly approvals?: IApprovalConsumptionPort;

  constructor(
    id: string,
    name: string,
    description: string,
    parameters: { name: string; type: string; description: string; required: boolean }[],
    provider: CampaignProvider,
    authorizer: MetaAccountAuthorizer,
    guardrails?: BudgetGuardrailsConfig,
    version = "1.0.0",
    journal: ExecutionJournalPort = defaultExecutionJournal,
    approvals?: IApprovalConsumptionPort
  ) {
    super(
      id,
      name,
      description,
      "marketing",
      parameters,
      true,
      ["read", "write"],
      "EXTERNAL_SIDE_EFFECT",
      version,
      true
    );
    this.provider = provider;
    this.authorizer = authorizer;
    this.guardrails = guardrails ?? DEFAULT_BUDGET_GUARDRAILS;
    // Terminal-transition failures are contained (see withSafeTerminalTransitions).
    this.journal = withSafeTerminalTransitions(journal);
    this.approvals = approvals;
  }

  protected async checkAccess(userId: string, accountId: string): Promise<ToolResult | null> {
    const validAccount = validateAccountId(accountId);
    if (!validAccount) return this.failure("Invalid account ID format");
    const authorized = await this.authorizer.isAuthorized(userId, validAccount);
    if (!authorized) return this.failure("Not authorized to access this Meta account");
    return null;
  }

  protected async ensureExecutable(
    idempotencyKey: string,
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<{ ok: true; executionId: string } | { ok: false; error: string }> {
    let record;
    try {
      record = await this.journal.begin({
        userId: context.userId,
        toolId: this.id,
        idempotencyKey,
        paramsHash: computeParamsHash(params),
        provider: "meta-ads",
        traceId: context.traceId,
        approvalId: context.approvalId,
      });
    } catch {
      // Journal unavailable BEFORE any claim: fail closed, no ownership taken.
      return { ok: false, error: "Execution journal unavailable" };
    }
    // Campaign creation blocks SUCCEEDED to prevent duplicate campaigns.
    if (CREATE_BLOCKED_STATUSES.has(record.status)) {
      return { ok: false, error: `Execution already ${record.status.toLowerCase()}` };
    }
    return { ok: true, executionId: record.executionId };
  }

  protected async claimExecution(executionId: string): Promise<boolean> {
    // Durable single-winner claim with lease ownership.
    return (await this.journal.claimForExecution(executionId, {
      ownerId: crypto.randomUUID(),
      leaseMs: DEFAULT_LEASE_MS,
    })) !== null;
  }
}

// ---------------------------------------------------------------------------
// meta.campaign.create — Create a new campaign from an AI-generated proposal
// ---------------------------------------------------------------------------
// Creates campaigns only. Does NOT create ad sets, ads, creatives, or targeting.
// Requires proposal validation, budget guardrails, approval, idempotency, stale protection,
// verification, and audit metadata.
// ---------------------------------------------------------------------------

export class MetaCreateCampaignTool extends BaseMetaCampaignTool {
  constructor(
    provider: CampaignProvider,
    authorizer: MetaAccountAuthorizer,
    guardrails?: BudgetGuardrailsConfig,
    journal?: ExecutionJournalPort,
    approvals?: IApprovalConsumptionPort
  ) {
    super(
      "meta.campaign.create",
      "Create Meta Campaign",
      "Create a new Meta campaign from an AI-generated proposal. Requires human approval. Budget guardrails enforced. Campaigns start in PAUSED state by default.",
      [
        { name: "accountId", type: "string", description: "Meta ad account ID (e.g. act_123456789)", required: true },
        { name: "proposal", type: "object", description: "AI-generated campaign proposal (see CampaignProposal schema)", required: true },
      ],
      provider,
      authorizer,
      guardrails,
      "1.0.0",
      journal,
      approvals
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const accountId = params.accountId as string;
    const proposal = params.proposal as CampaignProposal | undefined;

    const validAccount = validateAccountId(accountId);
    if (!validAccount) return this.failure("Invalid account ID format");

    const accessError = await this.checkAccess(context.userId, validAccount);
    if (accessError) return accessError;

    if (!proposal || typeof proposal !== "object") {
      return this.failure("proposal parameter is required and must be an object");
    }

    const proposalValidation = validateCampaignProposal(proposal);
    if (!proposalValidation.valid) {
      return this.failure(`Invalid proposal: ${proposalValidation.errors.join("; ")}`);
    }

    const hasBudget = (proposal.dailyBudget != null) || (proposal.lifetimeBudget != null) || proposal.adSets?.some((a) => a.dailyBudget != null);
    if (hasBudget) {
      const budgetAmount = proposal.dailyBudget ?? proposal.adSets?.[0]?.dailyBudget ?? 0;
      if (typeof budgetAmount === "number" && budgetAmount > 0) {
        if (budgetAmount > this.guardrails.maxDailyBudget) {
          return this.failure(`Budget guardrail: daily budget ${budgetAmount} exceeds maximum ${this.guardrails.maxDailyBudget}`);
        }
      }
    }

    const idempotencyKey = buildIdempotencyKey(
      this.id,
      validAccount,
      `proposal:${proposal.name}`,
      proposal.objective
    );
    const ensured = await this.ensureExecutable(idempotencyKey, params, context);
    if (!ensured.ok) return this.failure(ensured.error);

    let claimed = false;
    try {
      const claim = await authorizeAndClaim(
        this.approvals,
        this.journal,
        this.id,
        ensured.executionId,
        params,
        context
      );
      if (!claim.ok) return this.failure(claim.error);
      claimed = true;

      const input: MetaCampaignInput = {
        name: proposal.name,
        objective: proposal.objective,
        status: proposal.status ?? "PAUSED",
        buyingType: proposal.buyingType ?? "AUCTION",
        specialAdCategories: proposal.specialAdCategories ?? [],
      };

      if (proposal.dailyBudget != null) {
        input.dailyBudget = String(proposal.dailyBudget);
      }
      if (proposal.lifetimeBudget != null) {
        input.lifetimeBudget = String(proposal.lifetimeBudget);
      }

      let writeResult: Awaited<ReturnType<CampaignProvider["createCampaign"]>>;
      try {
        writeResult = await this.provider.createCampaign(validAccount, input);
      } catch (writeErr) {
        if (isAmbiguousWriteError(writeErr)) {
          await this.journal.markUnknown(ensured.executionId, {
            code: "AMBIGUOUS_OUTCOME",
            message: writeErr instanceof Error
              ? writeErr.message
              : "Uncertain provider outcome during createCampaign",
          });
        }
        throw writeErr;
      }

      if (!writeResult.success) {
        await this.journal.markFailed(ensured.executionId, {
          code: "PROVIDER_REJECTED",
          message: "Provider reported failure while creating campaign",
        });
        return this.failure("Failed to create campaign");
      }

      if (!writeResult.campaign?.campaignId) {
        await this.journal.markUnknown(ensured.executionId, {
          code: "VERIFICATION_INCONCLUSIVE",
          message: "Campaign was not created (no campaign ID returned); outcome uncertain",
        });
        return this.failure("Verification failed: campaign was not created (no campaign ID returned)");
      }

      const createdCampaign = writeResult.campaign;

      if (proposal.status && createdCampaign.status !== proposal.status) {
        await this.journal.markUnknown(ensured.executionId, {
          code: "VERIFICATION_MISMATCH",
          message: `Campaign status is "${createdCampaign.status}" but expected "${proposal.status}"`,
        });
        return this.failure(
          `Verification failed: campaign status is "${createdCampaign.status}" but expected "${proposal.status}"`
        );
      }

      await this.journal.markSucceeded(ensured.executionId, createdCampaign.campaignId);

      return this.success({
        action: "create_campaign",
        accountId: validAccount,
        campaignId: createdCampaign.campaignId,
        campaignName: createdCampaign.name,
        objective: proposal.objective,
        buyingType: proposal.buyingType ?? "AUCTION",
        status: createdCampaign.status,
        dailyBudget: createdCampaign.dailyBudget,
        lifetimeBudget: createdCampaign.lifetimeBudget,
        adSetCount: proposal.adSets?.length ?? 0,
        verified: true,
        aiProvider: proposal.aiProvider,
        aiModel: proposal.aiModel,
        confidence: proposal.confidence,
        warnings: proposal.warnings,
        assumptions: proposal.assumptions,
      }, { toolId: this.id, risk: this.risk, userId: context.userId });
    } catch (err) {
      if (claimed && !isAmbiguousWriteError(err)) {
        await this.journal.markFailed(ensured.executionId, {
          code: "EXECUTION_ERROR",
          message: err instanceof Error ? err.message : "Failed to create campaign",
        });
      }
      const message = err instanceof Error ? err.message : "Failed to create campaign";
      return this.failure(`Meta API error: ${message}`);
    }
  }
}
