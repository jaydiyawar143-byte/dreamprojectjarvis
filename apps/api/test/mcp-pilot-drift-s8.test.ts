// S8.6 — a live server that no longer matches its review, through the General
// Assistant.
//
// For this file core's MCP_MANIFEST holds the real pilot under a review that
// differs from what it now lists: `days_between` was reviewed with other
// wording (re-pinned, so the manifest itself is valid). That is exactly a
// server that changed after review. Everything else is the real container, the
// real assistant (OpenAI upstream scripted, database a closed port — see
// mcp-pilot-e2e-s8.test.ts), the real runtime and the real pilot process.
//
// Pinned here: what the model is shown is the review, never the live listing;
// the call fails closed with the existing SCHEMA_INVALID contract; the whole
// server is refused, not just the changed tool; and no usable connection or
// process is left behind — verification can only take tools away.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { SAVED_DATABASE_URL, REVIEWED_WORDING } = vi.hoisted(() => {
  const saved = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgresql://s86:closed-port-no-database@127.0.0.1:59999/none?schema=public";
  return { SAVED_DATABASE_URL: saved, REVIEWED_WORDING: "Counts calendar days between two dates, as worded at review." };
});

vi.mock("@jarvis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@jarvis/core")>();
  // S8.8 — only `dates` drifted; `units` keeps its shipped review, untouched.
  const [pilot, ...others] = actual.MCP_MANIFEST.servers;
  const tools = pilot!.tools.map((tool) => {
    if (tool.name !== "days_between") return tool;
    const reviewed = { ...tool, description: REVIEWED_WORDING };
    return { ...reviewed, fingerprint: actual.mcpToolFingerprint(reviewed) };
  });
  return { ...actual, MCP_MANIFEST: { servers: [{ ...pilot!, tools }, ...others] } };
});

import { MCP_MANIFEST, mcpFailure, type JarvisRequest, type ToolExecutionResult } from "@jarvis/core";
import { AGENT_POLICIES } from "@jarvis/agents";
import { PrismaAuditRepository } from "@jarvis/db";
import { getContainer, getMcpConnections, resetContainer } from "../src/services/container.js";
import { startScriptedOpenAI, type ScriptedOpenAI } from "./helpers/scripted-openai.js";

/** What the pilot really lists for days_between today. */
const LIVE_WORDING = "Counts the days from one calendar date to another.";

let upstream: ScriptedOpenAI;
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

function ask(message: string) {
  turn += 1;
  const conversationId = `conv-s8-6-drift-${turn}`;
  return getContainer().orchestrator.process({ message, conversationId, stream: false } as JarvisRequest, {
    auth: { userId: "user-s8-6-drift", role: "admin", email: "s86@example.com" },
    conversationId,
    traceId: `00000000-0000-4000-9000-${String(turn).padStart(12, "0")}`,
  });
}

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
  executions = [];
  vi.spyOn(PrismaAuditRepository.prototype, "create").mockImplementation(
    async (entry) => ({ ...entry, id: "audit", timestamp: new Date() }) as never
  );
  for (const level of ["log", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation(() => {});
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("JWT_SECRET", "Zk4pQ7vR2mX9tL6wB3nH8sD5gY1jF0cA");
  vi.stubEnv("BROWSER_ENABLED", "false");
  vi.stubEnv("JARVIS_ENCRYPTION_KEY", undefined);
  vi.stubEnv("OPENAI_API_KEY", "sk-test-s86-not-a-real-key-0123456789abcdef");
  vi.stubEnv("OPENAI_BASE_URL", upstream.baseURL);
  vi.stubEnv("JARVIS_MCP_ENABLED", "true");
});

afterEach(async () => {
  await Promise.all(getMcpConnections().map((connection) => connection.close()));
  resetContainer();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe("a pilot that changed after review", () => {
  it("is shown to the model as reviewed — the live wording never reaches it, before or after the call", async () => {
    container();
    upstream.callTool("mcp-dates-days_between", { start: "2026-01-01", end: "2026-03-01" });
    await ask("How many days are there from 2026-01-01 to 2026-03-01?");

    const offered = upstream.chats[0]!.tools!.find((t) => t.function.name === "mcp-dates-days_between");
    expect(offered?.function.description).toBe(REVIEWED_WORDING);
    expect(JSON.stringify(upstream.chats)).not.toContain(LIVE_WORDING);
  });

  it("fails closed with the existing SCHEMA_INVALID contract, and leaves no usable connection or process", async () => {
    container();
    const [connection] = getMcpConnections();
    upstream.callTool("mcp-dates-days_between", { start: "2026-01-01", end: "2026-03-01" });
    const response = await ask("How many days are there from 2026-01-01 to 2026-03-01?");

    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({
      toolId: "mcp.dates.days_between",
      status: "failed",
      error: mcpFailure("SCHEMA_INVALID").message,
      result: { success: false, metadata: { mcpFailureCode: "SCHEMA_INVALID" } },
    });
    expect(response).toMatchObject({ success: false, error: { code: "TOOL_EXECUTION_FAILED" } });

    expect(connection?.getState()).toBe("failed");
    expect(connection?.listVerifiedTools()).toEqual([]);
    await until(() => processes() === 0);
  });

  it("refuses the whole server — the unchanged tool too — every time, and adds or removes no tool or grant", async () => {
    const built = container();
    const tools = built.toolRegistry.getAll().map((t) => t.id).sort();
    const grants = JSON.stringify(Object.values(AGENT_POLICIES).map((p) => [...p.allowedTools]));

    for (const [name, args] of [
      ["mcp-dates-day_of_week", { date: "2026-10-05" }],
      ["mcp-dates-days_between", { start: "2026-01-01", end: "2026-03-01" }],
    ] as const) {
      upstream.callTool(name, args);
      await ask(`Use ${name}.`);
    }

    expect(executions.map((e) => [e.toolId, e.status, e.error])).toEqual([
      ["mcp.dates.day_of_week", "failed", mcpFailure("SCHEMA_INVALID").message],
      ["mcp.dates.days_between", "failed", mcpFailure("SCHEMA_INVALID").message],
    ]);
    expect(built.toolRegistry.getAll().map((t) => t.id).sort()).toEqual(tools);
    expect(JSON.stringify(Object.values(AGENT_POLICIES).map((p) => [...p.allowedTools]))).toBe(grants);
    expect(MCP_MANIFEST.servers[0]!.tools[0]!.description).toBe(REVIEWED_WORDING);
    await until(() => processes() === 0);
  });

  it("leaves the other reviewed server untouched: units still answers through the assistant, on its own connection", async () => {
    container();
    const dates = getMcpConnections().find((c) => c.serverId === "dates")!;
    const units = getMcpConnections().find((c) => c.serverId === "units")!;

    upstream.callTool("mcp-dates-days_between", { start: "2026-01-01", end: "2026-03-01" });
    await ask("How many days are there from 2026-01-01 to 2026-03-01?");
    upstream.callTool("mcp-units-convert_length", { value: 5, from: "km", to: "mi" });
    const response = await ask("How many miles is 5 km?");

    expect(executions.map((e) => [e.toolId, e.status])).toEqual([
      ["mcp.dates.days_between", "failed"],
      ["mcp.units.convert_length", "completed"],
    ]);
    expect(response.data?.message).toBe("5 km is 3.10686 mi.");
    expect(dates.getState()).toBe("failed");
    expect(units.getState()).toBe("ready");
    expect(JSON.stringify(upstream.chats)).not.toContain(LIVE_WORDING);
  });
});
