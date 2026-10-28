// ---------------------------------------------------------------------------
// Phase 17 multi-business hardening (review findings H2, M3, L11) — who may
// use a connection the deployment configures for everyone, read NOW.
//
// THE ONE READER. Every surface that touches a shared connection asks this:
// the Meta tools (through their account authorizer), the executor and the
// orchestrator (through the access gate below), the Integration Control
// Center (views and connection tests) and the dashboard's Meta pages. It reads
// the operator's owner record and the caller's membership straight from the
// database on every call — there is no cache, so a membership removed a
// moment ago is already in force — and hands both to the pure policy in
// `@jarvis/security` (`authorizeSharedConnection`).
//
// NEVER FROM THE REQUEST. The Organization is the connection's owner, as the
// operator recorded it, never something a caller names: nothing a request can
// fill reaches this file.
//
// FAIL CLOSED. A lookup that throws is `AUTHORIZATION_UNAVAILABLE` — refused,
// and told apart only so a caller can say the check could not be made.
//
// ONE ANSWER FOR OUTSIDERS. `member: false` covers a non-member, a connection
// nobody owns and an invalid owner record alike. A surface must answer all of
// them the same way, so the answer never tells a caller who owns what — or
// whether the deployment has the connection at all.
// ---------------------------------------------------------------------------

import {
  getIntegrationDescriptor,
  sharedConnectionOfTool,
  SHARED_INTEGRATION_CONNECTORS,
  type AutomationConnectorOwnerReader,
  type BrowserWriteScopePort,
  type BrowserWriteScopeResolution,
  type ConnectorOwnerLookup,
  type SharedConnectorKey,
  type TenantMembershipReader,
  type TenantRole,
  type ToolAccessGate,
} from "@jarvis/core";
import {
  authorizeSharedConnection,
  sharedWriteScope,
  type SharedConnectionDenyCode,
  type SharedConnectionOperation,
} from "@jarvis/security";

export type SharedAccessDecision =
  | { allowed: true; tenantId: string; role: TenantRole }
  | {
      allowed: false;
      code: SharedConnectionDenyCode | "AUTHORIZATION_UNAVAILABLE";
      /** True only for a member of the owning Organization whose role lacks the grant. */
      member: boolean;
    };

export interface SharedConnectionAccessPort {
  check(userId: string, connector: SharedConnectorKey, operation: SharedConnectionOperation): Promise<SharedAccessDecision>;
}

export class SharedConnectionAccess implements SharedConnectionAccessPort {
  constructor(private readonly tenancy: AutomationConnectorOwnerReader & TenantMembershipReader) {}

  async check(
    userId: string,
    connector: SharedConnectorKey,
    operation: SharedConnectionOperation
  ): Promise<SharedAccessDecision> {
    let owner: ConnectorOwnerLookup;
    try {
      owner = await this.tenancy.findConnectorOwner(connector.providerId, connector.connector);
    } catch {
      return { allowed: false, code: "AUTHORIZATION_UNAVAILABLE", member: false };
    }
    if (owner.status !== "assigned") {
      return { allowed: false, code: "RESOURCE_OWNERSHIP_MISSING", member: false };
    }

    let membership: { role: TenantRole } | null;
    try {
      membership = await this.tenancy.findMembership(userId, owner.tenantId);
    } catch {
      return { allowed: false, code: "AUTHORIZATION_UNAVAILABLE", member: false };
    }

    const decision = authorizeSharedConnection({
      subject: {
        auth: { userId },
        membership: membership ? { tenantId: owner.tenantId, userId, role: membership.role } : null,
      },
      operation,
      scope: { tenantId: owner.tenantId },
    });
    if (decision.allowed) return { allowed: true, tenantId: decision.tenantId, role: decision.role };
    return { allowed: false, code: decision.code, member: membership !== null };
  }
}

/**
 * The browser tools' implementation of `BrowserWriteScopePort`.
 *
 * A browser write is a write through the deployment's one shared browser
 * connection. This asks the same reader every other surface asks, at execution
 * time, and hands the result to the approval store. The store re-checks it
 * under locks when it consumes the approval — including that the Organization
 * still owns the connection — so an owner reassigned between approval and
 * execution is refused there. A lookup that throws is a refusal.
 */
export function createBrowserWriteScopeResolver(
  access: SharedConnectionAccessPort
): BrowserWriteScopePort {
  return {
    async resolveWriteScope(userId: string): Promise<BrowserWriteScopeResolution> {
      let decision: SharedAccessDecision;
      try {
        decision = await access.check(userId, SHARED_INTEGRATION_CONNECTORS.browser, "write");
      } catch {
        return { ok: false, message: SHARED_ACCESS_UNVERIFIED };
      }
      if (!decision.allowed) {
        return {
          ok: false,
          message: sharedRefusalMessage("Browser control", "write", decision),
        };
      }
      return {
        ok: true,
        tenantScope: sharedWriteScope(decision.tenantId, SHARED_INTEGRATION_CONNECTORS.browser),
      };
    },
  };
}

/**
 * Phase 19.2 — which Organization a remote browser session belongs to.
 *
 * The browser service binds a session to the organization its opening request
 * named, and refuses every later request that claims another. The API must
 * therefore resolve that organization itself: never from a request body, and
 * never from a session id. This asks the one shared-connection reader, so the
 * browser service sees exactly the membership answer every other shared
 * connection sees.
 *
 * A refusal carries no reason. The protocol has one fixed sentence for it, and
 * the service is never told whether the caller was a non-member, an outsider or
 * a deployment whose connection nobody owns.
 */
export interface BrowserSessionTenantResolver {
  resolveSessionOrganization(
    userId: string
  ): Promise<{ ok: true; organizationId: string } | { ok: false }>;
}

export function createBrowserSessionTenantResolver(
  access: SharedConnectionAccessPort
): BrowserSessionTenantResolver {
  return {
    async resolveSessionOrganization(
      userId: string
    ): Promise<{ ok: true; organizationId: string } | { ok: false }> {
      let decision: SharedAccessDecision;
      try {
        decision = await access.check(userId, SHARED_INTEGRATION_CONNECTORS.browser, "read");
      } catch {
        return { ok: false };
      }
      if (!decision.allowed) return { ok: false };
      return { ok: true, organizationId: decision.tenantId };
    },
  };
}

/** The fixed answer to anyone outside the owning Organization. Names no one. */
export function sharedConnectionUnavailable(integrationName: string): string {
  return `${integrationName} is not available to your account.`;
}

/** The fixed answer when the check itself could not be made. */
export const SHARED_ACCESS_UNVERIFIED = "Organization access could not be verified, so nothing was done.";

/**
 * What a refusal says, by who was refused. An outsider is told only that the
 * integration is not available to them; a member of the owning Organization
 * is told what their role does not allow, which tells them nothing new.
 */
export function sharedRefusalMessage(
  integrationName: string,
  operation: SharedConnectionOperation,
  decision: Extract<SharedAccessDecision, { allowed: false }>
): string {
  if (decision.code === "AUTHORIZATION_UNAVAILABLE") return SHARED_ACCESS_UNVERIFIED;
  if (!decision.member) return sharedConnectionUnavailable(integrationName);
  switch (operation) {
    case "write":
      return `Your organization role does not allow changes through ${integrationName}. Ask an owner or admin of your organization.`;
    case "test":
      return `Only an owner or admin of your organization can test the ${integrationName} connection.`;
    case "diagnostics":
      return `Only an owner or admin of your organization can see the ${integrationName} connection's details.`;
    case "approve":
      return "Only an owner or admin of your organization can approve this change.";
    default:
      return `Your organization role does not allow this on ${integrationName}.`;
  }
}

/**
 * The executor's and the orchestrator's early question (`ToolAccessGate`): a
 * tool that acts through a shared connection runs only for a member of the
 * owning Organization whose role allows what it does. Every other tool is
 * allowed here — this gate narrows, and never decides anything else.
 */
export function createSharedConnectionToolGate(access: SharedConnectionAccessPort): ToolAccessGate {
  return {
    async check({ toolId, userId }) {
      const use = sharedConnectionOfTool(toolId);
      if (!use) return { allowed: true };
      const decision = await access.check(userId, use.connector, use.access);
      if (decision.allowed) return { allowed: true };
      const name = getIntegrationDescriptor(use.integration)?.name ?? use.integration;
      return { allowed: false, reason: sharedRefusalMessage(name, use.access, decision) };
    },
  };
}
