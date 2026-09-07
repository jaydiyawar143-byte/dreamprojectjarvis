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

let _accessToken: string | null = null;
let _refreshToken: string | null = null;

export function setTokens(access: string, refresh: string): void {
  _accessToken = access;
  _refreshToken = refresh;
  if (typeof window !== "undefined") {
    sessionStorage.setItem("jarvis_access", access);
    sessionStorage.setItem("jarvis_refresh", refresh);
  }
}

export function loadTokens(): void {
  if (typeof window === "undefined") return;
  try {
    _accessToken = sessionStorage.getItem("jarvis_access");
    _refreshToken = sessionStorage.getItem("jarvis_refresh");
  } catch {
    // Session storage can throw outright when a browser is configured to block
    // site data. An unreadable store is the same situation as an empty one.
    _accessToken = null;
    _refreshToken = null;
  }
}

// Restore the session as soon as this module is evaluated, not on an effect.
//
// React runs child effects BEFORE the parent's, so a protected page's data
// fetch is issued before AuthProvider's mount effect has had a chance to call
// loadTokens(). Hydrating here — synchronously, during module evaluation, ahead
// of any render — is what guarantees the first authenticated request of a hard
// page load already carries its bearer token.
//
// Guarded for the server, where this module is also evaluated during
// prerendering and there is no session storage to read.
if (typeof window !== "undefined") {
  loadTokens();
}

export function clearTokens(): void {
  _accessToken = null;
  _refreshToken = null;
  if (typeof window !== "undefined") {
    sessionStorage.removeItem("jarvis_access");
    sessionStorage.removeItem("jarvis_refresh");
  }
}

export function getAccessToken(): string | null {
  return _accessToken;
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) || {}),
  };

  if (_accessToken) {
    headers["Authorization"] = `Bearer ${_accessToken}`;
  }

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
    });

    const body = await res.json();

    if (res.status === 401 && _refreshToken) {
      const refreshed = await refreshTokens();
      if (refreshed) {
        headers["Authorization"] = `Bearer ${_accessToken}`;
        const retryRes = await fetch(`${API_BASE}${path}`, {
          ...options,
          headers,
        });
        return await retryRes.json();
      }
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

async function refreshTokens(): Promise<boolean> {
  if (!_refreshToken) return false;
  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: _refreshToken }),
    });
    const body: ApiResponse<TokenPair> = await res.json();
    if (body.success && body.data) {
      setTokens(body.data.accessToken, body.data.refreshToken);
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

export async function register(
  email: string,
  name: string,
  password: string
): Promise<ApiResponse<{ user: SafeUser; tokens: TokenPair }>> {
  return request("/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, name, password }),
  });
}

export async function login(
  email: string,
  password: string
): Promise<ApiResponse<{ user: SafeUser; tokens: TokenPair }>> {
  return request("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export async function getMe(): Promise<ApiResponse<SafeUser>> {
  return request("/auth/me");
}

export async function sendChatMessage(
  message: string,
  conversationId?: string,
  agentId?: string
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
    body: JSON.stringify({ message, conversationId, agentId }),
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

export async function logout(): Promise<void> {
  clearTokens();
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
