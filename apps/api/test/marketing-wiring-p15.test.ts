// ---------------------------------------------------------------------------
// Phase 15 — the marketing workspace in the real composition root.
//
// Everything here is the real container: the real registry, the real agent
// policies, the real agents and the definitions they were actually handed.
// Nothing is mocked, and nothing reaches a network or a database — building
// the container opens no connection, and no tool is run.
//
// WHAT IT PINS.
//
//   1. Three registrations on three conditions. The workspace tools reach only
//      JARVIS's own database, so they are always there. The two page reads
//      exist only when an operator switched page reads on. The two publish
//      tools exist only when a publisher could be built.
//
//   2. Who is OFFERED what. Policy says who may call a tool; this checks the
//      function definitions each agent was given, because a tool that is
//      allowed and never offered cannot be reached from a conversation — which
//      is exactly what had happened to `meta.analyze` (finding F-1).
//
//   3. Publishing is offered to ONE agent. The general assistant can plan and
//      report; it is never handed a tool that posts.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MARKETING_LIMITS,
  MARKETING_PUBLISH_TOOL_IDS,
  MARKETING_READ_TOOL_IDS,
  MARKETING_RESEARCH_TOOL_IDS,
  MARKETING_TOOL_IDS,
  MARKETING_WORKSPACE_TOOL_IDS,
  type AIToolDefinition,
} from "@jarvis/core";
import { AGENT_IDS, AGENT_POLICIES } from "@jarvis/agents";
import { MetaGetInsightsTool } from "@jarvis/tools";
import { getContainer, resetContainer } from "../src/services/container.js";

const JWT_SECRET = "Zk4pQ7vR2mX9tL6wB3nH8sD5gY1jF0cA";
/** Shaped like the real things and good for nothing. No request is ever made with them. */
const FAKE_META_TOKEN = "p15-wiring-not-a-real-token";
const FAKE_META_ACCOUNT = "act_000000000000015";
const FAKE_OPENAI_KEY = "sk-test-p15-not-a-real-key";
/** A path with no browser at it: page reads must not need one. */
const NO_CHROME = "Z:\\p15\\no-such-browser.exe";

interface Environment {
  pageReads?: boolean;
  meta?: boolean;
  openai?: boolean;
}

let logged: string[];

function useEnvironment(env: Environment): void {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("JWT_SECRET", JWT_SECRET);
  vi.stubEnv("JARVIS_MCP_ENABLED", "false");
  vi.stubEnv("BROWSER_ENABLED", env.pageReads ? "true" : "false");
  vi.stubEnv("CHROME_PATH", NO_CHROME);
  vi.stubEnv("BROWSER_DOMAIN_ALLOWLIST", undefined);
  vi.stubEnv("META_ACCESS_TOKEN", env.meta ? FAKE_META_TOKEN : undefined);
  vi.stubEnv("META_AD_ACCOUNT_ID", env.meta ? FAKE_META_ACCOUNT : undefined);
  vi.stubEnv("OPENAI_API_KEY", env.openai ? FAKE_OPENAI_KEY : undefined);
}

/** The function definitions an agent was handed, by the names a model sees. */
function offeredTo(agentId: string): string[] {
  const agent = getContainer().agentRegistry.get(agentId) as unknown as { providerTools?: AIToolDefinition[] } | undefined;
  expect(agent, `${agentId} should be registered`).toBeDefined();
  return (agent!.providerTools ?? []).map((definition) => definition.name);
}

/** A registry id as a model is shown it: dots are not legal in a function name. */
const asOffered = (toolId: string): string => toolId.replace(/\./g, "-");

const registered = (toolId: string): boolean => getContainer().toolRegistry.get(toolId) !== undefined;

const WORKSPACE_AND_READS = [...MARKETING_READ_TOOL_IDS, ...MARKETING_WORKSPACE_TOOL_IDS];

beforeEach(() => {
  resetContainer();
  logged = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  resetContainer();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe("Phase 15 — a server with nothing connected", () => {
  beforeEach(() => useEnvironment({}));

  it("registers every workspace tool and every marketing read", () => {
    for (const id of WORKSPACE_AND_READS) expect(registered(id), id).toBe(true);
  });

  it("registers neither page read", () => {
    for (const id of MARKETING_RESEARCH_TOOL_IDS) expect(registered(id), id).toBe(false);
  });

  it("registers neither publish tool", () => {
    for (const id of MARKETING_PUBLISH_TOOL_IDS) expect(registered(id), id).toBe(false);
  });

  it("registers the marketing agent, because its workspace needs only the database", () => {
    expect(getContainer().agentRegistry.get(AGENT_IDS.marketing)).toBeDefined();
  });

  it("offers the marketing agent the workspace and nothing it could not run", () => {
    const offered = offeredTo(AGENT_IDS.marketing);

    for (const id of WORKSPACE_AND_READS) expect(offered, id).toContain(asOffered(id));
    for (const id of [...MARKETING_RESEARCH_TOOL_IDS, ...MARKETING_PUBLISH_TOOL_IDS]) {
      expect(offered, id).not.toContain(asOffered(id));
    }
    // No ad account is connected, so no ad-account read is offered either.
    expect(offered.filter((name) => name.startsWith("meta-"))).toEqual([]);
  });

  it("reports page reads and publishing as unavailable, from the service the tools hold", () => {
    const { marketing } = getContainer();

    expect(marketing.researchAvailable()).toBe(false);
    expect(marketing.publishableChannels()).toEqual([]);
  });

  it("says at start-up what was and was not wired, without a credential in the line", () => {
    getContainer();

    const lines = logged.filter((line) => line.includes('"marketing_wiring"'));
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]!) as { pageResearch: string; publishers: string[]; timestamp: string; service: string; component: string };
    expect(line.pageResearch).toMatch(/^disabled/);
    expect(line.publishers).toEqual([]);
    // Written through the operational log, not a bare console line: an
    // operator following a deployment gets when, and which component.
    expect(line).toMatchObject({ service: "jarvis-api", component: "marketing", level: "info" });
    expect(Number.isNaN(Date.parse(line.timestamp))).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("Phase 15 — page reads are switched on by the operator, and need no browser", () => {
  it("registers both page reads when BROWSER_ENABLED=true and no Chrome exists", () => {
    useEnvironment({ pageReads: true });

    for (const id of MARKETING_RESEARCH_TOOL_IDS) expect(registered(id), id).toBe(true);
    expect(getContainer().marketing.researchAvailable()).toBe(true);
    // The browsing tools themselves need a Chrome, and there is none here.
    expect(registered("browser.navigate")).toBe(false);
  });

  it("offers the page reads to the marketing agent and to the general assistant", () => {
    useEnvironment({ pageReads: true });

    for (const id of MARKETING_RESEARCH_TOOL_IDS) {
      expect(offeredTo(AGENT_IDS.marketing), id).toContain(asOffered(id));
      expect(offeredTo(AGENT_IDS.general), id).toContain(asOffered(id));
    }
  });

  it.each([
    ["unset", undefined],
    ["false", "false"],
    ["a truthy word that is not exactly true", "yes"],
    ["TRUE in capitals", "TRUE"],
  ])("leaves them unregistered when BROWSER_ENABLED is %s", (_label, value) => {
    useEnvironment({});
    vi.stubEnv("BROWSER_ENABLED", value);

    for (const id of MARKETING_RESEARCH_TOOL_IDS) expect(registered(id), id).toBe(false);
    expect(getContainer().marketing.researchAvailable()).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("Phase 15 — publishing exists only where a publisher could be built", () => {
  it("registers both publish tools when the Meta integration is configured", () => {
    useEnvironment({ meta: true });

    for (const id of MARKETING_PUBLISH_TOOL_IDS) expect(registered(id), id).toBe(true);
    expect(getContainer().marketing.publishableChannels()).toEqual(["FACEBOOK"]);
  });

  it.each([
    ["only the token", { META_ACCESS_TOKEN: FAKE_META_TOKEN, META_AD_ACCOUNT_ID: undefined }],
    ["only the account id", { META_ACCESS_TOKEN: undefined, META_AD_ACCOUNT_ID: FAKE_META_ACCOUNT }],
  ])("registers neither with %s", (_label, values) => {
    useEnvironment({});
    for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);

    for (const id of MARKETING_PUBLISH_TOOL_IDS) expect(registered(id), id).toBe(false);
    expect(getContainer().marketing.publishableChannels()).toEqual([]);
  });

  it("offers the publish tools to the marketing agent", () => {
    useEnvironment({ meta: true });

    const offered = offeredTo(AGENT_IDS.marketing);
    for (const id of MARKETING_PUBLISH_TOOL_IDS) expect(offered, id).toContain(asOffered(id));
  });

  it("offers them to no other agent", () => {
    useEnvironment({ meta: true, openai: true, pageReads: true });

    for (const agent of getContainer().agentRegistry.getAll()) {
      if (agent.id === AGENT_IDS.marketing) continue;
      const offered = offeredTo(agent.id);
      for (const id of MARKETING_PUBLISH_TOOL_IDS) expect(offered, `${agent.id} / ${id}`).not.toContain(asOffered(id));
    }
  });

  it("keeps them off every other agent's allowlist too, so offering is not the only guard", () => {
    for (const [agentId, policy] of Object.entries(AGENT_POLICIES)) {
      if (agentId === AGENT_IDS.marketing) continue;
      for (const id of MARKETING_PUBLISH_TOOL_IDS) expect(policy.allowedTools, `${agentId} / ${id}`).not.toContain(id);
    }
  });

  it("marks the publish tool as approval-gated and an external side effect", () => {
    useEnvironment({ meta: true });

    const publish = getContainer().toolRegistry.get(MARKETING_TOOL_IDS.contentPublish)!;
    expect(publish.requiresApproval).toBe(true);
    expect(publish.risk).toBe("EXTERNAL_SIDE_EFFECT");
    // The publish check is a read: it is what the approval is built from.
    const prepare = getContainer().toolRegistry.get(MARKETING_TOOL_IDS.publishPrepare)!;
    expect(prepare.requiresApproval).toBe(false);
    expect(prepare.risk).toBe("READ_ONLY");
  });

  it("gives the marketing agent the ad account's reads and none of its writes", () => {
    useEnvironment({ meta: true });

    const offered = offeredTo(AGENT_IDS.marketing).filter((name) => name.startsWith("meta-"));
    expect(offered.sort()).toEqual(["meta-accounts", "meta-ads", "meta-adsets", "meta-campaigns", "meta-insights"]);
  });

  it("never puts the access token in the start-up line", () => {
    useEnvironment({ meta: true });
    getContainer();

    const line = logged.find((entry) => entry.includes('"marketing_wiring"'))!;
    expect(line).not.toContain(FAKE_META_TOKEN);
    expect((JSON.parse(line) as { publishers: string[] }).publishers).toEqual(["meta-graph:FACEBOOK"]);
  });
});

// ---------------------------------------------------------------------------
// Finding F-1. `meta.analyze` was registered after the agents' definitions had
// been computed: in the registry, on three allowlists, listed as a capability,
// and offered to no model. "Analyse my ad account" in chat could not reach it.
// ---------------------------------------------------------------------------

describe("Phase 15 / F-1 — the account analysis is offered to the agents allowed to run it", () => {
  const ANALYZE = "meta.analyze";

  it("is registered when Meta and a model are both configured", () => {
    useEnvironment({ meta: true, openai: true });

    expect(registered(ANALYZE)).toBe(true);
  });

  it("is offered to every registered agent whose policy allows it", () => {
    useEnvironment({ meta: true, openai: true });

    const allowed = getContainer()
      .agentRegistry.getAll()
      .filter((agent) => AGENT_POLICIES[agent.id]?.allowedTools.includes(ANALYZE));
    // The general assistant, the Meta Ads agent, the analytics agent and — new
    // in this phase — the marketing agent.
    expect(allowed.map((agent) => agent.id).sort()).toEqual(
      [AGENT_IDS.general, AGENT_IDS.metaAds, AGENT_IDS.analytics, AGENT_IDS.marketing].sort()
    );
    for (const agent of allowed) expect(offeredTo(agent.id), agent.id).toContain(asOffered(ANALYZE));
  });

  it("is offered to no agent whose policy does not allow it", () => {
    useEnvironment({ meta: true, openai: true });

    for (const agent of getContainer().agentRegistry.getAll()) {
      if (AGENT_POLICIES[agent.id]?.allowedTools.includes(ANALYZE)) continue;
      expect(offeredTo(agent.id), agent.id).not.toContain(asOffered(ANALYZE));
    }
  });

  it.each([
    ["Meta without a model", { meta: true }],
    ["a model without Meta", { openai: true }],
    ["neither", {}],
  ])("is neither registered nor offered with %s", (_label, env) => {
    useEnvironment(env);

    expect(registered(ANALYZE)).toBe(false);
    for (const agent of getContainer().agentRegistry.getAll()) {
      expect(offeredTo(agent.id), agent.id).not.toContain(asOffered(ANALYZE));
    }
  });

  it("has the service behind it by the time the container is returned", () => {
    useEnvironment({ meta: true, openai: true });

    // The tool looks its service up when called. If the late reference were
    // never bound, every analysis would fail with "not ready".
    expect(getContainer().analysisService).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("Phase 15 — the page's publish flow is built over the same parts as everything else", () => {
  it("answers UNAVAILABLE when no publisher exists, without touching a database", async () => {
    useEnvironment({});

    const result = await getContainer().marketingPublishFlow.request({ userId: "user-p15", role: "owner" }, "content-1");

    expect(result.status).toBe("UNAVAILABLE");
  });

  it("refuses a role that cannot publish before any approval could be created", async () => {
    useEnvironment({ meta: true });

    // A viewer holds `read` and nothing else. Nothing is read from the
    // database to reach this answer — the refusal comes first.
    const result = await getContainer().marketingPublishFlow.request({ userId: "user-p15", role: "viewer" }, "content-1");

    expect(result.status).toBe("FORBIDDEN");
  });
});

// ---------------------------------------------------------------------------
// A report reads the ad account with the registered read tool, which refuses a
// window wider than it can serve. If the report's own limit were wider than
// that, every long report would come back saying the ad account "could not be
// read" — a failure of arithmetic reported as a failure of the provider.
// ---------------------------------------------------------------------------

describe("Phase 15 — the longest report period is one the ad-account read accepts", () => {
  const day = (offset: number): string => new Date(Date.UTC(2026, 9, 12) + offset * 86_400_000).toISOString().slice(0, 10);
  const insights = new MetaGetInsightsTool(
    {} as ConstructorParameters<typeof MetaGetInsightsTool>[0],
    {} as ConstructorParameters<typeof MetaGetInsightsTool>[1]
  );
  const window = (days: number) => ({ accountId: FAKE_META_ACCOUNT, startDate: day(-days), endDate: day(-1), level: "account" });

  it("accepts a window of exactly the longest period a report may cover", () => {
    expect(insights.validate(window(MARKETING_LIMITS.reportPeriodDaysMax))).toBe(true);
  });

  it("accepts every shorter period down to a single day", () => {
    for (const days of [1, 7, 30, MARKETING_LIMITS.reportPeriodDaysMax - 1]) expect(insights.validate(window(days)), `${days} days`).toBe(true);
  });

  it("would refuse a year — which is why a report is not allowed to ask for one", () => {
    expect(insights.validate(window(366))).toBe(false);
    expect(MARKETING_LIMITS.reportPeriodDaysMax).toBeLessThan(366);
  });
});
