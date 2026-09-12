// ---------------------------------------------------------------------------
// The capability contract.
//
// WHAT PROBLEM THIS SOLVES. "What can you do?" was answered by whatever the
// fallback agent's system prompt happened to claim — which named one provider,
// so the answer was that provider's feature list regardless of what was
// actually registered, connected or permitted. A prompt cannot know any of
// those things; only the running system can.
//
// So capability is DERIVED, never described. The registry reads:
//
//   the tool registry        -> is a tool actually registered?
//   the agent policy         -> is any agent allowed to call it?
//   the integration state    -> is the provider connected, for THIS user?
//   the granted permissions  -> is the scope actually granted?
//   the tool's own risk       -> does running it need confirmation?
//
// and reports one state per capability. Nothing here is a hand-written list of
// features, because a hand-written list is exactly what was wrong.
//
// TWO AXES, KEPT APART. "Does this capability exist in the build?" and "can it
// run right now, for you?" are different questions. Collapsing them is what
// produced a Gmail feature list on a deployment with no Google OAuth client:
// the capability is real, the execution is impossible, and a useful answer says
// both.
// ---------------------------------------------------------------------------

/**
 * Whether a capability can actually run right now.
 *
 * Ordered from most to least usable. A caller rendering a list can sort on this
 * and get the useful things first without a second lookup table.
 */
export type CapabilityAvailability =
  /** Registered, connected, permitted. Runs on request. */
  | "EXECUTABLE"
  /**
   * Runs, but changes something outside JARVIS, so it stops for an explicit
   * confirmation first and can never be authorised by voice alone.
   */
  | "REQUIRES_CONFIRMATION"
  /** The capability and its tool exist; the provider is not connected. */
  | "NOT_CONNECTED"
  /** Connected, but the provider has not granted the scope this needs. */
  | "PERMISSION_MISSING"
  /** The server lacks the configuration to offer it at all (env vars absent). */
  | "NOT_CONFIGURED"
  /** Connected once, but the provider has since refused the authorization. */
  | "NEEDS_REAUTH"
  /** The user switched the integration off. Credentials are kept. */
  | "DISABLED"
  /**
   * Declared in the catalogue, but this build has no tool implementing it.
   * Reported so a roadmap item is never mistaken for a working feature.
   */
  | "PLANNED";

/** Availability values that mean "you can ask for this now". */
export const USABLE_AVAILABILITY: readonly CapabilityAvailability[] = [
  "EXECUTABLE",
  "REQUIRES_CONFIRMATION",
];

export function isUsable(availability: CapabilityAvailability): boolean {
  return USABLE_AVAILABILITY.includes(availability);
}

/** Coarse grouping for presentation. Mirrors the integration categories. */
export type CapabilityGroup =
  | "google"
  | "maps"
  | "advertising"
  | "communication"
  | "automation"
  | "knowledge"
  | "browser"
  | "ambient"
  | "system";

/**
 * One capability, as reported to a user or a model.
 *
 * Deliberately carries no credential, no account id and no scope secret. The
 * `account` field is a MASKED display string produced by `maskIdentifier`, so
 * even a future edit that forwards it cannot reproduce a full identifier.
 */
export interface CapabilityView {
  /** Stable id. The registry tool id where one exists. */
  id: string;
  label: string;
  /** One sentence, plain English, describing what it does. */
  description: string;
  group: CapabilityGroup;
  /** Which integration gates it, when one does. */
  integration: string | null;

  // --- the two axes, kept separate -----------------------------------------

  /** Is a tool for this actually registered in the running process? */
  registered: boolean;
  /** Can it run right now, for this user? */
  availability: CapabilityAvailability;

  /** Reads cannot change anything; writes are confirmation- and approval-gated. */
  access: "read" | "write";

  /**
   * Why it is not usable, in plain English. Null when it IS usable.
   * Never contains provider internals or credential material.
   */
  reason: string | null;
  /**
   * What the user must do to make it usable, when anything can be done.
   * e.g. "Connect your Google account", "Set GOOGLE_MAPS_SERVER_KEY".
   */
  requiredAction: string | null;
}

/**
 * Summary counts, so a caller can lead with the headline rather than compute it.
 */
export interface CapabilitySummary {
  total: number;
  executable: number;
  requiresConfirmation: number;
  unavailable: number;
  planned: number;
}

/**
 * One integration's capability block, with its real connection facts attached.
 *
 * This is the shape that answers "Sirf connected integrations dikhao" and
 * "Gmail ke saath kya kar sakte ho?" without the caller having to join two
 * different reports.
 */
export interface IntegrationCapabilityView {
  integration: string;
  name: string;
  group: CapabilityGroup;

  /** REAL state, from the integration command service — not "config exists". */
  connection: string;
  health: string;
  /** Masked. Never a full account id or email. */
  account: string | null;
  enabledServices: string[];

  /** Capabilities that can run now. */
  executable: CapabilityView[];
  /** Capabilities that cannot, each carrying its reason. */
  unavailable: CapabilityView[];

  /** Null when nothing blocks this integration. */
  blockedReason: string | null;
  requiredAction: string | null;
}

/**
 * A permission as reported by capability discovery.
 *
 * `registered` and `granted` are separate on purpose: a permission this build
 * knows how to ask for is not a permission the provider has given. Reporting
 * the former as the latter is how a disconnected Google came to look as though
 * it had granted Gmail access.
 */
export interface PermissionView {
  id: string;
  label: string;
  integration: string;
  /** This build knows about, and can request, this permission. */
  registered: boolean;
  /** The provider has actually granted it. */
  granted: boolean;
  access: "read" | "write";
  /** True when exercising it stops for a confirmation. */
  requiresConfirmation: boolean;
  /** Why it is not granted. Null when it is. */
  reason: string | null;
}

/** The complete report. What `capabilities.list` returns. */
export interface CapabilityReport {
  summary: CapabilitySummary;
  /** Every capability, flat, sorted most-usable first. */
  capabilities: CapabilityView[];
  /** The same capabilities grouped by integration, with connection facts. */
  integrations: IntegrationCapabilityView[];
  /** Capabilities with no integration behind them — ambient, knowledge, system. */
  general: CapabilityView[];
}

export interface PermissionReport {
  permissions: PermissionView[];
  grantedCount: number;
  missingCount: number;
  writeCount: number;
}
