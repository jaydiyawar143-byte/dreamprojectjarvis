// ---------------------------------------------------------------------------
// Phase 17 — focused tests for the Permission and Risk Engine.
//
// Stage 1 pinned the five the task named — allow, deny, unknown operation,
// cross-tenant, and connector-specific permissions — plus the properties that
// make the engine's default-deny real: prototype-key operations, unknown roles,
// absent identity, agent scope, and the rule that a connector FALLBACK is
// granted exactly the same check as the surface it fell from (a fallback may
// never carry an operation across an authorization boundary, and may never
// shed the approval requirement on the way).
//
// Stage 3A moved the role to the TENANT MEMBERSHIP and made the resource's
// owning tenant mandatory. Every Stage 1 property is still pinned here, against
// the new contract. Two assertions changed with the approved policy
// (docs/tenant-model-design.md §4.4): a `member` now holds `mcp:read`, so the
// property "rest:read is not mcp:read" is pinned with `viewer`, the role that
// still holds REST read and nothing on MCP.
//
// Nothing here reaches a provider: the engine is pure, and these tests construct
// only plain objects.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { AUTOMATION_OPERATIONS, connectorStatus } from "@jarvis/core";
import type {
  AuthContext,
  AutomationConnectorStatus,
  Role,
  TenantMembershipContext,
  TenantRole,
} from "@jarvis/core";
import {
  AUTOMATION_PERMISSIONS,
  authorizeAutomationOperation,
  capabilityKindForRisk,
  classifyAutomationRisk,
  grantsForTenantRole,
} from "../src/automation-authz.js";
import type { AutomationAuthzInput, AutomationResourceScope } from "../src/automation-authz.js";

const TENANT = "tenant-a";
const OTHER_TENANT = "tenant-b";

/**
 * A trusted identity, as `requireAuth` would have produced it. The account role
 * defaults to `member` to make the point that it is not what the engine reads.
 */
const asUser = (userId: string, role: Role = "member"): AuthContext => ({
  userId,
  role,
  email: `${userId}@example.test`,
});

/** A membership as the server would have read it, for `findMembership(userId, tenantId)`. */
const memberOf = (userId: string, role: TenantRole, tenantId = TENANT): TenantMembershipContext => ({
  tenantId,
  userId,
  role,
});

/** What the registry says each surface can do (mirrors Phase 16's shapes). */
const REST_OPS = ["list", "describe", "monitor", "manage", "execute"] as const;
const MCP_OPS = ["list", "describe", "execute"] as const;

const bothAvailable = (): AutomationConnectorStatus[] => [
  connectorStatus("rest", true, REST_OPS),
  connectorStatus("mcp", true, MCP_OPS),
];
const restOnly = (): AutomationConnectorStatus[] => [connectorStatus("rest", true, REST_OPS)];
const mcpOnly = (): AutomationConnectorStatus[] => [connectorStatus("mcp", true, MCP_OPS)];

const ownedByTenant = (tenantId = TENANT): AutomationResourceScope => ({ tenantId });

/** The subject "user-a" with this membership role in TENANT. */
const as = (role: TenantRole, agentId?: string) => ({
  subject: { auth: asUser("user-a"), membership: memberOf("user-a", role), ...(agentId ? { agentId } : {}) },
});

const input = (over: Partial<AutomationAuthzInput> = {}): AutomationAuthzInput => ({
  subject: { auth: asUser("user-a"), membership: memberOf("user-a", "owner") },
  operation: "list",
  scope: ownedByTenant(),
  connectors: bothAvailable(),
  ...over,
});

const decide = (over: Partial<AutomationAuthzInput> = {}) => authorizeAutomationOperation(input(over));

const allowed = (over: Partial<AutomationAuthzInput> = {}) => {
  const d = decide(over);
  if (!d.allowed) throw new Error(`expected allow, got ${d.code}`);
  return d;
};

const denied = (over: Partial<AutomationAuthzInput> = {}) => {
  const d = decide(over);
  if (d.allowed) throw new Error("expected deny, got allow");
  return d;
};

describe("classifyAutomationRisk — explicit, total, default-deny", () => {
  it("classifies every declared operation (totality: nothing unclassified ships)", () => {
    expect(AUTOMATION_OPERATIONS).toHaveLength(5);
    for (const op of AUTOMATION_OPERATIONS) {
      expect(classifyAutomationRisk(op), op).not.toBeNull();
    }
  });

  it("reads are READ_ONLY; manage and execute are approval-carrying risks", () => {
    expect(classifyAutomationRisk("list")).toBe("READ_ONLY");
    expect(classifyAutomationRisk("describe")).toBe("READ_ONLY");
    expect(classifyAutomationRisk("monitor")).toBe("READ_ONLY");
    expect(classifyAutomationRisk("manage")).toBe("HIGH_IMPACT");
    expect(classifyAutomationRisk("execute")).toBe("EXTERNAL_SIDE_EFFECT");
  });

  it("returns null for unknown and prototype-key operations", () => {
    for (const bad of ["execuite", "", "execute_all", "constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(classifyAutomationRisk(bad), bad).toBeNull();
    }
    expect(classifyAutomationRisk(42 as unknown as string)).toBeNull();
    expect(classifyAutomationRisk(undefined as unknown as string)).toBeNull();
  });
});

describe("capabilityKindForRisk — fail-closed direction", () => {
  it("only READ_ONLY is a read capability; everything else demands write", () => {
    expect(capabilityKindForRisk("READ_ONLY")).toBe("read");
    expect(capabilityKindForRisk("LOW_IMPACT")).toBe("write");
    expect(capabilityKindForRisk("EXTERNAL_SIDE_EFFECT")).toBe("write");
    expect(capabilityKindForRisk("HIGH_IMPACT")).toBe("write");
    expect(capabilityKindForRisk("FINANCIAL")).toBe("write");
  });
});

describe("grantsForTenantRole — the approved membership table; REST and MCP are distinct", () => {
  it("owner and admin hold all four surface capabilities", () => {
    for (const role of ["owner", "admin"] as const) {
      expect([...grantsForTenantRole(role)].sort()).toEqual(["mcp:read", "mcp:write", "rest:read", "rest:write"]);
    }
  });

  it("member holds REST read and MCP read — and no write on either surface", () => {
    expect([...grantsForTenantRole("member")].sort()).toEqual(["mcp:read", "rest:read"]);
  });

  it("viewer holds REST read only — no MCP, no write", () => {
    expect(grantsForTenantRole("viewer")).toEqual(["rest:read"]);
  });

  it("an unrecognized role holds nothing", () => {
    expect(grantsForTenantRole("root")).toEqual([]);
    expect(grantsForTenantRole("OWNER")).toEqual([]);
    expect(grantsForTenantRole("")).toEqual([]);
    expect(grantsForTenantRole(7 as unknown as string)).toEqual([]);
  });

  it("the vocabulary is exactly four distinct capabilities", () => {
    expect([...AUTOMATION_PERMISSIONS].sort()).toEqual(["mcp:read", "mcp:write", "rest:read", "rest:write"]);
    expect(new Set(AUTOMATION_PERMISSIONS).size).toBe(4);
  });
});

describe("allow", () => {
  it("owner + list + matching tenant: allowed on the preferred surface, no approval", () => {
    expect(allowed()).toMatchObject({
      allowed: true,
      operation: "list",
      risk: "READ_ONLY",
      requiresApproval: false,
      surface: "rest",
      capability: "rest:read",
    });
  });

  it("a REST-only operation (monitor) resolves to REST", () => {
    const d = allowed({ operation: "monitor" });
    expect(d.surface).toBe("rest");
    expect(d.capability).toBe("rest:read");
  });

  it("manage is HIGH_IMPACT and approval-required on the granted surface", () => {
    const d = allowed({ operation: "manage" });
    expect(d.risk).toBe("HIGH_IMPACT");
    expect(d.requiresApproval).toBe(true);
    expect(d.capability).toBe("rest:write");
  });

  it("execute is EXTERNAL_SIDE_EFFECT, approval-required, MCP preferred", () => {
    const d = allowed({ operation: "execute" });
    expect(d.risk).toBe("EXTERNAL_SIDE_EFFECT");
    expect(d.requiresApproval).toBe(true);
    expect(d.surface).toBe("mcp");
    expect(d.capability).toBe("mcp:write");
  });

  it("a member may list on an MCP-only surface — its MCP read grant is its own", () => {
    const d = allowed({ ...as("member"), connectors: mcpOnly() });
    expect(d.surface).toBe("mcp");
    expect(d.capability).toBe("mcp:read");
    expect(d.requiresApproval).toBe(false);
  });
});

describe("deny — role without the capability", () => {
  it("member cannot manage (no write grant on any surface)", () => {
    expect(denied({ ...as("member"), operation: "manage" }).code).toBe("SURFACE_PERMISSION_DENIED");
  });

  it("viewer cannot execute (read is not write, on either surface)", () => {
    expect(denied({ ...as("viewer"), operation: "execute" }).code).toBe("SURFACE_PERMISSION_DENIED");
  });

  it("viewer is refused an MCP-only surface: rest:read is not mcp:read", () => {
    expect(denied({ ...as("viewer"), connectors: mcpOnly() }).code).toBe("SURFACE_PERMISSION_DENIED");
  });

  it("deny decisions carry a fixed sentence and never echo an input", () => {
    const d = denied({ operation: "delete-everything-now" });
    expect(d.code).toBe("OPERATION_UNKNOWN");
    expect(typeof d.message).toBe("string");
    expect(d.message.length).toBeGreaterThan(0);
    expect(JSON.stringify(d)).not.toContain("delete-everything-now");
  });
});

describe("default-deny — unknown, unclassified, unauthenticated", () => {
  it("an unknown operation is refused before anything else", () => {
    expect(denied({ operation: "execuite" }).code).toBe("OPERATION_UNKNOWN");
    expect(denied({ operation: "" }).code).toBe("OPERATION_UNKNOWN");
    expect(denied({ operation: "constructor" }).code).toBe("OPERATION_UNKNOWN");
    expect(denied({ operation: "__proto__" }).code).toBe("OPERATION_UNKNOWN");
    expect(denied({ operation: "toString" }).code).toBe("OPERATION_UNKNOWN");
    expect(denied({ operation: 42 as unknown as string }).code).toBe("OPERATION_UNKNOWN");
  });

  it("a non-string operation cannot smuggle a classification", () => {
    expect(denied({ operation: ["list"] as unknown as string }).code).toBe("OPERATION_UNKNOWN");
  });

  it("no trusted identity is refused before scope, membership, role or routing", () => {
    const membership = memberOf("user-a", "owner");
    expect(denied({ subject: { auth: null, membership } }).code).toBe("IDENTITY_REQUIRED");
    expect(denied({ subject: { auth: undefined, membership } }).code).toBe("IDENTITY_REQUIRED");
    expect(
      denied({ subject: { auth: { userId: "", role: "owner", email: "x@y.z" }, membership } }).code
    ).toBe("IDENTITY_REQUIRED");
  });

  it("an unrecognized membership role is refused even with everything else valid", () => {
    const d = denied({
      subject: {
        auth: asUser("user-a", "owner"),
        membership: { ...memberOf("user-a", "owner"), role: "root" as unknown as TenantRole },
      },
    });
    expect(d.code).toBe("ROLE_UNRECOGNIZED");
  });

  it("an upper-case database value that was not mapped is not a role", () => {
    const d = denied({
      subject: { auth: asUser("user-a"), membership: { ...memberOf("user-a", "owner"), role: "OWNER" as unknown as TenantRole } },
    });
    expect(d.code).toBe("ROLE_UNRECOGNIZED");
  });
});

describe("tenant ownership — a resource must name its owning organization", () => {
  it("a scope with no tenant is refused for everyone — an owner membership included", () => {
    expect(denied({ scope: { tenantId: "" } }).code).toBe("RESOURCE_OWNERSHIP_MISSING");
    expect(denied({ scope: { tenantId: undefined as unknown as string } }).code).toBe("RESOURCE_OWNERSHIP_MISSING");
    expect(denied({ scope: undefined as unknown as AutomationResourceScope }).code).toBe("RESOURCE_OWNERSHIP_MISSING");
  });

  it("missing ownership is answered before membership is even looked at", () => {
    expect(denied({ scope: { tenantId: "" }, subject: { auth: asUser("user-a"), membership: null } }).code).toBe(
      "RESOURCE_OWNERSHIP_MISSING"
    );
  });
});

describe("tenant membership — the caller's own, in exactly that tenant", () => {
  it("no membership: TENANT_MEMBERSHIP_REQUIRED", () => {
    expect(denied({ subject: { auth: asUser("user-a"), membership: null } }).code).toBe("TENANT_MEMBERSHIP_REQUIRED");
    expect(denied({ subject: { auth: asUser("user-a"), membership: undefined } }).code).toBe(
      "TENANT_MEMBERSHIP_REQUIRED"
    );
  });

  it("a membership read for another account is not this caller's", () => {
    const d = denied({ subject: { auth: asUser("user-a"), membership: memberOf("user-b", "owner") } });
    expect(d.code).toBe("TENANT_MEMBERSHIP_REQUIRED");
  });

  it("cross-tenant: a membership in another tenant does not reach this one", () => {
    const d = denied({ subject: { auth: asUser("user-a"), membership: memberOf("user-a", "owner", OTHER_TENANT) } });
    expect(d.code).toBe("SCOPE_TENANT_MISMATCH");
  });

  it("cross-tenant is refused for write operations too — no path skips it", () => {
    for (const operation of ["manage", "execute"]) {
      const d = denied({
        operation,
        subject: { auth: asUser("user-a"), membership: memberOf("user-a", "owner", OTHER_TENANT) },
      });
      expect(d.code, operation).toBe("SCOPE_TENANT_MISMATCH");
    }
  });

  it("the very same input with the matching tenant is allowed (control)", () => {
    expect(allowed({ scope: ownedByTenant(TENANT) }).allowed).toBe(true);
  });

  it("refusals say 'organization' and never repeat a tenant id or a user id", () => {
    const d = denied({ subject: { auth: asUser("user-a"), membership: memberOf("user-a", "owner", OTHER_TENANT) } });
    expect(d.message).toMatch(/organization/);
    expect(JSON.stringify(d)).not.toContain(TENANT);
    expect(JSON.stringify(d)).not.toContain(OTHER_TENANT);
    expect(JSON.stringify(d)).not.toContain("user-a");
  });
});

describe("the account-wide role is never read", () => {
  it("an account-wide owner or admin with no membership holds nothing on the tenant's resource", () => {
    for (const role of ["owner", "admin"] as const) {
      const d = denied({ subject: { auth: asUser("user-a", role), membership: null } });
      expect(d.code, role).toBe("TENANT_MEMBERSHIP_REQUIRED");
    }
  });

  it("an account-wide owner with a member membership gets member grants — no write", () => {
    const subject = { auth: asUser("user-a", "owner"), membership: memberOf("user-a", "member") };
    expect(denied({ subject, operation: "manage" }).code).toBe("SURFACE_PERMISSION_DENIED");
    expect(denied({ subject, operation: "execute" }).code).toBe("SURFACE_PERMISSION_DENIED");
    expect(allowed({ subject, connectors: mcpOnly() }).capability).toBe("mcp:read");
  });

  it("an account-wide owner with a viewer membership is refused MCP", () => {
    const subject = { auth: asUser("user-a", "owner"), membership: memberOf("user-a", "viewer") };
    expect(denied({ subject, connectors: mcpOnly() }).code).toBe("SURFACE_PERMISSION_DENIED");
  });

  it("an account-wide member with an owner membership gets owner grants — still approval-gated", () => {
    const subject = { auth: asUser("user-a", "member"), membership: memberOf("user-a", "owner") };
    const d = allowed({ subject, operation: "manage" });
    expect(d.capability).toBe("rest:write");
    expect(d.requiresApproval).toBe(true);
  });

  it("an unrecognized account role does not matter when the membership is valid", () => {
    const subject = { auth: { ...asUser("user-a"), role: "root" as unknown as Role }, membership: memberOf("user-a", "member") };
    expect(allowed({ subject }).allowed).toBe(true);
  });
});

describe("owner scope inside a tenant — checked beside the tenant, never instead of it", () => {
  it("another principal's resource in the same tenant: SCOPE_OWNER_MISMATCH, even for an owner membership", () => {
    expect(denied({ scope: { tenantId: TENANT, ownerUserId: "user-b" } }).code).toBe("SCOPE_OWNER_MISMATCH");
  });

  it("the very same input with the matching owner is allowed (control)", () => {
    expect(allowed({ scope: { tenantId: TENANT, ownerUserId: "user-a" } }).allowed).toBe(true);
  });

  it("an empty owner is refused, not assumed to be the caller's", () => {
    expect(denied({ scope: { tenantId: TENANT, ownerUserId: "" } }).code).toBe("SCOPE_OWNER_MISMATCH");
  });

  it("owner scope is checked for write operations too", () => {
    expect(denied({ operation: "execute", scope: { tenantId: TENANT, ownerUserId: "user-b" } }).code).toBe(
      "SCOPE_OWNER_MISMATCH"
    );
  });

  it("a matching owner never rescues a tenant mismatch", () => {
    const d = denied({
      scope: { tenantId: TENANT, ownerUserId: "user-a" },
      subject: { auth: asUser("user-a"), membership: memberOf("user-a", "owner", OTHER_TENANT) },
    });
    expect(d.code).toBe("SCOPE_TENANT_MISMATCH");
  });
});

describe("agent scope", () => {
  const agentScoped: AutomationResourceScope = { tenantId: TENANT, agentId: "agent-1" };

  it("an agent-scoped resource with no session agent: AGENT_CONTEXT_REQUIRED", () => {
    expect(denied({ scope: agentScoped, ...as("owner") }).code).toBe("AGENT_CONTEXT_REQUIRED");
  });

  it("a different session agent: AGENT_SCOPE_MISMATCH", () => {
    expect(denied({ scope: agentScoped, ...as("owner", "agent-2") }).code).toBe("AGENT_SCOPE_MISMATCH");
  });

  it("the matching agent is allowed (control)", () => {
    expect(allowed({ scope: agentScoped, ...as("owner", "agent-1") }).allowed).toBe(true);
  });

  it("a resource that is not agent-scoped is unaffected by a session agent", () => {
    expect(allowed({ scope: ownedByTenant(), ...as("owner", "agent-9") }).allowed).toBe(true);
  });

  it("scope is checked for the agent even when the role could do everything", () => {
    expect(denied({ operation: "manage", scope: agentScoped, ...as("owner", "agent-2") }).code).toBe(
      "AGENT_SCOPE_MISMATCH"
    );
  });
});

describe("connector-specific permissions and fallback", () => {
  it("unavailability of the granted surface never promotes the other one", () => {
    // Viewer holds rest:read; with REST unreachable, MCP is a DIFFERENT grant
    // and is not granted — the fallback must not hand over the operation.
    expect(denied({ ...as("viewer"), connectors: mcpOnly() }).code).toBe("SURFACE_PERMISSION_DENIED");
  });

  it("fallback succeeds on a surface that independently holds its grant", () => {
    // Owner holds every grant; REST is unreachable, so the registry's second
    // candidate is checked on its own and passes.
    const d = allowed({ connectors: mcpOnly() });
    expect(d.surface).toBe("mcp");
    expect(d.capability).toBe("mcp:read");
  });

  it("registry preference decides when both surfaces are granted", () => {
    expect(allowed({ connectors: bothAvailable() }).surface).toBe("rest");
    expect(allowed({ operation: "execute", connectors: bothAvailable() }).surface).toBe("mcp");
  });

  it("a viewer's list goes to REST, the surface it holds", () => {
    const d = allowed({ ...as("viewer"), connectors: bothAvailable() });
    expect(d.surface).toBe("rest");
    expect(d.capability).toBe("rest:read");
  });

  it("fallback for a write keeps the approval requirement", () => {
    // `execute` prefers MCP; with MCP unreachable it falls to REST — and
    // because risk comes from the OPERATION, requiresApproval survives the
    // fallback. A fallback can never shed the gate.
    const d = allowed({ operation: "execute", connectors: restOnly() });
    expect(d.surface).toBe("rest");
    expect(d.capability).toBe("rest:write");
    expect(d.risk).toBe("EXTERNAL_SIDE_EFFECT");
    expect(d.requiresApproval).toBe(true);
  });

  it("fallback through every candidate is still denied when none is granted", () => {
    // Member: MCP write refused, then REST write refused — two independent
    // checks, both deny, final answer deny. The second surface is never the
    // "yes" the first surface withheld.
    expect(denied({ ...as("member"), operation: "execute", connectors: bothAvailable() }).code).toBe(
      "SURFACE_PERMISSION_DENIED"
    );
  });

  it("read grant on one surface is not a write grant through fallback", () => {
    expect(denied({ ...as("member"), operation: "manage", connectors: bothAvailable() }).code).toBe(
      "SURFACE_PERMISSION_DENIED"
    );
  });

  it("a member's read grants imply no write on any surface combination", () => {
    for (const operation of ["manage", "execute"]) {
      for (const connectors of [bothAvailable(), restOnly(), mcpOnly()]) {
        const d = decide({ ...as("member"), operation, connectors });
        expect(d.allowed, `${operation} via ${connectors.map((c) => c.connector).join("+")}`).toBe(false);
      }
    }
  });

  it("every allowed write still requires approval, for every role that may write", () => {
    for (const role of ["owner", "admin"] as const) {
      for (const operation of ["manage", "execute"]) {
        expect(allowed({ ...as(role), operation }).requiresApproval, `${role} ${operation}`).toBe(true);
      }
    }
  });

  it("no available connector: NO_SUPPORTED_SURFACE (no grant failure involved)", () => {
    expect(denied({ connectors: [] }).code).toBe("NO_SUPPORTED_SURFACE");
  });

  it("a connector that does not declare the operation is not a candidate", () => {
    const d = denied({
      operation: "monitor", // REST-only in the preference table
      connectors: [connectorStatus("mcp", true, MCP_OPS)],
    });
    expect(d.code).toBe("NO_SUPPORTED_SURFACE");
  });

  it("an unavailable connector is present-but-false, never treated as offered", () => {
    const d = denied({
      connectors: [connectorStatus("rest", false, REST_OPS), connectorStatus("mcp", false, MCP_OPS)],
    });
    expect(d.code).toBe("NO_SUPPORTED_SURFACE");
  });
});
