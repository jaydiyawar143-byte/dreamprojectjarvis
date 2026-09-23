// ---------------------------------------------------------------------------
// Skill System V1 — Phase S1, the boundary tests.
//
// The core tests prove a `SkillView` is derived from the report it is handed.
// These prove the thing that report is derived FROM has not moved: the
// compile-time agent allowlist is still the only thing that decides whether a
// tool may run, and a skill naming a tool does not add it to any allowlist.
//
// DISCOVERY IS NOT AUTHORIZATION. This is the property that must survive every
// later phase — MCP tools, learned skills, dynamically registered providers.
// Whatever a skill claims membership of, `isToolAllowed` is unmoved by it,
// because `agent-policy.ts` does not import the catalogue and cannot.
//
// The second half is a coverage census. It is a pin, not an aspiration: it
// records exactly which allowlisted tools no skill owns TODAY, so that the
// phase which changes that does so on purpose rather than by accident.
// ---------------------------------------------------------------------------

import { readdirSync, readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { SKILL_CATALOG, SKILL_UNLISTED_TOOLS, skillForToolId } from "@jarvis/core";
import { AGENT_POLICIES, isToolAllowed } from "../src/agent-policy.js";

/** Every tool id some agent is permitted to call, anywhere in the build. */
const ALLOWLISTED: readonly string[] = [
  ...new Set(Object.values(AGENT_POLICIES).flatMap((p) => [...p.allowedTools])),
].sort();

function skillOf(toolId: string): string | undefined {
  return skillForToolId(toolId)?.id;
}

/**
 * Tool-id string literals as they appear in the source that implements tools.
 *
 * `packages/tools/src` is where every tool is built. The one exception is the
 * browser set, whose ids live in a constant map in `@jarvis/core` that
 * `browser-tools.ts` builds from — so that file is read too. Everything else
 * that mentions an id (policies, catalogues, this test) is a CONSUMER, and
 * reading those would defeat the purpose: a phantom id is one that only the
 * consumers know about.
 */
const IMPLEMENTATION_SOURCE: string = [
  ...walk(new URL("../../tools/src/", import.meta.url)),
  new URL("../../core/src/types/browser.ts", import.meta.url),
]
  .map((u) => readFileSync(u, "utf8"))
  .join(" ");

function walk(dir: URL): URL[] {
  const out: URL[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) out.push(...walk(child));
    else if (entry.name.endsWith(".ts")) out.push(child);
  }
  return out;
}

function isDeclared(toolId: string): boolean {
  return IMPLEMENTATION_SOURCE.includes(`"${toolId}"`);
}

// ---------------------------------------------------------------------------
// The boundary
// ---------------------------------------------------------------------------

describe("a skill does not authorize anything", () => {
  it("cannot grant an agent a tool its own policy omits", () => {
    // `meta.campaign.create` is a member of the advertising skill. Every agent
    // that is not permitted it must still be refused it.
    const denied = Object.entries(AGENT_POLICIES).filter(
      ([, p]) => !p.allowedTools.includes("meta.campaign.create")
    );
    expect(denied.length).toBeGreaterThan(0);
    for (const [agentId, policy] of denied) {
      expect(isToolAllowed("meta.campaign.create", policy.allowedTools), agentId).toBe(false);
    }
  });

  it("cannot grant a tool that exists nowhere, however the skill spells it", () => {
    // A future learned or MCP-sourced member, arriving as a plausible id.
    for (const s of SKILL_CATALOG) {
      const invented = `${s.prefixes[0] ?? `${s.id}.`}learnedFromUsage`;
      expect(skillOf(invented) ?? s.id).toBe(s.id); // the skill WOULD claim it
      for (const [agentId, policy] of Object.entries(AGENT_POLICIES)) {
        expect(isToolAllowed(invented, policy.allowedTools), `${agentId}/${invented}`).toBe(false);
      }
    }
  });

  it("is structurally incapable of it — the policy cannot see the catalogue", () => {
    // The strongest form of the guarantee: `agent-policy.ts` does not import
    // the skill catalogue, so no edit to a skill can widen a grant even by
    // mistake. Asserted on the source because that is where the property is.
    const source = readFileSync(
      new URL("../src/agent-policy.ts", import.meta.url),
      "utf8"
    );
    expect(source).not.toContain("SKILL_CATALOG");
    expect(source).not.toContain("skillForToolId");
    expect(source).not.toContain("SkillDefinition");
    expect(source).not.toContain("capability-presentation");
  });
});

// ---------------------------------------------------------------------------
// Membership resolves the same way for every real tool
// ---------------------------------------------------------------------------

describe("membership over the real tool set", () => {
  it("gives every allowlisted tool at most one skill", () => {
    for (const id of ALLOWLISTED) {
      const owners = SKILL_CATALOG.filter(
        (s) => s.exact?.includes(id) || s.prefixes.some((p) => id.startsWith(p))
      );
      expect(owners.length, `${id} -> ${owners.map((o) => o.id).join(", ")}`).toBeLessThanOrEqual(1);
    }
  });

  it("resolves deterministically — the same id, the same skill, every time", () => {
    for (const id of ALLOWLISTED) expect(skillOf(id)).toBe(skillOf(id));
  });

  it("names a skill for the overwhelming majority of real tools", () => {
    const owned = ALLOWLISTED.filter((id) => skillOf(id));
    expect(owned.length / ALLOWLISTED.length).toBeGreaterThan(0.9);
  });
});

// ---------------------------------------------------------------------------
// The census — what S1 deliberately left uncovered
// ---------------------------------------------------------------------------

describe("coverage census — every real tool is accounted for", () => {
  it("leaves no allowlisted tool unexplained: a skill owns it, or it is listed as unlisted", () => {
    // S2 closed the census. Before it, eight allowlisted tools simply had no
    // skill and no reason; now every one of them is either a member or carries
    // a written justification for not being one. A NEW orphan fails here.
    const unlisted = new Set(SKILL_UNLISTED_TOOLS.map((u) => u.id));
    const unexplained = ALLOWLISTED.filter((id) => !skillOf(id) && !unlisted.has(id));
    expect(unexplained).toEqual([]);
  });

  it("pins the intentional orphans exactly", () => {
    // Each is a decision recorded in SKILL_UNLISTED_TOOLS with its reason.
    expect(ALLOWLISTED.filter((id) => !skillOf(id))).toEqual([
      "self.describe",
      "task.create",
      "task.get",
      "task.list",
      "task.updateStatus",
    ]);
  });

  it("has no phantom phrase left — every curated phrasing names a callable tool", () => {
    // S1 found one: `knowledge.search`, which no tool in this build declares
    // and no agent may call, so the phrase could never render. S2 removed it.
    // Knowledge retrieval is real here, but it is an ORCHESTRATOR step rather
    // than a tool, so there is nothing to gate a phrase on.
    const allowed = new Set(ALLOWLISTED);
    const dead = SKILL_CATALOG.flatMap((s) =>
      s.phrases.filter((p) => !allowed.has(p.requires)).map((p) => p.requires)
    );
    expect(dead).toEqual([]);
  });

  it("adopts the Google Ads read tools without touching their authorization", () => {
    // S2's one membership addition among allowlisted tools. Their labels in
    // capability-catalog already read "Google Ads"; only the skill layer
    // disagreed, because it matched on a prefix (`google.ads.`) that no tool
    // has ever had.
    for (const id of ["google.accounts", "google.campaigns", "google.insights"]) {
      expect(skillOf(id), id).toBe("advertising");
      // Authorization is exactly what it was: the three agents GOOGLE_READ_TOOLS
      // was already granted to, and no others.
      const granted = Object.entries(AGENT_POLICIES)
        .filter(([, p]) => p.allowedTools.includes(id))
        .map(([a]) => a)
        .sort();
      expect(granted, id).toEqual([
        "analytics-agent",
        "conversational-assistant",
        "google-ads-agent",
      ]);
    }
  });

  it("keeps the unlisted tools every bit as callable as they were", () => {
    // The register is documentation, not a denial. self.describe is granted to
    // all nine agents and stays that way; task.* stays on the general
    // assistant alone.
    const agentsFor = (id: string) =>
      Object.values(AGENT_POLICIES).filter((p) => p.allowedTools.includes(id)).length;
    expect(agentsFor("self.describe")).toBe(Object.keys(AGENT_POLICIES).length);
    for (const id of ["task.create", "task.get", "task.list", "task.updateStatus"]) {
      expect(agentsFor(id), id).toBe(1);
    }
  });

  it("gives every unlisted entry a real, allowlisted-or-declared id and a reason", () => {
    for (const u of SKILL_UNLISTED_TOOLS) {
      expect(isDeclared(u.id), `${u.id} is not a real tool`).toBe(true);
      expect(skillOf(u.id), `${u.id} is both unlisted and a skill member`).toBeUndefined();
      expect(u.reason.length, u.id).toBeGreaterThan(20);
      expect(u.reason, u.id).not.toMatch(/TODO|TBD|FIXME/i);
    }
    const ids = SKILL_UNLISTED_TOOLS.map((u) => u.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps the two task namespaces apart, in both directions", () => {
    // `tasks.list` (the user's to-do list) is a skill member; `task.list`
    // (JARVIS's own work) is not. Widening the productivity prefix from
    // `tasks.` to `task.` would merge two different questions about two
    // different tables, which is why this is asserted rather than assumed.
    expect(skillOf("tasks.list")).toBe("productivity");
    for (const id of ALLOWLISTED.filter((i) => i.startsWith("task."))) {
      expect(skillOf(id), id).toBeUndefined();
    }
  });

  it("names no phantom tool — every member id is implemented somewhere in this build", () => {
    // The distinction S2 turns on. A member need not be AUTHORIZED (membership
    // is semantic; the allowlist filters later, in CapabilityService). But it
    // must EXIST, or the catalogue is describing something that was never
    // built — which is exactly what `knowledge.search` was.
    for (const s of SKILL_CATALOG) {
      for (const e of s.exact ?? []) expect(isDeclared(e), `${s.id}: ${e}`).toBe(true);
      for (const p of s.phrases) expect(isDeclared(p.requires), `${s.id}: ${p.requires}`).toBe(true);
    }
  });

  it("knows a phantom when it sees one", () => {
    // Guards the guard: if `isDeclared` ever returned true for everything, the
    // test above would pass while asserting nothing.
    expect(isDeclared("knowledge.search")).toBe(false);
    expect(isDeclared("meta.insights")).toBe(true);
  });

  it("holds members that exist but no agent may call — and they stay unreachable", () => {
    // `web.research`, `document.analyze` and `pdf.generate` are real research
    // tools that no policy grants. They are skill members because membership
    // describes what a tool is FOR; they are absent from every capability
    // report because CapabilityService skips any tool outside the allowlist.
    // Two axes, kept apart — the same rule connection/health follows.
    const allowed = new Set(ALLOWLISTED);
    for (const id of ["web.research", "document.analyze", "pdf.generate"]) {
      expect(isDeclared(id), id).toBe(true);
      expect(skillOf(id), id).toBe("research");
      expect(allowed.has(id), id).toBe(false);
      for (const [agentId, policy] of Object.entries(AGENT_POLICIES)) {
        expect(isToolAllowed(id, policy.allowedTools), `${agentId}/${id}`).toBe(false);
      }
    }
  });
});
