// ---------------------------------------------------------------------------
// Phase 17, Stage 1 — focused tests for the Permission and Risk Engine.
//
// The five the task names — allow, deny, unknown operation, cross-tenant, and
// connector-specific permissions — plus the properties that make the engine's
// default-deny real: prototype-key operations, unknown roles, absent identity,
// agent scope, and the rule that a connector FALLBACK is granted exactly the
// same check as the surface it fell from (a fallback may never carry an
// operation across an authorization boundary, and may never shed the approval
// requirement on the way).
//
// Nothing here reaches a provider: the engine is pure, and these tests construct
// only plain objects.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { AUTOMATION_OPERATIONS, connectorStatus } from "@jarvis/core";
import type { AuthContext, AutomationConnectorStatus, Role } from "@jarvis/core";
import {
  AUTOMATION_PERMISSIONS,
  authorizeAutomationOperation,
  capabilityKindForRisk,
  classifyAutomationRisk,
  grantsForAutomationRole,
} from "../src/automation-authz.js";
import type { AutomationAuthzInput, AutomationResourceScope } from "../src/automation-authz.js";

/** A trusted identity, as `requireAuth` would have produced it. */
const asUser = (userId: string, role: Role): AuthContext => ({
  userId,
  role,
  email: `${userId}@example.test`,
});

/** What the registry says each surface can do (mirrors Phase 16's shapes). */
const REST_OPS = ["list", "describe", "monitor", "manage", "execute"] as const;
const MCP_OPS = ["list", "describe", "execute"] as const;

const bothAvailable = (): AutomationConnectorStatus[] => [
  connectorStatus("rest", true, REST_OPS),
  connectorStatus("mcp", true, MCP_OPS),
];
const restOnly = (): AutomationConnectorStatus[] => [
  connectorStatus("rest", true, REST_OPS),
];
const mcpOnly = (): AutomationConnectorStatus[] => [
  connectorStatus("mcp", true, MCP_OPS),
];

const ownedBy = (userId: string): AutomationResourceScope => ({ ownerUserId: userId });

const input = (
  over: Partial<AutomationAuthzInput> = {}
): AutomationAuthzInput => ({
  subject: { auth: asUser("user-a", "owner") },
  operation: "list",
  scope: ownedBy("user-a"),
  connectors: bothAvailable(),
  ...over,
});

const decide = (over: Partial<AutomationAuthzInput> = {}) =>
  authorizeAutomationOperation(input(over));

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

describe("grantsForAutomationRole — REST and MCP are distinct", () => {
  it("owner and admin hold all four surface capabilities", () => {
    for (const role of ["owner", "admin"] as const) {
      expect([...grantsForAutomationRole(role)].sort()).toEqual([
        "mcp:read",
        "mcp:write",
        "rest:read",
        "rest:write",
      ]);
    }
  });

  it("member and viewer hold REST read only — no MCP, no write", () => {
    for (const role of ["member", "viewer"] as const) {
      expect(grantsForAutomationRole(role)).toEqual(["rest:read"]);
    }
  });

  it("an unrecognized role holds nothing", () => {
    expect(grantsForAutomationRole("root")).toEqual([]);
    expect(grantsForAutomationRole("OWNER")).toEqual([]);
    expect(grantsForAutomationRole("")).toEqual([]);
    expect(grantsForAutomationRole(7 as unknown as string)).toEqual([]);
  });

  it("the vocabulary is exactly four distinct capabilities", () => {
    expect([...AUTOMATION_PERMISSIONS].sort()).toEqual([
      "mcp:read",
      "mcp:write",
      "rest:read",
      "rest:write",
    ]);
    expect(new Set(AUTOMATION_PERMISSIONS).size).toBe(4);
  });
});

describe("allow", () => {
  it("owner + list + matching scope: allowed on the preferred surface, no approval", () => {
    const d = allowed();
    expect(d).toMatchObject({
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
});

describe("deny — role without the capability", () => {
  it("member cannot manage (no write grant on any surface)", () => {
    const d = denied({ operation: "manage", subject: { auth: asUser("user-a", "member") } });
    expect(d.code).toBe("SURFACE_PERMISSION_DENIED");
  });

  it("viewer cannot execute (read is not write, on either surface)", () => {
    const d = denied({ operation: "execute", subject: { auth: asUser("user-a", "viewer") } });
    expect(d.code).toBe("SURFACE_PERMISSION_DENIED");
  });

  it("member is refused an MCP-only surface: rest:read is not mcp:read", () => {
    const d = denied({
      subject: { auth: asUser("user-a", "member") },
      connectors: mcpOnly(),
    });
    expect(d.code).toBe("SURFACE_PERMISSION_DENIED");
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
    // The declared set membership check runs on the raw value first.
    expect(denied({ operation: ["list"] as unknown as string }).code).toBe("OPERATION_UNKNOWN");
  });

  it("no trusted identity is refused before scope, role or routing", () => {
    expect(denied({ subject: { auth: null } }).code).toBe("IDENTITY_REQUIRED");
    expect(denied({ subject: { auth: undefined } }).code).toBe("IDENTITY_REQUIRED");
    expect(
      denied({ subject: { auth: { userId: "", role: "owner", email: "x@y.z" } } }).code
    ).toBe("IDENTITY_REQUIRED");
  });

  it("an unrecognized role is refused even with everything else valid", () => {
    const d = denied({
      subject: { auth: { ...asUser("user-a", "owner"), role: "root" as unknown as Role } },
    });
    expect(d.code).toBe("ROLE_UNRECOGNIZED");
  });
});

describe("cross-tenant scope — role is never an override", () => {
  it("owner role + another principal's resource: SCOPE_OWNER_MISMATCH", () => {
    const d = denied({ scope: ownedBy("user-b") });
    expect(d.code).toBe("SCOPE_OWNER_MISMATCH");
  });

  it("the very same input with the matching owner is allowed (control)", () => {
    expect(allowed({ scope: ownedBy("user-a") }).allowed).toBe(true);
  });

  it("an unresolvable owner is refused, not assumed to be the caller's", () => {
    expect(denied({ scope: { ownerUserId: "" } }).code).toBe("SCOPE_OWNER_MISMATCH");
    expect(
      denied({ scope: { ownerUserId: undefined as unknown as string } }).code
    ).toBe("SCOPE_OWNER_MISMATCH");
  });

  it("scope is checked for write operations too — no path skips it", () => {
    const d = denied({ operation: "execute", scope: ownedBy("user-b") });
    expect(d.code).toBe("SCOPE_OWNER_MISMATCH");
  });
});

describe("agent scope", () => {
  const agentScoped: AutomationResourceScope = {
    ownerUserId: "user-a",
    agentId: "agent-1",
  };

  it("an agent-scoped resource with no session agent: AGENT_CONTEXT_REQUIRED", () => {
    const d = denied({ scope: agentScoped, subject: { auth: asUser("user-a", "owner") } });
    expect(d.code).toBe("AGENT_CONTEXT_REQUIRED");
  });

  it("a different session agent: AGENT_SCOPE_MISMATCH", () => {
    const d = denied({
      scope: agentScoped,
      subject: { auth: asUser("user-a", "owner"), agentId: "agent-2" },
    });
    expect(d.code).toBe("AGENT_SCOPE_MISMATCH");
  });

  it("the matching agent is allowed (control)", () => {
    const d = allowed({
      scope: agentScoped,
      subject: { auth: asUser("user-a", "owner"), agentId: "agent-1" },
    });
    expect(d.allowed).toBe(true);
  });

  it("a resource that is not agent-scoped is unaffected by a session agent", () => {
    const d = allowed({
      scope: ownedBy("user-a"),
      subject: { auth: asUser("user-a", "owner"), agentId: "agent-9" },
    });
    expect(d.allowed).toBe(true);
  });

  it("scope is checked for the agent even when the role could do everything", () => {
    const d = denied({
      operation: "manage",
      scope: agentScoped,
      subject: { auth: asUser("user-a", "owner"), agentId: "agent-2" },
    });
    expect(d.code).toBe("AGENT_SCOPE_MISMATCH");
  });
});

describe("connector-specific permissions and fallback", () => {
  it("unavailability of the granted surface never promotes the other one", () => {
    // Member holds rest:read; with REST unreachable, MCP is a DIFFERENT grant
    // and is not granted — the fallback must not hand over the operation.
    const d = denied({
      subject: { auth: asUser("user-a", "member") },
      connectors: mcpOnly(),
    });
    expect(d.code).toBe("SURFACE_PERMISSION_DENIED");
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
    const d = denied({
      operation: "execute",
      subject: { auth: asUser("user-a", "member") },
      connectors: bothAvailable(),
    });
    expect(d.code).toBe("SURFACE_PERMISSION_DENIED");
  });

  it("read grant on one surface is not a write grant through fallback", () => {
    const d = denied({
      operation: "manage",
      subject: { auth: asUser("user-a", "member") },
      connectors: bothAvailable(),
    });
    expect(d.code).toBe("SURFACE_PERMISSION_DENIED");
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
