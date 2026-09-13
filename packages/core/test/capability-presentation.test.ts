// ---------------------------------------------------------------------------
// The briefing that replaced the registry dump.
//
// The defect these pin: "What can you do?" answered with 34 bullet points in
// buckets called "Ambient" and "System", seven of which were raw registry ids
// (`integration.list`, `integration.status`, …). The truth underneath was
// already correct — CapabilityService derives it from the live registry — so
// none of these tests are about WHAT is reported. They are about whether it is
// reported as something a person asked for or as a database listing.
//
// The load-bearing property is the last describe block: a briefing can only
// ever narrow what the report contained. There is no input to
// `buildCapabilityBriefing` that makes it name a capability the report did not.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { buildCapabilityBriefing } from "../src/capability-presentation.js";
import type {
  CapabilityAvailability,
  CapabilityReport,
  CapabilityView,
  IntegrationCapabilityView,
} from "../src/types/capability.js";

function cap(
  id: string,
  label: string,
  availability: CapabilityAvailability,
  extra: Partial<CapabilityView> = {}
): CapabilityView {
  return {
    id,
    label,
    description: `${label} description`,
    group: "system",
    integration: null,
    registered: true,
    availability,
    access: availability === "REQUIRES_CONFIRMATION" ? "write" : "read",
    reason: null,
    requiredAction: null,
    ...extra,
  };
}

function integration(
  id: string,
  name: string,
  connection: string
): IntegrationCapabilityView {
  return {
    integration: id,
    name,
    group: "system",
    connection,
    health: connection === "CONNECTED" ? "HEALTHY" : "UNKNOWN",
    account: null,
    enabledServices: [],
    executable: [],
    unavailable: [],
    blockedReason: null,
    requiredAction: null,
  };
}

/** A deployment shaped like the one that produced the original bad answer. */
function realisticReport(): CapabilityReport {
  const capabilities: CapabilityView[] = [
    cap("meta.insights", "Read Meta performance insights", "EXECUTABLE", { integration: "meta" }),
    cap("meta.campaigns", "List Meta campaigns", "EXECUTABLE", { integration: "meta" }),
    cap("meta.adsets", "List Meta ad sets", "EXECUTABLE", { integration: "meta" }),
    cap("meta.ads", "List Meta ads", "EXECUTABLE", { integration: "meta" }),
    cap("meta.campaign.create", "Create a Meta campaign", "REQUIRES_CONFIRMATION", {
      integration: "meta",
    }),
    cap("meta.campaign.pause", "Pause a Meta campaign", "REQUIRES_CONFIRMATION", {
      integration: "meta",
    }),
    cap("maps.nearby", "Find places near a location", "EXECUTABLE", { integration: "google-maps" }),
    cap("maps.search", "Search places", "EXECUTABLE", { integration: "google-maps" }),
    cap("maps.route", "Compute a route", "EXECUTABLE", { integration: "google-maps" }),
    cap("system.status", "This machine's telemetry", "EXECUTABLE"),
    cap("time.now", "Current date and time", "EXECUTABLE"),
    cap("weather.current", "Current weather", "EXECUTABLE"),
    cap("tasks.list", "List your tasks", "EXECUTABLE"),
    // The ones that leaked verbatim. They now carry real labels, but the
    // briefing must not quote ids even if a label regressed.
    cap("integration.list", "See what is connected", "EXECUTABLE"),
    cap("integration.health", "Run an integration health check", "EXECUTABLE"),
    cap("gmail.listUnread", "List unread Gmail", "NOT_CONNECTED", {
      integration: "google",
      reason: "Google is not connected.",
      requiredAction: "Connect your Google account, then this becomes available.",
    }),
    cap("google.sheets", "Google Sheets (planned)", "PLANNED", { integration: "google" }),
  ];

  return {
    summary: {
      total: capabilities.length,
      executable: capabilities.filter((c) => c.availability === "EXECUTABLE").length,
      requiresConfirmation: capabilities.filter((c) => c.availability === "REQUIRES_CONFIRMATION")
        .length,
      unavailable: capabilities.filter((c) => c.availability === "NOT_CONNECTED").length,
      planned: capabilities.filter((c) => c.availability === "PLANNED").length,
    },
    capabilities,
    integrations: [
      integration("meta", "Meta Ads", "CONNECTED"),
      integration("google-maps", "Google Maps", "CONNECTED"),
      integration("google", "Google", "NOT_CONNECTED"),
    ],
    general: [],
  };
}

describe("a capability question is answered as a briefing, not a listing", () => {
  it("groups by what the user is trying to do, not by registry category", () => {
    const briefing = buildCapabilityBriefing(realisticReport());
    const titles = briefing.groups.map((g) => g.title);

    expect(titles).toContain("Business and advertising");
    expect(titles).toContain("Maps, places and travel");

    // The technical buckets that leaked into the original answer.
    expect(titles).not.toContain("Ambient");
    expect(titles).not.toContain("System");
    expect(titles.join(" ")).not.toMatch(/ambient/i);
  });

  it("returns four to six groups, never one per provider", () => {
    const briefing = buildCapabilityBriefing(realisticReport());

    expect(briefing.groups.length).toBeGreaterThanOrEqual(4);
    expect(briefing.groups.length).toBeLessThanOrEqual(6);
  });

  it("never puts a raw tool id in front of the model", () => {
    const briefing = buildCapabilityBriefing(realisticReport());
    const everything = JSON.stringify(briefing);

    // The seven that were actually read aloud to the user.
    expect(everything).not.toContain("integration.list");
    expect(everything).not.toContain("integration.health");
    expect(everything).not.toContain("meta.insights");
    expect(everything).not.toContain("system.status");
    // And nothing else id-shaped either.
    expect(everything).not.toMatch(/"[a-z]+\.[a-z.]+"/);
  });

  it("offers three to six example commands the user can say verbatim", () => {
    const briefing = buildCapabilityBriefing(realisticReport());

    expect(briefing.examples.length).toBeGreaterThanOrEqual(3);
    expect(briefing.examples.length).toBeLessThanOrEqual(6);
    expect(briefing.examples).toContain("Mere Meta campaigns ke insights batao.");
  });

  it("phrases capabilities as requests rather than as tool labels", () => {
    const briefing = buildCapabilityBriefing(realisticReport());
    const advertising = briefing.groups.find((g) => g.id === "advertising");

    expect(advertising).toBeDefined();
    expect(advertising!.youCanAsk.join(" ")).toMatch(/how your campaigns are performing/i);
  });
});

describe("the honest distinctions survive the reformatting", () => {
  it("marks approval-gated work explicitly and separately", () => {
    const briefing = buildCapabilityBriefing(realisticReport());

    expect(briefing.approvalNote).toBeTruthy();
    expect(briefing.approvalNote!).toMatch(/approve/i);

    const advertising = briefing.groups.find((g) => g.id === "advertising")!;
    expect(advertising.approvalCount).toBeGreaterThan(0);
  });

  it("reports an unconnected integration as unavailable, with the remedy", () => {
    const briefing = buildCapabilityBriefing(realisticReport());

    expect(briefing.unavailable).toHaveLength(1);
    expect(briefing.unavailable[0]!.what).toBe("Google");
    expect(briefing.unavailable[0]!.toFix).toMatch(/connect your google account/i);
  });

  it("never lets a planned capability into a usable group", () => {
    const briefing = buildCapabilityBriefing(realisticReport());

    expect(briefing.planned).toContain("Google Sheets");
    const usableText = JSON.stringify(briefing.groups) + briefing.examples.join(" ");
    expect(usableText).not.toMatch(/sheets/i);
  });

  it("never offers an example for a capability that is not usable", () => {
    const report = realisticReport();
    // Take Meta away entirely.
    report.capabilities = report.capabilities.filter((c) => !c.id.startsWith("meta."));
    report.integrations = report.integrations.filter((i) => i.integration !== "meta");
    report.summary.requiresConfirmation = 0;

    const briefing = buildCapabilityBriefing(report);

    expect(briefing.examples.join(" ")).not.toMatch(/meta/i);
    expect(briefing.groups.map((g) => g.id)).not.toContain("advertising");
  });
});

describe("the briefing cannot invent a capability", () => {
  it("says nothing is connected when nothing is, without offering anything", () => {
    const report: CapabilityReport = {
      summary: { total: 0, executable: 0, requiresConfirmation: 0, unavailable: 0, planned: 0 },
      capabilities: [],
      integrations: [],
      general: [],
    };

    const briefing = buildCapabilityBriefing(report);

    expect(briefing.groups).toHaveLength(0);
    expect(briefing.examples).toHaveLength(0);
    expect(briefing.intro).toMatch(/nothing is connected/i);
    expect(briefing.approvalNote).toBeNull();
  });

  it("only ever names integrations the report actually reported as connected", () => {
    const briefing = buildCapabilityBriefing(realisticReport());

    expect(briefing.intro).toContain("Meta Ads");
    expect(briefing.intro).toContain("Google Maps");
    // Present in the report, but NOT_CONNECTED — it must not appear in a line
    // that says what JARVIS is connected to.
    expect(briefing.intro).not.toMatch(/\bGoogle\b(?!\s+Maps)/);
  });

  it("counts a capability without quoting it when its label is still an id", () => {
    const report = realisticReport();
    // Simulate a newly registered tool nobody has labelled yet.
    report.capabilities.push(cap("newthing.dosomething", "newthing.dosomething", "EXECUTABLE"));

    const briefing = buildCapabilityBriefing(report);

    expect(JSON.stringify(briefing)).not.toContain("newthing.dosomething");
  });
});
