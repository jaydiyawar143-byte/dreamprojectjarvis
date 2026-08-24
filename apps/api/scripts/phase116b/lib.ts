// ---------------------------------------------------------------------------
// PHASE 11.6B â€” REAL approved optimization lifecycle smoke test (shared lib)
//
// Wires the EXACT production stack used by apps/api/src/services/container.ts:
//   RecommendationExecutionService -> ToolExecutor -> ExecutionJournal ->
//   meta.ad.pause tool -> MetaGraphProvider -> Meta Graph API
//
// Differences from container.ts are LIMITED to:
//   - an HTTP call-counting wrapper around MetaHttpClient (read/write accounting)
//   - no HTTP server: stages are driven directly, gated on explicit human approval
//
// SECRETS: this module never prints tokens/keys; the accounting log stores
// method + path only (never query params or headers).
// ---------------------------------------------------------------------------

import { config } from "dotenv";
import { resolve } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";

config({ path: resolve(process.cwd(), "../../.env") });

import {
  PermissionService,
  ApprovalService,
  AuditLogger,
  PasswordHasher,
} from "@jarvis/security";
import {
  prisma,
  PrismaAuditRepository,
  PrismaToolExecutionRepository,
  PrismaApprovalRepository,
  PrismaRecommendationRepository,
} from "@jarvis/db";

export { prisma };
import {
  ToolExecutor,
  ToolRegistry,
  MetaGetAccountsTool,
  MetaGetCampaignsTool,
  MetaGetAdSetsTool,
  MetaGetAdsTool,
  MetaGetInsightsTool,
  MetaPauseAdTool,
  MetaResumeAdTool,
  MetaPauseAdSetTool,
  MetaResumeAdSetTool,
  MetaPauseCampaignTool,
  MetaResumeCampaignTool,
  MetaUpdateCampaignBudgetTool,
  MetaUpdateAdSetBudgetTool,
  MetaCreateCampaignTool,
  RecommendationExecutionService,
  createExecutorBackedExternalStatePort,
} from "@jarvis/tools";
import { createMetaGraphProvider } from "@jarvis/meta-graph";
import {
  createMetaHttpClient,
  createMetaConfig,
  type MetaHttpClient,
} from "@jarvis/meta-graph";
import {
  createMockMetaProvider,
  type MockMetaProviderConfig,
  type MetaAdsBudgetProvider,
  MetaAdsProvider,
  type MetaAdsWriteProvider,
  MetaCampaignCreatorProvider,
} from "@jarvis/tools";
import type { ExternalEntityState, Role } from "@jarvis/core";

export const ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID ?? "";
export const API_VERSION = process.env.META_GRAPH_API_VERSION ?? "";
export const SMOKE_EMAIL = "phase116b-smoke@jarvis-test.local";

export interface HttpTally {
  get: number;
  post: number;
  log: Array<{ at: string; method: string; path: string }>;
}

export const tally: HttpTally = { get: 0, post: 0, log: [] };

function makeCountingClient(): MetaHttpClient {
  const inner = createMetaHttpClient(
    createMetaConfig({
      accessToken: process.env.META_ACCESS_TOKEN ?? "",
      adAccountId: ACCOUNT_ID,
      apiVersion: API_VERSION || undefined,
    })
  );
  return {
    async request(req) {
      if (req.method === "GET") tally.get += 1;
      else if (req.method === "POST") tally.post += 1;
      // Path only â€” NEVER query params (access_token travels in params).
      tally.log.push({
        at: new Date().toISOString(),
        method: req.method,
        path: req.path.split("?")[0] ?? req.path,
      });
      return inner.request(req);
    },
  };
}

// ---------------------------------------------------------------------------
// Production stack
// ---------------------------------------------------------------------------

export type StackProvider = MetaAdsProvider &
  MetaAdsWriteProvider &
  MetaAdsBudgetProvider &
  MetaCampaignCreatorProvider & {
    isAuthorized(userId: string, accountId: string): Promise<boolean>;
  };

export interface Stack {
  provider: StackProvider;
  registry: ToolRegistry;
  executor: ToolExecutor;
  approvalService: ApprovalService;
  approvalRepo: PrismaApprovalRepository;
  recRepo: PrismaRecommendationRepository;
  toolExecRepo: PrismaToolExecutionRepository;
  auditLogger: AuditLogger;
  service: RecommendationExecutionService;
}

export function buildStack(): Stack {
  if (!process.env.META_ACCESS_TOKEN || !ACCOUNT_ID) {
    throw new Error("META_ACCESS_TOKEN / META_AD_ACCOUNT_ID missing");
  }

  const provider = createMetaGraphProvider({
    accessToken: process.env.META_ACCESS_TOKEN,
    adAccountId: ACCOUNT_ID,
    apiVersion: API_VERSION || undefined,
    httpClient: makeCountingClient(),
  });

  return wireStack(provider, provider, {
    isAuthorized: (userId: string, accountId: string) => provider.isAuthorized(userId, accountId),
  });
}

/**
 * Option A stack: IDENTICAL production wiring, but the Meta HTTP layer is the
 * in-memory mock provider. Real Postgres rows, real approvals, real atomic
 * consumption, real journal â€” zero external calls.
 */
export function buildMockStack(fixtures: MockMetaProviderConfig = {}): Stack {
  const provider = createMockMetaProvider(fixtures);
  const authorizer = {
    isAuthorized: async (userId: string, accountId: string): Promise<boolean> => {
      void userId;
      return accountId === ACCOUNT_ID;
    },
  };
  return wireStack(provider as unknown as StackProvider, provider, authorizer);
}

function wireStack(
  provider: StackProvider,
  readProvider: MetaAdsProvider,
  authorizer: { isAuthorized(userId: string, accountId: string): Promise<boolean> }
): Stack {
  const executionJournal = new PrismaToolExecutionRepository(prisma);
  const approvalRepo = new PrismaApprovalRepository(prisma);
  const approvalService = new ApprovalService(approvalRepo);
  const auditLogger = new AuditLogger(new PrismaAuditRepository(prisma));

  const registry = new ToolRegistry();
  registry.register(new MetaGetAccountsTool(readProvider, authorizer));
  registry.register(new MetaGetCampaignsTool(readProvider, authorizer));
  registry.register(new MetaGetAdSetsTool(readProvider, authorizer));
  registry.register(new MetaGetAdsTool(readProvider, authorizer));
  registry.register(new MetaGetInsightsTool(readProvider, authorizer));
  registry.register(new MetaPauseCampaignTool(provider, authorizer, executionJournal, approvalRepo));
  registry.register(new MetaResumeCampaignTool(provider, authorizer, executionJournal, approvalRepo));
  registry.register(new MetaPauseAdSetTool(provider, authorizer, executionJournal, approvalRepo));
  registry.register(new MetaResumeAdSetTool(provider, authorizer, executionJournal, approvalRepo));
  registry.register(new MetaPauseAdTool(provider, authorizer, executionJournal, approvalRepo));
  registry.register(new MetaResumeAdTool(provider, authorizer, executionJournal, approvalRepo));
  registry.register(new MetaUpdateCampaignBudgetTool(provider, authorizer, undefined, executionJournal, approvalRepo));
  registry.register(new MetaUpdateAdSetBudgetTool(provider, authorizer, undefined, executionJournal, approvalRepo));
  registry.register(new MetaCreateCampaignTool(provider, authorizer, undefined, executionJournal, approvalRepo));

  const permissionService = new PermissionService();
  const executor = new ToolExecutor(registry, permissionService, approvalService, auditLogger);

  const recRepo = new PrismaRecommendationRepository(prisma);

  const service = new RecommendationExecutionService({
    executor,
    recommendations: recRepo,
    journal: {
      getById: (id) => executionJournal.getById(id),
      findRecentByTool: (userId, toolId, limit = 25) =>
        executionJournal.findRecentByTool(userId, toolId, limit),
    },
    approvals: approvalService,
    stateOf: (accountId, entityId, input) =>
      createExecutorBackedExternalStatePort({
        executor,
        userId: input.userId,
        role: input.role as Role,
      })(accountId, entityId),
    authorizer: {
      isAuthorized: (userId: string, accountId: string) => authorizer.isAuthorized(userId, accountId),
    },
    audit: auditLogger,
  });

  return {
    provider,
    registry,
    executor,
    approvalService,
    approvalRepo,
    recRepo,
    toolExecRepo: executionJournal,
    auditLogger,
    service,
  };
}

/**
 * Engine-side live-state port using the SAME executor-backed reader the
 * execution bridge uses, so proposal-time and execution-time state hashes are
 * computed over byte-identical ExternalEntityState mappings.
 */
export function makeLiveStatePort(
  executor: ToolExecutor,
  userId: string
): (accountId: string, entityId: string) => Promise<ExternalEntityState | null> {
  return createExecutorBackedExternalStatePort({
    executor,
    userId,
    role: "member" as Role,
  });
}

// ---------------------------------------------------------------------------
// Smoke user + marketing account bootstrap
// ---------------------------------------------------------------------------

export let SMOKE_USER_ID = "";

export async function ensureSmokeUser(): Promise<string> {
  const existing = await prisma.user.findUnique({ where: { email: SMOKE_EMAIL } });
  if (existing) {
    SMOKE_USER_ID = existing.id;
    return existing.id;
  }
  const hasher = new PasswordHasher();
  const password = await hasher.hash(randomUUID()); // throwaway, never printed
  const user = await prisma.user.create({
    data: {
      email: SMOKE_EMAIL,
      name: "Phase 11.6B Real Optimization Smoke",
      password,
      role: "MEMBER",
    },
  });
  SMOKE_USER_ID = user.id;
  return user.id;
}

export async function ensureMarketingAccount(userId: string): Promise<void> {
  const existing = await prisma.marketingAccount.findUnique({ where: { accountId: ACCOUNT_ID } });
  if (existing) return;
  await prisma.marketingAccount.create({
    data: { userId, accountId: ACCOUNT_ID, name: "JARVIS AD", currency: "INR", timezoneName: "America/Los_Angeles" },
  });
}

// ---------------------------------------------------------------------------
// Stage state file
// ---------------------------------------------------------------------------

export const STATE_FILE = resolve(process.cwd(), "scripts/phase116b/state.json");

export interface SmokeState {
  stage: string;
  startedAt: string;
  userId: string;
  account: { id: string; currency: string; timezone: string; status: number };
  target?: {
    kind: "AD" | "AD_SET";
    id: string;
    name: string;
    campaignId?: string;
    adSetId?: string;
    previousStatus: string;
  };
  recommendation?: {
    recommendationId: string;
    actionType: string;
    paramsHash: string;
    stateHash: string;
    expiresAt: string;
  };
  approval?: { approvalId: string; consumedByExecutionId?: string };
  execution?: { executionId: string; toolId: string; traceId: string; resultStatus: string };
  inventoryBaseline?: {
    campaigns: number;
    adSets: number;
    ads: number;
    ids: { campaigns: string[]; adSets: string[]; ads: string[] };
  };
}

export function loadState(): SmokeState {
  if (!existsSync(STATE_FILE)) throw new Error(`state file missing: ${STATE_FILE}`);
  return JSON.parse(readFileSync(STATE_FILE, "utf8")) as SmokeState;
}

export function saveState(state: SmokeState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function sha256Short(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

/** YYYY-MM-DD for the account timezone, offset by N days from UTC-now. */
export function accountDate(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  // Account TZ is fixed for this account (America/Los_Angeles).
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d);
}

export function mapToNormalized(
  accountId: string,
  currency: string,
  tz: string,
  rows: Array<Record<string, unknown>>
): NormalizedRow[] {
  const num = (v: unknown): number => {
    const n = Number(v ?? 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  return rows.map((r) => ({
    accountId,
    adId: typeof r.adId === "string" ? r.adId : undefined,
    date: String(r.dateStart ?? ""),
    spend: num(r.spend),
    impressions: Math.round(num(r.impressions)),
    clicks: Math.round(num(r.clicks)),
    reach: Math.round(num(r.reach)),
    conversions: num(r.conversions),
    revenue: 0,
    currency,
    timezone: tz,
  }));
}

export interface NormalizedRow {
  accountId: string;
  adId?: string;
  date: string;
  spend: number;
  impressions: number;
  clicks: number;
  reach: number;
  conversions: number;
  revenue: number;
  currency: string;
  timezone: string;
}

export function printHeader(title: string): void {
  console.log(`\n=== ${title} ===`);
}
