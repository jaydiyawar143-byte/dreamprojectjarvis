// S8.4 — the MCP grant, in the policy census.
//
// MCP tools reach exactly one agent — the general assistant — as one group,
// MCP_READ_TOOLS, derived from the reviewed manifest and nothing else. No MCP
// id is written into any policy by hand, no allowlist gains a wildcard, and
// background tasks never see the group. The shipped manifest is empty, so
// every allowlist keeps exactly the size it had before S8.
// (The same grant over a non-empty reviewed manifest is exercised end to end
// in apps/api/test/mcp-wiring-s8.test.ts.)
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { MCP_MANIFEST, VOICE_REFUSED_TOOLS, mcpReadToolIds } from "@jarvis/core";
import { AGENT_IDS, AGENT_POLICIES, MCP_READ_TOOLS, isToolAllowed, schedulableToolIds } from "../src/agent-policy.js";

const SOURCE = readFileSync(new URL("../src/agent-policy.ts", import.meta.url), "utf8");

describe("the MCP grant", () => {
  it("is the reviewed manifest's enabled tools, as one group", () => {
    expect(MCP_READ_TOOLS).toEqual(mcpReadToolIds(MCP_MANIFEST));
    // S8.6 / S8.8 — the two reviewed servers, in manifest order.
    expect(MCP_READ_TOOLS).toEqual([
      "mcp.dates.days_between",
      "mcp.dates.day_of_week",
      "mcp.units.convert_length",
      "mcp.units.convert_temperature",
    ]);
  });

  it("is spread into exactly one policy: the general assistant's", () => {
    expect([...SOURCE.matchAll(/\.\.\.MCP_READ_TOOLS\b/g)]).toHaveLength(1);
    const general = SOURCE.slice(SOURCE.indexOf("const GENERAL_POLICY"), SOURCE.indexOf("const META_ADS_POLICY"));
    expect(general).toContain("...MCP_READ_TOOLS");
  });

  it("names no MCP tool by hand anywhere in the policy", () => {
    expect(SOURCE).not.toMatch(/["'`]mcp[.-]/);
  });

  it("reaches no other agent", () => {
    for (const [agentId, policy] of Object.entries(AGENT_POLICIES)) {
      if (agentId === AGENT_IDS.general) continue;
      for (const id of MCP_READ_TOOLS) expect(isToolAllowed(id, policy.allowedTools), `${agentId}/${id}`).toBe(false);
    }
  });

  it("adds no wildcard to any allowlist", () => {
    for (const [agentId, policy] of Object.entries(AGENT_POLICIES)) {
      for (const id of policy.allowedTools) {
        expect(id, `${agentId}: ${id}`).toMatch(/^[a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/);
      }
    }
  });

  it("leaves every allowlist exactly the size it was, plus the reviewed MCP group for the general assistant", () => {
    const sizes = Object.fromEntries(Object.entries(AGENT_POLICIES).map(([id, p]) => [id, p.allowedTools.length]));
    // Phase 15 changed two entries, on purpose, and nothing else:
    //   - the general assistant gained the marketing workspace WITHOUT
    //     publishing: 8 reads + 5 own-store writes + 2 page reads = 15;
    //   - the marketing agent is new: those 15, the 2 publish tools, the 6 Meta
    //     reads, the 7 integration reads, the 4 capability tools and
    //     self.describe = 35.
    // Every other allowlist is the size it was.
    expect(sizes).toEqual({
      "conversational-assistant": 74 + 15 + MCP_READ_TOOLS.length,
      "meta-ads-agent": 27,
      "google-ads-agent": 40,
      "knowledge-agent": 5,
      "analytics-agent": 22,
      // Phase 18.2 — plus the three workflow library tools; 18.3B inspect and propose;
      // 18.4 match and the four draft tools.
      "automation-agent": 23,
      "communication-agent": 13,
      "browser-agent": 15,
      "location-agent": 20,
      "marketing-agent": 35,
      // Phase 19.7 — new: the two desktop tools, the 4 capability tools and
      // self.describe. It holds nothing that reads the outside world.
      "desktop-agent": 7,
    });
  });
});

describe("scheduled work", () => {
  it("may reach everything any agent may call — except the MCP group and what speech may not start", () => {
    // Phase 18.3A — a task can outlive the spoken turn that scheduled it, so
    // the tools on the voice list are not task tools (see schedulableToolIds).
    const spokenNever = Object.keys(VOICE_REFUSED_TOOLS);
    const union = Object.values(AGENT_POLICIES).flatMap((policy) => [...policy.allowedTools]);
    const expected = new Set(
      union.filter((id) => !(MCP_READ_TOOLS as readonly string[]).includes(id) && !spokenNever.includes(id))
    );
    const schedulable = schedulableToolIds();
    expect([...schedulable].sort()).toEqual([...expected].sort());
    for (const id of MCP_READ_TOOLS) expect(schedulable.has(id), id).toBe(false);
    // Phase 19.1 adds sensitive browser/desktop actions to the same list.
    expect(spokenNever).toContain("automation.library.sync");
    for (const id of spokenNever) expect(schedulable.has(id), id).toBe(false);
  });
});
