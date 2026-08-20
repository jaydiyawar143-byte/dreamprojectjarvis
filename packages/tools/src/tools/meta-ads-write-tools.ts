import { BaseTool } from "../base-tool.js";
import type { ToolResult, ToolContext, BudgetGuardrailsConfig, CampaignProposal, MetaCampaignInput } from "@jarvis/core";
import type { MetaAdsProvider, MetaAccountAuthorizer, MetaAdsWriteProvider, MetaAdsBudgetProvider, MetaCampaignCreatorProvider } from "./meta-ads-provider.js";
import { validateAccountId, validateEntityId, parseBudgetValue } from "./meta-ads-validators.js";
import { validateBudgetAmount, validateBudgetTransition, buildBudgetChangeSummary, verifyBudgetResult, DEFAULT_BUDGET_GUARDRAILS } from "./meta-ads-budget-guardrails.js";

// ---------------------------------------------------------------------------
// Execution state machine (application-level idempotency)
// ---------------------------------------------------------------------------
// Prevents duplicate Meta API side effects for the same action+target.
// ---------------------------------------------------------------------------

export type MetaExecutionState =
  | "PENDING"
  | "APPROVED"
  | "EXECUTING"
  | "SUCCEEDED"
  | "FAILED"
  | "EXPIRED"
  | "CANCELLED"
  | "STALE";

interface ExecutionRecord {
  state: MetaExecutionState;
  executionId: string;
  timestamp: number;
}

const executionStore = new Map<string, ExecutionRecord>();

export function getExecutionState(idempotencyKey: string): ExecutionRecord | undefined {
  return executionStore.get(idempotencyKey);
}

export function setExecutionState(
  idempotencyKey: string,
  state: MetaExecutionState,
  executionId: string
): void {
  executionStore.set(idempotencyKey, { state, executionId, timestamp: Date.now() });
}

export function clearExecutionStore(): void {
  executionStore.clear();
}

const BLOCKED_STATES: ReadonlySet<MetaExecutionState> = new Set([
  "EXECUTING",
  "CANCELLED",
  "EXPIRED",
  "STALE",
]);

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

abstract class BaseMetaAdsWriteTool extends BaseTool {
  protected readonly provider: WriteProvider;
  protected readonly authorizer: MetaAccountAuthorizer;

  constructor(
    id: string,
    name: string,
    description: string,
    parameters: { name: string; type: string; description: string; required: boolean }[],
    provider: WriteProvider,
    authorizer: MetaAccountAuthorizer,
    version = "1.0.0"
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

  protected checkIdempotency(idempotencyKey: string): {
    blocked: boolean;
    state?: MetaExecutionState;
    error?: string;
  } {
    const existing = getExecutionState(idempotencyKey);
    if (!existing) return { blocked: false };
    if (BLOCKED_STATES.has(existing.state)) {
      return {
        blocked: true,
        state: existing.state,
        error: `Execution already ${existing.state.toLowerCase()}`,
      };
    }
    return { blocked: false };
  }
}

// ---------------------------------------------------------------------------
// meta.campaign.pause — Pause an active campaign
// ---------------------------------------------------------------------------

export class MetaPauseCampaignTool extends BaseMetaAdsWriteTool {
  constructor(provider: WriteProvider, authorizer: MetaAccountAuthorizer) {
    super(
      "meta.campaign.pause",
      "Pause Meta Campaign",
      "Pause an active Meta ad campaign. Requires human approval. Reversible action.",
      [
        { name: "accountId", type: "string", description: "Meta ad account ID (e.g. act_123456789)", required: true },
        { name: "campaignId", type: "string", description: "Campaign ID to pause", required: true },
      ],
      provider,
      authorizer
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
    const idempotencyCheck = this.checkIdempotency(idempotencyKey);
    if (idempotencyCheck.blocked) {
      return this.failure(idempotencyCheck.error!);
    }

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
      setExecutionState(idempotencyKey, "EXECUTING", context.userId);
      const writeResult = await this.provider.updateCampaignStatus(validAccount, validCampaignId, "PAUSED");

      if (!writeResult.success) {
        setExecutionState(idempotencyKey, "FAILED", context.userId);
        return this.failure("Failed to pause campaign");
      }

      if (writeResult.campaign.status !== "PAUSED") {
        setExecutionState(idempotencyKey, "FAILED", context.userId);
        return this.failure("Verification failed: campaign status was not updated to PAUSED");
      }

      setExecutionState(idempotencyKey, "SUCCEEDED", context.userId);
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
      const message = err instanceof Error ? err.message : "Failed to pause campaign";
      return this.failure(`Meta API error: ${message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// meta.campaign.resume — Resume a paused campaign
// ---------------------------------------------------------------------------

export class MetaResumeCampaignTool extends BaseMetaAdsWriteTool {
  constructor(provider: WriteProvider, authorizer: MetaAccountAuthorizer) {
    super(
      "meta.campaign.resume",
      "Resume Meta Campaign",
      "Resume a paused Meta ad campaign. Requires human approval. Reversible action.",
      [
        { name: "accountId", type: "string", description: "Meta ad account ID (e.g. act_123456789)", required: true },
        { name: "campaignId", type: "string", description: "Campaign ID to resume", required: true },
      ],
      provider,
      authorizer
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
    const idempotencyCheck = this.checkIdempotency(idempotencyKey);
    if (idempotencyCheck.blocked) {
      return this.failure(idempotencyCheck.error!);
    }

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
      setExecutionState(idempotencyKey, "EXECUTING", context.userId);
      const writeResult = await this.provider.updateCampaignStatus(validAccount, validCampaignId, "ACTIVE");

      if (!writeResult.success) {
        setExecutionState(idempotencyKey, "FAILED", context.userId);
        return this.failure("Failed to resume campaign");
      }

      if (writeResult.campaign.status !== "ACTIVE") {
        setExecutionState(idempotencyKey, "FAILED", context.userId);
        return this.failure("Verification failed: campaign status was not updated to ACTIVE");
      }

      setExecutionState(idempotencyKey, "SUCCEEDED", context.userId);
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
      const message = err instanceof Error ? err.message : "Failed to resume campaign";
      return this.failure(`Meta API error: ${message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// meta.adset.pause — Pause an active ad set
// ---------------------------------------------------------------------------

export class MetaPauseAdSetTool extends BaseMetaAdsWriteTool {
  constructor(provider: WriteProvider, authorizer: MetaAccountAuthorizer) {
    super(
      "meta.adset.pause",
      "Pause Meta Ad Set",
      "Pause an active Meta ad set. Requires human approval. Reversible action.",
      [
        { name: "accountId", type: "string", description: "Meta ad account ID (e.g. act_123456789)", required: true },
        { name: "adSetId", type: "string", description: "Ad set ID to pause", required: true },
      ],
      provider,
      authorizer
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
    const idempotencyCheck = this.checkIdempotency(idempotencyKey);
    if (idempotencyCheck.blocked) {
      return this.failure(idempotencyCheck.error!);
    }

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
      setExecutionState(idempotencyKey, "EXECUTING", context.userId);
      const writeResult = await this.provider.updateAdSetStatus(validAccount, validAdSetId, "PAUSED");

      if (!writeResult.success) {
        setExecutionState(idempotencyKey, "FAILED", context.userId);
        return this.failure("Failed to pause ad set");
      }

      if (writeResult.adSet.status !== "PAUSED") {
        setExecutionState(idempotencyKey, "FAILED", context.userId);
        return this.failure("Verification failed: ad set status was not updated to PAUSED");
      }

      setExecutionState(idempotencyKey, "SUCCEEDED", context.userId);
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
      const message = err instanceof Error ? err.message : "Failed to pause ad set";
      return this.failure(`Meta API error: ${message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// meta.adset.resume — Resume a paused ad set
// ---------------------------------------------------------------------------

export class MetaResumeAdSetTool extends BaseMetaAdsWriteTool {
  constructor(provider: WriteProvider, authorizer: MetaAccountAuthorizer) {
    super(
      "meta.adset.resume",
      "Resume Meta Ad Set",
      "Resume a paused Meta ad set. Requires human approval. Reversible action.",
      [
        { name: "accountId", type: "string", description: "Meta ad account ID (e.g. act_123456789)", required: true },
        { name: "adSetId", type: "string", description: "Ad set ID to resume", required: true },
      ],
      provider,
      authorizer
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
    const idempotencyCheck = this.checkIdempotency(idempotencyKey);
    if (idempotencyCheck.blocked) {
      return this.failure(idempotencyCheck.error!);
    }

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
      setExecutionState(idempotencyKey, "EXECUTING", context.userId);
      const writeResult = await this.provider.updateAdSetStatus(validAccount, validAdSetId, "ACTIVE");

      if (!writeResult.success) {
        setExecutionState(idempotencyKey, "FAILED", context.userId);
        return this.failure("Failed to resume ad set");
      }

      if (writeResult.adSet.status !== "ACTIVE") {
        setExecutionState(idempotencyKey, "FAILED", context.userId);
        return this.failure("Verification failed: ad set status was not updated to ACTIVE");
      }

      setExecutionState(idempotencyKey, "SUCCEEDED", context.userId);
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
      const message = err instanceof Error ? err.message : "Failed to resume ad set";
      return this.failure(`Meta API error: ${message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// meta.ad.pause — Pause an active ad
// ---------------------------------------------------------------------------

export class MetaPauseAdTool extends BaseMetaAdsWriteTool {
  constructor(provider: WriteProvider, authorizer: MetaAccountAuthorizer) {
    super(
      "meta.ad.pause",
      "Pause Meta Ad",
      "Pause an active Meta ad. Requires human approval. Reversible action.",
      [
        { name: "accountId", type: "string", description: "Meta ad account ID (e.g. act_123456789)", required: true },
        { name: "adId", type: "string", description: "Ad ID to pause", required: true },
      ],
      provider,
      authorizer
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
    const idempotencyCheck = this.checkIdempotency(idempotencyKey);
    if (idempotencyCheck.blocked) {
      return this.failure(idempotencyCheck.error!);
    }

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
      setExecutionState(idempotencyKey, "EXECUTING", context.userId);
      const writeResult = await this.provider.updateAdStatus(validAccount, validAdId, "PAUSED");

      if (!writeResult.success) {
        setExecutionState(idempotencyKey, "FAILED", context.userId);
        return this.failure("Failed to pause ad");
      }

      if (writeResult.ad.status !== "PAUSED") {
        setExecutionState(idempotencyKey, "FAILED", context.userId);
        return this.failure("Verification failed: ad status was not updated to PAUSED");
      }

      setExecutionState(idempotencyKey, "SUCCEEDED", context.userId);
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
      const message = err instanceof Error ? err.message : "Failed to pause ad";
      return this.failure(`Meta API error: ${message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// meta.ad.resume — Resume a paused ad
// ---------------------------------------------------------------------------

export class MetaResumeAdTool extends BaseMetaAdsWriteTool {
  constructor(provider: WriteProvider, authorizer: MetaAccountAuthorizer) {
    super(
      "meta.ad.resume",
      "Resume Meta Ad",
      "Resume a paused Meta ad. Requires human approval. Reversible action.",
      [
        { name: "accountId", type: "string", description: "Meta ad account ID (e.g. act_123456789)", required: true },
        { name: "adId", type: "string", description: "Ad ID to resume", required: true },
      ],
      provider,
      authorizer
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
    const idempotencyCheck = this.checkIdempotency(idempotencyKey);
    if (idempotencyCheck.blocked) {
      return this.failure(idempotencyCheck.error!);
    }

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
      setExecutionState(idempotencyKey, "EXECUTING", context.userId);
      const writeResult = await this.provider.updateAdStatus(validAccount, validAdId, "ACTIVE");

      if (!writeResult.success) {
        setExecutionState(idempotencyKey, "FAILED", context.userId);
        return this.failure("Failed to resume ad");
      }

      if (writeResult.ad.status !== "ACTIVE") {
        setExecutionState(idempotencyKey, "FAILED", context.userId);
        return this.failure("Verification failed: ad status was not updated to ACTIVE");
      }

      setExecutionState(idempotencyKey, "SUCCEEDED", context.userId);
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

  constructor(
    id: string,
    name: string,
    description: string,
    parameters: { name: string; type: string; description: string; required: boolean }[],
    provider: BudgetProvider,
    authorizer: MetaAccountAuthorizer,
    guardrails?: BudgetGuardrailsConfig,
    version = "1.0.0"
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
  }

  protected async checkAccess(userId: string, accountId: string): Promise<ToolResult | null> {
    const validAccount = validateAccountId(accountId);
    if (!validAccount) return this.failure("Invalid account ID format");
    const authorized = await this.authorizer.isAuthorized(userId, validAccount);
    if (!authorized) return this.failure("Not authorized to access this Meta account");
    return null;
  }

  protected checkIdempotency(idempotencyKey: string): {
    blocked: boolean;
    state?: MetaExecutionState;
    error?: string;
  } {
    const existing = getExecutionState(idempotencyKey);
    if (!existing) return { blocked: false };
    if (BLOCKED_STATES.has(existing.state)) {
      return {
        blocked: true,
        state: existing.state,
        error: `Execution already ${existing.state.toLowerCase()}`,
      };
    }
    return { blocked: false };
  }
}

// ---------------------------------------------------------------------------
// meta.campaign.budget.update — Update campaign daily budget
// ---------------------------------------------------------------------------

export class MetaUpdateCampaignBudgetTool extends BaseMetaAdsBudgetTool {
  constructor(
    provider: BudgetProvider,
    authorizer: MetaAccountAuthorizer,
    guardrails?: BudgetGuardrailsConfig
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
      guardrails
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
    const idempotencyCheck = this.checkIdempotency(idempotencyKey);
    if (idempotencyCheck.blocked) {
      return this.failure(idempotencyCheck.error!);
    }

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

      // Validate transition against guardrails
      const transition = validateBudgetTransition(previousBudget, requestedBudget, this.guardrails);
      if (!transition.valid) {
        return this.failure(`Budget limit exceeded: ${transition.errors.join("; ")}`);
      }

      // Build change summary
      const summary = buildBudgetChangeSummary(previousBudget, requestedBudget, currency);

      // Execute write
      setExecutionState(idempotencyKey, "EXECUTING", context.userId);
      const budgetString = requestedBudget.toFixed(2);
      const writeResult = await this.provider.updateCampaignBudget(validAccount, validCampaignId, budgetString);

      if (!writeResult.success) {
        setExecutionState(idempotencyKey, "FAILED", context.userId);
        return this.failure("Failed to update campaign budget");
      }

      // Re-fetch to verify
      const verifyResult = await this.provider.getCampaigns(validAccount);
      const verifiedCampaign = verifyResult.data.find((c) => c.campaignId === validCampaignId);
      if (!verifiedCampaign) {
        setExecutionState(idempotencyKey, "FAILED", context.userId);
        return this.failure("Campaign not found after budget update");
      }

      const actualBudget = parseBudgetValue(verifiedCampaign.dailyBudget);
      if (actualBudget === null) {
        setExecutionState(idempotencyKey, "FAILED", context.userId);
        return this.failure("Cannot read budget from updated campaign");
      }

      const verification = verifyBudgetResult(requestedBudget, actualBudget);
      if (!verification.verified) {
        setExecutionState(idempotencyKey, "FAILED", context.userId);
        return this.failure(verification.error!);
      }

      setExecutionState(idempotencyKey, "SUCCEEDED", context.userId);

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
    guardrails?: BudgetGuardrailsConfig
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
      guardrails
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
    const idempotencyCheck = this.checkIdempotency(idempotencyKey);
    if (idempotencyCheck.blocked) {
      return this.failure(idempotencyCheck.error!);
    }

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

      // Validate transition against guardrails
      const transition = validateBudgetTransition(previousBudget, requestedBudget, this.guardrails);
      if (!transition.valid) {
        return this.failure(`Budget limit exceeded: ${transition.errors.join("; ")}`);
      }

      // Build change summary
      const summary = buildBudgetChangeSummary(previousBudget, requestedBudget, currency);

      // Execute write
      setExecutionState(idempotencyKey, "EXECUTING", context.userId);
      const budgetString = requestedBudget.toFixed(2);
      const writeResult = await this.provider.updateAdSetBudget(validAccount, validAdSetId, budgetString);

      if (!writeResult.success) {
        setExecutionState(idempotencyKey, "FAILED", context.userId);
        return this.failure("Failed to update ad set budget");
      }

      // Re-fetch to verify
      const verifyResult = await this.provider.getAdSets(validAccount);
      const verifiedAdSet = verifyResult.data.find((a) => a.adSetId === validAdSetId);
      if (!verifiedAdSet) {
        setExecutionState(idempotencyKey, "FAILED", context.userId);
        return this.failure("Ad set not found after budget update");
      }

      const actualBudget = parseBudgetValue(verifiedAdSet.dailyBudget);
      if (actualBudget === null) {
        setExecutionState(idempotencyKey, "FAILED", context.userId);
        return this.failure("Cannot read budget from updated ad set");
      }

      const verification = verifyBudgetResult(requestedBudget, actualBudget);
      if (!verification.verified) {
        setExecutionState(idempotencyKey, "FAILED", context.userId);
        return this.failure(verification.error!);
      }

      setExecutionState(idempotencyKey, "SUCCEEDED", context.userId);

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

  constructor(
    id: string,
    name: string,
    description: string,
    parameters: { name: string; type: string; description: string; required: boolean }[],
    provider: CampaignProvider,
    authorizer: MetaAccountAuthorizer,
    guardrails?: BudgetGuardrailsConfig,
    version = "1.0.0"
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
  }

  protected async checkAccess(userId: string, accountId: string): Promise<ToolResult | null> {
    const validAccount = validateAccountId(accountId);
    if (!validAccount) return this.failure("Invalid account ID format");
    const authorized = await this.authorizer.isAuthorized(userId, validAccount);
    if (!authorized) return this.failure("Not authorized to access this Meta account");
    return null;
  }

  protected checkIdempotency(idempotencyKey: string): {
    blocked: boolean;
    state?: MetaExecutionState;
    error?: string;
  } {
    const existing = getExecutionState(idempotencyKey);
    if (!existing) return { blocked: false };
    // Campaign creation blocks SUCCEEDED to prevent duplicate campaigns.
    // Other tools allow re-execution after success (idempotent re-check).
    const blockedStates = new Set([...BLOCKED_STATES, "SUCCEEDED"]);
    if (blockedStates.has(existing.state)) {
      return {
        blocked: true,
        state: existing.state,
        error: `Execution already ${existing.state.toLowerCase()}`,
      };
    }
    return { blocked: false };
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
    guardrails?: BudgetGuardrailsConfig
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
      guardrails
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
    const idempotencyCheck = this.checkIdempotency(idempotencyKey);
    if (idempotencyCheck.blocked) {
      return this.failure(idempotencyCheck.error!);
    }

    try {
      setExecutionState(idempotencyKey, "EXECUTING", context.userId);

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

      const writeResult = await this.provider.createCampaign(validAccount, input);

      if (!writeResult.success) {
        setExecutionState(idempotencyKey, "FAILED", context.userId);
        return this.failure("Failed to create campaign");
      }

      if (!writeResult.campaign?.campaignId) {
        setExecutionState(idempotencyKey, "FAILED", context.userId);
        return this.failure("Verification failed: campaign was not created (no campaign ID returned)");
      }

      const createdCampaign = writeResult.campaign;

      if (proposal.status && createdCampaign.status !== proposal.status) {
        setExecutionState(idempotencyKey, "FAILED", context.userId);
        return this.failure(
          `Verification failed: campaign status is "${createdCampaign.status}" but expected "${proposal.status}"`
        );
      }

      setExecutionState(idempotencyKey, "SUCCEEDED", context.userId);

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
      setExecutionState(idempotencyKey, "FAILED", context.userId);
      const message = err instanceof Error ? err.message : "Failed to create campaign";
      return this.failure(`Meta API error: ${message}`);
    }
  }
}
