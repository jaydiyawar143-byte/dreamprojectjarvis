// ---------------------------------------------------------------------------
// Phase 19, Stage 19.1 — the browser is authorized by the ONE Phase 17 policy.
//
// No new decision function is introduced. These tests pin that a browser
// operation uses `authorizeSharedConnection` exactly as every other shared
// connection does: membership in the owning Organization, the membership role,
// fail-closed ownership, cross-Organization refusal and an approval by someone
// other than the requester.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { SHARED_INTEGRATION_CONNECTORS, type TenantRole } from "@jarvis/core";
import {
  authorizeIndependentApproval,
  authorizeSharedConnection,
  rolesHoldingSharedPermission,
  sharedWriteScope,
} from "../src/shared-connection-authz.js";

const BROWSER = SHARED_INTEGRATION_CONNECTORS.browser;

function subject(userId: string, tenantId: string, role: TenantRole) {
  return {
    auth: { userId },
    membership: { userId, tenantId, role },
  };
}

describe("Phase 19.1 — browser authorization reuses the shared-connection policy", () => {
  it.each(["owner", "admin", "member", "viewer"] as const)(
    "lets a %s read through the browser connection",
    (role) => {
      expect(
        authorizeSharedConnection({
          subject: subject("user-1", "tenant-1", role),
          operation: "read",
          scope: { tenantId: "tenant-1" },
        })
      ).toMatchObject({ allowed: true, operation: "read", tenantId: "tenant-1", role });
    }
  );

  it.each(["member", "viewer"] as const)(
    "refuses a %s the page-changing write",
    (role) => {
      expect(
        authorizeSharedConnection({
          subject: subject("user-1", "tenant-1", role),
          operation: "write",
          scope: { tenantId: "tenant-1" },
        })
      ).toMatchObject({ allowed: false, code: "PERMISSION_DENIED" });
    }
  );

  it.each(["owner", "admin"] as const)("lets a %s write through the browser connection", (role) => {
    expect(
      authorizeSharedConnection({
        subject: subject("user-1", "tenant-1", role),
        operation: "write",
        scope: { tenantId: "tenant-1" },
      })
    ).toMatchObject({ allowed: true, operation: "write", tenantId: "tenant-1", role });
  });

  it("fails closed when the browser connection has no owner", () => {
    expect(
      authorizeSharedConnection({
        subject: subject("user-1", "tenant-1", "owner"),
        operation: "read",
        scope: null,
      })
    ).toMatchObject({ allowed: false, code: "RESOURCE_OWNERSHIP_MISSING" });
    expect(
      authorizeSharedConnection({
        subject: subject("user-1", "tenant-1", "owner"),
        operation: "write",
        scope: { tenantId: "" },
      })
    ).toMatchObject({ allowed: false, code: "RESOURCE_OWNERSHIP_MISSING" });
  });

  it("refuses a member of a different Organization", () => {
    expect(
      authorizeSharedConnection({
        subject: subject("user-1", "tenant-other", "owner"),
        operation: "read",
        scope: { tenantId: "tenant-1" },
      })
    ).toMatchObject({ allowed: false, code: "SCOPE_TENANT_MISMATCH" });
  });

  it("refuses a membership for somebody else or an unrecognized role", () => {
    expect(
      authorizeSharedConnection({
        subject: {
          auth: { userId: "user-1" },
          membership: { userId: "user-2", tenantId: "tenant-1", role: "owner" },
        },
        operation: "read",
        scope: { tenantId: "tenant-1" },
      })
    ).toMatchObject({ allowed: false, code: "TENANT_MEMBERSHIP_REQUIRED" });

    expect(
      authorizeSharedConnection({
        subject: {
          auth: { userId: "user-1" },
          membership: { userId: "user-1", tenantId: "tenant-1", role: "superuser" as TenantRole },
        },
        operation: "read",
        scope: { tenantId: "tenant-1" },
      })
    ).toMatchObject({ allowed: false, code: "ROLE_UNRECOGNIZED" });
  });

  it("never consults the account-wide role", () => {
    // A platform owner who is only a member of this Organization holds only a
    // member's grant on this Organization's connection.
    expect(
      authorizeSharedConnection({
        subject: {
          ...subject("user-1", "tenant-1", "member"),
          auth: { userId: "user-1", role: "owner" },
        },
        operation: "write",
        scope: { tenantId: "tenant-1" },
      })
    ).toMatchObject({ allowed: false, code: "PERMISSION_DENIED" });
  });

  it("binds a browser write approval to an independent owner or admin", () => {
    const scope = sharedWriteScope("tenant-1", BROWSER);
    expect(scope).toEqual({
      tenantId: "tenant-1",
      providerId: "browser",
      connector: "service",
      requesterRoles: ["owner", "admin"],
      approverRoles: ["owner", "admin"],
    });

    expect(
      authorizeIndependentApproval({
        requesterUserId: "requester-1",
        approver: subject("approver-1", "tenant-1", "owner"),
        scope: { tenantId: "tenant-1" },
      })
    ).toMatchObject({ allowed: true, operation: "approve" });

    expect(
      authorizeIndependentApproval({
        requesterUserId: "requester-1",
        approver: subject("requester-1", "tenant-1", "owner"),
        scope: { tenantId: "tenant-1" },
      })
    ).toMatchObject({ allowed: false, code: "SELF_APPROVAL_FORBIDDEN" });

    expect(
      authorizeIndependentApproval({
        requesterUserId: "requester-1",
        approver: subject("member-1", "tenant-1", "member"),
        scope: { tenantId: "tenant-1" },
      })
    ).toMatchObject({ allowed: false, code: "PERMISSION_DENIED" });

    expect(
      authorizeIndependentApproval({
        requesterUserId: "requester-1",
        approver: subject("approver-1", "tenant-1", "owner"),
        scope: null,
      })
    ).toMatchObject({ allowed: false, code: "RESOURCE_OWNERSHIP_MISSING" });
  });

  it("derives the approver roles from the one grant table", () => {
    expect(rolesHoldingSharedPermission("shared:approve")).toEqual(["owner", "admin"]);
    expect(rolesHoldingSharedPermission("shared:write")).toEqual(["owner", "admin"]);
    expect(rolesHoldingSharedPermission("shared:read")).toEqual([
      "owner",
      "admin",
      "member",
      "viewer",
    ]);
  });
});
