// ---------------------------------------------------------------------------
// UI V2 — the two read-only endpoints added for the Agents and Activity pages.
//
// Both are new surface area on a hardened API, so the tests are weighted toward
// what they must NOT do: leak another user's rows, accept a client-supplied
// identity, or report a capability this deployment does not have.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";

import { AGENT_POLICIES } from "@jarvis/agents";
import type { AuditEntry } from "@jarvis/core";

import { createAgentsRouter } from "../src/routes/agents.js";
import { createActivityRouter, ACTIVITY_MAX_LIMIT } from "../src/routes/activity.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function fakeRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    setHeader() {},
  };
}

const VALID_TOKEN = "valid-token";

/** Verifies only our one fixed token, so an unauthenticated case is easy. */
const tokenService = {
  verifyAccessToken: (token: string) =>
    token === VALID_TOKEN ? { userId: "user-1", role: "member", email: "u1@test.local" } : null,
};

interface QueryCall {
  userId?: string;
  agentId?: string;
  toolId?: string;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
}

let queries: QueryCall[];
let auditRows: AuditEntry[];

function containerWith(registeredAgentIds: string[]) {
  queries = [];
  return {
    tokenService,
    agentRegistry: { getAll: () => registeredAgentIds.map((id) => ({ id })) },
    auditLogger: {
      query: async (filters: QueryCall) => {
        queries.push(filters);
        return auditRows;
      },
    },
  } as unknown as Parameters<typeof createAgentsRouter>[0];
}

/** Drives a router's single GET handler the way Express would. */
async function get(
  router: unknown,
  options: { token?: string; query?: Record<string, string> } = {}
) {
  const stack = (
    router as {
      stack: Array<{ route?: { path: string; stack: Array<{ handle: (...a: unknown[]) => unknown }> } }>;
    }
  ).stack;
  const layer = stack.find((l) => l.route?.path === "/");
  if (!layer?.route) throw new Error("no GET / route");

  const req = {
    method: "GET",
    path: "/",
    query: options.query ?? {},
    params: {},
    headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
    get(header: string) {
      return (this.headers as Record<string, string>)[header.toLowerCase()];
    },
  };
  const res = fakeRes();

  for (const entry of layer.route.stack) {
    let advanced = false;
    await entry.handle(req, res, () => {
      advanced = true;
    });
    if (!advanced) break;
  }
  return res;
}

function auditRow(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: `audit-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date("2026-09-01T10:00:00.000Z"),
    userId: "user-1",
    action: "tool.execute",
    result: "success",
    ...overrides,
  } as AuditEntry;
}

beforeEach(() => {
  auditRows = [];
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

// ---------------------------------------------------------------------------
// GET /api/v1/agents
// ---------------------------------------------------------------------------

describe("UI V2 — GET /agents", () => {
  const ALL_IDS = Object.values(AGENT_POLICIES).map((p) => p.agentId);

  it("requires a bearer token", async () => {
    const res = await get(createAgentsRouter(containerWith(ALL_IDS)));
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ error: { code: "AUTHENTICATION_REQUIRED" } });
  });

  it("rejects an invalid token", async () => {
    const res = await get(createAgentsRouter(containerWith(ALL_IDS)), { token: "nope" });
    expect(res.statusCode).toBe(401);
  });

  it("returns every declared policy", async () => {
    const res = await get(createAgentsRouter(containerWith(ALL_IDS)), { token: VALID_TOKEN });
    const data = (res.body as { data: { agents: Array<{ agentId: string }>; total: number } }).data;

    expect(res.statusCode).toBe(200);
    expect(data.total).toBe(ALL_IDS.length);
    expect(data.agents.map((a) => a.agentId).sort()).toEqual([...ALL_IDS].sort());
  });

  it("reports an agent that did NOT register as UNAVAILABLE", async () => {
    // The whole reason this endpoint joins two sources. Four agents register
    // conditionally, and a UI told they exist would be lying to the operator.
    const partial = ["conversational-assistant", "meta-ads-agent"];
    const res = await get(createAgentsRouter(containerWith(partial)), { token: VALID_TOKEN });
    const data = (res.body as {
      data: { agents: Array<{ agentId: string; registered: boolean; availability: string }>; registeredCount: number };
    }).data;

    expect(data.registeredCount).toBe(2);
    for (const agent of data.agents) {
      const expected = partial.includes(agent.agentId);
      expect(agent.registered, agent.agentId).toBe(expected);
      expect(agent.availability, agent.agentId).toBe(expected ? "AVAILABLE" : "UNAVAILABLE");
    }
  });

  it("lists available agents before unavailable ones", async () => {
    const res = await get(createAgentsRouter(containerWith(["meta-ads-agent"])), {
      token: VALID_TOKEN,
    });
    const agents = (res.body as { data: { agents: Array<{ registered: boolean }> } }).data.agents;

    const firstUnavailable = agents.findIndex((a) => !a.registered);
    const lastAvailable = agents.map((a) => a.registered).lastIndexOf(true);
    expect(lastAvailable).toBeLessThan(firstUnavailable);
  });

  it("reports that every agent gates its writes", async () => {
    const res = await get(createAgentsRouter(containerWith(ALL_IDS)), { token: VALID_TOKEN });
    const agents = (res.body as { data: { agents: Array<{ writesRequireApproval: boolean }> } }).data
      .agents;

    for (const agent of agents) expect(agent.writesRequireApproval).toBe(true);
  });

  it("exposes tool IDS but no tool internals, prompts or credentials", async () => {
    const res = await get(createAgentsRouter(containerWith(ALL_IDS)), { token: VALID_TOKEN });
    const serialized = JSON.stringify(res.body);

    expect(serialized).not.toMatch(/systemPrompt|apiKey|api_key|secret|token|password/i);
    expect(serialized).not.toMatch(/sk-[a-zA-Z0-9]/);

    const keys = Object.keys(
      (res.body as { data: { agents: Array<Record<string, unknown>> } }).data.agents[0]!
    ).sort();
    expect(keys).toEqual([
      "agentId",
      "allowedTools",
      "availability",
      "clientSelectable",
      "description",
      "domain",
      "registered",
      "toolCount",
      "writesRequireApproval",
    ]);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/activity
// ---------------------------------------------------------------------------

describe("UI V2 — GET /activity", () => {
  const container = () => containerWith([]);

  it("requires a bearer token", async () => {
    const res = await get(createActivityRouter(container()));
    expect(res.statusCode).toBe(401);
  });

  it("ALWAYS scopes to the caller's own userId", async () => {
    auditRows = [auditRow()];
    await get(createActivityRouter(container()), { token: VALID_TOKEN });

    expect(queries).toHaveLength(1);
    expect(queries[0]!.userId).toBe("user-1");
  });

  it("IGNORES a userId supplied in the query string", async () => {
    // The one filter a caller must never choose. If this regresses, one user
    // can read another's entire activity history.
    auditRows = [auditRow()];
    await get(createActivityRouter(container()), {
      token: VALID_TOKEN,
      query: { userId: "user-2" },
    });

    expect(queries[0]!.userId).toBe("user-1");
  });

  it("passes through the filters it does support", async () => {
    auditRows = [];
    await get(createActivityRouter(container()), {
      token: VALID_TOKEN,
      query: {
        agentId: "meta-ads-agent",
        toolId: "meta.insights",
        startDate: "2026-09-01T00:00:00.000Z",
        endDate: "2026-09-02T00:00:00.000Z",
      },
    });

    expect(queries[0]!.agentId).toBe("meta-ads-agent");
    expect(queries[0]!.toolId).toBe("meta.insights");
    expect(queries[0]!.startDate).toBeInstanceOf(Date);
    expect(queries[0]!.endDate).toBeInstanceOf(Date);
  });

  it("filters by action prefix and by result", async () => {
    auditRows = [
      auditRow({ action: "tool.execute", result: "success" }),
      auditRow({ action: "approval.approve", result: "success" }),
      auditRow({ action: "tool.execute", result: "failure" }),
    ];

    const byAction = await get(createActivityRouter(container()), {
      token: VALID_TOKEN,
      query: { action: "approval." },
    });
    expect((byAction.body as { data: { count: number } }).data.count).toBe(1);

    const byResult = await get(createActivityRouter(container()), {
      token: VALID_TOKEN,
      query: { result: "failure" },
    });
    expect((byResult.body as { data: { count: number } }).data.count).toBe(1);
  });

  it.each([
    ["above the ceiling", "9999", ACTIVITY_MAX_LIMIT],
    ["zero", "0", 50],
    ["negative", "-5", 50],
    ["not a number", "lots", 50],
    ["fractional", "10.5", 50],
  ])("clamps a limit that is %s", async (_label, raw, expected) => {
    auditRows = [];
    await get(createActivityRouter(container()), { token: VALID_TOKEN, query: { limit: raw } });
    expect(queries[0]!.limit).toBe(expected);
  });

  it("returns the fields a timeline needs", async () => {
    auditRows = [
      auditRow({
        toolId: "meta.insights",
        agentId: "meta-ads-agent",
        traceId: "trace-1",
        metadata: { executionId: "exec-1", durationMs: 937 },
      }),
    ];

    const res = await get(createActivityRouter(container()), { token: VALID_TOKEN });
    const entry = (res.body as { data: { entries: Array<Record<string, unknown>> } }).data
      .entries[0]!;

    expect(entry).toMatchObject({
      action: "tool.execute",
      result: "success",
      toolId: "meta.insights",
      agentId: "meta-ads-agent",
      traceId: "trace-1",
      executionId: "exec-1",
      durationMs: 937,
    });
    expect(typeof entry.timestamp).toBe("string");
  });

  it("does NOT return tool parameters", async () => {
    // Redacted at write time or not, arguments are the highest-variance field
    // in the row and the least useful in a timeline.
    auditRows = [auditRow({ parameters: { accountId: "act_123", campaignId: "c-1" } })];

    const res = await get(createActivityRouter(container()), { token: VALID_TOKEN });
    expect(JSON.stringify(res.body)).not.toContain("act_123");
    expect((res.body as { data: { entries: Array<Record<string, unknown>> } }).data.entries[0]).not
      .toHaveProperty("parameters");
  });

  it("returns an empty list rather than an error when there is nothing", async () => {
    auditRows = [];
    const res = await get(createActivityRouter(container()), { token: VALID_TOKEN });

    expect(res.statusCode).toBe(200);
    expect((res.body as { data: { entries: unknown[]; count: number } }).data).toMatchObject({
      entries: [],
      count: 0,
    });
  });
});
