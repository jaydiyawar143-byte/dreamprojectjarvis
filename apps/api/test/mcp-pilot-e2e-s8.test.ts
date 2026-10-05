// S8.6 / S8.8 — the reviewed MCP servers, end to end, through the General
// Assistant.
//
//   user → orchestrator → General Assistant (real OpenAIAdapter, scripted
//   upstream) → reviewed MCP capability → ToolExecutor → McpTool → McpConnection
//   → the REAL server (packages/mcp/pilot/dates-server.mjs, and since S8.8
//   units-server.mjs, each on its own connection) → result → sanitizer (the
//   assistant's tool-result envelope) → audit → model → user.
//
// Everything is the container as production builds it — the shipped manifest,
// the agent policies, the registry, the executor, the runtime. Two things are
// stood in for, and only because they are outside JARVIS: the OpenAI upstream
// (a local scripted HTTP server, as the R-24 test does), and the database. The
// database URL is a closed local port, set before anything imports Prisma, so
// no real database — development or deployment — can be reached from this
// file; audit rows are captured below the real AuditLogger, at the Prisma
// repository, so its redaction still runs.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const SAVED_DATABASE_URL = vi.hoisted(() => {
  const saved = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgresql://s86:closed-port-no-database@127.0.0.1:59999/none?schema=public";
  return saved;
});

import { MCP_MANIFEST, type JarvisRequest, type SessionContext, type ToolExecutionResult } from "@jarvis/core";
import { AGENT_IDS } from "@jarvis/agents";
import { McpTool } from "@jarvis/tools";
import { PrismaAuditRepository } from "@jarvis/db";
import { getContainer, getMcpConnections, resetContainer } from "../src/services/container.js";
import { startScriptedOpenAI, type ScriptedOpenAI } from "./helpers/scripted-openai.js";

const USER = "user-s8-6";
const FAKE_OPENAI_KEY = "sk-test-s86-not-a-real-key-0123456789abcdef";
const JWT_SECRET = "Zk4pQ7vR2mX9tL6wB3nH8sD5gY1jF0cA";
/** A secret the pilot is NOT mapped to: it must reach nothing. */
const UNMAPPED_SECRET = "sk-live-s86-unmapped-secret-value-9f8e7d6c";
const DAYS = "mcp-dates-days_between";
const QUESTION = "How many days are there from 2026-01-01 to 2026-03-01?";
const [DAYS_REVIEW, WEEKDAY_REVIEW] = MCP_MANIFEST.servers[0]!.tools;
const [LENGTH_REVIEW, TEMPERATURE_REVIEW] = MCP_MANIFEST.servers[1]!.tools;
const LENGTH = "mcp-units-convert_length";
/** The managed connection of one reviewed server. */
const connectionOf = (serverId: string) => getMcpConnections().find((c) => c.serverId === serverId);

let upstream: ScriptedOpenAI;
let audit: Array<Record<string, unknown>>;
let logs: string[];
let executions: ToolExecutionResult[];
let turn = 0;

const processes = () => process.getActiveResourcesInfo().filter((r) => r === "ProcessWrap").length;

async function until(condition: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function useEnvironment(mcpEnabled: string | undefined): void {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("JWT_SECRET", JWT_SECRET);
  vi.stubEnv("BROWSER_ENABLED", "false");
  vi.stubEnv("JARVIS_ENCRYPTION_KEY", undefined);
  vi.stubEnv("OPENAI_API_KEY", FAKE_OPENAI_KEY);
  vi.stubEnv("OPENAI_BASE_URL", upstream.baseURL);
  vi.stubEnv("JARVIS_MCP_DATES_TOKEN", UNMAPPED_SECRET);
  vi.stubEnv("JARVIS_MCP_ENABLED", mcpEnabled);
}

/** A container whose executor is watched, without being changed. */
function container() {
  const built = getContainer();
  const execute = built.executor.execute.bind(built.executor);
  vi.spyOn(built.executor, "execute").mockImplementation(async (request) => {
    const result = await execute(request);
    executions.push(result);
    return result;
  });
  return built;
}

/** One user turn through the real orchestrator. */
function ask(message: string, role: SessionContext["auth"]["role"] = "admin") {
  turn += 1;
  const conversationId = `conv-s8-6-${turn}`;
  return getContainer().orchestrator.process({ message, conversationId, stream: false } as JarvisRequest, {
    auth: { userId: USER, role, email: "s86@example.com" },
    conversationId,
    traceId: `00000000-0000-4000-8000-${String(turn).padStart(12, "0")}`,
  });
}

const offeredTools = (chat = 0) => (upstream.chats[chat]?.tools ?? []).map((t) => t.function);
const toolMessages = (chat: number) =>
  (upstream.chats[chat]?.messages ?? []).filter((m) => m.role === "tool").map((m) => m.content ?? "");

beforeAll(async () => {
  upstream = await startScriptedOpenAI();
});

afterAll(async () => {
  await upstream.close();
  if (SAVED_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = SAVED_DATABASE_URL;
});

beforeEach(() => {
  resetContainer();
  upstream.chats.length = 0;
  audit = [];
  logs = [];
  executions = [];
  vi.spyOn(PrismaAuditRepository.prototype, "create").mockImplementation(async (entry) => {
    const row = { ...entry, id: `audit-${audit.length + 1}`, timestamp: new Date() };
    audit.push(row as Record<string, unknown>);
    return row as never;
  });
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
  }
});

afterEach(async () => {
  await Promise.all(getMcpConnections().map((connection) => connection.close()));
  resetContainer();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe("MCP switched off — the default", () => {
  it("offers the assistant no MCP tool, registers none, and starts nothing", async () => {
    useEnvironment(undefined);
    const built = container();
    expect(built.toolRegistry.getAll().filter((t) => t.id.startsWith("mcp."))).toEqual([]);
    upstream.callTool(DAYS, { start: "2026-01-01", end: "2026-03-01" });

    const response = await ask(QUESTION);
    expect(offeredTools().filter((t) => t.name.startsWith("mcp-"))).toEqual([]);
    // The model named the tool anyway. The reviewed grant is compile-time
    // (S8.4), so the policy lets the name through — and ToolExecutor, the one
    // execution authority, finds no such tool registered: nothing runs.
    expect(executions.map((e) => [e.toolId, e.status, e.error])).toEqual([
      ["mcp.dates.days_between", "failed", "Tool not found"],
    ]);
    // Every tool in the round failed, so the existing contract answers with an
    // explicit failure rather than a model's guess.
    expect(response).toMatchObject({
      success: false,
      error: { code: "TOOL_EXECUTION_FAILED", details: { reason: "mcp.dates.days_between: Tool not found" } },
    });
    expect(processes()).toBe(0);
  });
});

describe("MCP switched on — the reviewed servers through the General Assistant", () => {
  beforeEach(() => useEnvironment("true"));

  it("is selected by the assistant, run by ToolExecutor on the real server, and its answer reaches the user", async () => {
    const built = container();
    const [connection] = getMcpConnections();
    expect(connection?.serverId).toBe("dates");
    expect(built.toolRegistry.get("mcp.dates.days_between")).toBeInstanceOf(McpTool);
    // Boot started nothing.
    expect(connection?.getState()).toBe("idle");
    expect(processes()).toBe(0);

    upstream.callTool(DAYS, { start: "2026-01-01", end: "2026-03-01" });
    const response = await ask(QUESTION);

    expect(response.success).toBe(true);
    expect(response.data?.agentId).toBe(AGENT_IDS.general);
    expect(response.data?.message).toBe("There are 59 days from 2026-01-01 to 2026-03-01.");

    // ToolExecutor ran it: the real server answered, and the result is marked untrusted.
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({
      toolId: "mcp.dates.days_between",
      status: "completed",
      result: {
        success: true,
        data: { content: [{ type: "text", text: "59 days from 2026-01-01 to 2026-03-01." }] },
        metadata: { treatedAsUntrustedData: true, containsSuspectedInjection: false },
      },
    });

    // The first call started and verified the server — that server alone.
    expect(connection?.getState()).toBe("ready");
    expect(connection?.listVerifiedTools()).toEqual([DAYS_REVIEW, WEEKDAY_REVIEW]);
    expect(connectionOf("units")?.getState()).toBe("idle");
    expect(processes()).toBe(1);

    // The model was handed the result through the assistant's envelope.
    const [envelope] = toolMessages(1);
    expect(envelope).toContain("TOOL: mcp.dates.days_between");
    expect(envelope).toContain("STATUS: COMPLETED");
    expect(envelope).toContain("59 days from 2026-01-01 to 2026-03-01.");
  });

  it("shows the model only the reviewed metadata — never the live server's own listing", async () => {
    container();
    upstream.callTool(DAYS, { start: "2026-01-01", end: "2026-03-01" });
    await ask(QUESTION);

    const offered = offeredTools().filter((t) => t.name.startsWith("mcp-"));
    expect(offered.map((t) => t.name).sort()).toEqual([
      "mcp-dates-day_of_week",
      "mcp-dates-days_between",
      "mcp-units-convert_length",
      "mcp-units-convert_temperature",
    ]);
    // Each server's tools carry that server's own review — told apart by name.
    expect(offered.find((t) => t.name === LENGTH)?.description).toBe(LENGTH_REVIEW!.description);
    expect(offered.find((t) => t.name === "mcp-units-convert_temperature")?.description).toBe(TEMPERATURE_REVIEW!.description);
    const days = offered.find((t) => t.name === DAYS)!;
    expect(days.description).toBe(DAYS_REVIEW!.description);
    expect(days.parameters).toMatchObject({
      type: "object",
      properties: {
        start: { type: "string", description: DAYS_REVIEW!.inputSchema.properties.start!.description },
        end: { type: "string", description: DAYS_REVIEW!.inputSchema.properties.end!.description },
      },
      required: ["start", "end"],
    });
    const text = JSON.stringify(upstream.chats);
    for (const hidden of [
      DAYS_REVIEW!.fingerprint,
      WEEKDAY_REVIEW!.fingerprint,
      LENGTH_REVIEW!.fingerprint,
      TEMPERATURE_REVIEW!.fingerprint,
      "jarvis-dates",
      "jarvis-units",
      "dates-server.mjs",
      "units-server.mjs",
      "stdio",
      "readOnlyHint",
    ]) {
      expect(text, hidden).not.toContain(hidden);
    }
  });

  it("reuses the verified connection for later calls, and shutdown ends the process", async () => {
    container();
    const [connection] = getMcpConnections();
    upstream.callTool(DAYS, { start: "2026-01-01", end: "2026-03-01" });
    await ask(QUESTION);
    upstream.callTool("mcp-dates-day_of_week", { date: "2026-10-05" });
    const second = await ask("Which day of the week is 2026-10-05?");

    expect(second.data?.message).toBe("2026-10-05 is a Monday.");
    expect(executions.map((e) => e.status)).toEqual(["completed", "completed"]);
    expect(connectionOf("dates")).toBe(connection);
    expect(connectionOf("units")?.getState()).toBe("idle");
    expect(processes()).toBe(1);

    await Promise.all(getMcpConnections().map((c) => c.close()));
    expect(connection?.getState()).toBe("closed");
    await until(() => processes() === 0);
  });

  it("is audited by the normal tool.execute path, for either server — and by nothing MCP-specific", async () => {
    container();
    upstream.callTool(DAYS, { start: "2026-01-01", end: "2026-03-01" });
    await ask(QUESTION);
    upstream.callTool(LENGTH, { value: 5, from: "km", to: "mi" });
    await ask("How many miles is 5 km?");

    const executed = audit.filter((row) => row.action === "tool.execute");
    expect(executed).toHaveLength(2);
    expect(executed[0]).toMatchObject({
      userId: USER,
      toolId: "mcp.dates.days_between",
      result: "success",
      parameters: { start: "2026-01-01", end: "2026-03-01" },
    });
    expect(executed[1]).toMatchObject({
      userId: USER,
      toolId: "mcp.units.convert_length",
      result: "success",
      parameters: { value: 5, from: "km", to: "mi" },
    });
    expect(audit.map((row) => row.action)).toContain("orchestrator.process");
    expect(audit.filter((row) => String(row.action).toLowerCase().includes("mcp"))).toEqual([]);
  });

  it("puts no secret into parameters, logs, audit rows, results or anything the model is shown", async () => {
    container();
    upstream.callTool(DAYS, { start: "2026-01-01", end: "2026-03-01" });
    await ask(QUESTION);
    upstream.callTool(LENGTH, { value: 5, from: "km", to: "mi" });
    await ask("How many miles is 5 km?");
    expect(executions.map((e) => e.status)).toEqual(["completed", "completed"]);

    const everything = JSON.stringify({ audit, logs, executions, chats: upstream.chats });
    for (const secret of [FAKE_OPENAI_KEY, JWT_SECRET, UNMAPPED_SECRET, "closed-port-no-database"]) {
      expect(everything, secret).not.toContain(secret);
    }
  });

  it("selects the units server just as well — run by ToolExecutor on its own real server, which alone starts", async () => {
    const built = container();
    expect(built.toolRegistry.get("mcp.units.convert_length")).toBeInstanceOf(McpTool);
    upstream.callTool(LENGTH, { value: 5, from: "km", to: "mi" });
    const response = await ask("How many miles is 5 km?");

    expect(response.data?.agentId).toBe(AGENT_IDS.general);
    expect(response.data?.message).toBe("5 km is 3.10686 mi.");
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({
      toolId: "mcp.units.convert_length",
      status: "completed",
      result: {
        data: { content: [{ type: "text", text: "5 km is 3.10686 mi." }] },
        metadata: { treatedAsUntrustedData: true },
      },
    });
    expect(toolMessages(1)[0]).toContain("TOOL: mcp.units.convert_length");

    expect(connectionOf("units")?.getState()).toBe("ready");
    expect(connectionOf("units")?.listVerifiedTools()).toEqual([LENGTH_REVIEW, TEMPERATURE_REVIEW]);
    expect(connectionOf("dates")?.getState()).toBe("idle");
    expect(processes()).toBe(1);
  });

  it("starts each server on its own first call — one process apiece — and shutdown closes every one", async () => {
    container();
    upstream.callTool(DAYS, { start: "2026-01-01", end: "2026-03-01" });
    await ask(QUESTION);
    expect(processes()).toBe(1);
    upstream.callTool("mcp-units-convert_temperature", { value: 100, from: "C", to: "F" });
    const temperature = await ask("What is 100 C in Fahrenheit?");

    expect(temperature.data?.message).toBe("100 C is 212 F.");
    expect(getMcpConnections().map((c) => [c.serverId, c.getState()])).toEqual([
      ["dates", "ready"],
      ["units", "ready"],
    ]);
    expect(processes()).toBe(2);

    // The hook index.ts calls at shutdown.
    await Promise.all(getMcpConnections().map((c) => c.close()));
    expect(getMcpConnections().map((c) => c.getState())).toEqual(["closed", "closed"]);
    await until(() => processes() === 0);
  });

  it("refuses a tool the review never offered before anything starts", async () => {
    container();
    const [connection] = getMcpConnections();
    upstream.callTool("mcp-dates-add_days", { date: "2026-01-01", days: 3 });
    const response = await ask("What date is 3 days after 2026-01-01?");

    expect(executions).toEqual([]);
    expect(audit.filter((row) => row.action === "agent.tool_denied").map((row) => row.toolId)).toEqual([
      "mcp-dates-add_days",
    ]);
    expect(response.data?.message).toBe("I could not get that answer from the dates tool.");
    expect(connection?.getState()).toBe("idle");
    expect(processes()).toBe(0);
  });
});
