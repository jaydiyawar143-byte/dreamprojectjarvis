// ---------------------------------------------------------------------------
// CapabilityService — answers "what can you do?" from the running system.
//
// THE BUG THIS REPLACES. The question used to be answered by the fallback
// agent's system prompt, which said "you have direct access to the user's Meta
// Ads account". So the answer was a Meta Ads feature list on every deployment,
// regardless of what was registered, connected or permitted — and it listed
// Gmail actions on a server with no Google OAuth client, because a prompt
// cannot know that and was never asked to.
//
// So nothing here is written down as a feature. Every capability is DERIVED:
//
//   tool registry        -> is a tool actually registered in this process?
//   agent policy         -> is any agent permitted to call it?
//   integration state    -> is the provider connected, for THIS user?
//   granted permissions  -> has the provider actually granted the scope?
//   the tool's own risk  -> does running it stop for a confirmation?
//
// A capability that is registered but whose provider is disconnected is
// reported as NOT_CONNECTED with the reason and the required action. It is
// never reported as something JARVIS can do.
//
// IDENTIFIERS ARE MASKED HERE, at the point of construction, not by the caller.
// `account` on the returned view is already `act_2478••••••1624`; there is no
// path through this service that emits a full one, which is stronger than
// asking every caller to remember.
// ---------------------------------------------------------------------------

import {
  describeCapability,
  groupForToolId,
  plannedCapabilities,
  maskEmail,
  maskIdentifier,
  INTEGRATION_CATALOG,
  isUsable,
  type CapabilityAvailability,
  type CapabilityGroup,
  type CapabilityReport,
  type CapabilitySummary,
  type CapabilityView,
  type IntegrationCapabilityView,
  type IntegrationView,
  type PermissionReport,
  type PermissionView,
  type ITool,
} from "@jarvis/core";

/** The subset of ToolRegistry this service needs. Narrow, so tests can fake it. */
export interface ToolRegistryPort {
  getAll(): ITool[];
}

/**
 * Per-user integration state, read through the SAME service the Integration
 * Center and the JARVIS integration tools use.
 *
 * Passed as a port rather than the concrete class so capability discovery has
 * no way to reach a provider or a credential of its own — it can only ask the
 * one component that is allowed to.
 */
export interface IntegrationStateReader {
  /** Every integration's real state for one user, or null when unavailable. */
  listIntegrations(userId: string): Promise<IntegrationView[] | null>;
}

export interface CapabilityDeps {
  toolRegistry: ToolRegistryPort;
  integrations: IntegrationStateReader;
  /**
   * Tool ids any agent is allowed to call. A registered tool no policy grants
   * is unreachable, and reporting it as a capability would promise something
   * no conversation can actually trigger.
   */
  allowedToolIds: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------

/** How an integration's state translates into a capability's availability. */
function availabilityFromIntegration(
  integration: IntegrationView | undefined,
  writesExternally: boolean
): { availability: CapabilityAvailability; reason: string | null; requiredAction: string | null } {
  if (!integration) {
    return {
      availability: "NOT_CONFIGURED",
      reason: "This deployment has no configuration for the provider behind this capability.",
      requiredAction: "Ask an administrator to configure it on the server.",
    };
  }

  switch (integration.connection) {
    case "DISABLED":
      return {
        availability: "DISABLED",
        reason: `${integration.name} is switched off. Its credentials are kept.`,
        requiredAction: `Enable ${integration.name} in the Integration Center, or say "${integration.name} enable karo".`,
      };

    case "NEEDS_REAUTH":
      return {
        availability: "NEEDS_REAUTH",
        reason: `${integration.name} authorization has expired or been revoked by the provider.`,
        requiredAction: `Reauthorize ${integration.name} — a retry cannot fix a grant that no longer exists.`,
      };

    case "NOT_CONNECTED":
      return {
        availability: "NOT_CONNECTED",
        reason:
          integration.configKind === "oauth"
            ? `${integration.name} is not connected. ${integration.detail}`
            : `${integration.name} is not configured. ${integration.detail}`,
        requiredAction:
          integration.configKind === "oauth"
            ? `Connect your ${integration.name} account, then this becomes available.`
            : integration.configKind === "server-managed"
              ? `Set ${integration.name}'s server environment variables and restart.`
              : `Save ${integration.name} credentials in the Integration Center.`,
      };

    case "PARTIAL":
      return {
        availability: "NOT_CONNECTED",
        reason: `${integration.name} is only partially configured. Missing: ${
          integration.missingConfig.length > 0 ? integration.missingConfig.join(", ") : "some settings"
        }.`,
        requiredAction: `Complete ${integration.name}'s configuration.`,
      };

    case "CONNECTED":
    default:
      // Connected is necessary but not sufficient: a write still stops for a
      // confirmation, and that is a capability fact the user should see up
      // front rather than discovering at execution time.
      return writesExternally
        ? { availability: "REQUIRES_CONFIRMATION", reason: null, requiredAction: null }
        : { availability: "EXECUTABLE", reason: null, requiredAction: null };
  }
}

/**
 * Whether the granted permissions cover a capability.
 *
 * Reads GRANTED permissions, never the ones this build knows how to request.
 * That distinction is the whole reason a disconnected Google stopped reporting
 * Gmail access as available.
 */
function permissionGap(
  integration: IntegrationView | undefined,
  access: "read" | "write"
): string | null {
  if (!integration || integration.connection !== "CONNECTED") return null;

  const relevant = integration.permissions.filter((p) => p.access === access);
  if (relevant.length === 0) return null;
  if (relevant.some((p) => p.granted)) return null;

  return access === "write"
    ? `${integration.name} is connected, but no write permission has been granted.`
    : `${integration.name} is connected, but the required read permission has not been granted.`;
}

export class CapabilityService {
  constructor(private readonly deps: CapabilityDeps) {}

  /**
   * The full capability report for one user.
   *
   * Always returns something usable: if integration state cannot be read, every
   * integration-gated capability degrades to NOT_CONFIGURED with that stated,
   * rather than the whole report failing. A capability question answered
   * partially is far better than an error, and silently reporting them as
   * available would be the one unacceptable outcome.
   */
  async report(userId: string): Promise<CapabilityReport> {
    const integrations = (await this.deps.integrations.listIntegrations(userId)) ?? [];
    const byId = new Map<string, IntegrationView>(integrations.map((i) => [i.id, i]));

    const capabilities: CapabilityView[] = [];

    // --- registered tools ---------------------------------------------------
    for (const tool of this.deps.toolRegistry.getAll()) {
      // A registered tool no agent may call cannot be triggered by any
      // conversation, so listing it would promise something unreachable.
      if (!this.deps.allowedToolIds.has(tool.id)) continue;

      // Integration management is how you FIX a disconnected provider. Listing
      // it as a capability is correct and useful, but it is never gated on the
      // integration it manages — otherwise "connect Google" would report itself
      // as unavailable because Google is not connected.
      const isManagement = tool.id.startsWith("integration.");

      const meta = describeCapability(tool.id, tool.description);
      const writesExternally =
        tool.risk === "EXTERNAL_SIDE_EFFECT" ||
        tool.risk === "HIGH_IMPACT" ||
        tool.risk === "FINANCIAL";
      const access: "read" | "write" = writesExternally ? "write" : "read";

      let availability: CapabilityAvailability;
      let reason: string | null;
      let requiredAction: string | null;

      if (isManagement || meta.integration === null) {
        // Ungated. Only its own risk decides whether it needs confirmation.
        availability = writesExternally ? "REQUIRES_CONFIRMATION" : "EXECUTABLE";
        reason = null;
        requiredAction = null;
      } else {
        const integration = byId.get(meta.integration);
        const derived = availabilityFromIntegration(integration, writesExternally);
        availability = derived.availability;
        reason = derived.reason;
        requiredAction = derived.requiredAction;

        // Connected but unscoped is its own state, distinct from disconnected.
        if (isUsable(availability)) {
          const gap = permissionGap(integration, access);
          if (gap) {
            availability = "PERMISSION_MISSING";
            reason = gap;
            requiredAction = `Grant the required ${access} permission for ${integration?.name ?? meta.integration}.`;
          }
        }
      }

      capabilities.push({
        id: tool.id,
        label: meta.label,
        description: meta.description,
        group: meta.group,
        integration: isManagement ? null : meta.integration,
        registered: true,
        availability,
        access,
        reason,
        requiredAction,
      });
    }

    // --- planned capability -------------------------------------------------
    // Declared, connectable, but with no client in this build. Reported so a
    // roadmap item is never mistaken for a working feature.
    for (const planned of plannedCapabilities()) {
      const integration = byId.get(planned.integration);
      capabilities.push({
        id: planned.id,
        label: planned.label,
        description: planned.description,
        group: planned.group,
        integration: planned.integration,
        registered: false,
        availability: "PLANNED",
        access: planned.access,
        reason: `This build has no client for ${planned.label.replace(" (planned)", "")}, so no action can run even once ${integration?.name ?? "the provider"} is connected.`,
        requiredAction: null,
      });
    }

    capabilities.sort(byUsefulness);

    return {
      summary: summarise(capabilities),
      capabilities,
      integrations: this.groupByIntegration(capabilities, integrations),
      general: capabilities.filter((c) => c.integration === null),
    };
  }

  /** Capabilities for ONE integration, answering "Gmail ke saath kya kar sakte ho?". */
  async forIntegration(
    userId: string,
    integrationId: string
  ): Promise<IntegrationCapabilityView | null> {
    const report = await this.report(userId);
    return report.integrations.find((i) => i.integration === integrationId) ?? null;
  }

  /** Only integrations whose REAL connection state is connected. */
  async connectedIntegrations(userId: string): Promise<IntegrationCapabilityView[]> {
    const report = await this.report(userId);
    // `connection === "CONNECTED"` is a fact about stored configuration that the
    // integration service derives; `health` is whether a real call has ever
    // succeeded. Both are reported, and neither is inferred from the other.
    return report.integrations.filter((i) => i.connection === "CONNECTED");
  }

  /**
   * Permissions across every integration, with registered and granted kept apart.
   */
  async permissions(userId: string): Promise<PermissionReport> {
    const integrations = (await this.deps.integrations.listIntegrations(userId)) ?? [];
    const permissions: PermissionView[] = [];

    for (const integration of integrations) {
      const disconnected = integration.connection !== "CONNECTED";

      for (const permission of integration.permissions) {
        // A disconnected provider has granted NOTHING, whatever a stale
        // permission list might imply. This is the specific misreport that made
        // a disconnected Google look as though it had granted Gmail access.
        const granted = disconnected ? false : permission.granted;

        permissions.push({
          id: permission.id,
          label: permission.label,
          integration: integration.id,
          // This build knows how to request it — true regardless of connection.
          registered: true,
          granted,
          access: permission.access,
          requiresConfirmation: permission.access === "write",
          reason: granted
            ? null
            : disconnected
              ? `${integration.name} is ${integration.connection.toLowerCase().replace(/_/g, " ")}. ${
                  integration.configKind === "oauth"
                    ? "An OAuth connection is required before any permission can be granted."
                    : "Configure and connect it first."
                }`
              : `${integration.name} is connected but has not granted this permission.`,
        });
      }
    }

    const granted = permissions.filter((p) => p.granted);
    return {
      permissions,
      grantedCount: granted.length,
      missingCount: permissions.length - granted.length,
      writeCount: granted.filter((p) => p.access === "write").length,
    };
  }

  // -------------------------------------------------------------------------

  private groupByIntegration(
    capabilities: CapabilityView[],
    integrations: IntegrationView[]
  ): IntegrationCapabilityView[] {
    return INTEGRATION_CATALOG.map((descriptor) => {
      const state = integrations.find((i) => i.id === descriptor.id);
      const own = capabilities.filter((c) => c.integration === descriptor.id);

      const executable = own.filter((c) => isUsable(c.availability));
      const unavailable = own.filter((c) => !isUsable(c.availability));

      // One sentence for the whole integration, taken from its capabilities
      // rather than invented: whatever is blocking them is what is blocking it.
      const blocked = unavailable.find((c) => c.reason !== null);

      return {
        integration: descriptor.id,
        name: descriptor.name,
        group: groupForToolId(`${descriptor.id}.`).group as CapabilityGroup,
        connection: state?.connection ?? "NOT_CONNECTED",
        health: state?.health ?? "NOT_CONNECTED",
        // MASKED at construction. An email is masked as an email; anything else
        // as an identifier. Neither reproduces the full value.
        account: state?.account
          ? state.account.label.includes("@")
            ? maskEmail(state.account.label)
            : maskIdentifier(state.account.label)
          : null,
        enabledServices: state?.enabledServices ?? [],
        executable,
        unavailable,
        blockedReason: executable.length > 0 ? null : (blocked?.reason ?? null),
        requiredAction: executable.length > 0 ? null : (blocked?.requiredAction ?? null),
      };
    });
  }
}

// ---------------------------------------------------------------------------

const AVAILABILITY_ORDER: CapabilityAvailability[] = [
  "EXECUTABLE",
  "REQUIRES_CONFIRMATION",
  "PERMISSION_MISSING",
  "NEEDS_REAUTH",
  "DISABLED",
  "NOT_CONNECTED",
  "NOT_CONFIGURED",
  "PLANNED",
];

/** Most usable first, then alphabetical, so the order is stable across calls. */
function byUsefulness(a: CapabilityView, b: CapabilityView): number {
  const rank =
    AVAILABILITY_ORDER.indexOf(a.availability) - AVAILABILITY_ORDER.indexOf(b.availability);
  return rank !== 0 ? rank : a.label.localeCompare(b.label);
}

function summarise(capabilities: CapabilityView[]): CapabilitySummary {
  return {
    total: capabilities.length,
    executable: capabilities.filter((c) => c.availability === "EXECUTABLE").length,
    requiresConfirmation: capabilities.filter((c) => c.availability === "REQUIRES_CONFIRMATION")
      .length,
    unavailable: capabilities.filter(
      (c) => !isUsable(c.availability) && c.availability !== "PLANNED"
    ).length,
    planned: capabilities.filter((c) => c.availability === "PLANNED").length,
  };
}
