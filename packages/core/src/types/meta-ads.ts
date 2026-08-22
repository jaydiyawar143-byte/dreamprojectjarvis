import { z } from "zod";

// ---------------------------------------------------------------------------
// Meta Ads — Core Type Contracts (Phase 8)
// ---------------------------------------------------------------------------
// These types are shared between the tools layer and any future integration
// layer. They represent the read-only Meta Ads data model.
// ---------------------------------------------------------------------------

// --- Ad Account ---

export const MetaAdAccountSchema = z.object({
  accountId: z.string(),
  name: z.string(),
  currency: z.string(),
  timezoneName: z.string().optional(),
  accountStatus: z.number().optional(),
  spendCap: z.string().optional(),
  amountSpent: z.string().optional(),
  balance: z.string().optional(),
  businessName: z.string().optional(),
});

export type MetaAdAccount = z.infer<typeof MetaAdAccountSchema>;

// --- Campaign ---

export const MetaCampaignStatusSchema = z.enum([
  "ACTIVE",
  "PAUSED",
  "DELETED",
  "ARCHIVED",
  "IN_PROCESS",
  "WITH_ISSUES",
]);

export type MetaCampaignStatus = z.infer<typeof MetaCampaignStatusSchema>;

export const MetaCampaignSchema = z.object({
  campaignId: z.string(),
  name: z.string(),
  status: MetaCampaignStatusSchema,
  objective: z.string().optional(),
  dailyBudget: z.string().optional(),
  lifetimeBudget: z.string().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  bidStrategy: z.string().optional(),
  buyingType: z.string().optional(),
  /** ISO-8601 creation timestamp from the provider (Phase 10.5 reconciliation
   *  correlation window). Absent on payloads that omit created_time. */
  createdAt: z.string().optional(),
});

export type MetaCampaign = z.infer<typeof MetaCampaignSchema>;

// --- Ad Set ---

export const MetaAdSetSchema = z.object({
  adSetId: z.string(),
  campaignId: z.string(),
  name: z.string(),
  status: MetaCampaignStatusSchema,
  targeting: z.record(z.unknown()).optional(),
  dailyBudget: z.string().optional(),
  lifetimeBudget: z.string().optional(),
  bidAmount: z.number().optional(),
  optimizationGoal: z.string().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
});

export type MetaAdSet = z.infer<typeof MetaAdSetSchema>;

// --- Ad ---

export const MetaAdSchema = z.object({
  adId: z.string(),
  adSetId: z.string(),
  campaignId: z.string(),
  name: z.string(),
  status: MetaCampaignStatusSchema,
  creative: z.record(z.unknown()).optional(),
  trackingSpecs: z.array(z.record(z.unknown())).optional(),
});

export type MetaAd = z.infer<typeof MetaAdSchema>;

// --- Insights ---

export const MetaInsightsSchema = z.object({
  impressions: z.string().optional(),
  reach: z.string().optional(),
  clicks: z.string().optional(),
  spend: z.string().optional(),
  ctr: z.string().optional(),
  cpc: z.string().optional(),
  cpm: z.string().optional(),
  frequency: z.string().optional(),
  conversions: z.string().optional(),
  costPerConversion: z.string().optional(),
  results: z.string().optional(),
  costPerResult: z.string().optional(),
  roas: z.string().optional(),
  actions: z.array(z.record(z.unknown())).optional(),
  actionValues: z.array(z.record(z.unknown())).optional(),
  dateStart: z.string().optional(),
  dateStop: z.string().optional(),
  accountId: z.string().optional(),
  campaignId: z.string().optional(),
  adsetId: z.string().optional(),
  adId: z.string().optional(),
});

export type MetaInsights = z.infer<typeof MetaInsightsSchema>;

// --- Date Range ---

export const MetaDateRangeSchema = z.object({
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD format"),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD format"),
});

export type MetaDateRange = z.infer<typeof MetaDateRangeSchema>;

// --- Pagination ---

export const MetaPaginationSchema = z.object({
  limit: z.number().int().min(1).max(500).default(50),
  after: z.string().optional(),
});

export type MetaPagination = z.infer<typeof MetaPaginationSchema>;

// --- Account Connection (server-side boundary) ---

export const MetaAccountConnectionStatusSchema = z.enum([
  "active",
  "expired",
  "revoked",
  "error",
]);

export type MetaAccountConnectionStatus = z.infer<typeof MetaAccountConnectionStatusSchema>;

export const MetaAccountConnectionSchema = z.object({
  id: z.string(),
  userId: z.string(),
  accountId: z.string(),
  accountName: z.string().optional(),
  status: MetaAccountConnectionStatusSchema,
  connectedAt: z.string().datetime(),
  lastSyncedAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
});

export type MetaAccountConnection = z.infer<typeof MetaAccountConnectionSchema>;

// --- Insight Level ---

export const MetaInsightLevelSchema = z.enum(["account", "campaign", "adset", "ad"]);
export type MetaInsightLevel = z.infer<typeof MetaInsightLevelSchema>;

// --- Allowed Metrics ---

export const META_ALLOWED_METRICS = [
  "impressions",
  "reach",
  "clicks",
  "spend",
  "ctr",
  "cpc",
  "cpm",
  "frequency",
  "conversions",
  "cost_per_conversion",
  "results",
  "cost_per_result",
  "roas",
] as const;

export type MetaAllowedMetric = (typeof META_ALLOWED_METRICS)[number];

// --- Allowed Breakdowns ---

export const META_ALLOWED_BREAKDOWNS = [
  "age",
  "gender",
  "country",
  "placement",
  "device_platform",
  "publisher_platform",
] as const;

export type MetaAllowedBreakdown = (typeof META_ALLOWED_BREAKDOWNS)[number];

// --- Budget Guardrails (Phase 9.2) ---

export const BudgetGuardrailsConfigSchema = z.object({
  maxDailyBudget: z.number().positive(),
  maxIncreasePercent: z.number().min(0).max(100),
  maxIncreaseAbsolute: z.number().positive(),
  maxDecreasePercent: z.number().min(0).max(100),
  maxDecreaseAbsolute: z.number().positive(),
});

export type BudgetGuardrailsConfig = z.infer<typeof BudgetGuardrailsConfigSchema>;

// --- Budget Validation Result ---

export const BudgetValidationResultSchema = z.object({
  valid: z.boolean(),
  errors: z.array(z.string()),
  absoluteChange: z.number(),
  percentChange: z.number(),
});

export type BudgetValidationResult = z.infer<typeof BudgetValidationResultSchema>;

// --- Campaign Proposal (Phase 9.3) ---

export const MetaObjectiveSchema = z.enum([
  "OUTCOME_AWARENESS",
  "OUTCOME_ENGAGEMENT",
  "OUTCOME_LEADS",
  "OUTCOME_SALES",
  "OUTCOME_TRAFFIC",
]);
export type MetaObjective = z.infer<typeof MetaObjectiveSchema>;

export const AdSetProposalSchema = z.object({
  name: z.string().min(1).max(400),
  optimizationGoal: z.string().min(1),
  billingEvent: z.string().optional(),
  bidAmount: z.number().positive().optional(),
  dailyBudget: z.number().positive().optional(),
  lifetimeBudget: z.number().positive().optional(),
  targeting: z.record(z.unknown()).optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  pacingType: z.string().optional(),
});
export type AdSetProposal = z.infer<typeof AdSetProposalSchema>;

export const CreativeBriefSchema = z.object({
  name: z.string().optional(),
  body: z.string().optional(),
  headline: z.string().optional(),
  description: z.string().optional(),
  callToAction: z.string().optional(),
  imageUrl: z.string().url().optional(),
  linkUrl: z.string().url().optional(),
});
export type CreativeBrief = z.infer<typeof CreativeBriefSchema>;

export const CampaignProposalSchema = z.object({
  name: z.string().min(1).max(400),
  objective: MetaObjectiveSchema,
  buyingType: z.enum(["AUCTION", "RESERVED"]).default("AUCTION"),
  dailyBudget: z.number().positive().optional(),
  lifetimeBudget: z.number().positive().optional(),
  currency: z.string().length(3).optional(),
  status: z.enum(["ACTIVE", "PAUSED"]).default("PAUSED"),
  specialAdCategories: z.array(z.string()).default([]),
  adSets: z.array(AdSetProposalSchema).min(1).max(50),
  creative: CreativeBriefSchema.optional(),
  rationale: z.string().optional(),
  sourceData: z.string().optional(),
  assumptions: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).optional(),
  warnings: z.array(z.string()).default([]),
  aiProvider: z.string().optional(),
  aiModel: z.string().optional(),
});
export type CampaignProposal = z.infer<typeof CampaignProposalSchema>;

// --- Campaign Creation Input ---

export const MetaCampaignInputSchema = z.object({
  name: z.string().min(1).max(400),
  objective: z.string(),
  status: z.enum(["ACTIVE", "PAUSED"]).default("PAUSED"),
  dailyBudget: z.string().optional(),
  lifetimeBudget: z.string().optional(),
  specialAdCategories: z.array(z.string()).default([]),
  buyingType: z.enum(["AUCTION", "RESERVED"]).default("AUCTION"),
});
export type MetaCampaignInput = z.infer<typeof MetaCampaignInputSchema>;
