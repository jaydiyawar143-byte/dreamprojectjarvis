// ---------------------------------------------------------------------------
// Capability metadata: how a registry tool id becomes something a person reads.
//
// THIS IS NOT A FEATURE LIST. The set of capabilities is whatever is registered
// in the running process; this file only supplies the human-facing label, the
// grouping and the gating integration for ids it recognises. A tool with no
// entry here still appears — grouped by its id prefix and labelled from its own
// description — because the failure being fixed was a hand-written list that
// disagreed with reality, and a lookup table that must be edited for a new tool
// to be visible would reproduce exactly that.
//
// The one thing genuinely declared here is PLANNED capability: a Google service
// with no provider client yet. That cannot be derived from the registry,
// because the whole point is that nothing is registered for it — and leaving it
// out entirely would be its own lie, since the OAuth foundation really does
// exist and the user really can connect it.
// ---------------------------------------------------------------------------

import type { CapabilityGroup } from "./types/capability.js";
import { GOOGLE_SERVICES } from "./integration-catalog.js";

export interface CapabilityMetadata {
  label: string;
  description: string;
  group: CapabilityGroup;
  /** The integration whose connection gates it, or null when nothing does. */
  integration: string | null;
  /** The Google sub-service whose granted scope additionally gates it. */
  googleService?: "gmail" | "drive" | "calendar" | "ads";
}

/**
 * Prefix → grouping and gating integration.
 *
 * Ordered longest-first at lookup time so `integration.` cannot be shadowed by
 * a shorter prefix. Everything in the repository's tool namespace is covered;
 * an unrecognised prefix falls through to `system` with no gate, which is the
 * conservative reading — ungated and unremarkable rather than falsely
 * attributed to a provider.
 */
const PREFIX_RULES: Array<{
  prefix: string;
  group: CapabilityGroup;
  integration: string | null;
  /**
   * The Google SUB-SERVICE whose scope gates this capability.
   *
   * Needed because "Google is connected" is not "Gmail is authorized": a user
   * can connect Google for Ads alone, and Gmail reads would then 403. The
   * capability report has to gate on the granted scope for the specific
   * service, not on the integration as a whole.
   */
  googleService?: "gmail" | "drive" | "calendar" | "ads";
}> = [
  { prefix: "integration.", group: "system", integration: null },
  // Phase 13 — write PLANNING. Longest prefix, so it is matched before the
  // bare `gmail.`/`drive.`/`calendar.` read rules below. Each is gated on the
  // same sub-service scope as its read counterpart, because a plan that
  // cannot be executed is not a capability.
  { prefix: "google.plan.gmail.", group: "google", integration: "google", googleService: "gmail" },
  { prefix: "google.plan.drive.", group: "google", integration: "google", googleService: "drive" },
  { prefix: "google.plan.calendar.", group: "google", integration: "google", googleService: "calendar" },
  // Phase 12 — real Workspace reads, each gated on its own granted scope.
  { prefix: "gmail.", group: "google", integration: "google", googleService: "gmail" },
  { prefix: "drive.", group: "google", integration: "google", googleService: "drive" },
  { prefix: "calendar.", group: "google", integration: "google", googleService: "calendar" },
  { prefix: "meta.", group: "advertising", integration: "meta" },
  { prefix: "google.", group: "google", integration: "google", googleService: "ads" },
  { prefix: "maps.", group: "maps", integration: "google-maps" },
  { prefix: "whatsapp.", group: "communication", integration: "whatsapp" },
  { prefix: "n8n.", group: "automation", integration: "n8n" },
  { prefix: "browser.", group: "browser", integration: null },
  { prefix: "knowledge.", group: "knowledge", integration: null },
  { prefix: "data.", group: "system", integration: null },
  { prefix: "weather.", group: "ambient", integration: null },
  { prefix: "market.", group: "ambient", integration: null },
  { prefix: "system.", group: "ambient", integration: null },
  { prefix: "time.", group: "ambient", integration: null },
  { prefix: "tasks.", group: "ambient", integration: null },
  { prefix: "pdf.", group: "system", integration: null },
  { prefix: "document.", group: "knowledge", integration: null },
  { prefix: "web.", group: "browser", integration: null },
];

/** Human labels for ids worth wording better than their raw description. */
const LABEL_OVERRIDES: Record<string, string> = {
  "meta.accounts": "List Meta ad accounts",
  "meta.campaigns": "List Meta campaigns",
  "meta.adsets": "List Meta ad sets",
  "meta.ads": "List Meta ads",
  "meta.insights": "Read Meta performance insights",
  "google.accounts": "List Google Ads accounts",
  "google.campaigns": "List Google Ads campaigns",
  "google.insights": "Read Google Ads insights",
  "maps.search": "Search places",
  "maps.nearby": "Find places near a location",
  "maps.geocode": "Resolve an address to coordinates",
  "maps.reverse.geocode": "Resolve coordinates to an address",
  "maps.current.location": "Read your current location",
  "maps.route": "Compute a route",
  "maps.distance": "Distance and travel time",
  "maps.place": "Look up place details",
  "whatsapp.send": "Send a WhatsApp message",
  "n8n.trigger": "Trigger an n8n workflow",
  "weather.current": "Current weather",
  "market.quote": "Market and crypto prices",
  "system.status": "This machine's telemetry",
  "time.now": "Current date and time",
  "tasks.list": "List your tasks",
  "data.csv.analyze": "Analyse a CSV file",
  // Integration management. These were the ids that leaked verbatim into
  // "What can you do?" — every one of them fell through to `?? toolId`, so the
  // answer literally read "integration.list, integration.status, …". They are
  // real, ungated capabilities and always registered, so the fix is to give
  // them the label they never had rather than to hide them.
  "integration.list": "See what is connected",
  "integration.status": "Check one integration's status",
  "integration.health": "Run an integration health check",
  "integration.permissions": "Review granted permissions",
  "integration.audit": "Read the integration audit trail",
  "integration.test": "Test an integration connection",
  "integration.validate": "Validate integration credentials",
  "integration.connect": "Connect an account",
  "integration.configure": "Configure an integration",
  "integration.reconnect": "Reconnect an expired integration",
  "integration.enable": "Switch an integration on",
  "integration.disable": "Switch an integration off",
  "integration.disconnect": "Disconnect an account",
  // Capability discovery itself.
  "capabilities.list": "Report what I can currently do",
  "capabilities.connected": "List connected integrations",
  "capabilities.integration": "Describe one integration's capabilities",
  "capabilities.permissions": "Summarise permissions",
  // Phase 12
  "gmail.listUnread": "List unread Gmail",
  "gmail.search": "Search Gmail",
  "gmail.getMessage": "Read a Gmail message",
  "gmail.getThread": "Read a Gmail thread",
  "drive.searchFiles": "Search Google Drive",
  "drive.listRecentFiles": "List recent Drive files",
  "drive.getFileMetadata": "Get Drive file details",
  "calendar.listUpcomingEvents": "List upcoming calendar events",
  "calendar.getEvent": "Get calendar event details",
  // Phase 13 — every label says PREPARE or REQUEST, never the bare verb. A
  // capability list reading "Send an email" would imply JARVIS can send one on
  // request; it cannot, and the label is where that is first communicated.
  "google.plan.gmail.createDraft": "Prepare a Gmail draft (needs approval)",
  "google.plan.gmail.updateDraft": "Prepare a draft update (needs approval)",
  "google.plan.gmail.sendDraft": "Request approval to send an email",
  "google.plan.drive.createFolder": "Prepare a new Drive folder (needs approval)",
  "google.plan.drive.uploadFile": "Prepare a Drive upload (needs approval)",
  "google.plan.drive.moveFile": "Request approval to move a Drive file",
  "google.plan.drive.renameFile": "Request approval to rename a Drive file",
  "google.plan.calendar.createEvent": "Prepare a calendar event (needs approval)",
  "google.plan.calendar.updateEvent": "Prepare an event change (needs approval)",
  "google.plan.calendar.deleteEvent": "Request approval to delete an event",
};

export function groupForToolId(toolId: string): {
  group: CapabilityGroup;
  integration: string | null;
  googleService?: "gmail" | "drive" | "calendar" | "ads";
} {
  const match = [...PREFIX_RULES]
    .sort((a, b) => b.prefix.length - a.prefix.length)
    .find((rule) => toolId.startsWith(rule.prefix));

  if (!match) return { group: "system", integration: null };

  return {
    group: match.group,
    integration: match.integration,
    ...(match.googleService ? { googleService: match.googleService } : {}),
  };
}

/**
 * Metadata for one registered tool.
 *
 * `description` falls back to the tool's OWN description, which is why a new
 * tool needs no edit here to be discoverable — it just reads slightly more
 * technically until someone writes a friendlier label.
 */
export function describeCapability(
  toolId: string,
  toolDescription: string
): CapabilityMetadata {
  const { group, integration, googleService } = groupForToolId(toolId);
  return {
    ...(googleService ? { googleService } : {}),
    label: LABEL_OVERRIDES[toolId] ?? toolId,
    // Bounded: a tool description is authored in this repo, but the capability
    // report is shown to users and read by a model, and neither benefits from
    // three paragraphs.
    description: toolDescription.slice(0, 240),
    group,
    integration,
  };
}

// ---------------------------------------------------------------------------
// Planned capability
// ---------------------------------------------------------------------------

export interface PlannedCapability {
  id: string;
  label: string;
  description: string;
  group: CapabilityGroup;
  integration: string;
  access: "read" | "write";
}

/**
 * Google services whose OAuth foundation exists but whose provider client does
 * not. Derived from `GOOGLE_SERVICES[].implemented`, so marking a service
 * implemented in one place removes it from here automatically.
 *
 * Reported as PLANNED rather than omitted, because the user CAN connect these
 * and will reasonably ask what happens next; and reported as planned rather
 * than available, because JARVIS cannot actually read their mail.
 */
export function plannedCapabilities(): PlannedCapability[] {
  return GOOGLE_SERVICES.filter((service) => !service.implemented).map((service) => ({
    id: `google.${service.id}`,
    label: `${service.label} (planned)`,
    description: `${service.description} The OAuth scope model exists and the account can be connected, but this build has no ${service.label} client yet, so no action can run.`,
    group: "google" as CapabilityGroup,
    integration: "google",
    access: "read" as const,
  }));
}
