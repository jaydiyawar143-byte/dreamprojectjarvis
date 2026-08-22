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
  if (typeof window !== "undefined") {
    _accessToken = sessionStorage.getItem("jarvis_access");
    _refreshToken = sessionStorage.getItem("jarvis_refresh");
  }
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
