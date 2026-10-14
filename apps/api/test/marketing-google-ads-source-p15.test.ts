// ---------------------------------------------------------------------------
// Phase 15 — Google Ads as a report source.
//
// THE RULE. Google Ads may be used only after the access it needs has been
// GRANTED and that grant verified. Phase 15 therefore puts no Google Ads
// figure in a report at all; what it does is say, in every report, whether
// Google Ads could have been read and — if not — exactly why.
//
// This runs the real `googleAdsReportSource` over the real `CapabilityService`,
// so the answer below is derived the way production derives it: from the
// registered tools, the user's connection, and the permissions Google actually
// GRANTED. Only the integration state is supplied by the test.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import type { ITool, IntegrationView } from "@jarvis/core";
import { CapabilityService } from "../src/services/capabilities/capability-service.js";
import { googleAdsReportSource } from "../src/services/marketing/google-ads-source.js";

function tool(id: string): ITool {
  return {
    id,
    name: id,
    description: `Tool ${id}`,
    category: "system",
    risk: "READ_ONLY",
    parameters: [],
    requiresApproval: false,
    requiredPermissions: ["read"],
    version: "1.0.0",
    enabled: true,
    execute: async () => ({ success: true }),
    validate: () => true,
  } as unknown as ITool;
}

type Permission = IntegrationView["permissions"][number];

function google(over: Partial<IntegrationView> = {}): IntegrationView {
  return {
    id: "google",
    name: "Google",
    subtitle: "",
    category: "google",
    configKind: "oauth",
    connection: "NOT_CONNECTED",
    health: "NOT_CONNECTED",
    detail: "No Google account is connected.",
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

const connected = (permissions: Permission[]): IntegrationView =>
  google({ connection: "CONNECTED", health: "CONNECTED", detail: "Connected.", permissions });

const IDENTITY = { id: "openid", label: "Identify the connected Google account", granted: true, access: "read" } as Permission;
const ADS_READ = { id: "adwords", label: "Read Google Ads", granted: true, access: "read", service: "ads" } as Permission;

const ADS_TOOLS = [tool("google.accounts"), tool("google.campaigns"), tool("google.insights")];

function capabilities(tools: ITool[], integration: IntegrationView | null, allowed: string[] = tools.map((t) => t.id)) {
  return new CapabilityService({
    toolRegistry: { getAll: () => tools },
    integrations: { listIntegrations: async () => (integration ? [integration] : []) },
    allowedToolIds: new Set(allowed),
  });
}

const USER = "user-p15";

// ---------------------------------------------------------------------------

describe("Phase 15 — Google Ads report source: not set up", () => {
  it("is NOT_CONFIGURED when there is no capability service to ask", async () => {
    const answer = await googleAdsReportSource(null, USER);

    expect(answer.status).toBe("NOT_CONFIGURED");
    expect(answer.detail).toContain("Google Ads developer token");
  });

  it("is NOT_CONFIGURED when the Google Ads read tools are not registered", async () => {
    // A Google connection with the Ads scope changes nothing: nothing here could read it.
    const answer = await googleAdsReportSource(capabilities([tool("gmail.listUnread")], connected([IDENTITY, ADS_READ])), USER);

    expect(answer.status).toBe("NOT_CONFIGURED");
  });

  it("is NOT_CONFIGURED when the tool is registered and no agent may call it", async () => {
    const answer = await googleAdsReportSource(capabilities(ADS_TOOLS, connected([IDENTITY, ADS_READ]), ["google.accounts"]), USER);

    expect(answer.status).toBe("NOT_CONFIGURED");
  });
});

describe("Phase 15 — Google Ads report source: not connected", () => {
  it("is NOT_CONNECTED when the user has connected no Google account", async () => {
    const answer = await googleAdsReportSource(capabilities(ADS_TOOLS, google()), USER);

    expect(answer.status).toBe("NOT_CONNECTED");
    expect(answer.detail).toMatch(/Google is not connected/);
    expect(answer.detail).toMatch(/Connect your Google account/);
  });

  it("is NOT_CONNECTED when the user switched Google off", async () => {
    const answer = await googleAdsReportSource(capabilities(ADS_TOOLS, google({ connection: "DISABLED", permissions: [IDENTITY, ADS_READ] })), USER);

    expect(answer.status).toBe("NOT_CONNECTED");
  });

  it("is not reported as readable when Google has since refused the authorization", async () => {
    const answer = await googleAdsReportSource(capabilities(ADS_TOOLS, google({ connection: "NEEDS_REAUTH", permissions: [IDENTITY, ADS_READ] })), USER);

    expect(answer.status).toBe("NOT_CONNECTED");
  });
});

describe("Phase 15 — Google Ads report source: connected, and the Ads scope not granted", () => {
  it("is SCOPE_NOT_GRANTED on a connection that carries no Ads permission", async () => {
    const answer = await googleAdsReportSource(capabilities(ADS_TOOLS, connected([IDENTITY])), USER);

    expect(answer.status).toBe("SCOPE_NOT_GRANTED");
    expect(answer.detail).toMatch(/read access to Google Ads was not granted/i);
    // And it says what would change that — an explicit re-grant, nothing silent.
    expect(answer.detail).toMatch(/Reconnect Google and approve read access for Google Ads/i);
  });

  it("reads what was GRANTED, not what was requested", async () => {
    // The Ads scope was asked for and Google did not grant it.
    const requestedOnly = { ...ADS_READ, granted: false } as Permission;

    const answer = await googleAdsReportSource(capabilities(ADS_TOOLS, connected([IDENTITY, requestedOnly])), USER);

    expect(answer.status).toBe("SCOPE_NOT_GRANTED");
  });

  it("is not satisfied by another Google service's scope", async () => {
    const gmail = { id: "gmail.readonly", label: "Read Gmail", granted: true, access: "read", service: "gmail" } as Permission;
    const drive = { id: "drive.readonly", label: "Read Drive", granted: true, access: "read", service: "drive" } as Permission;

    const answer = await googleAdsReportSource(capabilities(ADS_TOOLS, connected([IDENTITY, gmail, drive])), USER);

    expect(answer.status).toBe("SCOPE_NOT_GRANTED");
  });
});

describe("Phase 15 — Google Ads report source: every gate open", () => {
  it("is NOT_INCLUDED — usable, and deliberately not used in this version", async () => {
    const answer = await googleAdsReportSource(capabilities(ADS_TOOLS, connected([IDENTITY, ADS_READ])), USER);

    expect(answer.status).toBe("NOT_INCLUDED");
    expect(answer.detail).toMatch(/does not put Google Ads figures in reports yet/);
  });

  it("never answers INCLUDED, whatever the connection looks like", async () => {
    const states: Array<IntegrationView | null> = [
      null,
      google(),
      google({ connection: "DISABLED" }),
      google({ connection: "NEEDS_REAUTH" }),
      google({ connection: "PARTIAL" as IntegrationView["connection"] }),
      connected([]),
      connected([IDENTITY]),
      connected([IDENTITY, ADS_READ]),
    ];

    for (const state of states) {
      const answer = await googleAdsReportSource(capabilities(ADS_TOOLS, state), USER);
      expect(answer.status, JSON.stringify(state?.connection ?? null)).not.toBe("INCLUDED");
      expect(answer.detail.length).toBeGreaterThan(0);
    }
  });

  it("asks about the user it was given, and no other", async () => {
    const asked: string[] = [];
    const answer = await googleAdsReportSource(
      {
        report: async (userId) => {
          asked.push(userId);
          return capabilities(ADS_TOOLS, connected([IDENTITY])).report(userId);
        },
      },
      "user-a"
    );

    expect(asked).toEqual(["user-a"]);
    expect(answer.status).toBe("SCOPE_NOT_GRANTED");
  });
});
