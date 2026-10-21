// ---------------------------------------------------------------------------
// Phase 17 multi-business hardening — the shared-connection policy.
//
// Pins the grant table (the policy the review asked for: an Organization's
// members may read, only its owners and admins may write, approve, test or see
// diagnostics), the decision order and its default-deny steps, and the rule
// that makes an approval independent: never the requester's own.
//
// Pure: every input is a plain object, and nothing reaches a provider.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import type { AuthContext, Role, TenantMembershipContext, TenantRole } from "@jarvis/core";
import { SHARED_INTEGRATION_CONNECTORS, TENANT_ROLES } from "@jarvis/core";
import {
  SHARED_CONNECTION_OPERATIONS,
  authorizeIndependentApproval,
  authorizeSharedConnection,
  rolesHoldingSharedPermission,
  sharedConnectionGrantsFor,
  sharedWriteScope,
  type SharedConnectionAuthzInput,
} from "../src/shared-connection-authz.js";

const ORG = "org-a";
const OTHER_ORG = "org-b";

/** The account role defaults to `owner` to make the point that it is not read. */
const asUser = (userId: string, role: Role = "owner"): AuthContext => ({
  userId,
  role,
  email: `${userId}@example.test`,
});

const memberOf = (userId: string, role: TenantRole, tenantId = ORG): TenantMembershipContext => ({
  tenantId,
  userId,
  role,
});

const input = (over: Partial<SharedConnectionAuthzInput> = {}): SharedConnectionAuthzInput => ({
  subject: { auth: asUser("user-a"), membership: memberOf("user-a", "owner") },
  operation: "read",
  scope: { tenantId: ORG },
  ...over,
});

const as = (role: TenantRole, operation: string) =>
  authorizeSharedConnection(
    input({ subject: { auth: asUser("user-a"), membership: memberOf("user-a", role) }, operation })
  );

describe("the grant table", () => {
  it("is exactly the reviewed policy", () => {
    expect(sharedConnectionGrantsFor("owner")).toEqual([
      "shared:read",
      "shared:write",
      "shared:approve",
      "shared:status",
      "shared:diagnostics",
      "shared:test",
      // Phase 18, Stage 18.1 — starting a catalog sync spends the credential's
      // quota, so it is the operator side, like `test`.
      "shared:sync",
    ]);
    expect(sharedConnectionGrantsFor("admin")).toEqual(sharedConnectionGrantsFor("owner"));
    expect(sharedConnectionGrantsFor("member")).toEqual(["shared:read", "shared:status"]);
    expect(sharedConnectionGrantsFor("viewer")).toEqual(["shared:read", "shared:status"]);
  });

  it.each(["OWNER", "Owner", "superuser", "", "__proto__", "constructor", "toString"])(
    "gives an unrecognized role %j nothing",
    (role) => {
      expect(sharedConnectionGrantsFor(role)).toEqual([]);
    }
  );

  it("names the roles the approval store must check, from the same table", () => {
    expect(rolesHoldingSharedPermission("shared:write")).toEqual(["owner", "admin"]);
    expect(rolesHoldingSharedPermission("shared:approve")).toEqual(["owner", "admin"]);
    expect(rolesHoldingSharedPermission("shared:read")).toEqual([...TENANT_ROLES]);
  });

  it("builds a write's consumption scope from the table and the connector key", () => {
    expect(sharedWriteScope(ORG, SHARED_INTEGRATION_CONNECTORS.meta)).toEqual({
      tenantId: ORG,
      providerId: "meta",
      connector: "ads",
      requesterRoles: ["owner", "admin"],
      approverRoles: ["owner", "admin"],
    });
  });
});

describe("what each role may do", () => {
  const expected: Record<TenantRole, readonly string[]> = {
    owner: SHARED_CONNECTION_OPERATIONS,
    admin: SHARED_CONNECTION_OPERATIONS,
    member: ["read", "status"],
    viewer: ["read", "status"],
  };

  for (const role of TENANT_ROLES) {
    for (const operation of SHARED_CONNECTION_OPERATIONS) {
      const may = expected[role].includes(operation);
      it(`${role} ${may ? "may" : "may not"} ${operation}`, () => {
        const decision = as(role, operation);
        expect(decision.allowed).toBe(may);
        if (decision.allowed) {
          expect(decision).toMatchObject({ operation, permission: `shared:${operation}`, tenantId: ORG, role });
        } else {
          expect(decision.code).toBe("PERMISSION_DENIED");
        }
      });
    }
  }
});

describe("the decision order defaults to deny", () => {
  it("refuses without a verified identity, before anything else", () => {
    for (const auth of [null, undefined, { userId: "" }]) {
      const decision = authorizeSharedConnection(input({ subject: { auth, membership: memberOf("user-a", "owner") } }));
      expect(decision).toMatchObject({ allowed: false, code: "IDENTITY_REQUIRED" });
    }
  });

  it.each(["Write", "WRITE", "execute", "", "__proto__", "constructor", "toString", 7, null])(
    "refuses the undeclared operation %j",
    (operation) => {
      const decision = authorizeSharedConnection(input({ operation: operation as string }));
      expect(decision).toMatchObject({ allowed: false, code: "OPERATION_UNKNOWN" });
    }
  );

  it("refuses everyone, an owner included, when the connection has no owner", () => {
    for (const scope of [null, undefined, { tenantId: "" }]) {
      const decision = authorizeSharedConnection(input({ scope }));
      expect(decision).toMatchObject({ allowed: false, code: "RESOURCE_OWNERSHIP_MISSING" });
    }
  });

  it("refuses a non-member — whatever the account-wide role says", () => {
    const decision = authorizeSharedConnection(
      input({ subject: { auth: asUser("user-a", "owner"), membership: null } })
    );
    expect(decision).toMatchObject({ allowed: false, code: "TENANT_MEMBERSHIP_REQUIRED" });
  });

  it("refuses a membership read for another account", () => {
    const decision = authorizeSharedConnection(
      input({ subject: { auth: asUser("user-a"), membership: memberOf("user-b", "owner") } })
    );
    expect(decision).toMatchObject({ allowed: false, code: "TENANT_MEMBERSHIP_REQUIRED" });
  });

  it("refuses an owner of ANOTHER Organization", () => {
    const decision = authorizeSharedConnection(
      input({ subject: { auth: asUser("user-a"), membership: memberOf("user-a", "owner", OTHER_ORG) } })
    );
    expect(decision).toMatchObject({ allowed: false, code: "SCOPE_TENANT_MISMATCH" });
  });

  it("refuses an unrecognized membership role", () => {
    const decision = authorizeSharedConnection(
      input({
        subject: {
          auth: asUser("user-a"),
          membership: { tenantId: ORG, userId: "user-a", role: "OWNER" as TenantRole },
        },
      })
    );
    expect(decision).toMatchObject({ allowed: false, code: "ROLE_UNRECOGNIZED" });
  });

  it("never reflects an input in its message", () => {
    const decision = authorizeSharedConnection(input({ operation: "<script>org-a" }));
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.message).not.toContain("script");
      expect(decision.message).not.toContain(ORG);
    }
  });
});

describe("an approval is someone else's", () => {
  const approve = (approverId: string, role: TenantRole, requesterUserId: string, tenantId = ORG) =>
    authorizeIndependentApproval({
      requesterUserId,
      approver: { auth: asUser(approverId), membership: memberOf(approverId, role, tenantId) },
      scope: { tenantId: ORG },
    });

  it("lets another owner or admin of the Organization approve", () => {
    expect(approve("owner-2", "owner", "requester").allowed).toBe(true);
    expect(approve("admin-1", "admin", "requester").allowed).toBe(true);
  });

  it("never lets the requester approve their own write — not even an owner", () => {
    for (const role of ["owner", "admin"] as const) {
      expect(approve("requester", role, "requester")).toMatchObject({
        allowed: false,
        code: "SELF_APPROVAL_FORBIDDEN",
      });
    }
  });

  it("refuses a member or a viewer as the approver", () => {
    expect(approve("member-1", "member", "requester")).toMatchObject({ allowed: false, code: "PERMISSION_DENIED" });
    expect(approve("viewer-1", "viewer", "requester")).toMatchObject({ allowed: false, code: "PERMISSION_DENIED" });
  });

  it("refuses an owner of another Organization", () => {
    expect(approve("outsider", "owner", "requester", OTHER_ORG)).toMatchObject({
      allowed: false,
      code: "SCOPE_TENANT_MISMATCH",
    });
  });

  it("refuses an approval with no recorded requester", () => {
    expect(approve("owner-2", "owner", "")).toMatchObject({ allowed: false, code: "PERMISSION_DENIED" });
  });

  it("refuses everyone when the connection has no owner", () => {
    const decision = authorizeIndependentApproval({
      requesterUserId: "requester",
      approver: { auth: asUser("owner-2"), membership: memberOf("owner-2", "owner") },
      scope: null,
    });
    expect(decision).toMatchObject({ allowed: false, code: "RESOURCE_OWNERSHIP_MISSING" });
  });
});
