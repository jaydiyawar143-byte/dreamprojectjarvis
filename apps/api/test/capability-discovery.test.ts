// ---------------------------------------------------------------------------
// Capability discovery.
//
// THE REGRESSION THIS FILE EXISTS FOR. "What can you do?" used to be answered
// by the fallback agent's system prompt, which opened with "you have direct
// access to the user's Meta Ads account". Because that agent is the routing
// fallback, every capability question returned a Meta-Ads-only feature list on
// every deployment — and it listed Gmail actions on servers with no Google
// OAuth client, because a prompt cannot know that.
//
// So the load-bearing assertion here is negative: a generic capability question
// CANNOT come back Meta-only while other capabilities are registered. It is
// asserted structurally — against the derived report — rather than by matching
// prose, because prose is what was wrong.
//
// The rest pins the state machine: registered is not connected, connected is
// not permitted, permitted is not unconditional, and planned is none of them.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import type { ITool, IntegrationView, RiskLevel } from "@jarvis/core";
import { maskIdentifier, maskEmail, maskIdentifiersInText } from "@jarvis/core";
import {
  CapabilityService,
  type IntegrationStateReader,
} from "../src/services/capabilities/capability-service.js";

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

function tool(id: string, risk: RiskLevel = "READ_ONLY"): ITool {
  return {
    id,
    name: id,
    description: `Tool ${id}`,
    category: "system",
    risk,
    parameters: [],
    requiresApproval: risk !== "READ_ONLY",
    requiredPermissions: ["read"],
    version: "1.0.0",
    enabled: true,
    execute: async () => ({ success: true }),
    validate: () => true,
  } as unknown as ITool;
}

/** A realistic integration view. Defaults to the disconnected case. */
function integration(over: Partial<IntegrationView> & { id: string }): IntegrationView {
  return {
    name: over.id,
    subtitle: "",
    category: "advertising",
    configKind: "form",
    connection: "NOT_CONNECTED",
    health: "NOT_CONNECTED",
    detail: "Nothing configured.",
    account: null,
    config: [],
    configComplete: false,
    missingConfig: [],
    permissions: [],
    actions: [],
    enabledServices: [],
    usage: null,
    lastTestedAt: null,
    lastSuccessfulSyncAt: null,
    lastError: null,
    effectiveSource: "none",
    supportedCommands: [],
    ...over,
  } as IntegrationView;
}

/** Every integration disconnected — a fresh deployment with no OAuth client. */
const NOTHING_CONNECTED: IntegrationView[] = [
  integration({
    id: "google",
    name: "Google",
    category: "google",
    configKind: "oauth",
    detail: "No Google OAuth client is configured on the server.",
    permissions: [],
  }),
  integration({ id: "google-maps", name: "Google Maps", category: "maps", configKind: "server-managed" }),
  integration({ id: "meta", name: "Meta Ads" }),
  integration({ id: "whatsapp", name: "WhatsApp Business", category: "communication", configKind: "server-managed" }),
  integration({ id: "n8n", name: "n8n Automations", category: "automation", configKind: "server-managed" }),
];

function serviceWith(tools: ITool[], integrations: IntegrationView[]) {
  const reader: IntegrationStateReader = {
    listIntegrations: async () => integrations,
  };
  return new CapabilityService({
    toolRegistry: { getAll: () => tools },
    integrations: reader,
    allowedToolIds: new Set(tools.map((t) => t.id)),
  });
}

/** The tool set a real deployment registers. Spans several domains. */
const REGISTERED = [
  tool("meta.accounts"),
  tool("meta.campaigns"),
  tool("meta.insights"),
  tool("meta.campaign.budget.update", "FINANCIAL"),
  tool("google.accounts"),
  tool("maps.geocode"),
  tool("maps.route"),
  tool("weather.current"),
  tool("market.quote"),
  tool("time.now"),
  tool("data.csv.analyze"),
  tool("integration.list"),
  tool("integration.status"),
  tool("capabilities.list"),
];

// ---------------------------------------------------------------------------

describe("a generic capability question is never Meta-only", () => {
  it("reports capabilities from several groups, not just advertising", async () => {
    // THE regression assertion. With nothing connected at all — the exact state
    // that used to produce a confident Meta Ads feature list — the report must
    // still span the other registered domains.
    const service = serviceWith(REGISTERED, NOTHING_CONNECTED);
    const report = await service.report("u1");

    const groups = new Set(report.capabilities.map((c) => c.group));
    expect(groups.size).toBeGreaterThan(1);
    expect(groups).toContain("ambient");
    expect(groups).toContain("maps");
    expect(groups).toContain("system");
  });

  it("does not let advertising dominate what is actually executable", async () => {
    const service = serviceWith(REGISTERED, NOTHING_CONNECTED);
    const report = await service.report("u1");

    const executable = report.capabilities.filter((c) => c.availability === "EXECUTABLE");
    expect(executable.length).toBeGreaterThan(0);

    // Nothing is connected, so NO advertising capability may be executable —
    // which is the precise opposite of the old behaviour.
    expect(executable.every((c) => c.group !== "advertising")).toBe(true);
  });

  it("still reports ungated capabilities when every integration is disconnected", async () => {
    // Weather, time and CSV analysis need no provider connection. An answer of
    // "I can do nothing" would be as wrong as a Meta-only answer.
    const service = serviceWith(REGISTERED, NOTHING_CONNECTED);
    const report = await service.report("u1");

    const ids = report.capabilities
      .filter((c) => c.availability === "EXECUTABLE")
      .map((c) => c.id);

    expect(ids).toContain("weather.current");
    expect(ids).toContain("time.now");
    expect(ids).toContain("data.csv.analyze");
  });

  it("omits a registered tool that no agent policy grants", async () => {
    // Unreachable by any conversation, so promising it would be a lie.
    const reader: IntegrationStateReader = { listIntegrations: async () => NOTHING_CONNECTED };
    const service = new CapabilityService({
      toolRegistry: { getAll: () => [tool("weather.current"), tool("secret.backdoor")] },
      integrations: reader,
      allowedToolIds: new Set(["weather.current"]),
    });

    const report = await service.report("u1");
    expect(report.capabilities.map((c) => c.id)).toContain("weather.current");
    expect(report.capabilities.map((c) => c.id)).not.toContain("secret.backdoor");
  });
});

// ---------------------------------------------------------------------------

describe("availability is separate from capability", () => {
  it("reports a registered-but-disconnected capability as NOT_CONNECTED with a remedy", async () => {
    const service = serviceWith(REGISTERED, NOTHING_CONNECTED);
    const report = await service.report("u1");

    const metaInsights = report.capabilities.find((c) => c.id === "meta.insights")!;
    expect(metaInsights.registered).toBe(true);
    expect(metaInsights.availability).toBe("NOT_CONNECTED");
    expect(metaInsights.reason).toBeTruthy();
    expect(metaInsights.requiredAction).toBeTruthy();
  });

  it("reports Gmail as PLANNED, never as available, even when Google connects", async () => {
    // The specific misreport from the screenshots: Gmail actions listed as
    // things JARVIS could do. There is no Gmail client in this build, so it is
    // planned whatever the connection state.
    const connectedGoogle = NOTHING_CONNECTED.map((i) =>
      i.id === "google"
        ? integration({
            id: "google",
            name: "Google",
            category: "google",
            configKind: "oauth",
            connection: "CONNECTED",
            health: "CONNECTED",
            detail: "Connected.",
            permissions: [
              { id: "openid", label: "Identify the account", granted: true, access: "read" },
            ],
          })
        : i
    );

    const service = serviceWith(REGISTERED, connectedGoogle);
    const report = await service.report("u1");

    const gmail = report.capabilities.find((c) => c.id === "google.gmail")!;
    expect(gmail.availability).toBe("PLANNED");
    expect(gmail.registered).toBe(false);
    expect(gmail.reason).toMatch(/no client/i);
  });

  it("marks an external write as REQUIRES_CONFIRMATION rather than plainly executable", async () => {
    const connectedMeta = NOTHING_CONNECTED.map((i) =>
      i.id === "meta"
        ? integration({
            id: "meta",
            name: "Meta Ads",
            connection: "CONNECTED",
            health: "CONNECTED",
            detail: "Connected.",
            permissions: [
              { id: "ads_read", label: "Read", granted: true, access: "read" },
              { id: "ads_management", label: "Write", granted: true, access: "write" },
            ],
          })
        : i
    );

    const service = serviceWith(REGISTERED, connectedMeta);
    const report = await service.report("u1");

    expect(report.capabilities.find((c) => c.id === "meta.insights")!.availability).toBe(
      "EXECUTABLE"
    );
    expect(
      report.capabilities.find((c) => c.id === "meta.campaign.budget.update")!.availability
    ).toBe("REQUIRES_CONFIRMATION");
  });

  it("reports DISABLED distinctly from NOT_CONNECTED", async () => {
    const disabled = NOTHING_CONNECTED.map((i) =>
      i.id === "meta"
        ? integration({ id: "meta", name: "Meta Ads", connection: "DISABLED", health: "DISABLED" })
        : i
    );

    const report = await serviceWith(REGISTERED, disabled).report("u1");
    const cap = report.capabilities.find((c) => c.id === "meta.insights")!;
    expect(cap.availability).toBe("DISABLED");
    expect(cap.requiredAction).toMatch(/enable/i);
  });

  it("reports NEEDS_REAUTH distinctly, and does not offer a pointless retry", async () => {
    const stale = NOTHING_CONNECTED.map((i) =>
      i.id === "google"
        ? integration({
            id: "google",
            name: "Google",
            category: "google",
            configKind: "oauth",
            connection: "NEEDS_REAUTH",
            health: "NEEDS_REAUTH",
          })
        : i
    );

    const report = await serviceWith(REGISTERED, stale).report("u1");
    const cap = report.capabilities.find((c) => c.id === "google.accounts")!;
    expect(cap.availability).toBe("NEEDS_REAUTH");
    expect(cap.requiredAction).toMatch(/reauthorize/i);
  });

  it("reports PERMISSION_MISSING when connected but unscoped", async () => {
    // Connected is necessary, not sufficient. This is its own state.
    const unscoped = NOTHING_CONNECTED.map((i) =>
      i.id === "meta"
        ? integration({
            id: "meta",
            name: "Meta Ads",
            connection: "CONNECTED",
            health: "CONNECTED",
            permissions: [
              { id: "ads_read", label: "Read", granted: false, access: "read" },
            ],
          })
        : i
    );

    const report = await serviceWith(REGISTERED, unscoped).report("u1");
    const cap = report.capabilities.find((c) => c.id === "meta.insights")!;
    expect(cap.availability).toBe("PERMISSION_MISSING");
    expect(cap.reason).toMatch(/not been granted/i);
  });

  it("never gates integration management on the integration it manages", async () => {
    // "Connect Google" must not report itself unavailable because Google is
    // disconnected — that would make the remedy unreachable.
    const report = await serviceWith(REGISTERED, NOTHING_CONNECTED).report("u1");

    for (const id of ["integration.list", "integration.status"]) {
      const cap = report.capabilities.find((c) => c.id === id)!;
      expect(cap.availability, id).toBe("EXECUTABLE");
    }
  });
});

// ---------------------------------------------------------------------------

describe("connected integrations", () => {
  it("returns nothing when nothing is connected", async () => {
    const connected = await serviceWith(REGISTERED, NOTHING_CONNECTED).connectedIntegrations("u1");
    expect(connected).toEqual([]);
  });

  it("does not treat 'configuration exists' as connected", async () => {
    // Config present, connection still PARTIAL. The old dashboards called this
    // connected; it is not.
    const partial = NOTHING_CONNECTED.map((i) =>
      i.id === "google-maps"
        ? integration({
            id: "google-maps",
            name: "Google Maps",
            category: "maps",
            configKind: "server-managed",
            connection: "PARTIAL",
            health: "CONFIG_REQUIRED",
            configComplete: false,
            missingConfig: ["serverKey"],
          })
        : i
    );

    const connected = await serviceWith(REGISTERED, partial).connectedIntegrations("u1");
    expect(connected.map((c) => c.integration)).not.toContain("google-maps");
  });

  it("reports health alongside connection, without inferring one from the other", async () => {
    const connectedUnverified = NOTHING_CONNECTED.map((i) =>
      i.id === "meta"
        ? integration({
            id: "meta",
            name: "Meta Ads",
            connection: "CONNECTED",
            // Set up, never verified. A real and common combination.
            health: "UNVERIFIED",
          })
        : i
    );

    const connected = await serviceWith(REGISTERED, connectedUnverified).connectedIntegrations("u1");
    expect(connected).toHaveLength(1);
    expect(connected[0]!.connection).toBe("CONNECTED");
    expect(connected[0]!.health).toBe("UNVERIFIED");
  });

  it("separates executable from unavailable actions per integration", async () => {
    const connectedMeta = NOTHING_CONNECTED.map((i) =>
      i.id === "meta"
        ? integration({
            id: "meta",
            name: "Meta Ads",
            connection: "CONNECTED",
            health: "CONNECTED",
            permissions: [
              { id: "ads_read", label: "Read", granted: true, access: "read" },
              { id: "ads_management", label: "Write", granted: true, access: "write" },
            ],
          })
        : i
    );

    const connected = await serviceWith(REGISTERED, connectedMeta).connectedIntegrations("u1");
    const meta = connected.find((c) => c.integration === "meta")!;
    expect(meta.executable.length).toBeGreaterThan(0);
    // Every unavailable entry must explain itself.
    for (const cap of meta.unavailable) {
      expect(cap.reason, cap.id).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------

describe("permissions distinguish registered from granted", () => {
  it("never reports a disconnected Google's permissions as granted", async () => {
    // The exact misreport: Gmail permissions shown as granted with no OAuth.
    const withPerms = NOTHING_CONNECTED.map((i) =>
      i.id === "google"
        ? integration({
            id: "google",
            name: "Google",
            category: "google",
            configKind: "oauth",
            connection: "NOT_CONNECTED",
            // A stale list that says "granted" must not be believed.
            permissions: [
              { id: "gmail.readonly", label: "Read Gmail", granted: true, access: "read" },
            ],
          })
        : i
    );

    const report = await serviceWith(REGISTERED, withPerms).permissions("u1");
    const gmail = report.permissions.find((p) => p.id === "gmail.readonly")!;

    expect(gmail.registered).toBe(true);
    expect(gmail.granted).toBe(false);
    expect(gmail.reason).toMatch(/oauth connection is required/i);
  });

  it("preserves Meta read and write information when connected", async () => {
    const connectedMeta = NOTHING_CONNECTED.map((i) =>
      i.id === "meta"
        ? integration({
            id: "meta",
            name: "Meta Ads",
            connection: "CONNECTED",
            health: "CONNECTED",
            permissions: [
              { id: "ads_read", label: "Read ad accounts", granted: true, access: "read" },
              { id: "ads_management", label: "Change budgets", granted: true, access: "write" },
            ],
          })
        : i
    );

    const report = await serviceWith(REGISTERED, connectedMeta).permissions("u1");
    const read = report.permissions.find((p) => p.id === "ads_read")!;
    const write = report.permissions.find((p) => p.id === "ads_management")!;

    expect(read.granted).toBe(true);
    expect(read.access).toBe("read");
    expect(read.requiresConfirmation).toBe(false);

    expect(write.granted).toBe(true);
    expect(write.access).toBe("write");
    // Writes are approval-gated, and that is part of the permission's meaning.
    expect(write.requiresConfirmation).toBe(true);
  });

  it("counts granted separately from registered", async () => {
    const report = await serviceWith(REGISTERED, NOTHING_CONNECTED).permissions("u1");
    expect(report.grantedCount).toBe(0);
    expect(report.missingCount).toBe(report.permissions.length);
  });
});

// ---------------------------------------------------------------------------

describe("identifier masking", () => {
  it("masks a Meta ad account id in the documented shape", () => {
    expect(maskIdentifier("act_2478566669291624")).toBe("act_2478••••••1624");
  });

  it("keeps the structural prefix but never the full value", () => {
    const masked = maskIdentifier("act_2478566669291624");
    expect(masked.startsWith("act_")).toBe(true);
    expect(masked).not.toContain("2478566669291624");
  });

  it("masks a bare customer id", () => {
    const masked = maskIdentifier("1234567890");
    expect(masked).toBe("1234••••••7890");
    expect(masked).not.toBe("1234567890");
  });

  it("replaces a short value entirely rather than revealing most of it", () => {
    // Revealing 8 of 9 characters is not masking. This is the branch where a
    // naive implementation leaks.
    expect(maskIdentifier("12345")).toBe("••••••");
    expect(maskIdentifier("abc")).toBe("••••••");
  });

  it("distinguishes absent from withheld", () => {
    expect(maskIdentifier(null)).toBe("");
    expect(maskIdentifier("")).toBe("");
  });

  it("masks an email's local part and keeps the domain", () => {
    const masked = maskEmail("operator@company.com");
    expect(masked).toContain("@company.com");
    expect(masked).not.toContain("operator");
  });

  it("scrubs identifiers out of model-authored prose", () => {
    const text = "Your account act_2478566669291624 spent 24785 rupees this week.";
    const scrubbed = maskIdentifiersInText(text);

    expect(scrubbed).not.toContain("act_2478566669291624");
    expect(scrubbed).toContain("act_2478••••••1624");
    // An ordinary number in prose is NOT an identifier and must survive.
    expect(scrubbed).toContain("24785");
  });

  it("scrubs API keys and long-lived tokens from prose", () => {
    const text = "key AIzaSyД1234567890abcdefghijklmno and token EAABwzLixnjYBO1234567890abcdef";
    const scrubbed = maskIdentifiersInText(text.replace("Д", "A"));
    expect(scrubbed).not.toMatch(/AIzaSyA1234567890abcdefghijklmno/);
    expect(scrubbed).not.toMatch(/EAABwzLixnjYBO1234567890abcdef/);
  });

  it("masks the account on an integration capability view", async () => {
    const withAccount = NOTHING_CONNECTED.map((i) =>
      i.id === "meta"
        ? integration({
            id: "meta",
            name: "Meta Ads",
            connection: "CONNECTED",
            health: "CONNECTED",
            account: { label: "act_2478566669291624" },
          })
        : i
    );

    const connected = await serviceWith(REGISTERED, withAccount).connectedIntegrations("u1");
    const meta = connected.find((c) => c.integration === "meta")!;

    // Masked at construction — no caller has to remember to do it.
    expect(meta.account).toBe("act_2478••••••1624");
    expect(JSON.stringify(connected)).not.toContain("2478566669291624");
  });

  it("leaves no full identifier anywhere in a full report", async () => {
    const withAccount = NOTHING_CONNECTED.map((i) =>
      i.id === "meta"
        ? integration({
            id: "meta",
            name: "Meta Ads",
            connection: "CONNECTED",
            health: "CONNECTED",
            account: { label: "act_2478566669291624" },
          })
        : i
    );

    const report = await serviceWith(REGISTERED, withAccount).report("u1");
    expect(JSON.stringify(report)).not.toContain("2478566669291624");
  });
});

// ---------------------------------------------------------------------------

describe("degradation", () => {
  it("still answers when integration state cannot be read", async () => {
    // A capability question answered partially beats an error. What must NEVER
    // happen is integration-gated capabilities reporting as available.
    const service = new CapabilityService({
      toolRegistry: { getAll: () => REGISTERED },
      integrations: { listIntegrations: async () => null },
      allowedToolIds: new Set(REGISTERED.map((t) => t.id)),
    });

    const report = await service.report("u1");
    expect(report.capabilities.length).toBeGreaterThan(0);

    const meta = report.capabilities.find((c) => c.id === "meta.insights")!;
    expect(meta.availability).toBe("NOT_CONFIGURED");

    // The ungated ones still work.
    expect(report.capabilities.find((c) => c.id === "time.now")!.availability).toBe("EXECUTABLE");
  });

  it("sorts most-usable first, so a caller leads with what works", async () => {
    const report = await serviceWith(REGISTERED, NOTHING_CONNECTED).report("u1");
    const firstUnavailable = report.capabilities.findIndex(
      (c) => c.availability !== "EXECUTABLE" && c.availability !== "REQUIRES_CONFIRMATION"
    );
    const lastUsable = report.capabilities.reduce(
      (acc, c, i) =>
        c.availability === "EXECUTABLE" || c.availability === "REQUIRES_CONFIRMATION" ? i : acc,
      -1
    );
    expect(lastUsable).toBeLessThan(firstUnavailable);
  });
});
