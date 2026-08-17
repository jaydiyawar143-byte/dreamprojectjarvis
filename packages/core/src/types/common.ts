export const RoleSchema = {
  OWNER: "owner",
  ADMIN: "admin",
  MEMBER: "member",
  VIEWER: "viewer",
} as const;

export type Role = (typeof RoleSchema)[keyof typeof RoleSchema];

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
  parameters: Record<string, unknown>;
  result: "success" | "failure" | "rejected" | "pending";
  ipAddress: string;
  metadata: Record<string, unknown>;
}
