// ---------------------------------------------------------------------------
// Capability discovery tools.
//
// These exist so "What can you do?" is answered by the SYSTEM rather than by a
// system prompt. The prompt used to claim a single provider's feature list; it
// could not know what was registered, connected or permitted, and on a server
// with no Google OAuth client it happily listed Gmail actions.
//
// `capabilities.list` is the tool the general assistant is instructed to call
// for any capability question. Its answer is derived from the live tool
// registry, the agent policies and the per-user integration state, so it is
// correct by construction on every deployment — including one where nothing is
// connected at all.
//
// NO CAPABILITY LOGIC LIVES HERE. As with the integration tools, these are
// translations: a question becomes a port call, and the port is implemented in
// the API over the one CapabilityService. A tool that assembled its own list
// would be a second answer that could disagree with the first.
//
// EVERYTHING IS READ_ONLY. Asking what you can do changes nothing, and nothing
// here can execute a capability it describes.
// ---------------------------------------------------------------------------

import { BaseTool } from "../base-tool.js";
import type { ToolContext, ToolResult } from "@jarvis/core";
import {
  buildCapabilityBriefing,
  resolveIntegrationAlias,
  type CapabilityReport,
  type IntegrationCapabilityView,
  type PermissionReport,
} from "@jarvis/core";

/**
 * The seam to CapabilityService.
 *
 * Four reads, no writes. The API implements it over the same service instance
 * the REST route uses, so a spoken question and a rendered page cannot report
 * different capabilities.
 */
export interface CapabilityPort {
  report(userId: string): Promise<CapabilityReport>;
  forIntegration(userId: string, integrationId: string): Promise<IntegrationCapabilityView | null>;
  connectedIntegrations(userId: string): Promise<IntegrationCapabilityView[]>;
  permissions(userId: string): Promise<PermissionReport>;
}

/**
 * Compresses a report into something a model can relay without inventing.
 *
 * WHAT CHANGED, AND WHY. This used to return four flat arrays of
 * `{id, label, group}`. The separation was right — executable and unavailable
 * have to stay apart or a model flattens them back into "here is what I can
 * do" — but a flat array of 34 ids is a registry listing, and the model read it
 * out as one: technical buckets, raw tool ids, no examples, no sense of what
 * any of it was FOR.
 *
 * So the honest separation is kept and the SHAPE is changed. `buildCapabilityBriefing`
 * regroups the same derived truth by user goal and phrases it as requests; the
 * counts still travel so nothing is overstated. No tool id reaches the model at
 * all now, which removes the possibility of one being read aloud.
 */
function summariseReport(report: CapabilityReport) {
  const briefing = buildCapabilityBriefing(report);

  return {
    // The natural opening, already reflecting what is really connected.
    intro: briefing.intro,

    // Four to six user-oriented groups. Each carries its own phrasing, so the
    // model composes rather than enumerates.
    whatICanDo: briefing.groups.map((g) => ({
      area: g.title,
      summary: g.summary,
      youCanAsk: g.youCanAsk,
      ...(g.approvalCount > 0 ? { someNeedApproval: true } : {}),
    })),

    // Things the user can say verbatim, every one backed by a usable tool.
    tryAsking: briefing.examples,

    // The approval boundary, in one sentence. Null when nothing is gated.
    howApprovalWorks: briefing.approvalNote,

    // Kept SEPARATE from everything above — this is the distinction that must
    // never collapse.
    notAvailableYet: briefing.unavailable,
    plannedNotBuilt: briefing.planned,

    counts: briefing.counts,
  };
}

/**
 * The answer to every generic capability question.
 *
 * Registered under the id `capabilities.list` and exposed to models as
 * `get_available_capabilities`, which is the name the system prompt names.
 */
export class GetAvailableCapabilitiesTool extends BaseTool {
  constructor(private readonly port: CapabilityPort) {
    super(
      "capabilities.list",
      "Get available capabilities",
      [
        "Reports what JARVIS can ACTUALLY do right now, derived from the live tool registry and the user's real integration connection state.",
        "USE THIS for every generic capability question — 'what can you do', 'tum kya kar sakte ho', 'available tools batao', 'what are your features', 'mere available tools batao'.",
        "Returns a ready-to-speak briefing: an intro, user-oriented capability areas each with natural phrasings, example commands, how approval works, and separate notAvailableYet / plannedNotBuilt lists.",
        "NEVER answer a capability question from memory or from your own prompt: only this tool knows what is registered and connected on this deployment.",
        "Relay it as flowing prose grouped by area. Do NOT enumerate every item, do NOT print counts, and do NOT invent anything the briefing does not contain.",
        "Do NOT describe anything in 'notAvailableYet' or 'plannedNotBuilt' as something you can do.",
      ].join(" "),
      "system",
      [],
      false,
      ["read"],
      "READ_ONLY"
    );
  }

  async execute(_params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const report = await this.port.report(context.userId);
    const data = summariseReport(report);

    // Phase — structured capability log. Counts and group ids only: no tool
    // id, no account, no credential, nothing about WHAT the user asked. Enough
    // to answer "did capability intent fire, and how much did it find" from the
    // log alone, which is the question that gets asked when an answer looks
    // wrong.
    console.log(
      JSON.stringify({
        level: "info",
        event: "capability_request",
        conversationId: context.conversationId ?? null,
        traceId: context.traceId ?? null,
        capabilityIntentDetected: true,
        capabilityGroupsGenerated: data.counts.groupsShown,
        liveCapabilitiesCount: data.counts.usable,
        approvalRequiredCount: data.counts.needsApproval,
        unavailableCount: data.counts.unavailable,
      })
    );

    return this.success(data, {
      // The opening line, not a count. A headline reading "34 capabilities are
      // ready" invited the enumeration this whole change removes.
      message: data.intro,
      // Restated in metadata because it is the instruction most easily lost
      // between a tool result and a rendered answer.
      rule: "Answer in natural prose grouped by area, using 'youCanAsk' phrasings and a few 'tryAsking' examples. Never list tool names, ids or counts. Report notAvailableYet and plannedNotBuilt with their reasons, never as available.",
    });
  }
}

/** "Sirf connected integrations dikhao." */
export class GetConnectedIntegrationsTool extends BaseTool {
  constructor(private readonly port: CapabilityPort) {
    super(
      "capabilities.connected",
      "List connected integrations",
      [
        "Lists ONLY the integrations whose real connection state is connected, with their health, enabled services, executable actions and unavailable actions.",
        "USE THIS for 'sirf connected integrations dikhao', 'which integrations are connected', 'what is connected'.",
        "An integration absent from this list is NOT connected. Do not add any integration to the answer that this tool did not return.",
        "Connection state is the provider-level fact, not merely whether configuration exists.",
      ].join(" "),
      "system",
      [],
      false,
      ["read"],
      "READ_ONLY"
    );
  }

  async execute(_params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const connected = await this.port.connectedIntegrations(context.userId);

    return this.success(
      {
        connected: connected.map((i) => ({
          name: i.name,
          integration: i.integration,
          connection: i.connection,
          health: i.health,
          account: i.account,
          enabledServices: i.enabledServices,
          executableActions: i.executable.map((c) => c.label),
          unavailableActions: i.unavailable.map((c) => ({
            label: c.label,
            status: c.availability,
            reason: c.reason,
          })),
        })),
        count: connected.length,
      },
      {
        message:
          connected.length === 0
            ? "No integrations are connected. Nothing is available until one is connected."
            : `${connected.length} integration(s) connected: ${connected.map((i) => i.name).join(", ")}.`,
        rule: "Only these are connected. Do not list any others as connected.",
      }
    );
  }
}

/** "Gmail ke saath kya kar sakte ho?" — one integration, honestly. */
export class GetIntegrationCapabilitiesTool extends BaseTool {
  constructor(private readonly port: CapabilityPort) {
    super(
      "capabilities.integration",
      "Get capabilities for one integration",
      [
        "Reports what can and cannot be done with ONE named integration right now, with the reason and required action for anything unavailable.",
        "USE THIS for 'Gmail ke saath kya kar sakte ho', 'what can you do with Drive', 'Maps se kya kar sakte ho'.",
        "Accepts a common name: gmail, drive, calendar, youtube, sheets, docs and adwords all resolve to the Google integration; maps resolves to Google Maps.",
        "If the integration is not connected, say so and give the required action. Do NOT describe its actions as available.",
      ].join(" "),
      "system",
      [
        {
          name: "integration",
          type: "string",
          description:
            "Integration or service name — e.g. google, gmail, drive, youtube, google-maps, meta, whatsapp, n8n.",
          required: true,
        },
      ],
      false,
      ["read"],
      "READ_ONLY"
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const raw = typeof params.integration === "string" ? params.integration : "";
    const resolved = resolveIntegrationAlias(raw);

    if (!resolved) {
      // A question, not a guess. Naming the wrong integration here would answer
      // confidently about something the user did not ask about.
      return this.failure(
        `I do not manage an integration called "${raw.slice(0, 60)}". I manage: google (Ads, Gmail, Drive, Calendar, YouTube, Sheets, Docs), google-maps, meta, whatsapp, n8n.`
      );
    }

    const view = await this.port.forIntegration(context.userId, resolved);
    if (!view) {
      return this.failure(`No capability information is available for ${resolved}.`);
    }

    const usable = view.executable.length > 0;

    return this.success(
      {
        integration: view.integration,
        name: view.name,
        connection: view.connection,
        health: view.health,
        account: view.account,
        enabledServices: view.enabledServices,
        executableActions: view.executable.map((c) => ({ label: c.label, access: c.access })),
        unavailableActions: view.unavailable.map((c) => ({
          label: c.label,
          status: c.availability,
          reason: c.reason,
          requiredAction: c.requiredAction,
        })),
        blockedReason: view.blockedReason,
        requiredAction: view.requiredAction,
      },
      {
        message: usable
          ? `${view.name} is ${view.connection} (health ${view.health}). ${view.executable.length} action(s) available.`
          : `${view.name} is ${view.connection}. Nothing can run yet. ${view.requiredAction ?? view.blockedReason ?? ""}`.trim(),
        rule: usable
          ? "Only executableActions can be run. Everything in unavailableActions needs its requiredAction first."
          : "Nothing here is currently executable. State the required action; do not describe these actions as available.",
      }
    );
  }
}

/** "Mere available tools aur permissions batao." */
export class GetPermissionsOverviewTool extends BaseTool {
  constructor(private readonly port: CapabilityPort) {
    super(
      "capabilities.permissions",
      "Get permissions overview",
      [
        "Reports every permission across all integrations, keeping REGISTERED (this build can request it) separate from GRANTED (the provider has actually given it).",
        "USE THIS for 'mere permissions batao', 'what permissions do you have', 'kaunse permissions active hain'.",
        "A permission on a disconnected integration is NEVER granted — report it as missing with its reason, and say that connecting comes first.",
        "Write permissions are approval-gated: exercising one always stops for explicit confirmation.",
      ].join(" "),
      "system",
      [],
      false,
      ["read"],
      "READ_ONLY"
    );
  }

  async execute(_params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const report = await this.port.permissions(context.userId);

    const granted = report.permissions.filter((p) => p.granted);
    const missing = report.permissions.filter((p) => !p.granted);

    return this.success(
      {
        granted: granted.map((p) => ({
          label: p.label,
          integration: p.integration,
          access: p.access,
          requiresConfirmation: p.requiresConfirmation,
        })),
        missing: missing.map((p) => ({
          label: p.label,
          integration: p.integration,
          access: p.access,
          reason: p.reason,
        })),
        grantedCount: report.grantedCount,
        missingCount: report.missingCount,
      },
      {
        message:
          granted.length === 0
            ? "No permissions are currently granted — nothing is connected."
            : `${report.grantedCount} permission(s) granted, ${report.missingCount} not granted.`,
        rule: "Only 'granted' entries are active. 'missing' entries are not granted, whatever integration they belong to.",
      }
    );
  }
}

// ---------------------------------------------------------------------------

export function createCapabilityTools(port: CapabilityPort): BaseTool[] {
  return [
    new GetAvailableCapabilitiesTool(port),
    new GetConnectedIntegrationsTool(port),
    new GetIntegrationCapabilitiesTool(port),
    new GetPermissionsOverviewTool(port),
  ];
}

export const CAPABILITY_TOOL_IDS = [
  "capabilities.list",
  "capabilities.connected",
  "capabilities.integration",
  "capabilities.permissions",
] as const;
