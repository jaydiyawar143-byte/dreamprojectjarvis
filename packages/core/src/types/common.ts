import { z } from "zod";
import { ToolPermissionSchema, type ToolPermission, type RiskLevel } from "./tool.js";

export const RoleSchema = {
  OWNER: "owner",
  ADMIN: "admin",
  MEMBER: "member",
  VIEWER: "viewer",
} as const;

export type Role = (typeof RoleSchema)[keyof typeof RoleSchema];

export const RoleZodSchema = z.enum(["owner", "admin", "member", "viewer"]);

export const PermissionSchema = z.object({
  resource: z.string(),
  action: ToolPermissionSchema,
});

export type Permission = z.infer<typeof PermissionSchema>;

export const ApprovalStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "expired",
]);

export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApprovalSchema = z.object({
  id: z.string(),
  userId: z.string(),
  agentId: z.string().optional(),
  toolId: z.string(),
  action: z.string(),
  params: z.record(z.unknown()),
  status: ApprovalStatusSchema,
  expiresAt: z.string().datetime(),
  resolvedAt: z.string().datetime().nullable().optional(),
  createdAt: z.string().datetime(),
});

export type Approval = z.infer<typeof ApprovalSchema>;

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  timestamp: string;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface AuditEntry {
  id: string;
  timestamp: Date;
  userId: string;
  agentId?: string;
  toolId?: string;
  action: string;
  parameters?: Record<string, unknown>;
  result: "success" | "failure" | "rejected" | "pending";
  traceId?: string;
  ipAddress?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditQueryFilters {
  userId?: string;
  agentId?: string;
  toolId?: string;
  startDate?: Date;
  endDate?: Date;
}

export interface IApprovalRepository {
  create(data: Omit<Approval, "id" | "status" | "createdAt">): Promise<Approval>;
  findById(id: string): Promise<Approval | null>;
  updateStatus(id: string, status: ApprovalStatus, resolvedAt?: string): Promise<Approval | null>;
  findPending(): Promise<Approval[]>;
  findExistingForTool(toolId: string, userId: string): Promise<Approval | null>;
}

export interface IAuditRepository {
  create(entry: Omit<AuditEntry, "id" | "timestamp">): Promise<AuditEntry>;
  query(filters: AuditQueryFilters): Promise<AuditEntry[]>;
}

export interface IPermissionChecker {
  hasPermission(role: Role, resource: string, action: ToolPermission): boolean;
}

export interface IApprovalManager {
  requestApproval(
    request: Omit<Approval, "id" | "status" | "createdAt">
  ): Promise<Approval>;
  findExistingForTool(
    toolId: string,
    userId: string
  ): Promise<Approval | null>;
}

// ---------------------------------------------------------------------------
// ApprovalRequest — For Tool Intelligence approval gates
// ---------------------------------------------------------------------------

export interface ApprovalRequest {
  id: string;
  userId: string;
  tool: string;
  action: string;
  risk: RiskLevel;
  params: Record<string, unknown>;
  estimatedImpact?: string;
  cost?: { amount: number; currency: string };
  traceId: string;
  conversationId?: string;
  expiresAt: Date;
  status: "pending" | "approved" | "rejected" | "expired";
  decidedAt?: Date;
  decidedBy?: string;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// ApprovalDecision — User's response to approval request
// ---------------------------------------------------------------------------

export interface ApprovalDecision {
  approvalId: string;
  status: "approved" | "rejected";
  reason?: string;
}

// ---------------------------------------------------------------------------
// ToolApprovalCheck — Result of pre-execution approval gate
// ---------------------------------------------------------------------------

export interface ToolApprovalCheck {
  allowed: boolean;
  requiresApproval: boolean;
  approvalId?: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// ToolExecutionAudit — Recorded for every tool step execution attempt
// ---------------------------------------------------------------------------

export interface ToolExecutionAudit {
  executionId: string;
  stepIndex: number;
  userId: string;
  tool: string;
  action: string;
  risk: RiskLevel;
  arguments: Record<string, unknown>;
  status:
    | "success"
    | "failed"
    | "timeout"
    | "denied"
    | "approval_pending"
    | "approval_rejected";
  durationMs: number;
  approvalId?: string;
  traceId: string;
  conversationId?: string;
  error?: { code: string; message: string };
  timestamp: Date;
}

// ---------------------------------------------------------------------------
// ToolAuditEntry — Extended audit for tool executions
// ---------------------------------------------------------------------------

export interface ToolAuditEntry {
  id: string;
  executionId: string;
  stepIndex: number;
  userId: string;
  tool: string;
  action: string;
  risk: RiskLevel;
  arguments: Record<string, unknown>;
  resultSummary: string;
  status:
    | "success"
    | "failed"
    | "timeout"
    | "denied"
    | "approval_pending"
    | "approval_rejected";
  durationMs: number;
  approvalId?: string;
  traceId: string;
  conversationId?: string;
  ipAddress?: string;
  error?: { code: string; message: string };
  timestamp: Date;
}
