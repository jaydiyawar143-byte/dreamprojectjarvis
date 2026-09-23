// ---------------------------------------------------------------------------
// Skill System V1 — Phase S1. The foundation, and what it must never become.
//
// A skill is METADATA. It names an outcome and the tools behind it; it does not
// run anything. The dangerous version of this feature is the one where a skill
// grows an `execute()`, or a `toolIds` list that a caller trusts as permission,
// because either puts work outside ToolExecutor — which is where the permission
// check, the approval gate, the deadline and the audit row live.
//
// So these tests are mostly negative. They pin three properties:
//
//   DERIVED       every field of a SkillView comes from the report passed in.
//   NARROWING     a skill can only ever report LESS than the report contained.
//   INERT         nothing in the skill surface can be called.
//
// They also pin the promotion itself: `SKILL_CATALOG` is the SAME list the
// capability briefing has always used, so "What can you do?" must answer
// identically after S1 as before it.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  SKILL_CATALOG,
  buildCapabilityBriefing,
  buildSkillViews,
  skillForToolId,
  CAPABILITY_GOAL_GROUP_IDS,
} from "../src/capability-presentation.js";
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
    registered: availability !== "PLANNED",
    availability,
    access: availability === "REQUIRES_CONFIRMATION" ? "write" : "read",
    reason: null,
    requiredAction: null,
    ...extra,
  };
}

function integration(id: string, name: string, connection: string): IntegrationCapabilityView {
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

function report(
  capabilities: CapabilityView[],
  integrations: IntegrationCapabilityView[] = []
): CapabilityReport {
  return {
    summary: {
      total: capabilities.length,
      executable: capabilities.filter((c) => c.availability === "EXECUTABLE").length,
      requiresConfirmation: capabilities.filter((c) => c.availability === "REQUIRES_CONFIRMATION")
        .length,
      unavailable: capabilities.filter(
        (c) => !["EXECUTABLE", "REQUIRES_CONFIRMATION", "PLANNED"].includes(c.availability)
      ).length,
      planned: capabilities.filter((c) => c.availability === "PLANNED").length,
    },
    capabilities,
    integrations,
    general: [],
  };
}

/** A deployment with Meta connected, Google not, and one planned capability. */
function realisticReport(): CapabilityReport {
  return report(
    [
      cap("meta.insights", "Read Meta performance insights", "EXECUTABLE", { integration: "meta" }),
      cap("meta.campaigns", "List Meta campaigns", "EXECUTABLE", { integration: "meta" }),
      cap("meta.campaign.pause", "Pause a Meta campaign", "REQUIRES_CONFIRMATION", {
        integration: "meta",
      }),
      cap("maps.nearby", "Find places near a location", "EXECUTABLE", {
        integration: "google-maps",
      }),
      cap("maps.search", "Search places", "EXECUTABLE", { integration: "google-maps" }),
      cap("system.status", "This machine telemetry", "EXECUTABLE"),
      cap("time.now", "Current date and time", "EXECUTABLE"),
      cap("gmail.listUnread", "List unread Gmail", "NOT_CONNECTED", {
        integration: "google",
        reason: "Google is not connected.",
        requiredAction: "Connect your Google account, then this becomes available.",
      }),
      cap("gmail.search", "Search Gmail", "NOT_CONNECTED", {
        integration: "google",
        reason: "Google is not connected.",
        requiredAction: "Connect your Google account, then this becomes available.",
      }),
      cap("calendar.schedule", "Calendar scheduling (planned)", "PLANNED", {
        integration: "google",
      }),
      // Owned by NO skill — `google.` is not a prefix any skill claims (the
      // workspace skill claims `google.plan.`). See the last describe block.
      cap("google.sheets", "Google Sheets (planned)", "PLANNED", { integration: "google" }),
    ],
    [
      integration("meta", "Meta Ads", "CONNECTED"),
      integration("google-maps", "Google Maps", "CONNECTED"),
      integration("google", "Google", "NOT_CONNECTED"),
    ]
  );
}

function skill(views: ReturnType<typeof buildSkillViews>, id: string) {
  const found = views.find((v) => v.id === id);
  if (!found) throw new Error(`no skill view for ${id}`);
  return found;
}

// ---------------------------------------------------------------------------
// A. Every SkillDefinition references tool ids that can exist
// ---------------------------------------------------------------------------

describe("A. a skill names real, well-formed tool ids", () => {
  it("gates every phrase on an exact tool id, never a prefix or a label", () => {
    for (const s of SKILL_CATALOG) {
      for (const phrase of s.phrases) {
        expect(phrase.requires, `${s.id}: ${phrase.text}`).toMatch(
          /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/
        );
      }
    }
  });

  it("gates every phrase on a tool THIS skill owns", () => {
    // A phrase pointing at another skill's tool would make the two disagree
    // about what is available: one would show the phrase, the other the tool.
    for (const s of SKILL_CATALOG) {
      for (const phrase of s.phrases) {
        expect(skillForToolId(phrase.requires)?.id, `${s.id}: ${phrase.requires}`).toBe(s.id);
      }
    }
  });

  it("declares prefixes that are prefixes, and exact ids that are ids", () => {
    for (const s of SKILL_CATALOG) {
      // A skill may be defined by prefixes, by exact ids, or by both — but it
      // must own SOMETHING, or it is a title with no capability behind it.
      expect(s.prefixes.length + (s.exact?.length ?? 0), s.id).toBeGreaterThan(0);
      for (const p of s.prefixes) expect(p, s.id).toMatch(/^[a-z][a-zA-Z0-9.]*\.$/);
      for (const e of s.exact ?? []) {
        expect(e, s.id).toMatch(/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/);
      }
    }
  });

  it("gives every skill a human title and summary, never an id", () => {
    for (const s of SKILL_CATALOG) {
      expect(s.title, s.id).not.toMatch(/^[a-z0-9]+(\.[a-z0-9.]+)+$/);
      expect(s.title.length, s.id).toBeGreaterThan(3);
      expect(s.summary.length, s.id).toBeGreaterThan(10);
    }
  });
});

// ---------------------------------------------------------------------------
// B. Skill ids are unique, and membership is unambiguous
// ---------------------------------------------------------------------------

describe("B. one tool belongs to exactly one skill", () => {
  it("has unique skill ids", () => {
    const ids = SKILL_CATALOG.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("claims no exact tool id twice", () => {
    const claimed = SKILL_CATALOG.flatMap((s) => [...(s.exact ?? [])]);
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  it("declares no prefix that is a prefix of another skill's prefix", () => {
    // If it did, `ruleFor` would silently award the tool to whichever skill was
    // declared first, and moving a line in the catalogue would move the tool.
    const all = SKILL_CATALOG.flatMap((s) => s.prefixes.map((p) => ({ skill: s.id, p })));
    for (const a of all) {
      for (const b of all) {
        if (a.skill === b.skill || a.p === b.p) continue;
        expect(a.p.startsWith(b.p), `${a.skill}:${a.p} vs ${b.skill}:${b.p}`).toBe(false);
      }
    }
  });

  it("resolves a tool id to the same skill however it is reached", () => {
    for (const s of SKILL_CATALOG) {
      for (const e of s.exact ?? []) expect(skillForToolId(e)?.id).toBe(s.id);
      for (const p of s.prefixes) expect(skillForToolId(`${p}someNewTool`)?.id).toBe(s.id);
    }
  });

  it("returns undefined rather than guessing for an unowned id", () => {
    expect(skillForToolId("totallyUnclaimed.thing")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// C. Skill metadata is deterministic
// ---------------------------------------------------------------------------

describe("C. the same report always produces the same skills", () => {
  it("is pure — two calls on equal reports are deeply equal", () => {
    expect(buildSkillViews(realisticReport())).toEqual(buildSkillViews(realisticReport()));
  });

  it("does not mutate the report it was handed", () => {
    const r = realisticReport();
    const before = JSON.stringify(r);
    buildSkillViews(r);
    expect(JSON.stringify(r)).toBe(before);
  });

  it("orders most-usable first, with a total ordering", () => {
    const views = buildSkillViews(realisticReport());
    const rank = ["EXECUTABLE", "REQUIRES_CONFIRMATION", "NOT_CONNECTED"];
    const seen = views.map((v) => rank.indexOf(v.availability));
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  it("reports nothing at all for an empty report", () => {
    expect(buildSkillViews(report([]))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// D. Discovery is not authorization
// ---------------------------------------------------------------------------

describe("D. a definition cannot smuggle in a tool the report did not contain", () => {
  it("never names a tool absent from the report, whatever the catalogue claims", () => {
    const views = buildSkillViews(
      report([cap("meta.insights", "Read Meta insights", "EXECUTABLE")])
    );
    expect(views.flatMap((v) => v.toolIds)).toEqual(["meta.insights"]);
  });

  it("omits a skill entirely when this build has no member for it", () => {
    const views = buildSkillViews(
      report([cap("meta.insights", "Read Meta insights", "EXECUTABLE")])
    );
    expect(views.map((v) => v.id)).toEqual(["advertising"]);
  });

  it("drops the phrase when its tool is present but not usable", () => {
    const usable = buildSkillViews(realisticReport());
    const blocked = buildSkillViews(
      report(
        realisticReport().capabilities.map((c) =>
          c.id.startsWith("meta.") ? { ...c, availability: "NOT_CONNECTED" as const } : c
        )
      )
    );
    expect(skill(usable, "advertising").youCanAsk.length).toBeGreaterThan(0);
    expect(skill(blocked, "advertising").youCanAsk).toEqual([]);
  });

  it("carries no field a caller could mistake for permission to run", () => {
    for (const v of buildSkillViews(realisticReport())) {
      const keys = Object.keys(v);
      expect(keys).not.toContain("execute");
      expect(keys).not.toContain("run");
      expect(keys).not.toContain("handler");
      expect(keys).not.toContain("allowed");
      for (const value of Object.values(v)) expect(typeof value).not.toBe("function");
    }
  });

  it("is inert as a catalogue too — no definition carries anything callable", () => {
    for (const s of SKILL_CATALOG) {
      for (const value of Object.values(s)) expect(typeof value).not.toBe("function");
    }
  });
});

// ---------------------------------------------------------------------------
// E. Availability follows the existing CapabilityService semantics
// ---------------------------------------------------------------------------

describe("E. a skill state is derived from its members", () => {
  it("reports the BEST member, so one blocked tool does not deny the outcome", () => {
    const views = buildSkillViews(
      report([
        cap("meta.insights", "Read Meta insights", "EXECUTABLE", { integration: "meta" }),
        cap("meta.campaign.pause", "Pause a campaign", "NOT_CONNECTED", {
          integration: "meta",
          reason: "Meta write access is not granted.",
        }),
      ])
    );
    expect(skill(views, "advertising").availability).toBe("EXECUTABLE");
  });

  it("does not hide the degradation — it counts it and explains it", () => {
    const workspace = skill(buildSkillViews(realisticReport()), "workspace");

    expect(workspace.availability).toBe("NOT_CONNECTED");
    expect(workspace.usableCount).toBe(0);
    expect(workspace.unavailableCount).toBe(3); // two Gmail + one planned Sheets
    expect(workspace.totalCount).toBe(3);
    expect(workspace.blockedBy).toEqual(["Google is not connected."]); // de-duplicated
  });

  it("counts a confirmation-gated member as usable, and says how many", () => {
    const ads = skill(buildSkillViews(realisticReport()), "advertising");
    expect(ads.usableCount).toBe(3);
    expect(ads.approvalCount).toBe(1);
    expect(ads.unavailableCount).toBe(0);
  });

  it("keeps a PLANNED member out of toolIds — it has no tool to name", () => {
    const workspace = skill(buildSkillViews(realisticReport()), "workspace");
    expect(workspace.toolIds).toEqual(["gmail.listUnread", "gmail.search"]);
    expect(workspace.totalCount).toBe(3);
    expect(workspace.toolIds).not.toContain("calendar.schedule");
  });

  it("derives integrations from members, de-duplicated", () => {
    const views = buildSkillViews(realisticReport());
    expect(skill(views, "advertising").integrations).toEqual(["meta"]);
    expect(skill(views, "workspace").integrations).toEqual(["google"]);
    expect(skill(views, "places").integrations).toEqual(["google-maps"]);
  });

  it("leaves blockedBy empty when the skill is whole", () => {
    expect(skill(buildSkillViews(realisticReport()), "places").blockedBy).toEqual([]);
  });

  it("changes state when the report does, with no other input", () => {
    const connected = realisticReport().capabilities.map((c) =>
      c.id.startsWith("gmail.")
        ? { ...c, availability: "EXECUTABLE" as const, reason: null, requiredAction: null }
        : c
    );
    const workspace = skill(buildSkillViews(report(connected)), "workspace");
    expect(workspace.availability).toBe("EXECUTABLE");
    expect(workspace.usableCount).toBe(2);
    expect(workspace.blockedBy).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// F. "What can you do?" is unchanged by the promotion
// ---------------------------------------------------------------------------

describe("F. the existing capability briefing still answers as it did", () => {
  it("keeps the group vocabulary the briefing has always used", () => {
    expect(CAPABILITY_GOAL_GROUP_IDS).toEqual(SKILL_CATALOG.map((s) => s.id));
  });

  it("titles a briefing group exactly as the skill titles itself", () => {
    for (const g of buildCapabilityBriefing(realisticReport()).groups) {
      const s = SKILL_CATALOG.find((x) => x.id === g.id);
      expect(s?.title).toBe(g.title);
      expect(s?.summary).toBe(g.summary);
    }
  });

  it("agrees with the skill view about what the user can ask for", () => {
    const r = realisticReport();
    const briefing = buildCapabilityBriefing(r);
    const views = buildSkillViews(r);
    for (const g of briefing.groups) {
      expect(skill(views, g.id).youCanAsk).toEqual(g.youCanAsk);
      expect(skill(views, g.id).usableCount).toBe(g.capabilityCount);
      expect(skill(views, g.id).approvalCount).toBe(g.approvalCount);
    }
  });

  it("still puts no raw tool id in front of the model", () => {
    const everything = JSON.stringify(buildCapabilityBriefing(realisticReport()));
    expect(everything).not.toMatch(/"[a-z]+\.[a-z.]+"/);
  });
});

// ---------------------------------------------------------------------------
// G. A newly registered tool is picked up without editing the catalogue
// ---------------------------------------------------------------------------

describe("G. discovery is dynamic", () => {
  it("adds an unknown tool to its skill by prefix alone", () => {
    const views = buildSkillViews(
      report([
        cap("maps.traffic", "Check live traffic", "EXECUTABLE", { integration: "google-maps" }),
      ])
    );
    const places = skill(views, "places");
    expect(places.toolIds).toContain("maps.traffic");
    expect(places.youCanAsk).toContain("check live traffic");
  });

  it("counts a tool it cannot phrase, rather than quoting its id", () => {
    const views = buildSkillViews(report([cap("maps.geocode.v2", "maps.geocode.v2", "EXECUTABLE")]));
    const places = skill(views, "places");
    expect(places.totalCount).toBe(1);
    expect(places.youCanAsk).toEqual([]);
  });

  it("ignores a tool no skill owns instead of inventing a home for it", () => {
    expect(buildSkillViews(report([cap("orphan.tool", "An orphan", "EXECUTABLE")]))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// H. The gap S1 deliberately did not close
// ---------------------------------------------------------------------------

describe("H. a capability no skill owns is still reported, just not as a skill", () => {
  // `google.sheets` matches no prefix — `workspace` claims `google.plan.`, not
  // `google.`. Widening that prefix would change the accepted answer to "What
  // can you do?", which is not a thing to do in a foundation phase. It is
  // recorded here so the next phase changes it on purpose, with a decision.
  it("leaves google.* out of every skill", () => {
    expect(skillForToolId("google.sheets")).toBeUndefined();
    expect(skillForToolId("google.docs")).toBeUndefined();
  });

  it("but the briefing still names it under planned, so nothing is lost", () => {
    expect(buildCapabilityBriefing(realisticReport()).planned).toContain("Google Sheets");
  });

  it("leaves the Core V1 task tools out too — the prefix is tasks., the ids are task.", () => {
    expect(skillForToolId("task.create")).toBeUndefined();
    expect(skillForToolId("tasks.list")?.id).toBe("productivity");
  });
});

// ---------------------------------------------------------------------------
// I. There is still exactly one way to run a tool
// ---------------------------------------------------------------------------

describe("I. S1 added no runtime", () => {
  const repo = (p: string) => new URL(`../../../${p}`, import.meta.url);

  it("created no competing skill engine anywhere in the repository", () => {
    for (const path of ["packages/skills", "apps/api/src/skills", "skills"]) {
      expect(existsSync(repo(path)), path).toBe(false);
    }
  });

  it("left ToolExecutor with no idea skills exist", () => {
    const source = readFileSync(repo("packages/tools/src/executor.ts"), "utf8");
    expect(source.toLowerCase()).not.toContain("skill");
  });

  it("keeps the skill contract free of anything that could perform work", () => {
    const source = readFileSync(repo("packages/core/src/types/skill.ts"), "utf8");
    // The only import a pure contract needs is the availability type.
    const imports = [...source.matchAll(/^import .*?from "(.+?)";$/gm)].map((m) => m[1]);
    expect(imports).toEqual(["./capability.js"]);

    // Types only. No function, no class, no arrow — so there is nothing in the
    // contract a caller could invoke even by mistake. (Comments are stripped
    // first: the header explains at length that there is no `execute()`.)
    const code = source.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/\bfunction\b/);
    expect(code).not.toMatch(/\bclass\b/);
    expect(code).not.toMatch(/\bexecute\b/);
    expect(code).not.toContain("=>");
  });
});
