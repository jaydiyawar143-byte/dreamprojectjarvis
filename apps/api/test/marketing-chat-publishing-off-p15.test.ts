// Phase 15 (second audit, M1) — publishing switched off, in a conversation,
// through the REAL composition root.
//
//   user → real orchestrator → real Marketing Agent (real OpenAIAdapter,
//   scripted upstream) → a publish tool the model names although this server
//   did not register it → the orchestrator's own answer → the model → the user.
//
// WHAT THIS IS FOR. The marketing agent's grant is compile-time, so its policy
// names the publish tools on every server; whether they exist is a setting.
// Before this, a model that named one where publishing was off was handed to
// the executor, which found nothing to run, and a turn whose only tool call
// failed came back as an error — HTTP 500, "Data retrieval failed." — for what
// is not a fault at all. The pieces that fix it are each tested where they
// live; this file proves the container WIRES them: the reason an operator is
// given on the Marketing page is the reason the agent is told and the reason
// the orchestrator answers with.
//
// Everything is the container as production builds it. Two things are stood in
// for, and only because they are outside JARVIS: the OpenAI upstream (a local
// scripted HTTP server), and the database. The database URL is a closed local
// port, set before anything imports Prisma, so no real database — development
// or deployment — can be reached from this file; audit rows are captured below
// the real AuditLogger, at the repository, so its redaction still runs.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const SAVED_DATABASE_URL = vi.hoisted(() => {
  const saved = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgresql://p15:closed-port-no-database@127.0.0.1:59999/none?schema=public";
  return saved;
});

import { MARKETING_PUBLISH_TOOL_IDS, MARKETING_TOOL_IDS, type JarvisRequest, type ToolExecutionRequest } from "@jarvis/core";
import { AGENT_IDS } from "@jarvis/agents";
import { PrismaAuditRepository } from "@jarvis/db";
import { getContainer, resetContainer } from "../src/services/container.js";
import { startScriptedOpenAI, type ScriptedOpenAI } from "./helpers/scripted-openai.js";

const USER = "user-p15-m1";
const JWT_SECRET = "Zk4pQ7vR2mX9tL6wB3nH8sD5gY1jF0cA";
/** Shaped like the real things and good for nothing. No request is ever made with them. */
const FAKE_OPENAI_KEY = "sk-test-p15-m1-not-a-real-key-0123456789abcdef";
const FAKE_META_TOKEN = "p15-m1-not-a-real-token";
const FAKE_META_ACCOUNT = "act_000000000000015";

const PUBLISH = MARKETING_TOOL_IDS.contentPublish;
const PREPARE = MARKETING_TOOL_IDS.publishPrepare;
/** The names a model is shown: dots are not legal in a function name. */
const asOffered = (toolId: string): string => toolId.replace(/\./g, "-");
const ASK = "Publish the Diwali post to our Facebook page.";
const POST = { contentId: "c1", targetId: "1234567890", targetName: "Shop Page", message: "Festive offer is live." };

let upstream: ScriptedOpenAI;
let audit: Array<Record<string, unknown>>;
let executed: ToolExecutionRequest[];
let turn = 0;

function useEnvironment(env: { publishing?: boolean; meta?: boolean }): void {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("JWT_SECRET", JWT_SECRET);
  vi.stubEnv("BROWSER_ENABLED", "false");
  vi.stubEnv("JARVIS_MCP_ENABLED", "false");
  vi.stubEnv("JARVIS_ENCRYPTION_KEY", undefined);
  vi.stubEnv("OPENAI_API_KEY", FAKE_OPENAI_KEY);
  vi.stubEnv("OPENAI_BASE_URL", upstream.baseURL);
  vi.stubEnv("META_ACCESS_TOKEN", env.meta ? FAKE_META_TOKEN : undefined);
  vi.stubEnv("META_AD_ACCOUNT_ID", env.meta ? FAKE_META_ACCOUNT : undefined);
  vi.stubEnv("MARKETING_PUBLISH_ENABLED", env.publishing ? "true" : undefined);
}

/** The container, with everything its one executor is asked to run written down — and nothing changed. */
function container() {
  const built = getContainer();
  const execute = built.executor.execute.bind(built.executor);
  vi.spyOn(built.executor, "execute").mockImplementation(async (request) => {
    executed.push(request);
    return execute(request);
  });
  return built;
}

/** One user turn through the real orchestrator. */
function ask(message: string, role: "admin" | "member" | "viewer" = "member") {
  turn += 1;
  const conversationId = `conv-p15-m1-${turn}`;
  return getContainer().orchestrator.process({ message, conversationId, stream: false } as JarvisRequest, {
    auth: { userId: USER, role, email: "p15-m1@example.com" },
    conversationId,
    traceId: `00000000-0000-4000-8000-${String(turn).padStart(12, "0")}`,
  });
}

type Summary = { total: number; failed: number; denied: number; allFailed: boolean; executions: Array<{ toolId: string; status: string; error?: string }> };
const summaryOf = (response: Awaited<ReturnType<typeof ask>>) => (response.data?.metadata as { toolExecution?: Summary } | undefined)?.toolExecution;
const systemPromptOf = (chat: number) => (upstream.chats[chat]?.messages ?? []).filter((m) => m.role === "system").map((m) => m.content ?? "").join("\n");
const offeredIn = (chat: number) => (upstream.chats[chat]?.tools ?? []).map((t) => t.function.name);
const toolResultsIn = (chat: number) => (upstream.chats[chat]?.messages ?? []).filter((m) => m.role === "tool").map((m) => m.content ?? "").join("\n");
const auditOf = (action: string) => audit.filter((row) => row.action === action);

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
  executed = [];
  vi.spyOn(PrismaAuditRepository.prototype, "create").mockImplementation(async (entry) => {
    const row = { ...entry, id: `audit-${audit.length + 1}`, timestamp: new Date() };
    audit.push(row as Record<string, unknown>);
    return row as never;
  });
  for (const level of ["log", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation(() => {});
});

afterEach(() => {
  resetContainer();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe("publishing switched off — a model that names the publish tool anyway", () => {
  beforeEach(() => useEnvironment({ meta: true }));

  it("is answered, not failed: the turn succeeds and the reply reaches the user", async () => {
    const built = container();
    upstream.callTool(asOffered(PUBLISH), POST);

    const response = await ask(ASK);

    // Before this the same turn was `success: false`, TOOL_EXECUTION_FAILED — HTTP 500 at the route.
    expect(response.success).toBe(true);
    expect(response.error).toBeUndefined();
    expect(response.data?.agentId).toBe(AGENT_IDS.marketing);
    expect(typeof response.data?.message).toBe("string");
    // The reason is the one the Marketing page is given: this server has one sentence for it.
    expect(built.marketingPublishingUnavailableReason).toBe(
      "Publishing is switched off on this server. An administrator can switch it on by setting MARKETING_PUBLISH_ENABLED=true and restarting."
    );
    expect(summaryOf(response)).toMatchObject({ total: 1, failed: 0, denied: 0, allFailed: false });
    expect(summaryOf(response)!.executions).toEqual([
      expect.objectContaining({ toolId: PUBLISH, status: "unavailable", error: `${built.marketingPublishingUnavailableReason} Nothing was done.` }),
    ]);
  });

  it("creates nothing: the executor is never asked, so there is no execution, no approval and no pending action", async () => {
    container();
    upstream.callTool(asOffered(PUBLISH), POST);

    const response = await ask(ASK);

    expect(executed).toEqual([]);
    expect(auditOf("tool.execute")).toEqual([]);
    expect((response.data?.metadata as { pendingAction?: unknown } | undefined)?.pendingAction).toBeUndefined();
    // Nothing on the audit log speaks of an approval, either.
    expect(audit.filter((row) => String(row.action).toLowerCase().includes("approval"))).toEqual([]);
  });

  it("tells the model why, in the operator's terms, and how it is switched on", async () => {
    const built = container();
    upstream.callTool(asOffered(PUBLISH), POST);

    await ask(ASK);

    // The second request to the model is the one that carries the tool's result.
    const shown = toolResultsIn(1);
    expect(shown).toContain(`TOOL: ${PUBLISH}`);
    expect(shown).toContain("STATUS: UNAVAILABLE");
    expect(shown).toContain(`ERROR: ${built.marketingPublishingUnavailableReason} Nothing was done.`);
    expect(shown).toContain("MARKETING_PUBLISH_ENABLED=true");
    expect(shown).toContain("This tool is switched off on this server, so it did not run and nothing was changed.");
    expect(shown).toContain("Do NOT retry it and do NOT look for another way");
    expect(shown).not.toContain("Tool not found");
    expect(shown).not.toContain("not authorized");
    // And nothing the model was sent carries a credential.
    expect(JSON.stringify(upstream.chats)).not.toContain(FAKE_META_TOKEN);
    expect(JSON.stringify(upstream.chats)).not.toContain(FAKE_OPENAI_KEY);
  });

  it("was never told it could publish here, and was handed no tool that could", async () => {
    const built = container();
    upstream.callTool(asOffered(PUBLISH), POST);

    await ask(ASK);

    const prompt = systemPromptOf(0);
    expect(prompt).toContain("=== PUBLISHING IS NOT AVAILABLE ON THIS SERVER ===");
    expect(prompt).toContain(built.marketingPublishingUnavailableReason!);
    expect(prompt).toContain("You have no publish tool and no publish-check tool here. Do not call one");
    expect(prompt).not.toContain("call the publish tool");
    expect(prompt).not.toContain("call the publish-check tool");
    for (const id of MARKETING_PUBLISH_TOOL_IDS) {
      expect(offeredIn(0), id).not.toContain(asOffered(id));
      expect(built.toolRegistry.get(id), id).toBeUndefined();
    }
    expect(offeredIn(0)).toContain(asOffered(MARKETING_TOOL_IDS.contentList));
  });

  it("audits the refusal — the tool, the agent and the user, and none of the post", async () => {
    container();
    upstream.callTool(asOffered(PUBLISH), POST);

    await ask(ASK);

    const rows = auditOf("agent.tool_unavailable");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: USER, agentId: AGENT_IDS.marketing, toolId: PUBLISH, result: "rejected" });
    expect(JSON.stringify(rows[0])).not.toContain(POST.message);
    expect(JSON.stringify(rows[0])).not.toContain(POST.targetId);
  });

  it("answers the publish check the same way", async () => {
    container();
    upstream.callTool(asOffered(PREPARE), { contentId: "c1" });

    const response = await ask(ASK);

    expect(response.success).toBe(true);
    expect(summaryOf(response)!.executions).toEqual([expect.objectContaining({ toolId: PREPARE, status: "unavailable" })]);
    expect(executed).toEqual([]);
    expect(toolResultsIn(1)).toContain("MARKETING_PUBLISH_ENABLED=true");
  });

  it("answers a viewer the same way: it is a setting, not their role", async () => {
    container();
    upstream.callTool(asOffered(PUBLISH), POST);

    const response = await ask(ASK, "viewer");

    expect(response.success).toBe(true);
    expect(summaryOf(response)!.executions).toEqual([expect.objectContaining({ status: "unavailable" })]);
    expect(executed).toEqual([]);
  });
});

describe("publishing switched on with no connection — the other reason it can be unavailable", () => {
  beforeEach(() => useEnvironment({ publishing: true }));

  it("answers with THAT reason, and tells nobody to set a switch that is already set", async () => {
    const built = container();
    upstream.callTool(asOffered(PUBLISH), POST);

    const response = await ask(ASK);

    expect(built.marketingPublishingUnavailableReason).toBe("Publishing is switched on, but no publishing connection is configured on this server.");
    expect(response.success).toBe(true);
    expect(summaryOf(response)!.executions).toEqual([
      expect.objectContaining({ toolId: PUBLISH, status: "unavailable", error: `${built.marketingPublishingUnavailableReason} Nothing was done.` }),
    ]);
    expect(executed).toEqual([]);
    expect(systemPromptOf(0)).toContain(built.marketingPublishingUnavailableReason!);
    expect(systemPromptOf(0)).not.toContain("MARKETING_PUBLISH_ENABLED");
    expect(toolResultsIn(1)).not.toContain("MARKETING_PUBLISH_ENABLED");
  });
});
