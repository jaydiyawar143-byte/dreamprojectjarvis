// ---------------------------------------------------------------------------
// Skill System V1 — Phase S3: the projection.
//
// S3 gives the planner something the tool definitions cannot carry. A tool
// definition looks identical whether Google is connected or not, so a model
// handed seventy-three of them knows what exists and nothing about what works.
// `buildSkillContext` answers the second question, for ONE agent, from the
// live report.
//
// The whole safety argument is that it can only ever NARROW:
//
//   CapabilityService  drops every tool no agent policy grants
//   buildSkillContext  intersects what remains with THIS agent's allowlist
//
// There is no argument to this function that widens anything, and nothing it
// returns is consulted when a tool call is authorized. These tests pin that,
// and they pin the two things a projection can quietly get wrong: inheriting a
// healthy headline from a sibling the agent cannot call, and leaking a raw
// identifier into prose a model will repeat.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  buildSkillContext,
  buildSkillViews,
  renderSkillContext,
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

/** Meta connected, Google not, maps working — the shape of a real deployment. */
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
      cap("gmail.listUnread", "List unread Gmail", "NOT_CONNECTED", {
        integration: "google",
        reason: "Google is not connected.",
        requiredAction: "Connect your Google account.",
      }),
      cap("gmail.search", "Search Gmail", "NOT_CONNECTED", {
        integration: "google",
        reason: "Google is not connected.",
        requiredAction: "Connect your Google account.",
      }),
      cap("system.status", "This machine telemetry", "EXECUTABLE"),
      cap("time.now", "Current date and time", "EXECUTABLE"),
    ],
    [
      integration("meta", "Meta Ads", "CONNECTED"),
      integration("google-maps", "Google Maps", "CONNECTED"),
      integration("google", "Google", "NOT_CONNECTED"),
    ]
  );
}

const EVERYTHING = new Set(realisticReport().capabilities.map((c) => c.id));

function ctx(contexts: ReturnType<typeof buildSkillContext>, id: string) {
  const found = contexts.find((c) => c.id === id);
  if (!found) throw new Error(`no skill context for ${id}`);
  return found;
}

// ---------------------------------------------------------------------------
// A. Only tools the selected agent may call
// ---------------------------------------------------------------------------

describe("A. the context is scoped to the agent that will actually run", () => {
  it("names only tools inside the agent's allowlist", () => {
    const allowed = new Set(["meta.insights", "meta.campaigns"]);
    const contexts = buildSkillContext(realisticReport(), allowed);

    expect(contexts.flatMap((c) => c.toolIds)).toEqual(["meta.insights", "meta.campaigns"]);
  });

  it("shrinks as the allowlist shrinks, and never the other way", () => {
    const wide = buildSkillContext(realisticReport(), EVERYTHING);
    const narrow = buildSkillContext(realisticReport(), new Set(["maps.nearby"]));

    const wideIds = new Set(wide.flatMap((c) => c.toolIds));
    for (const id of narrow.flatMap((c) => c.toolIds)) expect(wideIds.has(id)).toBe(true);
    expect(narrow.flatMap((c) => c.toolIds)).toEqual(["maps.nearby"]);
  });

  it("cannot be talked into a tool the report never contained", () => {
    // The allowlist is not a source of capabilities. An id in the allowlist
    // that the report does not carry contributes nothing.
    const contexts = buildSkillContext(
      realisticReport(),
      new Set(["meta.insights", "meta.campaign.create", "invented.tool"])
    );
    expect(contexts.flatMap((c) => c.toolIds)).toEqual(["meta.insights"]);
  });

  it("returns nothing at all for an empty allowlist", () => {
    expect(buildSkillContext(realisticReport(), new Set())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// C / D. Omission and partial membership
// ---------------------------------------------------------------------------

describe("C. a skill with no member this agent can call is omitted", () => {
  it("drops the skill entirely rather than reporting it empty", () => {
    // Maps is fully usable in the report, and completely out of reach for an
    // agent holding only Meta tools. Listing it would invite a call the
    // allowlist gate denies and audits.
    const contexts = buildSkillContext(realisticReport(), new Set(["meta.insights"]));
    expect(contexts.map((c) => c.id)).toEqual(["advertising"]);
  });

  it("omits a skill whose only reachable member is unavailable too? no — it keeps it", () => {
    // Unavailable is not unreachable. The agent CAN call gmail.search; it will
    // fail for a reason worth telling the user. That is exactly what blockedBy
    // is for, so the skill stays and carries the reason.
    const contexts = buildSkillContext(realisticReport(), new Set(["gmail.search"]));
    expect(contexts.map((c) => c.id)).toEqual(["workspace"]);
    expect(ctx(contexts, "workspace").availability).toBe("NOT_CONNECTED");
    expect(ctx(contexts, "workspace").blockedBy).toEqual(["Google is not connected."]);
  });
});

describe("D. partial membership exposes only the authorized part", () => {
  it("lists the reachable members and hides the rest", () => {
    const contexts = buildSkillContext(
      realisticReport(),
      new Set(["meta.insights", "maps.nearby"])
    );
    expect(ctx(contexts, "advertising").toolIds).toEqual(["meta.insights"]);
    expect(ctx(contexts, "advertising").toolIds).not.toContain("meta.campaign.pause");
    expect(ctx(contexts, "places").toolIds).toEqual(["maps.nearby"]);
  });

  it("recomputes availability over the reachable part, not the whole skill", () => {
    // THE PROJECTION BUG THIS GUARDS. `advertising` is EXECUTABLE overall
    // because meta.insights works. An agent that can reach only the blocked
    // member must not inherit that headline.
    const blockedWrite = realisticReport().capabilities.map((c) =>
      c.id === "meta.campaign.pause"
        ? { ...c, availability: "NEEDS_REAUTH" as const, reason: "Meta needs reauthorization." }
        : c
    );

    const wholeSkill = buildSkillContext(report(blockedWrite), EVERYTHING);
    expect(ctx(wholeSkill, "advertising").availability).toBe("EXECUTABLE");

    const onlyTheBlockedOne = buildSkillContext(
      report(blockedWrite),
      new Set(["meta.campaign.pause"])
    );
    expect(ctx(onlyTheBlockedOne, "advertising").availability).toBe("NEEDS_REAUTH");
    expect(ctx(onlyTheBlockedOne, "advertising").blockedBy).toEqual([
      "Meta needs reauthorization.",
    ]);
  });

  it("keeps the best-member rule within the reachable part", () => {
    const contexts = buildSkillContext(
      realisticReport(),
      new Set(["meta.insights", "meta.campaign.pause"])
    );
    expect(ctx(contexts, "advertising").availability).toBe("EXECUTABLE");
    expect(ctx(contexts, "advertising").blockedBy).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// I / J. Determinism and multi-skill
// ---------------------------------------------------------------------------

describe("I. the same inputs always produce the same context", () => {
  it("is pure — two calls are deeply equal", () => {
    expect(buildSkillContext(realisticReport(), EVERYTHING)).toEqual(
      buildSkillContext(realisticReport(), EVERYTHING)
    );
  });

  it("does not mutate the report or the allowlist", () => {
    const r = realisticReport();
    const allowed = new Set(EVERYTHING);
    const before = JSON.stringify(r);
    buildSkillContext(r, allowed);
    expect(JSON.stringify(r)).toBe(before);
    expect(allowed.size).toBe(EVERYTHING.size);
  });

  it("orders most-usable first, with a total ordering", () => {
    const contexts = buildSkillContext(realisticReport(), EVERYTHING);
    const rank = ["EXECUTABLE", "REQUIRES_CONFIRMATION", "NOT_CONNECTED"];
    const seen = contexts.map((c) => rank.indexOf(c.availability));
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  it("agrees with buildSkillViews about membership when nothing is narrowed", () => {
    // The projection must not invent or lose a skill relative to S1.
    const views = buildSkillViews(realisticReport()).filter((v) => v.toolIds.length > 0);
    const contexts = buildSkillContext(realisticReport(), EVERYTHING);
    expect([...contexts.map((c) => c.id)].sort()).toEqual([...views.map((v) => v.id)].sort());
    for (const c of contexts) {
      const view = views.find((v) => v.id === c.id)!;
      expect(c.title).toBe(view.title);
      expect(c.summary).toBe(view.summary);
      expect(c.toolIds).toEqual(view.toolIds);
    }
  });
});

describe("J. several skills can be relevant at once", () => {
  it("represents advertising and workspace together — no single-skill selection", () => {
    // "Check my ads and email me the summary." Nothing here picks a winner.
    const contexts = buildSkillContext(
      realisticReport(),
      new Set(["meta.insights", "gmail.search", "maps.nearby"])
    );
    expect(contexts.map((c) => c.id).sort()).toEqual(["advertising", "places", "workspace"]);
  });

  it("carries a per-skill state rather than one verdict for the turn", () => {
    const contexts = buildSkillContext(realisticReport(), EVERYTHING);
    expect(ctx(contexts, "advertising").availability).toBe("EXECUTABLE");
    expect(ctx(contexts, "workspace").availability).toBe("NOT_CONNECTED");
  });
});

// ---------------------------------------------------------------------------
// K. Nothing sensitive, nothing executable
// ---------------------------------------------------------------------------

describe("K. the context is inert and carries no secret", () => {
  it("has no callable field", () => {
    for (const c of buildSkillContext(realisticReport(), EVERYTHING)) {
      for (const value of Object.values(c)) expect(typeof value).not.toBe("function");
      expect(Object.keys(c)).not.toContain("execute");
    }
  });

  it("carries exactly the six declared fields and nothing more", () => {
    for (const c of buildSkillContext(realisticReport(), EVERYTHING)) {
      expect(Object.keys(c).sort()).toEqual([
        "availability",
        "blockedBy",
        "id",
        "summary",
        "title",
        "toolIds",
      ]);
    }
  });

  it("carries no account, credential or connection detail", () => {
    const withAccount = report(
      [
        cap("meta.insights", "Read Meta performance insights", "EXECUTABLE", {
          integration: "meta",
        }),
      ],
      [{ ...integration("meta", "Meta Ads", "CONNECTED"), account: "act_2478••••••1624" }]
    );
    const serialized = JSON.stringify(buildSkillContext(withAccount, new Set(["meta.insights"])));
    expect(serialized).not.toContain("act_");
    expect(serialized).not.toContain("token");
    expect(serialized).not.toMatch(/secret|apiKey|credential/i);
  });
});

// ---------------------------------------------------------------------------
// The rendered block
// ---------------------------------------------------------------------------

describe("the prose the model actually reads", () => {
  const rendered = () => renderSkillContext(buildSkillContext(realisticReport(), EVERYTHING));

  it("is empty when there is nothing to say, so the prompt is untouched", () => {
    expect(renderSkillContext([])).toBe("");
  });

  it("speaks in outcomes, not inventory", () => {
    const text = rendered();
    expect(text).toContain("Business and advertising");
    expect(text).toContain("Maps, places and travel");
  });

  it("puts no raw tool id in front of the model", () => {
    // The defect the capability briefing was rewritten to fix: a model shown an
    // id will eventually quote it to a user.
    const text = rendered();
    expect(text).not.toContain("meta.insights");
    expect(text).not.toContain("gmail.search");
    expect(text).not.toMatch(/\b[a-z]+\.[a-z][a-zA-Z.]+\b/);
  });

  it("leaks no risk level, parameter shape or integration id", () => {
    const text = rendered();
    expect(text).not.toContain("READ_ONLY");
    expect(text).not.toContain("REQUIRES_CONFIRMATION");
    expect(text).not.toContain("google-maps");
    expect(text).not.toMatch(/params|parameters|risk:/i);
  });

  it("says what is blocked, and why, in plain English", () => {
    const text = rendered();
    expect(text).toContain("Google is not connected.");
  });

  it("tells the model this is orientation and not a restriction", () => {
    // Without this the model reads the list as the set of things it may do and
    // stops calling the tools that belong to no skill on purpose —
    // self.describe, the task.* lifecycle.
    expect(rendered()).toContain("not a restriction");
  });

  it("is deterministic", () => {
    expect(rendered()).toBe(rendered());
  });
});
