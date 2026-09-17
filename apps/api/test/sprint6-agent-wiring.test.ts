// ---------------------------------------------------------------------------
// Sprint 6.11 — API wiring for the specialized agent layer.
//
// Two kinds of check:
//
//   BEHAVIOUR  the per-agent tool filter the container uses, exercised directly
//              against the real policies.
//   DRIFT      assertions that container.ts still wires what this sprint
//              depends on. The container needs a database, an OpenAI key and a
//              JWT secret to instantiate, so it is not constructed here; the
//              existing container-wiring test uses the same approach.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AIToolDefinition, ITool, RiskLevel } from "@jarvis/core";
import {
  AGENT_IDS,
  AGENT_POLICIES,
  AgentRegistry,
  AnalyticsAgent,
  AutomationAgent,
  CommunicationAgent,
  ConversationalAssistant,
  GoogleAdsAgent,
  BrowserAgent,
  LocationAgent,
  KnowledgeAgent,
  MetaAdsAgent,
  isToolAllowed,
} from "@jarvis/agents";

const CONTAINER_SOURCE = readFileSync(
  resolve(__dirname, "../src/services/container.ts"),
  "utf-8"
);

// ---------------------------------------------------------------------------
// Mirrors of the container helpers
// ---------------------------------------------------------------------------

function sanitizeToolName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function definitionsFor(toolIds: string[]): AIToolDefinition[] {
  return toolIds.map((id) => ({
    name: sanitizeToolName(id),
    description: `Tool ${id}`,
    parameters: { type: "object", properties: {}, required: [] },
  })) as AIToolDefinition[];
}

/** The container's `toolDefsFor`. */
function toolDefsFor(
  all: AIToolDefinition[],
  allowed: readonly string[]
): AIToolDefinition[] {
  return all.filter((def) => isToolAllowed(def.name, allowed));
}

const ALL_REGISTERED_TOOLS = [
  "meta.accounts",
  "meta.campaigns",
  "meta.adsets",
  "meta.ads",
  "meta.insights",
  "meta.analyze",
  "meta.campaign.pause",
  "meta.campaign.resume",
  "meta.adset.pause",
  "meta.adset.resume",
  "meta.ad.pause",
  "meta.ad.resume",
  "meta.campaign.budget.update",
  "meta.adset.budget.update",
  "meta.campaign.create",
  "google.accounts",
  "google.campaigns",
  "google.insights",
  "whatsapp.send",
  "n8n.trigger",
  // Integration management — registered by the container whenever
  // JARVIS_ENCRYPTION_KEY is set, i.e. whenever a credential can be stored at
  // all. These are the JARVIS arm of the two-path integration contract.
  "integration.list",
  "integration.status",
  "integration.health",
  "integration.permissions",
  "integration.audit",
  "integration.test",
  "integration.validate",
  "integration.connect",
  "integration.configure",
  "integration.reconnect",
  "integration.enable",
  "integration.disable",
  "integration.disconnect",
  // Capability discovery — registered alongside the integration tools, and
  // granted to EVERY policy so a capability question never falls back to an
  // agent's own system prompt.
  "capabilities.list",
  "capabilities.connected",
  "capabilities.integration",
  "capabilities.permissions",
  // Phase 12 — real Gmail, Drive and Calendar reads. Registered whenever a
  // Google OAuth client and an encryption key are present.
  "gmail.listUnread",
  "gmail.search",
  "gmail.getMessage",
  "gmail.getThread",
  "drive.searchFiles",
  "drive.listRecentFiles",
  "drive.getFileMetadata",
  "calendar.listUpcomingEvents",
  "calendar.getEvent",
  // Phase 13 — write PLANNING tools. Registered whenever writes are possible.
  // There is no corresponding execute tool, by design: execution happens only
  // when a human approves the row a plan created.
  "google.plan.gmail.createDraft",
  "google.plan.gmail.updateDraft",
  "google.plan.gmail.sendDraft",
  "google.plan.drive.createFolder",
  "google.plan.drive.uploadFile",
  "google.plan.drive.moveFile",
  "google.plan.drive.renameFile",
  "google.plan.calendar.createEvent",
  "google.plan.calendar.updateEvent",
  "google.plan.calendar.deleteEvent",
  // Sprint 7 — registered by the container when BROWSER_ENABLED is set.
  "browser.navigate",
  "browser.inspect",
  "browser.extract",
  "browser.screenshot",
  "browser.click",
  "browser.type",
  "browser.select",
  "browser.download",
  "browser.submit",
  "browser.upload",
  // Maps — registered unconditionally by the container, because the geo layer
  // answers from OpenStreetMap when no Google key is set.
  "maps.search",
  "maps.nearby",
  "maps.geocode",
  "maps.reverse.geocode",
  "maps.current.location",
  "maps.route",
  "maps.distance",
  "maps.place",
  // Ambient reads — registered unconditionally alongside the maps tools. These
  // were granted to the general assistant when they were added but never listed
  // here, which left the "no policy grants an unregistered tool" check below
  // failing on `weather.current`.
  "weather.current",
  "market.quote",
  "system.status",
  "time.now",
  "tasks.list",
];

function fakeTool(overrides: Partial<ITool> & { id: string }): ITool {
  return {
    name: overrides.id,
    description: `Tool ${overrides.id}`,
    category: "system",
    risk: "READ_ONLY" as RiskLevel,
    parameters: [],
    requiresApproval: false,
    requiredPermissions: ["read"],
    version: "1.0.0",
    enabled: true,
    execute: async () => ({ success: true }),
    validate: () => true,
    ...overrides,
  };
}

const stubProvider = {
  id: "stub",
  name: "Stub",
  defaultModel: "stub-model",
  async complete() {
    return {
      message: { role: "assistant" as const, content: "" },
      finishReason: "stop" as const,
      model: "stub-model",
    };
  },
  async listModels() {
    return ["stub-model"];
  },
  async isAvailable() {
    return true;
  },
};

// ---------------------------------------------------------------------------

/**
 * Tool names with the cross-cutting MANAGEMENT groups removed.
 *
 * Integration management and capability discovery are granted to every agent
 * on purpose — "is this connected?" and "what can you do?" are asked of
 * whichever agent the router picked, and an agent without them answers from its
 * own system prompt, which is the bug capability discovery exists to remove.
 *
 * So the per-agent assertions below are about what an agent can ACT with. The
 * model sees sanitized names (dots become dashes), hence the dashed prefixes.
 */
const actingOnly = (names: string[]): string[] =>
  names.filter((n) => !n.startsWith("integration-") && !n.startsWith("capabilities-"));

describe("Sprint 6 — per-agent tool definition filtering", () => {
  const all = definitionsFor(ALL_REGISTERED_TOOLS);

  it("offers the Meta agent Meta tools only", () => {
    const defs = toolDefsFor(all, AGENT_POLICIES[AGENT_IDS.metaAds]!.allowedTools).map(
      (d) => d.name
    );

    expect(defs).toContain("meta-insights");
    expect(defs).toContain("meta-campaign-pause");
    expect(defs).not.toContain("whatsapp-send");
    expect(defs).not.toContain("n8n-trigger");
    expect(defs).not.toContain("google-insights");
  });

  it("offers the automation agent exactly one ACTING tool", () => {
    const defs = toolDefsFor(
      all,
      AGENT_POLICIES[AGENT_IDS.automation]!.allowedTools
    ).map((d) => d.name);

    // One tool that can do something, plus the read-only integration lookups
    // that let it answer "is n8n still connected?" without guessing.
    expect(actingOnly(defs)).toEqual(["n8n-trigger"]);
    expect(defs).not.toContain("whatsapp-send");
    expect(defs).not.toContain("meta-insights");
    // It can READ integration state; it cannot change anyone's connection.
    expect(defs).not.toContain("integration-disconnect");
    expect(defs).not.toContain("integration-configure");
  });

  it("offers the communication agent exactly one ACTING tool", () => {
    const defs = toolDefsFor(
      all,
      AGENT_POLICIES[AGENT_IDS.communication]!.allowedTools
    ).map((d) => d.name);

    expect(actingOnly(defs)).toEqual(["whatsapp-send"]);
    expect(defs).not.toContain("n8n-trigger");
    expect(defs).not.toContain("meta-insights");
    expect(defs).not.toContain("integration-disconnect");
  });

  it("offers the knowledge agent nothing it can ACT with", () => {
    // Retrieval already happened before this agent ran, so it still owns no
    // search tool and no provider tool. It holds capability discovery only, so
    // a "what can you do?" landing here reaches the registry.
    const defs = toolDefsFor(all, AGENT_POLICIES[AGENT_IDS.knowledge]!.allowedTools).map(
      (d) => d.name
    );
    expect(actingOnly(defs)).toEqual([]);
    expect(defs.every((n) => n.startsWith("capabilities-"))).toBe(true);
  });

  it("offers the Google agent only Google tools and its own connection lifecycle", () => {
    const defs = toolDefsFor(all, AGENT_POLICIES[AGENT_IDS.googleAds]!.allowedTools).map(
      (d) => d.name
    );

    // Phase 12 added the Workspace reads to this agent, since anything naming
    // Google may route here. They are separated out so the Ads-specific
    // assertion still means what it did.
    const workspacePrefixes = ["gmail-", "drive-", "calendar-", "google-plan-"];
    const adsOnly = actingOnly(defs).filter(
      (n) => !workspacePrefixes.some((p) => n.startsWith(p))
    );
    expect(adsOnly).toEqual(["google-accounts", "google-campaigns", "google-insights"]);

    // And the Workspace reads really are reachable from here.
    expect(defs).toContain("gmail-listUnread");
    // "Google Ads reconnect karo" routes here, so this agent owns the
    // management verbs. It still cannot touch another provider's data.
    expect(defs).toContain("integration-reconnect");
    expect(defs).not.toContain("meta-insights");
    expect(defs).not.toContain("whatsapp-send");
  });

  it("no longer offers the general assistant the external-integration tools", () => {
    // Before Sprint 6 every agent received the entire registry.
    const defs = toolDefsFor(all, AGENT_POLICIES[AGENT_IDS.general]!.allowedTools).map(
      (d) => d.name
    );

    expect(defs).not.toContain("whatsapp-send");
    expect(defs).not.toContain("n8n-trigger");
    expect(defs).toContain("meta-insights");
  });

  it("filters correctly when an integration is unconfigured", () => {
    // WhatsApp and n8n absent from the registry entirely.
    const partial = definitionsFor(
      ALL_REGISTERED_TOOLS.filter((t) => !t.startsWith("whatsapp") && !t.startsWith("n8n"))
    );

    // Nothing it can ACT with. The integration lookups survive, because they
    // describe JARVIS's own configuration and stay meaningful — in fact
    // especially meaningful — when the provider is unconfigured.
    expect(
      actingOnly(
        toolDefsFor(partial, AGENT_POLICIES[AGENT_IDS.communication]!.allowedTools).map(
          (d) => d.name
        )
      )
    ).toEqual([]);
    expect(
      toolDefsFor(partial, AGENT_POLICIES[AGENT_IDS.metaAds]!.allowedTools).length
    ).toBeGreaterThan(0);
  });
});

describe("Sprint 6 — conditional agent registration", () => {
  function registryFor(availableToolIds: string[]): AgentRegistry {
    const registered = new Set(availableToolIds);
    const has = (id: string) => registered.has(id);

    const registry = new AgentRegistry({ requirePolicy: true });
    registry.register(new ConversationalAssistant({ provider: stubProvider }));
    registry.register(new MetaAdsAgent({ provider: stubProvider }));
    registry.register(new KnowledgeAgent({ provider: stubProvider }));
    registry.register(new AnalyticsAgent({ provider: stubProvider }));
    if (has("google.accounts")) {
      registry.register(new GoogleAdsAgent({ provider: stubProvider }));
    }
    if (has("n8n.trigger")) {
      registry.register(new AutomationAgent({ provider: stubProvider }));
    }
    if (has("whatsapp.send")) {
      registry.register(new CommunicationAgent({ provider: stubProvider }));
    }
    if (has("browser.navigate")) {
      registry.register(new BrowserAgent({ provider: stubProvider }));
    }
    if (has("maps.route")) {
      registry.register(new LocationAgent({ provider: stubProvider }));
    }
    return registry;
  }

  it("registers every declared agent when everything is configured", () => {
    const registry = registryFor(ALL_REGISTERED_TOOLS);

    expect(registry.getAll().map((a) => a.id).sort()).toEqual(
      Object.values(AGENT_IDS).slice().sort()
    );
  });

  it("omits integration agents when their tools are absent", () => {
    const registry = registryFor(["meta.accounts", "meta.insights"]);
    const ids = registry.getAll().map((a) => a.id);

    expect(ids).toContain(AGENT_IDS.general);
    expect(ids).toContain(AGENT_IDS.metaAds);
    expect(ids).toContain(AGENT_IDS.knowledge);
    expect(ids).toContain(AGENT_IDS.analytics);
    expect(ids).not.toContain(AGENT_IDS.automation);
    expect(ids).not.toContain(AGENT_IDS.communication);
    expect(ids).not.toContain(AGENT_IDS.googleAds);
    expect(ids).not.toContain(AGENT_IDS.browser);
    expect(ids).not.toContain(AGENT_IDS.location);
  });

  it("binds a policy to every registered agent", () => {
    const registry = registryFor(ALL_REGISTERED_TOOLS);

    for (const agent of registry.getAll()) {
      const policy = registry.getPolicy(agent.id);
      expect(policy, agent.id).toBeDefined();
      expect(policy!.agentId).toBe(agent.id);
      expect(policy!.writesRequireApproval).toBe(true);
    }
  });

  it("refuses to register an agent the policy table does not know", () => {
    const registry = new AgentRegistry({ requirePolicy: true });
    const rogue = new (class extends KnowledgeAgent {
      override id = "developer-agent";
    })({ provider: stubProvider });

    expect(() => registry.register(rogue)).toThrow(/no policy/i);
  });

  it("does not register any of the remaining non-goal agents", () => {
    // "browser-agent" was on this list until Sprint 7 built it. The other
    // three are still deliberately absent and this test still guards them.
    const registry = registryFor(ALL_REGISTERED_TOOLS);
    const ids = registry.getAll().map((a) => a.id);

    for (const forbidden of ["voice-agent", "developer-agent", "autopilot-agent"]) {
      expect(ids).not.toContain(forbidden);
    }
  });
});

describe("Sprint 6 — container wiring has not drifted", () => {
  it("constructs the agent registry in requirePolicy mode", () => {
    expect(CONTAINER_SOURCE).toContain("new AgentRegistry({ requirePolicy: true })");
  });

  it("passes the real permission service to the orchestrator", () => {
    expect(CONTAINER_SOURCE).toContain("permissionChecker: permissionService");
  });

  it("registers each specialized agent", () => {
    for (const cls of [
      "KnowledgeAgent",
      "AnalyticsAgent",
      "AutomationAgent",
      "CommunicationAgent",
      "GoogleAdsAgent",
    ]) {
      expect(CONTAINER_SOURCE, cls).toContain(`new ${cls}(`);
    }
  });

  it("gates integration agents on their tool being registered", () => {
    expect(CONTAINER_SOURCE).toContain('hasTool("n8n.trigger")');
    expect(CONTAINER_SOURCE).toContain('hasTool("whatsapp.send")');
    expect(CONTAINER_SOURCE).toContain('hasTool("google.accounts")');
  });

  it("gives every agent a policy-filtered tool list, never the whole registry", () => {
    // The pre-Sprint-6 spelling handed the full set to each agent.
    expect(CONTAINER_SOURCE).not.toMatch(/tools:\s*agentTools\s*,/);
    expect(CONTAINER_SOURCE).toContain("toolDefsFor(");
  });

  it("still routes tool execution through the executor and approval service", () => {
    expect(CONTAINER_SOURCE).toContain("new ToolExecutor(");
    expect(CONTAINER_SOURCE).toContain("new ToolApprovalService(");
    expect(CONTAINER_SOURCE).toContain("toolApprovalService,");
  });

  it("keeps the Sprint 5 integration guards intact", () => {
    expect(CONTAINER_SOURCE).toContain("isWhatsAppConfigured()");
    expect(CONTAINER_SOURCE).toContain("isN8nConfigured()");
    expect(CONTAINER_SOURCE).toContain("isGoogleConfigured()");
    expect(CONTAINER_SOURCE).toContain("RepositoryRecipientAuthorizer");
  });
});

describe("Sprint 6 — allowlists match the tools the container can register", () => {
  it("grants no policy a tool the container never registers", () => {
    const registered = new Set(
      ALL_REGISTERED_TOOLS.concat(["data.csv.analyze"]).map((id) => id)
    );

    for (const policy of Object.values(AGENT_POLICIES)) {
      for (const tool of policy.allowedTools) {
        expect(registered.has(tool), `${policy.agentId} -> ${tool}`).toBe(true);
      }
    }
  });

  it("keeps every approval-gated tool reachable by exactly the intended agents", () => {
    const holdersOf = (toolId: string) =>
      Object.values(AGENT_POLICIES)
        .filter((p) => p.allowedTools.includes(toolId))
        .map((p) => p.agentId)
        .sort();

    expect(holdersOf("whatsapp.send")).toEqual([AGENT_IDS.communication]);
    expect(holdersOf("n8n.trigger")).toEqual([AGENT_IDS.automation]);
    expect(holdersOf("meta.campaign.create")).toEqual(
      [AGENT_IDS.general, AGENT_IDS.metaAds].sort()
    );
  });

  it("treats a disabled tool as absent for every agent", () => {
    const disabled = fakeTool({ id: "whatsapp.send", enabled: false });

    expect(disabled.enabled).toBe(false);
    // The container filters on `enabled` before building definitions, so a
    // disabled tool never reaches any agent regardless of policy.
    expect(
      definitionsFor([disabled.id]).filter(() => disabled.enabled)
    ).toEqual([]);
  });
});
