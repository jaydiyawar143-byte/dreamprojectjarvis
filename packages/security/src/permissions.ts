import type { Role, Permission, ToolPermission } from "@jarvis/core";

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
    { resource: "tools", action: "read" },
    { resource: "tools", action: "execute" },
  ],
  member: [
    { resource: "conversations", action: "read" },
    { resource: "conversations", action: "write" },
    { resource: "agents", action: "execute" },
    { resource: "knowledge", action: "read" },
    { resource: "knowledge", action: "write" },
    { resource: "tools", action: "read" },
  ],
  viewer: [
    { resource: "conversations", action: "read" },
    { resource: "agents", action: "read" },
    { resource: "knowledge", action: "read" },
    { resource: "tools", action: "read" },
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

  checkToolPermissions(
    role: Role,
    requiredPermissions: ToolPermission[]
  ): boolean {
    return requiredPermissions.every((perm) =>
      this.hasPermission(role, "tools", perm)
    );
  }
}
