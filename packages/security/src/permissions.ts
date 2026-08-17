import type { Role } from "@jarvis/core";

interface Permission {
  resource: string;
  action: "read" | "write" | "execute" | "admin";
}

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  owner: [
    { resource: "*", action: "admin" },
  ],
  admin: [
    { resource: "agents", action: "read" },
    { resource: "agents", action: "write" },
    { resource: "agents", action: "execute" },
    { resource: "conversations", action: "read" },
    { resource: "conversations", action: "write" },
    { resource: "approvals", action: "read" },
    { resource: "approvals", action: "write" },
    { resource: "audit", action: "read" },
    { resource: "settings", action: "read" },
  ],
  member: [
    { resource: "conversations", action: "read" },
    { resource: "conversations", action: "write" },
    { resource: "agents", action: "execute" },
    { resource: "knowledge", action: "read" },
    { resource: "knowledge", action: "write" },
  ],
  viewer: [
    { resource: "conversations", action: "read" },
    { resource: "agents", action: "read" },
    { resource: "knowledge", action: "read" },
  ],
};

export class PermissionService {
  hasPermission(
    role: Role,
    resource: string,
    action: Permission["action"]
  ): boolean {
    const permissions = ROLE_PERMISSIONS[role] || [];
    return permissions.some(
      (p) =>
        (p.resource === "*" || p.resource === resource) &&
        (p.action === "admin" || p.action === action)
    );
  }

  getPermissions(role: Role): Permission[] {
    return ROLE_PERMISSIONS[role] || [];
  }
}
