const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api/v1";

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: ApiError;
  traceId?: string;
  timestamp: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface SafeUser {
  id: string;
  email: string;
  name: string;
  role: string;
  createdAt: string;
  updatedAt: string;
}

export interface Conversation {
  id: string;
  title: string | null;
  userId: string;
  agentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface ConversationWithMessages extends Conversation {
  messages: ConversationMessage[];
}

// ---------------------------------------------------------------------------
// UI V2 — session transport.
//
// The refresh token is NEVER visible to this file. It lives in an HttpOnly
// cookie set by the API, so script on this page — ours or an attacker's —
// cannot read it. What is held here is the short-lived (15 min) access token,
// in a module variable ONLY: not localStorage, not sessionStorage, not a
// readable cookie. Nothing that survives a reload on its own.
//
// Persistence therefore comes from the cookie, not from web storage. On a cold
// load the app has no access token and asks /auth/refresh for one; the browser
// attaches the cookie, and a valid session is restored without the user ever
// re-entering a password. That is what makes login survive a closed tab, and
// it is also why "log in again on every visit" was happening before: tokens
// were in sessionStorage, which is cleared the moment the tab closes.
// ---------------------------------------------------------------------------

let _accessToken: string | null = null;

/** Non-secret UI preference. Safe in localStorage; it is not a credential. */
const REMEMBER_KEY = "jarvis_remember";

/** Keys written by the pre-V2 build. Removed on sight, never read. */
const LEGACY_TOKEN_KEYS = ["jarvis_access", "jarvis_refresh"];

export function setAccessToken(token: string | null): void {
  _accessToken = token;
}

export function getAccessToken(): string | null {
  return _accessToken;
}

export function setRemember(remember: boolean): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(REMEMBER_KEY, remember ? "1" : "0");
  } catch {
    // Blocked site data. The session still works; it just will not outlive
    // the browser, which is the safe direction to fail in.
  }
}

export function getRemember(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(REMEMBER_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Deletes anything a previous version of this app left in web storage.
 *
 * An upgrading browser can still be holding a real refresh token in
 * sessionStorage from the old build. Clearing it is part of the fix, not
 * housekeeping — leaving it behind would preserve exactly the exposure the
 * cookie was introduced to remove.
 */
export function purgeLegacyTokenStorage(): void {
  if (typeof window === "undefined") return;
  for (const key of LEGACY_TOKEN_KEYS) {
    try {
      sessionStorage.removeItem(key);
      localStorage.removeItem(key);
    } catch {
      // Unreadable storage cannot be holding anything we could have written.
    }
  }
}

if (typeof window !== "undefined") {
  purgeLegacyTokenStorage();
}

/** Drops the in-memory session. Does NOT revoke server-side; logout() does. */
export function clearTokens(): void {
  _accessToken = null;
  if (typeof window !== "undefined") {
    try {
      localStorage.removeItem(REMEMBER_KEY);
    } catch {
      // Nothing readable to clear.
    }
  }
  purgeLegacyTokenStorage();
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // Tells the API to speak cookies to this client: the refresh token is set
    // as HttpOnly and withheld from the response body.
    "X-Auth-Mode": "cookie",
    ...((options.headers as Record<string, string>) || {}),
  };

  if (_accessToken) {
    headers["Authorization"] = `Bearer ${_accessToken}`;
  }

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
      // Required for the refresh cookie to be sent at all: fetch omits
      // credentials on cross-origin requests by default, and the web app and
      // the API are different origins (different ports).
      credentials: "include",
    });

    const body = await res.json();

    // A 401 here means the ACCESS token expired, which is routine every 15
    // minutes. The refresh cookie may still be perfectly valid, so this is
    // attempted without any local evidence of a refresh token — there is none
    // to have. `/auth/refresh` is excluded to avoid recursing on itself.
    if (res.status === 401 && !path.startsWith("/auth/refresh")) {
      const refreshed = await refreshTokens();
      if (refreshed) {
        headers["Authorization"] = `Bearer ${_accessToken}`;
        const retryRes = await fetch(`${API_BASE}${path}`, {
          ...options,
          headers,
          credentials: "include",
        });
        return await retryRes.json();
      }
      // The session is genuinely gone, not merely stale.
      clearTokens();
    }

    return body;
  } catch {
    return {
      success: false,
      error: { code: "NETWORK_ERROR", message: "Network request failed" },
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * Trades the refresh cookie for a fresh access token.
 *
 * Sends no token: the browser attaches the HttpOnly cookie, which this code
 * cannot read. `rememberMe` is restated because the server cannot see whether
 * the browser is holding a session or a persistent cookie, and defaulting to
 * "session" must not silently extend a deliberately-temporary login.
 *
 * In-flight requests are shared. A cold page load fires several protected
 * fetches at once, all of which 401 together; without this they would each
 * rotate the refresh token, and the rotations would invalidate one another.
 */
let _refreshInFlight: Promise<boolean> | null = null;

async function refreshTokens(): Promise<boolean> {
  if (_refreshInFlight) return _refreshInFlight;

  _refreshInFlight = (async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Auth-Mode": "cookie" },
        credentials: "include",
        body: JSON.stringify({ rememberMe: getRemember() }),
      });
      const body: ApiResponse<Omit<TokenPair, "refreshToken">> = await res.json();
      if (body.success && body.data?.accessToken) {
        setAccessToken(body.data.accessToken);
        return true;
      }
    } catch {
      // Network failure is indistinguishable here from an expired session;
      // both mean "no usable access token", and the caller handles that.
    }
    return false;
  })();

  try {
    return await _refreshInFlight;
  } finally {
    _refreshInFlight = null;
  }
}

/**
 * Restores a session on app start, if the browser still holds a valid cookie.
 *
 * This is the whole persistence mechanism: no stored credential is read, the
 * cookie is simply presented and either honoured or not.
 */
export async function bootstrapSession(): Promise<boolean> {
  return refreshTokens();
}

// The response no longer carries `refreshToken` for this client — the API
// withholds it and sets the cookie instead — so the token shape is narrowed
// rather than lying about what arrives.
export type BrowserTokenPair = Omit<TokenPair, "refreshToken">;

export async function register(
  email: string,
  name: string,
  password: string,
  rememberMe = true
): Promise<ApiResponse<{ user: SafeUser; tokens: BrowserTokenPair }>> {
  return request("/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, name, password, rememberMe }),
  });
}

export async function login(
  email: string,
  password: string,
  rememberMe = true
): Promise<ApiResponse<{ user: SafeUser; tokens: BrowserTokenPair }>> {
  return request("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password, rememberMe }),
  });
}

export async function getMe(): Promise<ApiResponse<SafeUser>> {
  return request("/auth/me");
}

export async function sendChatMessage(
  message: string,
  conversationId?: string,
  agentId?: string,
  activeSurfaceKeys?: string[]
): Promise<
  ApiResponse<{
    message: string;
    conversationId: string;
    agentId?: string;
    metadata?: Record<string, unknown>;
    pendingAction?: Record<string, unknown>;
  }>
> {
  return request("/chat", {
    method: "POST",
    body: JSON.stringify({
      message,
      conversationId,
      agentId,
      // Which contextual surfaces are on screen RIGHT NOW.
      //
      // Only the browser knows: a surface may have closed itself on an idle
      // timer since the last turn. The server uses it to decide whether to
      // update the panel already open or open a new one — without it, "Bitcoin
      // ka bhi" stacks a second market card beside the first.
      ...(activeSurfaceKeys && activeSurfaceKeys.length > 0
        ? { metadata: { activeSurfaceKeys } }
        : {}),
    }),
  });
}

export async function listConversations(): Promise<
  ApiResponse<Conversation[]>
> {
  return request("/conversations");
}

export async function getConversation(
  id: string
): Promise<ApiResponse<ConversationWithMessages>> {
  return request(`/conversations/${id}`);
}

/**
 * Ends the session on the SERVER, then locally.
 *
 * The previous implementation only dropped the in-memory copy, which left the
 * refresh token valid in the database for its full 7 days — "logging out" did
 * not actually end the session. This revokes it and clears the cookie.
 *
 * Local state is cleared even when the call fails: a user who asked to be
 * logged out must never be left looking logged in.
 */
export async function logout(): Promise<void> {
  try {
    await fetch(`${API_BASE}/auth/logout`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Auth-Mode": "cookie" },
      credentials: "include",
      body: "{}",
    });
  } catch {
    // Offline logout is still a logout on this device.
  } finally {
    clearTokens();
  }
}

// ---------------------------------------------------------------------------
// PHASE 10.7 — Approvals
// ---------------------------------------------------------------------------

export interface ApprovalSummaryInfo {
  actionSummary: string;
  accountRedacted?: string;
  budget?: string;
  targetResource?: string;
  detailLines: Array<{ label: string; value: string }>;
}

export type ApprovalStatusValue =
  | "pending"
  | "approved"
  | "consumed"
  | "rejected"
  | "expired";

export interface ApprovalRecord extends ApprovalSummaryInfo {
  approvalId: string;
  toolId: string;
  /**
   * The tool's declared risk, read from the same registry that gates execution.
   * Optional: an unknown tool reports nothing rather than a guessed default.
   */
  risk?: "READ_ONLY" | "LOW_IMPACT" | "EXTERNAL_SIDE_EFFECT" | "HIGH_IMPACT" | "FINANCIAL";
  paramsHash?: string;
  status: ApprovalStatusValue;
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
  params: Record<string, unknown>;
  executionId?: string;
  executionStatus?: string;
}

export interface Paginated<T> {
  success: boolean;
  data?: T[];
  pagination?: { page: number; limit: number; total: number; totalPages: number };
  error?: ApiError;
  timestamp: string;
}

export async function listApprovals(
  status?: ApprovalStatusValue,
  page = 1,
  limit = 20
): Promise<Paginated<ApprovalRecord>> {
  const qs = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (status) qs.set("status", status);
  return request(`/approvals?${qs.toString()}`);
}

export async function getApproval(
  id: string
): Promise<ApiResponse<ApprovalRecord>> {
  return request(`/approvals/${id}`);
}

export async function approveApproval(
  id: string
): Promise<ApiResponse<{ approvalId: string; status: string }>> {
  return request(`/approvals/${id}/approve`, { method: "POST" });
}

export async function rejectApproval(
  id: string
): Promise<ApiResponse<{ approvalId: string; status: string }>> {
  return request(`/approvals/${id}/reject`, { method: "POST" });
}

// ---------------------------------------------------------------------------
// PHASE 11.9C — Pending Action API
// ---------------------------------------------------------------------------

export async function getPendingAction(
  conversationId: string
): Promise<ApiResponse<Record<string, unknown> | null>> {
  const qs = new URLSearchParams({ conversationId });
  return request(`/pending-actions?${qs.toString()}`);
}

export async function confirmPendingAction(
  id: string,
  conversationId: string
): Promise<ApiResponse<{ pendingAction: Record<string, unknown>; executionResult?: Record<string, unknown> }>> {
  return request(`/pending-actions/${id}/confirm`, {
    method: "POST",
    body: JSON.stringify({ conversationId }),
  });
}

export async function rejectPendingActionApi(
  id: string,
  conversationId: string
): Promise<ApiResponse<{ message: string }>> {
  return request(`/pending-actions/${id}/reject`, {
    method: "POST",
    body: JSON.stringify({ conversationId }),
  });
}

export async function modifyPendingAction(
  id: string,
  conversationId: string,
  params: Record<string, unknown>
): Promise<ApiResponse<{ pendingAction: Record<string, unknown>; message: string }>> {
  return request(`/pending-actions/${id}/modify`, {
    method: "POST",
    body: JSON.stringify({ conversationId, params }),
  });
}

// ---------------------------------------------------------------------------
// PHASE 11.9B — Opportunity Queue
// ---------------------------------------------------------------------------

export type OpportunityPriority = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "IGNORE";
export type OpportunityDisplayStatus =
  | "NEW"
  | "REVIEWED"
  | "APPROVAL_PENDING"
  | "APPROVED"
  | "REJECTED"
  | "EXPIRED"
  | "EXECUTED"
  | "FAILED";

export interface OpportunityRationale {
  positiveFactors: string[];
  negativeFactors: string[];
  riskNote: string;
  historicalNote: string | null;
  limitations: string[];
}

/** One item in the ranked opportunity queue — list view. */
export interface OpportunityQueueItem {
  recommendationId: string;
  accountId: string;
  entityId: string;
  entityType: string;
  actionType: string;
  objective?: string | null;
  score: number;
  priority: OpportunityPriority;
  severity: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  expectedImpact: string;
  risk: "LOW" | "MEDIUM" | "HIGH";
  urgency: string;
  reversibility: string;
  historicalEvidenceStrength: string;
  explanation: string;
  rationale: OpportunityRationale;
  diagnosisId: string;
  anomalyCount: number;
  historicalSampleSize: number;
  displayStatus: OpportunityDisplayStatus;
  status: string;
  approvalId?: string;
  conflicted: boolean;
  conflictWith: string[];
  createdAt: string;
  expiresAt: string;
  scoringVersion: number;
  calculatedAt: string;
}

/** Full detail for the human review panel. */
export interface OpportunityQueueItemDetail extends Omit<OpportunityQueueItem, "rationale"> {
  diagnosisCategory?: string | null;
  reason: string;
  currentMetrics: Record<string, unknown>;
  metricDetails: Array<{
    metric: string;
    currentValue: number | null;
    baselineValue: number | null;
    changePercent: number | null;
    direction: string;
  }>;
  anomalies: Array<{
    metric: string;
    severity: string;
    direction: string;
    percentDeviation: number | null;
    detectedAt: string;
  }>;
  currency?: string;
  currentState: Record<string, unknown>;
  proposedState: Record<string, unknown>;
  historicalConsistency?: string;
  contradictoryEvidenceCount: number;
  sampleQuality?: string;
  historicalLimitations: string[];
  positiveFactors: string[];
  negativeFactors: string[];
  riskNote: string;
  historicalNote: string | null;
  limitations: string[];
  preconditions: string[];
  requiresApproval: true;
  approvalRequirements: {
    requiresHumanApproval: true;
    boundToUser: boolean;
    boundToTool: string;
    paramsHashProtected: boolean;
    expiresAt: string;
    staleStateProtected: boolean;
  };
}

export interface NoOpportunityExplanation {
  reason: string;
  message: string;
}

export interface OpportunityQueueResponse {
  success: boolean;
  items?: OpportunityQueueItem[];
  nextCursor?: string | null;
  totalEligible?: number;
  ineligibleCount?: number;
  noOpportunity?: NoOpportunityExplanation;
  error?: ApiError;
  timestamp: string;
}

export interface OpportunityDetailResponse {
  success: boolean;
  opportunity?: OpportunityQueueItemDetail;
  staleWarning?: {
    isStale: boolean;
    reasons: string[];
    message: string;
  } | null;
  approvalHandoff?: {
    approvalId: string | null;
    approvalRoute: string;
    message: string;
  };
  error?: ApiError;
  timestamp: string;
}

export async function listOpportunities(options?: {
  priority?: OpportunityPriority;
  status?: OpportunityDisplayStatus;
  entityType?: string;
  actionType?: string;
  limit?: number;
  cursor?: string;
}): Promise<OpportunityQueueResponse> {
  const qs = new URLSearchParams();
  if (options?.priority) qs.set("priority", options.priority);
  if (options?.status) qs.set("status", options.status);
  if (options?.entityType) qs.set("entityType", options.entityType);
  if (options?.actionType) qs.set("actionType", options.actionType);
  if (options?.limit) qs.set("limit", String(options.limit));
  if (options?.cursor) qs.set("cursor", options.cursor);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return request(`/opportunities${suffix}`);
}

export async function getOpportunity(
  id: string
): Promise<OpportunityDetailResponse> {
  return request(`/opportunities/${id}`);
}

// ---------------------------------------------------------------------------
// Sprint 4.3 — Dashboard API
//
// Thin wrappers over /api/v1/dashboard. Every figure originates in an existing
// service; nothing here computes a metric.
// ---------------------------------------------------------------------------

export interface DashboardSummary {
  pendingApprovals: number;
  conversations: number;
  knowledgeDocuments: number;
  knowledgeProcessed: number;
  openOpportunities: number;
  metaConfigured: boolean;
}

export interface DashboardStatus {
  service: string;
  uptimeSeconds: number;
  capabilities: {
    knowledgeBase: boolean;
    retrieval: boolean;
    memory: boolean;
    embeddings: boolean;
    metaAds: boolean;
  };
}

/**
 * A metric is `null` when Meta reported nothing for it. Null is not zero: a
 * zero is a measurement, a null is a gap, and the charts render them
 * differently.
 */
export interface MetricTotals {
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  reach: number | null;
  conversions: number | null;
  revenue: number | null;
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  cpa: number | null;
  roas: number | null;
}

export interface MetricPoint extends MetricTotals {
  date: string;
}

export interface CampaignMetrics extends MetricTotals {
  campaignId: string | null;
  campaignName: string | null;
  date: string | null;
}

export interface DateRangeParams {
  startDate?: string;
  endDate?: string;
}

function rangeQuery(range?: DateRangeParams): string {
  if (!range?.startDate || !range?.endDate) return "";
  const qs = new URLSearchParams({ startDate: range.startDate, endDate: range.endDate });
  return `?${qs.toString()}`;
}

export async function getDashboardSummary(): Promise<ApiResponse<DashboardSummary>> {
  return request("/dashboard/summary");
}

export async function getDashboardStatus(): Promise<ApiResponse<DashboardStatus>> {
  return request("/dashboard/status");
}

export async function getMetaOverview(
  range?: DateRangeParams
): Promise<ApiResponse<{ accountId: string; dateRange: { start: string; end: string }; totals: MetricTotals; rowCount: number }>> {
  return request(`/dashboard/meta/overview${rangeQuery(range)}`);
}

export async function getMetaTimeseries(
  range?: DateRangeParams
): Promise<ApiResponse<{ accountId: string; dateRange: { start: string; end: string }; series: MetricPoint[]; pointCount: number }>> {
  return request(`/dashboard/meta/timeseries${rangeQuery(range)}`);
}

export async function getMetaCampaigns(
  range?: DateRangeParams,
  limit?: number
): Promise<ApiResponse<{ accountId: string; dateRange: { start: string; end: string }; campaigns: CampaignMetrics[]; campaignCount: number }>> {
  const qs = new URLSearchParams();
  if (range?.startDate && range?.endDate) {
    qs.set("startDate", range.startDate);
    qs.set("endDate", range.endDate);
  }
  if (limit) qs.set("limit", String(limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return request(`/dashboard/meta/campaigns${suffix}`);
}

// ---------------------------------------------------------------------------
// Sprint 4.5 — Knowledge Base
//
// Thin wrappers over the Sprint 3.6 endpoints. Extraction, chunking, embedding
// and retrieval all happen server-side; nothing here reimplements any of it.
// ---------------------------------------------------------------------------

/** Mirrors SUPPORTED_DOCUMENT_EXTENSIONS so the picker and the pre-flight agree. */
export const KNOWLEDGE_EXTENSIONS = [".pdf", ".docx", ".txt", ".md"] as const;

/** The API's decoded-byte ceiling (MAX_UPLOAD_BYTES). Checked before encoding. */
export const KNOWLEDGE_MAX_BYTES = 6 * 1024 * 1024;

export interface KnowledgeDocument {
  id: string;
  title: string;
  documentType: string;
  mimeType?: string | null;
  source?: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  fileName?: string | null;
  charCount?: number;
  wordCount?: number;
  byteSize?: number;
  pageCount?: number;
  /** Present only on the single-document read. */
  content?: string;
}

export interface KnowledgeSection {
  title?: string;
  level?: number;
  order?: number;
}

export interface KnowledgeChunk {
  id: string;
  chunkIndex: number;
  content: string;
  pageNumbers: number[];
  sections?: KnowledgeSection[];
  primarySection?: KnowledgeSection | null;
  charCount?: number;
  wordCount?: number;
}

export interface KnowledgeSearchHit {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  documentType: string;
  source?: string | null;
  chunkIndex: number;
  content: string;
  score: number;
  pageNumbers: number[];
  primarySection?: KnowledgeSection | null;
}

export interface KnowledgeIngestResult {
  document: KnowledgeDocument;
  chunkCount: number;
  embeddedCount: number;
  skippedCount: number;
  embedded: boolean;
  searchable: boolean;
}

/** Extension check, mirroring the server's. Saves a doomed round trip. */
export function isSupportedKnowledgeFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return KNOWLEDGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Reads a File into base64 without pulling the whole thing through a string. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the file"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      // A data: URL prefix precedes the payload; the API wants only the payload.
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

export async function listKnowledgeDocuments(): Promise<
  ApiResponse<{ documents: KnowledgeDocument[]; total: number }>
> {
  return request("/knowledge/documents");
}

export async function getKnowledgeDocument(
  id: string
): Promise<ApiResponse<{ document: KnowledgeDocument }>> {
  return request(`/knowledge/documents/${id}`);
}

export async function getKnowledgeChunks(
  id: string
): Promise<ApiResponse<{ documentId: string; chunks: KnowledgeChunk[]; total: number }>> {
  return request(`/knowledge/documents/${id}/chunks`);
}

export async function deleteKnowledgeDocument(
  id: string
): Promise<ApiResponse<{ id: string; deleted: boolean }>> {
  return request(`/knowledge/documents/${id}`, { method: "DELETE" });
}

export async function uploadKnowledgeDocument(input: {
  fileName: string;
  content: string;
  mimeType?: string;
  source?: string;
  title?: string;
}): Promise<ApiResponse<KnowledgeIngestResult>> {
  return request("/knowledge/documents", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function searchKnowledge(
  query: string,
  options?: { topK?: number; similarityThreshold?: number }
): Promise<
  ApiResponse<{
    query: string;
    results: KnowledgeSearchHit[];
    resultCount: number;
    topK: number;
    similarityThreshold: number;
    emptyQuery: boolean;
  }>
> {
  return request("/knowledge/search", {
    method: "POST",
    body: JSON.stringify({ query, ...(options ?? {}) }),
  });
}

// ---------------------------------------------------------------------------
// Sprint 4.6 — Meta Ads panel
//
// Account context comes from the dashboard router; anomalies, diagnosis,
// evidence and recommendations all come from the Phase 11.5–11.9 endpoints
// that already existed. The panel is READ-ONLY: nothing here can execute a
// recommendation, and the execute endpoint is deliberately not wrapped.
// ---------------------------------------------------------------------------

export interface MetaAccountContext {
  accountId: string;
  name: string | null;
  currency: string | null;
  timezone: string | null;
  status: string | null;
}

export async function getMetaAccount(): Promise<ApiResponse<{ account: MetaAccountContext }>> {
  return request("/dashboard/meta/account");
}

export interface RecommendationSummary {
  id: string;
  accountId?: string;
  status: string;
  actionType?: string;
  entityType?: string;
  entityId?: string;
  entityName?: string | null;
  rationale?: string | null;
  createdAt?: string;
  expiresAt?: string | null;
  [key: string]: unknown;
}

export interface RecommendationListResponse {
  success: boolean;
  items?: RecommendationSummary[];
  total?: number;
  error?: ApiError;
  timestamp: string;
}

export async function listRecommendations(options?: {
  status?: string;
  limit?: number;
}): Promise<RecommendationListResponse> {
  const qs = new URLSearchParams();
  if (options?.status) qs.set("status", options.status);
  if (options?.limit) qs.set("limit", String(options.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return request(`/recommendations${suffix}`);
}

// ---------------------------------------------------------------------------
// Sprint 8 — Voice.
//
// Two stateless transformations. Neither carries conversation state: the
// transcript returned here is sent through `sendChatMessage` like any typed
// message, so voice inherits routing, memory, approvals and audit rather than
// re-implementing them.
// ---------------------------------------------------------------------------

export interface VoiceStatus {
  enabled: boolean;
  sttModel: string;
  ttsModel: string;
  voice: string;
  maxAudioBytes: number;
  maxTtsChars: number;
  canConfirmApprovals: boolean;
}

export async function getVoiceStatus(): Promise<ApiResponse<VoiceStatus>> {
  return request("/voice/status");
}

export async function transcribeAudio(input: {
  audio: string;
  mimeType: string;
  durationMs?: number;
  conversationId?: string;
}): Promise<ApiResponse<{ text: string; empty: boolean; model: string; latencyMs?: number }>> {
  return request("/voice/transcribe", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function synthesizeSpeech(input: {
  text: string;
  conversationId?: string;
}): Promise<
  ApiResponse<{
    audio: string;
    mimeType: string;
    model: string;
    voice: string;
    format: string;
    characterCount: number;
  }>
> {
  return request("/voice/speak", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// ---------------------------------------------------------------------------
// UI V2 — Agents and Activity
//
// Both are read-only windows on data the server already owned but never
// exposed. `registered` is the field that matters on an agent: four of the
// eight register only when their integration is configured, so a UI that
// showed policy alone would claim capabilities this deployment does not have.
// ---------------------------------------------------------------------------

export type AgentAvailability = "AVAILABLE" | "UNAVAILABLE";

export interface AgentSummary {
  agentId: string;
  domain: string;
  description: string;
  allowedTools: string[];
  toolCount: number;
  writesRequireApproval: boolean;
  clientSelectable: boolean;
  registered: boolean;
  availability: AgentAvailability;
}

export async function listAgents(): Promise<
  ApiResponse<{ agents: AgentSummary[]; total: number; registeredCount: number }>
> {
  return request("/agents");
}

export type ActivityResult = "success" | "failure" | "rejected" | "pending";

export interface ActivityEntry {
  id: string;
  timestamp: string;
  action: string;
  result: ActivityResult;
  agentId?: string;
  toolId?: string;
  traceId?: string;
  executionId?: string;
  durationMs?: number;
}

export interface ActivityFilters {
  limit?: number;
  agentId?: string;
  toolId?: string;
  action?: string;
  result?: ActivityResult;
  startDate?: string;
  endDate?: string;
}

export async function listActivity(
  filters: ActivityFilters = {}
): Promise<ApiResponse<{ entries: ActivityEntry[]; count: number; limit: number }>> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && String(value).length > 0) {
      params.set(key, String(value));
    }
  }
  const query = params.toString();
  return request(`/activity${query ? `?${query}` : ""}`);
}

// ---------------------------------------------------------------------------
// UI V2 — System health
//
// These three routes return BARE JSON with no {success, data} envelope, so they
// deliberately bypass `request()`. A client that unwrapped `data` would read
// undefined and report a healthy service as unknown.
// ---------------------------------------------------------------------------

export interface HealthReport {
  status: string;
  state?: string;
  service?: string;
  uptime?: number;
  checks?: Record<string, string>;
  timestamp?: string;
}

async function bareGet(path: string): Promise<{ ok: boolean; body: HealthReport | null }> {
  try {
    const res = await fetch(`${API_BASE}${path}`);
    return { ok: res.ok, body: (await res.json()) as HealthReport };
  } catch {
    return { ok: false, body: null };
  }
}

export async function getHealth(): Promise<{ ok: boolean; body: HealthReport | null }> {
  return bareGet("/health");
}

export async function getReadiness(): Promise<{ ok: boolean; body: HealthReport | null }> {
  return bareGet("/health/ready");
}

export interface CapabilityStatus {
  service: string;
  uptimeSeconds: number;
  capabilities: {
    knowledgeBase: boolean;
    retrieval: boolean;
    memory: boolean;
    embeddings: boolean;
    metaAds: boolean;
  };
}

export async function getCapabilityStatus(): Promise<ApiResponse<CapabilityStatus>> {
  return request("/dashboard/status");
}

// ---------------------------------------------------------------------------
// UI V2 — Integrations
//
// Google has a status route. WhatsApp and n8n do NOT: their whole router is
// unmounted when the integration is unconfigured, so every call 404s. That is
// why each helper below reports a `configured` flag derived from the response
// rather than throwing — "not deployed" is a state the UI must render calmly,
// not an error.
// ---------------------------------------------------------------------------

export interface GoogleStatus {
  configured: boolean;
  connected: boolean;
  account: { email: string; scopes: string[]; connectedAt?: string; expiresAt?: string } | null;
}

export async function getGoogleStatus(): Promise<ApiResponse<GoogleStatus>> {
  return request("/google/status");
}

export async function connectGoogle(): Promise<ApiResponse<{ authUrl: string }>> {
  return request("/google/connect", { method: "POST" });
}

export async function disconnectGoogle(): Promise<
  ApiResponse<{ disconnected: boolean; revokedAtGoogle?: boolean; reason?: string }>
> {
  return request("/google/disconnect", { method: "POST" });
}

export interface WhatsAppMessage {
  id: string;
  providerMessageId: string;
  waId: string;
  direction: string;
  type: string;
  body: string | null;
  status: string;
  timestamp: string;
}

export async function listWhatsAppMessages(
  limit = 50
): Promise<ApiResponse<{ messages: WhatsAppMessage[]; count: number }>> {
  return request(`/whatsapp/messages?limit=${encodeURIComponent(String(limit))}`);
}

export interface N8nWorkflow {
  id: string;
  name: string;
  isActive: boolean;
  createdAt: string;
}

export interface N8nExecution {
  id: string;
  workflowId: string;
  status: string;
  remoteExecutionId: string | null;
  resultSummary: string | null;
  errorCode: string | null;
  traceId: string | null;
  triggeredAt: string;
  completedAt: string | null;
}

export async function listN8nWorkflows(): Promise<
  ApiResponse<{ workflows: N8nWorkflow[]; count: number }>
> {
  return request("/n8n/workflows");
}

export async function listN8nExecutions(
  limit = 50
): Promise<ApiResponse<{ executions: N8nExecution[]; count: number }>> {
  return request(`/n8n/executions?limit=${encodeURIComponent(String(limit))}`);
}

/**
 * True when a failed response means "this integration is not deployed" rather
 * than "something went wrong".
 *
 * The unconfigured routers are not mounted at all, so the request falls through
 * to the terminal 404 handler.
 */
export function isNotDeployed(error?: ApiError): boolean {
  return error?.code === "NOT_FOUND";
}

// ---------------------------------------------------------------------------
// UI V2 — Google sign-in.
//
// Availability is a SERVER fact, not a build-time flag: the routes are mounted
// only when the OAuth client credentials exist, so a 404 here is the honest
// answer that the channel is unprovisioned. Asking avoids the failure mode
// where a web env var says "enabled" and the exchange then dies at the token
// endpoint — the button is shown only when it can actually complete.
// ---------------------------------------------------------------------------

export async function getGoogleSignInEnabled(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/auth/google/status`, {
      credentials: "include",
    });
    if (!res.ok) return false;
    const body: ApiResponse<{ enabled: boolean }> = await res.json();
    return body.success === true && body.data?.enabled === true;
  } catch {
    return false;
  }
}

/**
 * The URL that begins the flow.
 *
 * A full-page navigation, never fetch/XHR: the browser has to follow redirects
 * to accounts.google.com and back, and a cross-origin fetch cannot do that.
 */
export function googleSignInStartUrl(next = "/dashboard"): string {
  return `${API_BASE}/auth/google/start?next=${encodeURIComponent(next)}`;
}

// ---------------------------------------------------------------------------
// UI V2 — Agent Credential Center.
//
// The server never returns a stored secret, so there is no type here that can
// hold one. `values` carries a mask for secret fields and the real value only
// for non-secret ones (an ad account id), which is what lets the UI show WHICH
// account is configured without ever re-rendering a token.
// ---------------------------------------------------------------------------

export type CredentialStatus =
  | "CONNECTED"
  | "CONFIGURED"
  | "NOT_CONNECTED"
  | "CONFIGURATION_REQUIRED"
  | "INVALID";

export interface CredentialField {
  name: string;
  label: string;
  kind: "secret" | "text";
  required: boolean;
  placeholder?: string;
  help?: string;
}

export interface CredentialProvider {
  id: string;
  label: string;
  /** How it is configured, which decides what the UI may offer. */
  kind: "form" | "oauth" | "server-managed";
  description: string;
  testable: boolean;
  fields: CredentialField[];
  status: CredentialStatus;
  detail: string;
  /** What the RUNNING system is using, which may differ from what is stored. */
  effectiveSource: string;
  values?: Record<string, string>;
  connectUrl?: string;
}

export interface CredentialTestResult {
  status: CredentialStatus;
  detail: string;
  checkedAt: string;
}

export async function listCredentials(): Promise<
  ApiResponse<{ providers: CredentialProvider[] }>
> {
  return request("/credentials");
}

export async function saveCredentials(
  provider: string,
  values: Record<string, string>
): Promise<ApiResponse<CredentialProvider>> {
  return request(`/credentials/${provider}`, {
    method: "PUT",
    body: JSON.stringify(values),
  });
}

export async function testCredentials(
  provider: string
): Promise<ApiResponse<CredentialTestResult>> {
  return request(`/credentials/${provider}/test`, { method: "POST" });
}

export async function removeCredentials(
  provider: string
): Promise<ApiResponse<CredentialProvider>> {
  return request(`/credentials/${provider}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// V3 — Command Center.
//
// Every live value arrives wrapped in { value, meta }. The meta is not optional
// decoration: it is how the UI knows whether it may present a number as current.
// There is deliberately no helper that unwraps `value` on its own, because that
// helper is exactly how a stale price ends up rendered as live.
// ---------------------------------------------------------------------------

export type Freshness = "LIVE" | "DELAYED" | "STALE" | "UNAVAILABLE";

export interface ProviderMeta {
  freshness: Freshness;
  observedAt: string;
  ageSeconds: number;
  source: string;
  reason?: string;
  cached?: boolean;
}

/** A value that may not exist on this machine, with the reason it does not. */
export interface Maybe<T> {
  value: T | null;
  reason?: string;
}

export interface Live<T> {
  value: T | null;
  meta: ProviderMeta;
}

export interface WeatherNow {
  temperatureC: number;
  feelsLikeC: number | null;
  humidityPct: number | null;
  windKph: number | null;
  precipitationMm: number | null;
  code: number;
  isDay: boolean;
  sunrise: string | null;
  sunset: string | null;
  location: { latitude: number; longitude: number; timezone: string; label?: string };
  forecast: Array<{ date: string; minC: number; maxC: number; code: number }>;
}

export interface CryptoQuote {
  id: string;
  symbol: string;
  name: string;
  price: number;
  changePct24h: number | null;
  marketCapRank: number;
}

export interface IndexQuote {
  symbol: string;
  name: string;
  value: number;
  change: number | null;
  changePct: number | null;
  marketState?: "OPEN" | "CLOSED" | "PRE_OPEN" | "UNKNOWN";
}

export interface Place {
  name: string;
  latitude: number;
  longitude: number;
  type?: string;
  /**
   * Google's stable id for the place, when Google resolved it. Pass it back
   * for routing rather than the display name — "Gondia" is a city, a district
   * and a station, and the id is the only way to say which one.
   *
   * Absent on OpenStreetMap results.
   */
  placeId?: string;
  attribution: string;
}

export interface RouteResult {
  from: Place;
  to: Place;
  distanceKm: number;
  durationMinutes: number;
  geometry?: Array<[number, number]>;
  attribution: string;
}

export interface SystemSnapshot {
  at: string;
  cpu: { loadPct: Maybe<number>; cores: number; model: string; temperatureC: Maybe<number> };
  memory: { usedPct: number; usedBytes: number; totalBytes: number; availableBytes: number };
  gpu: {
    model: Maybe<string>;
    utilizationPct: Maybe<number>;
    memoryUsedMB: Maybe<number>;
    temperatureC: Maybe<number>;
  };
  disk: Maybe<{ usedPct: number; usedBytes: number; totalBytes: number; mount: string }>;
  network: Maybe<{ rxBytesPerSec: number; txBytesPerSec: number; iface: string }>;
  uptimeSeconds: number;
  containerized: boolean;
}

export interface TaskRecord {
  id: string;
  title: string;
  description: string | null;
  dueAt: string | null;
  priority: "LOW" | "NORMAL" | "HIGH" | string;
  completedAt: string | null;
  createdAt: string;
}

export interface CommandCenterPreferences {
  clockMode?: "DIGITAL" | "ANALOG";
  hourFormat?: "12" | "24";
  weatherLocation?: { latitude: number; longitude: number; label?: string } | null;
  /**
   * Widget position, size and visibility. Repaired on read, never trusted raw.
   *
   * V4 stores grid coordinates. The V3 `{ size: { w, h } }` shape is still in
   * the database for anyone who saved one and is accepted here so it can be
   * migrated on read — see `normalizeLayout`.
   */
  layout?: Array<{
    id: string;
    x?: number;
    y?: number;
    w?: number;
    h?: number;
    /** V3 only. */
    size?: { w: number; h: number };
    hidden?: boolean;
  }>;
  /** Kept for preferences written by the first V3 build. */
  widgets?: string[];
  hiddenWidgets?: string[];
}

export interface CommandCenterCapabilities {
  weather: boolean;
  crypto: boolean;
  indices: boolean;
  /** Geocoding and routing — always true (Google or OpenStreetMap). */
  geo: boolean;
  /** An INTERACTIVE map — needs a Google browser key, and has no fallback. */
  maps?: boolean;
  system: boolean;
  tasks: boolean;
}

const CC = "/command-center";

export async function getCapabilities(): Promise<ApiResponse<CommandCenterCapabilities>> {
  return request(`${CC}/capabilities`);
}

export async function getWeather(
  coords?: { latitude: number; longitude: number }
): Promise<ApiResponse<Live<WeatherNow>>> {
  const qs = coords ? `?lat=${coords.latitude}&lon=${coords.longitude}` : "";
  return request(`${CC}/weather${qs}`);
}

export async function getCrypto(count = 3): Promise<ApiResponse<Live<CryptoQuote[]>>> {
  return request(`${CC}/markets/crypto?count=${count}`);
}

export async function getIndices(): Promise<ApiResponse<Live<IndexQuote[]>>> {
  return request(`${CC}/markets/indices`);
}

export async function searchPlaces(
  query: string,
  near?: { latitude: number; longitude: number }
): Promise<ApiResponse<Live<Place[]>>> {
  const qs = new URLSearchParams({ q: query });
  if (near) {
    qs.set("lat", String(near.latitude));
    qs.set("lon", String(near.longitude));
  }
  return request(`${CC}/geo/search?${qs.toString()}`);
}

export async function getRoute(
  from: string,
  to: string,
  geometry = false,
  mode?: TravelMode,
  // Place IDs win over the strings when both are supplied, so a route runs
  // between exactly the places the user picked from the suggestion list.
  ids?: { fromPlaceId?: string; toPlaceId?: string }
): Promise<ApiResponse<Live<RouteResult>>> {
  const qs = new URLSearchParams({
    from,
    to,
    ...(geometry ? { geometry: "true" } : {}),
    ...(mode ? { mode } : {}),
    ...(ids?.fromPlaceId ? { fromPlaceId: ids.fromPlaceId } : {}),
    ...(ids?.toPlaceId ? { toPlaceId: ids.toPlaceId } : {}),
  });
  return request(`${CC}/geo/route?${qs.toString()}`);
}

export async function getSystemSnapshot(): Promise<ApiResponse<Live<SystemSnapshot>>> {
  return request(`${CC}/system`);
}

export async function listTasks(
  includeCompleted = false
): Promise<ApiResponse<{ tasks: TaskRecord[] }>> {
  return request(`${CC}/tasks?includeCompleted=${includeCompleted}`);
}

export async function createTask(input: {
  title: string;
  description?: string;
  dueAt?: string | null;
  priority?: "LOW" | "NORMAL" | "HIGH";
}): Promise<ApiResponse<{ task: TaskRecord }>> {
  return request(`${CC}/tasks`, { method: "POST", body: JSON.stringify(input) });
}

export async function updateTask(
  id: string,
  input: { completed?: boolean; title?: string; dueAt?: string | null; priority?: string }
): Promise<ApiResponse<{ task: TaskRecord }>> {
  return request(`${CC}/tasks/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

export async function deleteTask(id: string): Promise<ApiResponse<{ deleted: boolean }>> {
  return request(`${CC}/tasks/${id}`, { method: "DELETE" });
}

export async function getPreferences(): Promise<
  ApiResponse<{ preferences: CommandCenterPreferences }>
> {
  return request(`${CC}/preferences`);
}

export async function savePreferences(
  prefs: CommandCenterPreferences
): Promise<ApiResponse<{ preferences: CommandCenterPreferences }>> {
  return request(`${CC}/preferences`, { method: "PUT", body: JSON.stringify(prefs) });
}

// ---------------------------------------------------------------------------
// V3 — image understanding.
//
// Images take a different route from documents because they cannot be chunked
// directly: the server describes the image with a vision model and ingests THAT
// text through the ordinary knowledge pipeline. From the client's point of view
// the outcome is the same — a searchable, citable knowledge document.
// ---------------------------------------------------------------------------

export const SUPPORTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export interface ImageIngestResult {
  document: { id: string; title: string | null; fileName: string };
  description: string;
  chunkCount: number;
  searchable: boolean;
}

export async function uploadKnowledgeImage(input: {
  fileName: string;
  content: string;
  mimeType: string;
  question?: string;
}): Promise<ApiResponse<ImageIngestResult>> {
  return request("/knowledge/images", { method: "POST", body: JSON.stringify(input) });
}

// ---------------------------------------------------------------------------
// V3 — Google Maps.
//
// The browser key arrives from an authenticated endpoint rather than a build-
// time constant, so it is not in a static bundle. `serverGeoAvailable` tells
// the UI whether search and routing will be answered by Google or by
// OpenStreetMap, so results can be labelled truthfully either way.
// ---------------------------------------------------------------------------

export interface MapsConfig {
  browserKey: string | null;
  mapsAvailable: boolean;
  serverGeoAvailable: boolean;
  reason: string;
}

export type TravelMode = "driving" | "walking" | "cycling" | "transit";

export async function getMapsConfig(): Promise<ApiResponse<MapsConfig>> {
  return request("/command-center/maps/config");
}

/** Coordinates → an address, for the current-location label. */
export async function reverseGeocode(
  latitude: number,
  longitude: number
): Promise<ApiResponse<Live<Place>>> {
  return request(`/command-center/geo/reverse?lat=${latitude}&lon=${longitude}`);
}

/**
 * One type-ahead row.
 *
 * Exactly one of `placeId` and `place` is set. Google returns a Place ID that
 * must be resolved on selection; OpenStreetMap has no autocomplete product, so
 * its rows come from an ordinary search and already carry coordinates.
 */
export interface PlaceSuggestion {
  placeId?: string;
  description: string;
  primary: string;
  secondary?: string;
  type?: string;
  place?: Place;
}

/**
 * Type-ahead suggestions.
 *
 * DEBOUNCE THIS. Autocomplete is billed per request, and an undebounced input
 * fires one call per keystroke. The map widget debounces at 300ms and drops
 * responses that arrive out of order; any other caller must do the same.
 */
export async function autocompletePlaces(
  input: string,
  near?: { latitude: number; longitude: number },
  signal?: AbortSignal
): Promise<ApiResponse<Live<PlaceSuggestion[]>>> {
  const qs = new URLSearchParams({ q: input });
  if (near) {
    qs.set("lat", String(near.latitude));
    qs.set("lon", String(near.longitude));
  }
  return request(`${CC}/geo/autocomplete?${qs.toString()}`, signal ? { signal } : {});
}

/** A picked suggestion's Place ID → a place with coordinates. */
export async function resolvePlace(placeId: string): Promise<ApiResponse<Live<Place>>> {
  return request(`${CC}/geo/place/${encodeURIComponent(placeId)}`);
}

/**
 * Publishes the browser's position so the SERVER-side maps tools can use it.
 *
 * This is what makes "meri current location se Gondia ka route dikhao" work in
 * chat: the tools run on the server and cannot see the browser.
 *
 * The server holds it in memory for fifteen minutes, keyed on the authenticated
 * user, and never persists or logs it. Call `clearPublishedLocation` to revoke
 * it early.
 */
export async function publishLocation(coords: {
  latitude: number;
  longitude: number;
  accuracy?: number;
}): Promise<ApiResponse<{ accepted: boolean }>> {
  return request(`${CC}/geo/location`, {
    method: "POST",
    body: JSON.stringify(coords),
  });
}

/** Forgets the published position immediately. */
export async function clearPublishedLocation(): Promise<ApiResponse<{ cleared: boolean }>> {
  return request(`${CC}/geo/location`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Google Maps monthly usage.
//
// Counts only. This endpoint returns no key and no coordinates — there is
// nothing here that would be sensitive in a proxy log. `byUser` is present only
// for OWNER and ADMIN, and is omitted from the payload entirely otherwise
// rather than hidden in the client.
// ---------------------------------------------------------------------------

export interface MapsUsage {
  available: true;
  period: string;
  used: number;
  limit: number;
  percentUsed: number;
  level: "OK" | "WARNING" | "STRONG_WARNING" | "CRITICAL" | "BLOCKED";
  blocked: boolean;
  message: string;
  byService: Array<{ service: string; count: number }>;
  yourUsage: number;
  lastRequestAt: string | null;
  byUser?: Array<{ userId: string; count: number }>;
  note: string;
}

export interface MapsUsageUnavailable {
  available: false;
  reason: string;
}

export async function getMapsUsage(): Promise<
  ApiResponse<MapsUsage | MapsUsageUnavailable>
> {
  return request(`${CC}/maps/usage`);
}

// ---------------------------------------------------------------------------
// Integration Control Center.
//
// The unified read/test surface. Actions (connect, configure, disconnect) are
// NOT duplicated here: each integration carries the existing endpoint to call,
// so there is one write path to a credential rather than two.
//
// Nothing in these shapes can hold a secret. There is no token, key or webhook
// field — the server does not send one, and the type is the second control.
// ---------------------------------------------------------------------------

export type IntegrationHealth =
  | "CONNECTED"
  | "DEGRADED"
  | "UNVERIFIED"
  | "ERROR"
  | "NOT_CONNECTED"
  | "CONFIG_REQUIRED"
  | "DISABLED";

export type IntegrationCategory =
  | "google"
  | "maps"
  | "communication"
  | "automation"
  | "advertising";

export interface IntegrationCapability {
  id: string;
  label: string;
  available: boolean;
  /** Marked so a connected card cannot read as "this dashboard can execute". */
  requiresApproval?: boolean;
}

export interface IntegrationUsage {
  used: number;
  limit: number;
  percentUsed: number;
  level: string;
  blocked: boolean;
}

export interface Integration {
  id: string;
  name: string;
  subtitle: string;
  category: IntegrationCategory;
  health: IntegrationHealth;
  detail: string;
  capabilities: IntegrationCapability[];
  /** Non-secret identifiers only — an account email, an account id, a base URL. */
  account: { label: string; detail?: string } | null;
  usage: IntegrationUsage | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  effectiveSource: string;
  actions: {
    testable: boolean;
    connectUrl?: string;
    configureUrl?: string;
    disconnectUrl?: string;
  };
}

export interface IntegrationCheckResult {
  health: IntegrationHealth;
  detail: string;
  checkedAt: string;
}

export async function listIntegrations(): Promise<
  ApiResponse<{ integrations: Integration[] }>
> {
  return request("/integrations");
}

/** Runs a REAL connection test. Every provider's test is a read. */
export async function testIntegration(
  id: string
): Promise<ApiResponse<IntegrationCheckResult>> {
  return request(`/integrations/${id}/test`, { method: "POST" });
}

/**
 * Forgets the cached verdict for one integration.
 *
 * Called after connect / configure / disconnect so a card cannot keep showing
 * a result that predates the change.
 */
export async function refreshIntegration(
  id: string
): Promise<ApiResponse<Integration>> {
  return request(`/integrations/${id}/refresh`, { method: "POST" });
}
