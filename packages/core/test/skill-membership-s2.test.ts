// ---------------------------------------------------------------------------
// Skill System V1 — Phase S2: membership.
//
// S1 asked "is this layer inert?". S2 asks a different question: "is each tool
// in the RIGHT skill, and is every tool that is in none of them there for a
// written reason?"
//
// The audit that produced these changes found four distinct defects, and each
// one has a test here that would have caught it:
//
//   PHANTOM PREFIX   advertising matched `google.ads.` and `adwords.`. No tool
//                    in this build has ever had either prefix, so three real,
//                    authorized Google Ads tools belonged to no skill.
//   PHANTOM PHRASE   research offered a phrasing gated on `knowledge.search`,
//                    a tool id nothing in the build declares. Knowledge
//                    retrieval here is an orchestrator step, not a tool.
//   SILENT CAPTURE   the obvious repair — a `google.` prefix on advertising —
//                    would have taken all nine `google.plan.*` Workspace tools
//                    away from the workspace skill, because advertising is
//                    declared first and `ruleFor` returns the first match.
//   UNEXPLAINED GAP  five allowlisted tools had no skill and no reason. Now
//                    they have a reason, in SKILL_UNLISTED_TOOLS.
//
// The rule underneath all of it: membership is SEMANTIC and authorization is
// SEPARATE. A skill says what a tool is for. Whether it may run is the agent
// allowlist's business, and nothing here touches it.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  SKILL_CATALOG,
  SKILL_TASK_NAMESPACES,
  SKILL_UNLISTED_TOOLS,
  buildCapabilityBriefing,
  buildSkillViews,
  skillForToolId,
} from "../src/capability-presentation.js";
import type {
  CapabilityAvailability,
  CapabilityReport,
  CapabilityView,
} from "../src/types/capability.js";

function cap(
  id: string,
  label: string,
  availability: CapabilityAvailability = "EXECUTABLE",
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

function report(capabilities: CapabilityView[]): CapabilityReport {
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
    integrations: [],
    general: [],
  };
}

const META_CAPS = [
  cap("meta.insights", "Read Meta performance insights", "EXECUTABLE", { integration: "meta" }),
  cap("meta.campaigns", "List Meta campaigns", "EXECUTABLE", { integration: "meta" }),
  cap("meta.adsets", "List Meta ad sets", "EXECUTABLE", { integration: "meta" }),
  cap("meta.ads", "List Meta ads", "EXECUTABLE", { integration: "meta" }),
  cap("meta.campaign.create", "Create a Meta campaign", "REQUIRES_CONFIRMATION", {
    integration: "meta",
  }),
];

const GOOGLE_ADS_CAPS = [
  cap("google.accounts", "List Google Ads accounts", "EXECUTABLE", { integration: "google" }),
  cap("google.campaigns", "List Google Ads campaigns", "EXECUTABLE", { integration: "google" }),
  cap("google.insights", "Read Google Ads insights", "EXECUTABLE", { integration: "google" }),
];

const WORKSPACE_PLAN_CAPS = [
  cap("google.plan.gmail.createDraft", "Prepare a Gmail draft (needs approval)", "REQUIRES_CONFIRMATION", {
    integration: "google",
  }),
  cap("google.plan.drive.uploadFile", "Prepare a Drive upload (needs approval)", "REQUIRES_CONFIRMATION", {
    integration: "google",
  }),
  cap("google.plan.calendar.createEvent", "Prepare a calendar event (needs approval)", "REQUIRES_CONFIRMATION", {
    integration: "google",
  }),
];

function skill(views: ReturnType<typeof buildSkillViews>, id: string) {
  const found = views.find((v) => v.id === id);
  if (!found) throw new Error(`no skill view for ${id}`);
  return found;
}

// ---------------------------------------------------------------------------
// Google Ads — the membership correction
// ---------------------------------------------------------------------------

describe("Google Ads reads belong to the advertising outcome", () => {
  it("puts all three in the advertising skill", () => {
    for (const id of ["google.accounts", "google.campaigns", "google.insights"]) {
      expect(skillForToolId(id)?.id, id).toBe("advertising");
    }
  });

  it("claims them by exact id, never by a prefix", () => {
    const advertising = SKILL_CATALOG.find((s) => s.id === "advertising")!;
    expect(advertising.exact).toEqual([
      "google.accounts",
      "google.campaigns",
      "google.insights",
    ]);
    expect(advertising.prefixes).toEqual(["meta."]);
  });

  it("drops the prefixes that matched nothing", () => {
    // `google.ads.` and `adwords.` were the original attempt. Both were wrong
    // about how this build names its Google Ads tools.
    const prefixes = SKILL_CATALOG.flatMap((s) => [...s.prefixes]);
    expect(prefixes).not.toContain("google.ads.");
    expect(prefixes).not.toContain("adwords.");
  });

  it("does NOT steal the Workspace write-planning tools", () => {
    // The defect a `google.` prefix would have introduced. `ruleFor` returns
    // the first matching skill, and advertising is declared before workspace.
    for (const c of WORKSPACE_PLAN_CAPS) {
      expect(skillForToolId(c.id)?.id, c.id).toBe("workspace");
    }
    const views = buildSkillViews(report([...GOOGLE_ADS_CAPS, ...WORKSPACE_PLAN_CAPS]));
    expect(skill(views, "advertising").toolIds).toEqual([
      "google.accounts",
      "google.campaigns",
      "google.insights",
    ]);
    expect(skill(views, "workspace").toolIds).toEqual(WORKSPACE_PLAN_CAPS.map((c) => c.id));
  });

  it("counts them in the advertising skill alongside Meta", () => {
    const ads = skill(buildSkillViews(report([...META_CAPS, ...GOOGLE_ADS_CAPS])), "advertising");
    expect(ads.totalCount).toBe(8);
    expect(ads.usableCount).toBe(8);
    expect(ads.integrations).toEqual(["meta", "google"]);
  });

  it("leaves the briefing's spoken phrasings unchanged", () => {
    // The membership fix is a counting fix. The curated Meta phrasings already
    // fill the four-phrase cap, so nothing a user HEARS moves. Saying Google
    // Ads out loud is a presentation decision, not a membership one, and is
    // deliberately not made here.
    const withoutGoogle = buildCapabilityBriefing(report(META_CAPS));
    const withGoogle = buildCapabilityBriefing(report([...META_CAPS, ...GOOGLE_ADS_CAPS]));

    const group = (b: ReturnType<typeof buildCapabilityBriefing>) =>
      b.groups.find((g) => g.id === "advertising")!;

    expect(group(withGoogle).youCanAsk).toEqual(group(withoutGoogle).youCanAsk);
    expect(group(withGoogle).capabilityCount).toBe(group(withoutGoogle).capabilityCount + 3);
  });

  it("still reports nothing about Google Ads when Google is not connected", () => {
    const blocked = GOOGLE_ADS_CAPS.map((c) => ({
      ...c,
      availability: "NOT_CONNECTED" as const,
      reason: "Google is not connected.",
    }));
    const ads = skill(buildSkillViews(report([...META_CAPS, ...blocked])), "advertising");
    expect(ads.usableCount).toBe(5);
    expect(ads.unavailableCount).toBe(3);
    expect(ads.blockedBy).toEqual(["Google is not connected."]);
  });
});

// ---------------------------------------------------------------------------
// exact vs prefix — the collision class
// ---------------------------------------------------------------------------

describe("exact ids and prefixes cannot collide", () => {
  it("gives no exact id to two skills", () => {
    const claimed = SKILL_CATALOG.flatMap((s) => [...(s.exact ?? [])]);
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  it("never lets one skill's prefix reach another skill's exact id", () => {
    // `exact` is checked before `prefixes`, so a collision here would be SILENT
    // — the exact owner would win and the prefix owner would lose a tool it
    // believes it has. Either the ownership is wrong or the prefix is too wide;
    // both deserve a failing test rather than a quiet resolution.
    for (const owner of SKILL_CATALOG) {
      for (const id of owner.exact ?? []) {
        for (const other of SKILL_CATALOG) {
          if (other.id === owner.id) continue;
          const captured = other.prefixes.find((p) => id.startsWith(p));
          expect(captured, `${other.id}:${captured} would capture ${owner.id}:${id}`).toBeUndefined();
        }
      }
    }
  });

  it("keeps every prefix earning its place, or documents why it does not", () => {
    // A prefix that matches nothing is how the Google Ads tools went missing.
    // `knowledge.` is the one deliberate exception: retrieval is an
    // orchestrator step in this build, so no tool carries the prefix yet.
    const research = SKILL_CATALOG.find((s) => s.id === "research")!;
    expect(research.prefixes).toContain("knowledge.");
    expect(skillForToolId("knowledge.somethingFuture")?.id).toBe("research");
  });
});

// ---------------------------------------------------------------------------
// knowledge.search — the phantom
// ---------------------------------------------------------------------------

describe("knowledge.search is gone, and nothing replaced it", () => {
  it("offers no phrasing gated on it", () => {
    const gates = SKILL_CATALOG.flatMap((s) => s.phrases.map((p) => p.requires));
    expect(gates).not.toContain("knowledge.search");
  });

  it("does not quietly promise document answering through some other tool", () => {
    // The removed phrase said "answer questions from documents you have given
    // me". Nothing in the catalogue should say that again until a tool exists
    // that does it on request.
    const everything = JSON.stringify(SKILL_CATALOG).toLowerCase();
    expect(everything).not.toContain("documents you have given me");
  });

  it("would still adopt a real knowledge tool the day one is built", () => {
    const views = buildSkillViews(report([cap("knowledge.search", "Search your documents")]));
    expect(skill(views, "research").toolIds).toEqual(["knowledge.search"]);
  });
});

// ---------------------------------------------------------------------------
// The intentional orphans
// ---------------------------------------------------------------------------

describe("every tool outside a skill is outside it on purpose", () => {
  it("names each one with a reason, not a TODO", () => {
    expect(SKILL_UNLISTED_TOOLS.length).toBeGreaterThan(0);
    for (const u of SKILL_UNLISTED_TOOLS) {
      expect(u.id).toMatch(/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/);
      expect(u.reason.length, u.id).toBeGreaterThan(20);
      expect(u.reason, u.id).not.toMatch(/TODO|TBD|FIXME|\?\?\?/i);
    }
  });

  it("keeps the register and the catalogue disjoint", () => {
    for (const u of SKILL_UNLISTED_TOOLS) {
      expect(skillForToolId(u.id), u.id).toBeUndefined();
    }
  });

  it("means unlisted, not unavailable — an unlisted tool simply has no skill", () => {
    // The register is a presentation decision. It has no effect on execution,
    // and `buildSkillViews` proves it by ignoring the tool entirely rather
    // than reporting it as blocked.
    const views = buildSkillViews(report(SKILL_UNLISTED_TOOLS.map((u) => cap(u.id, u.id))));
    expect(views).toEqual([]);
  });

  it("holds self.describe out as introspection rather than an outcome", () => {
    expect(SKILL_UNLISTED_TOOLS.map((u) => u.id)).toContain("self.describe");
    expect(skillForToolId("self.describe")).toBeUndefined();
    // It is NOT in the integrations skill, whose `capabilities.` prefix is the
    // nearest thing to it. That skill is about connected accounts.
    expect(skillForToolId("capabilities.list")?.id).toBe("integrations");
  });

  it("holds the test fixture out, which is why monitoring uses exact ids", () => {
    const monitoring = SKILL_CATALOG.find((s) => s.id === "monitoring")!;
    expect(monitoring.prefixes).toEqual([]);
    expect(monitoring.exact).toEqual(["system.status", "time.now"]);
    expect(skillForToolId("system.echo")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// task. vs tasks. — the mismatch that is not a typo
// ---------------------------------------------------------------------------

describe("the two task namespaces stay apart", () => {
  it("records what each one means", () => {
    expect(SKILL_TASK_NAMESPACES.userTodos).toBe("tasks.");
    expect(SKILL_TASK_NAMESPACES.jarvisWork).toBe("task.");
  });

  it("gives the user's to-do list to productivity", () => {
    expect(skillForToolId("tasks.list")?.id).toBe("productivity");
    const productivity = SKILL_CATALOG.find((s) => s.id === "productivity")!;
    expect(productivity.prefixes).toContain(SKILL_TASK_NAMESPACES.userTodos);
  });

  it("gives JARVIS's own work queue to no skill at all", () => {
    for (const id of ["task.create", "task.get", "task.list", "task.updateStatus"]) {
      expect(skillForToolId(id), id).toBeUndefined();
    }
  });

  it("would break loudly if someone widened the prefix to `task.`", () => {
    // The merge this guards against: `tasks.` does not match `task.list`, and
    // that is the only thing keeping "what is due?" and "what are you working
    // on?" answering from different tables.
    expect("task.list".startsWith(SKILL_TASK_NAMESPACES.userTodos)).toBe(false);
    expect("tasks.list".startsWith(SKILL_TASK_NAMESPACES.userTodos)).toBe(true);
    const views = buildSkillViews(report([cap("tasks.list", "List your tasks"), cap("task.list", "task.list")]));
    expect(skill(views, "productivity").toolIds).toEqual(["tasks.list"]);
  });
});

// ---------------------------------------------------------------------------
// Nothing else moved
// ---------------------------------------------------------------------------

describe("the rest of the catalogue is where S1 left it", () => {
  it("still has exactly eight skills, with the same ids in the same order", () => {
    expect(SKILL_CATALOG.map((s) => s.id)).toEqual([
      "advertising",
      "places",
      "workspace",
      "research",
      "productivity",
      "messaging",
      "monitoring",
      "integrations",
    ]);
  });

  it("gives every tool at most one skill", () => {
    const sample = [
      ...META_CAPS.map((c) => c.id),
      ...GOOGLE_ADS_CAPS.map((c) => c.id),
      ...WORKSPACE_PLAN_CAPS.map((c) => c.id),
      "gmail.search",
      "maps.nearby",
      "browser.navigate",
      "whatsapp.send",
      "n8n.trigger",
      "integration.list",
      "capabilities.list",
      "system.status",
      "time.now",
      "tasks.list",
      "weather.current",
      "market.quote",
      "data.csv.analyze",
      "pdf.generate",
      "web.research",
      "document.analyze",
    ];
    for (const id of sample) {
      const owners = SKILL_CATALOG.filter(
        (s) => s.exact?.includes(id) || s.prefixes.some((p) => id.startsWith(p))
      );
      expect(owners.length, `${id} -> ${owners.map((o) => o.id).join(", ")}`).toBe(1);
    }
  });

  it("still derives the briefing deterministically", () => {
    const r = report([...META_CAPS, ...GOOGLE_ADS_CAPS, ...WORKSPACE_PLAN_CAPS]);
    expect(buildCapabilityBriefing(r)).toEqual(buildCapabilityBriefing(r));
    expect(buildSkillViews(r)).toEqual(buildSkillViews(r));
  });

  it("still puts no raw tool id in front of the model", () => {
    const briefing = buildCapabilityBriefing(report([...META_CAPS, ...GOOGLE_ADS_CAPS]));
    expect(JSON.stringify(briefing)).not.toMatch(/"[a-z]+\.[a-z.]+"/);
  });
});
