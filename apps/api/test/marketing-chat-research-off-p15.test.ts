// Phase 15 (final review, item 3) — page research switched off, in a
// conversation, through the REAL composition root.
//
//   user → real orchestrator → real agent (real OpenAIAdapter, scripted
//   upstream) → a page-research tool the model names although this server did
//   not register it → the orchestrator's own answer → the model → the user.
//
// WHAT THIS IS FOR. `marketing.seo.audit` and `marketing.competitor.analyze`
// are on the marketing agent's allowlist — and the general assistant's — on
// every server: a grant is compile-time. They are REGISTERED only where an
// operator set `BROWSER_ENABLED=true`. Everywhere else a model that named one
// was handed to the executor, which found nothing to run, and a turn whose
// only tool call failed came back as an error — `TOOL_EXECUTION_FAILED`,
// "Data retrieval failed.", HTTP 500 at the route — for what is a setting.
//
// The same thing had been fixed for the two publish tools. This file pins it
// for the two page reads: the server names them as switched off, with the
// sentence the service already uses to say so, and the orchestrator answers
// before the executor is asked.
//
// NOTHING HERE READS A PAGE OR STARTS A BROWSER. `BROWSER_ENABLED` is never
// `true` in any case, so no page reader is built; the page reader's one method
// is watched all the same and must never be called. The only thing reached is
// the local stand-in for the model. The database URL is a closed local port,
// set before anything imports Prisma.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const SAVED_DATABASE_URL = vi.hoisted(() => {
  const saved = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgresql://p15:closed-port-no-database@127.0.0.1:59999/none?schema=public";
  return saved;
});

import { MARKETING_RESEARCH_TOOL_IDS, MARKETING_TOOL_IDS, type JarvisRequest, type ToolExecutionRequest } from "@jarvis/core";
import { AGENT_IDS } from "@jarvis/agents";
import { PublicPageFetcher } from "@jarvis/browser";
import { PrismaAuditRepository } from "@jarvis/db";
import { getContainer, resetContainer } from "../src/services/container.js";
import { PAGE_RESEARCH_OFF } from "../src/services/marketing/marketing-service.js";
import { startScriptedOpenAI, type ScriptedOpenAI } from "./helpers/scripted-openai.js";

const USER = "user-p15-research-off";
const JWT_SECRET = "Zk4pQ7vR2mX9tL6wB3nH8sD5gY1jF0cA";
/** Shaped like the real thing and good for nothing. No request is ever made with it. */
const FAKE_OPENAI_KEY = "sk-test-p15-research-off-not-a-real-key-0123456789";
/** A page nothing in this file may read. It is only ever a string in a model's tool call. */
const PAGE = "https://never-read.example/landing";

const SEO = MARKETING_TOOL_IDS.seoAudit;
const COMPETITOR = MARKETING_TOOL_IDS.competitorAnalyze;
const PUBLISH = MARKETING_TOOL_IDS.contentPublish;
/** The names a model is shown: dots are not legal in a function name. */
const asOffered = (toolId: string): string => toolId.replace(/\./g, "-");
const ASK = "Run an SEO audit of the landing page for my content calendar campaign.";
const SAID = `${PAGE_RESEARCH_OFF} Nothing was done.`;

let upstream: ScriptedOpenAI;
let audit: Array<Record<string, unknown>>;
let executed: ToolExecutionRequest[];
/** Every address the page reader was asked to read. It must stay empty. */
let pagesRead: string[];
let turn = 0;

function useEnvironment(browserEnabled: string | undefined = "false"): void {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("JWT_SECRET", JWT_SECRET);
  vi.stubEnv("BROWSER_ENABLED", browserEnabled);
  vi.stubEnv("BROWSER_DOMAIN_ALLOWLIST", undefined);
  vi.stubEnv("JARVIS_MCP_ENABLED", "false");
  vi.stubEnv("JARVIS_ENCRYPTION_KEY", undefined);
  vi.stubEnv("OPENAI_API_KEY", FAKE_OPENAI_KEY);
  vi.stubEnv("OPENAI_BASE_URL", upstream.baseURL);
  vi.stubEnv("META_ACCESS_TOKEN", undefined);
  vi.stubEnv("META_AD_ACCOUNT_ID", undefined);
  vi.stubEnv("MARKETING_PUBLISH_ENABLED", undefined);
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
function ask(message: string, options: { role?: "admin" | "member" | "viewer"; agentId?: string } = {}) {
  turn += 1;
  const conversationId = `conv-p15-research-off-${turn}`;
  return getContainer().orchestrator.process(
    { message, conversationId, stream: false, ...(options.agentId ? { agentId: options.agentId } : {}) } as JarvisRequest,
    {
      auth: { userId: USER, role: options.role ?? "member", email: "p15-research-off@example.com" },
      conversationId,
      traceId: `00000000-0000-4000-8000-${String(turn).padStart(12, "0")}`,
    }
  );
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
  pagesRead = [];
  vi.spyOn(PrismaAuditRepository.prototype, "create").mockImplementation(async (entry) => {
    const row = { ...entry, id: `audit-${audit.length + 1}`, timestamp: new Date() };
    audit.push(row as Record<string, unknown>);
    return row as never;
  });
  // The page reader is the only thing in JARVIS that opens a page a user named.
  // Wherever one exists, a read is written down here and refused.
  vi.spyOn(PublicPageFetcher.prototype, "fetch").mockImplementation(async (url) => {
    pagesRead.push(String(url));
    throw new Error("a page was read in a test that must read none");
  });
  for (const level of ["log", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation(() => {});
});

afterEach(() => {
  resetContainer();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe("page research switched off — a model that names a page-research tool anyway", () => {
  beforeEach(() => useEnvironment("false"));

  it("the server registered neither page read, and handed neither to the agent", async () => {
    const built = container();
    upstream.callTool(asOffered(SEO), { url: PAGE });

    await ask(ASK);

    for (const id of MARKETING_RESEARCH_TOOL_IDS) {
      expect(built.toolRegistry.get(id), id).toBeUndefined();
      expect(offeredIn(0), id).not.toContain(asOffered(id));
    }
    expect(built.marketing.researchAvailable()).toBe(false);
    // The workspace itself is there: this is one switch, not a broken agent.
    expect(offeredIn(0)).toContain(asOffered(MARKETING_TOOL_IDS.contentList));
  });

  it("is answered, not failed: the turn succeeds and the reply reaches the user", async () => {
    container();
    upstream.callTool(asOffered(SEO), { url: PAGE });

    const response = await ask(ASK);

    // Before this the same turn was `success: false`, TOOL_EXECUTION_FAILED,
    // "Data retrieval failed." — HTTP 500 at the route.
    expect(response.success).toBe(true);
    expect(response.error).toBeUndefined();
    expect(response.data?.agentId).toBe(AGENT_IDS.marketing);
    expect(typeof response.data?.message).toBe("string");
    expect(summaryOf(response)).toMatchObject({ total: 1, failed: 0, denied: 0, allFailed: false });
    expect(summaryOf(response)!.executions).toEqual([expect.objectContaining({ toolId: SEO, status: "unavailable", error: SAID })]);
  });

  it("runs nothing and reads nothing: the executor is never asked, and the page reader is never used", async () => {
    container();
    upstream.callTool(asOffered(SEO), { url: PAGE });

    const response = await ask(ASK);

    expect(executed).toEqual([]);
    expect(auditOf("tool.execute")).toEqual([]);
    expect((response.data?.metadata as { pendingAction?: unknown } | undefined)?.pendingAction).toBeUndefined();
    // The model was reached — twice: the question, and then the tool's answer — and no page was.
    expect(upstream.chats).toHaveLength(2);
    expect(pagesRead).toEqual([]);
  });

  it("tells the model why, in the operator's terms, and how it is switched on", async () => {
    container();
    upstream.callTool(asOffered(SEO), { url: PAGE });

    await ask(ASK);

    // The second request to the model is the one that carries the tool's result.
    const shown = toolResultsIn(1);
    expect(shown).toContain(`TOOL: ${SEO}`);
    expect(shown).toContain("STATUS: UNAVAILABLE");
    expect(shown).toContain(`ERROR: ${SAID}`);
    expect(shown).toContain("Reading web pages is switched off on this server");
    expect(shown).toContain("BROWSER_ENABLED=true");
    expect(shown).toContain("This tool is switched off on this server, so it did not run and nothing was changed.");
    expect(shown).toContain("Do NOT retry it and do NOT look for another way");
    expect(shown).not.toContain("Tool not found");
    expect(shown).not.toContain("not authorized");
    // It is the page-research sentence, not the publishing one.
    expect(shown).not.toContain("MARKETING_PUBLISH_ENABLED");
  });

  it("audits the refusal — the tool, the agent and the user, and not the address that was asked for", async () => {
    container();
    upstream.callTool(asOffered(SEO), { url: PAGE });

    await ask(ASK);

    const rows = auditOf("agent.tool_unavailable");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: USER, agentId: AGENT_IDS.marketing, toolId: SEO, result: "rejected" });
    expect(JSON.stringify(rows[0])).not.toContain("never-read.example");
  });

  it("answers the competitor comparison the same way", async () => {
    container();
    upstream.callTool(asOffered(COMPETITOR), { competitorUrl: PAGE });

    const response = await ask("Compare our landing page with this competitor page for my content calendar campaign.");

    expect(response.success).toBe(true);
    expect(summaryOf(response)!.executions).toEqual([expect.objectContaining({ toolId: COMPETITOR, status: "unavailable", error: SAID })]);
    expect(executed).toEqual([]);
    expect(pagesRead).toEqual([]);
    expect(toolResultsIn(1)).toContain("BROWSER_ENABLED=true");
  });

  it("answers the general assistant the same way: it holds these tools too", async () => {
    container();
    upstream.callTool(asOffered(SEO), { url: PAGE });

    const response = await ask(ASK, { agentId: AGENT_IDS.general });

    expect(response.success).toBe(true);
    expect(response.data?.agentId).toBe(AGENT_IDS.general);
    expect(summaryOf(response)!.executions).toEqual([expect.objectContaining({ toolId: SEO, status: "unavailable", error: SAID })]);
    expect(executed).toEqual([]);
    // It is told the reason in the same words, whatever else its own envelope says.
    expect(toolResultsIn(1)).toContain("STATUS: UNAVAILABLE");
    expect(toolResultsIn(1)).toContain(`ERROR: ${SAID}`);
    expect(toolResultsIn(1)).not.toContain("Tool not found");
  });

  it("answers a viewer the same way: it is a setting, not their role", async () => {
    container();
    upstream.callTool(asOffered(SEO), { url: PAGE });

    const response = await ask(ASK, { role: "viewer" });

    expect(response.success).toBe(true);
    expect(summaryOf(response)!.executions).toEqual([expect.objectContaining({ status: "unavailable" })]);
    expect(executed).toEqual([]);
  });

  it("gives each switched-off tool its own reason: a publish call on the same server is told about publishing", async () => {
    const built = container();
    upstream.callTool(asOffered(PUBLISH), { contentId: "c1", targetId: "1234567890", targetName: "Shop Page", message: "Festive offer is live." });

    const response = await ask("Publish the Diwali post to our Facebook page.");

    expect(response.success).toBe(true);
    expect(summaryOf(response)!.executions).toEqual([
      expect.objectContaining({ toolId: PUBLISH, status: "unavailable", error: `${built.marketingPublishingUnavailableReason} Nothing was done.` }),
    ]);
    expect(toolResultsIn(1)).not.toContain("BROWSER_ENABLED");
  });
});

describe("page research switched off — whatever the switch is set to, short of exactly true", () => {
  it.each<[string, string | undefined]>([
    ["unset", undefined],
    ["empty", ""],
    ["1", "1"],
    ["TRUE in capitals", "TRUE"],
    ["a truthy word that is not exactly true", "yes"],
  ])("with BROWSER_ENABLED %s, the page read is still answered as switched off", async (_label, value) => {
    useEnvironment(value);
    const built = container();
    upstream.callTool(asOffered(SEO), { url: PAGE });

    const response = await ask(ASK);

    expect(built.toolRegistry.get(SEO)).toBeUndefined();
    expect(response.success).toBe(true);
    expect(summaryOf(response)!.executions).toEqual([expect.objectContaining({ toolId: SEO, status: "unavailable", error: SAID })]);
    expect(executed).toEqual([]);
    expect(pagesRead).toEqual([]);
  });
});

describe("page research switched off — what the marketing agent is told before it is asked anything", () => {
  beforeEach(() => useEnvironment("false"));

  it("does not instruct it to call a page-research tool it was not given", async () => {
    container();

    await ask("What is on the content calendar this week?");

    const prompt = systemPromptOf(0);
    // Its instructions for research are about how to PRESENT research — which it can still list from what was saved.
    expect(offeredIn(0)).toContain(asOffered(MARKETING_TOOL_IDS.researchList));
    expect(prompt).not.toMatch(/call the (SEO[- ]audit|competitor)[^.]* tool/i);
  });
});
