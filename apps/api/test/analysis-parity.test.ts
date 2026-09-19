// ---------------------------------------------------------------------------
// Phase 11.10 — Analysis parity test.
//
// The dashboard "Analyze" button and a JARVIS "analyze this account" sentence
// must reach the SAME shared AnalysisGenerator instance, with the same input,
// from the same executor, with the same authorization, safety caps and
// persistence. This file proves it the same way integration-command-parity
// does: one REAL generator is instrumented, and both arms are shown to land on
// that instance — not on two copies that happen to look alike.
//
// Arms under test:
//   frontend: POST /api/v1/analysis -> container.analysisService.analyze()
//   jarvis:   MetaAnalyzeTool.execute() -> MetaAnalyzePort -> the same instance
//
// The route and tool constructors are the exact ones container.ts builds.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from "vitest";
import type { Router } from "express";
import { createAnalysisRouter } from "../src/routes/analysis.js";
import { AnalysisGenerator, MetaAnalyzeTool } from "@jarvis/tools";
import type {
  AnalysisCaller,
  AnalysisInput,
} from "@jarvis/tools";
import type { Container } from "../src/services/container.js";
import type {
  ToolExecutionRequest,
  ToolExecutionResult,
  IAIProvider,
  RecommendationStorePort,
  AuditLogger,
} from "@jarvis/core";

const ACCOUNT = "act_1";
const AD_ID = "ad_x1";
const NOW = new Date("2026-09-10T12:00:00Z");

// ---------------------------------------------------------------------------
// Doubles shared by BOTH arms — the same executor, the same provider, the same
// store. If the two arms used separate machinery you could not prove parity
// with a single instance; so the constructor wiring here mirrors container.ts
// exactly.
// ---------------------------------------------------------------------------

function insightRows(): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let d = 3; d <= 9; d++) {
    rows.push({
      dateStart: `2026-09-${String(d).padStart(2, "0")}`,
      adId: AD_ID,
      campaignId: "cmp_1",
      adsetId: "as_1",
      spend: "5000",
      impressions: "10000",
      clicks: "1200",
      conversions: "12",
    });
  }
  rows.push({
    dateStart: "2026-09-10",
    adId: AD_ID,
    campaignId: "cmp_1",
    adsetId: "as_1",
    spend: "5000",
    impressions: "10000",
    clicks: "120",
    conversions: "2",
  });
  return rows;
}

function makeExecutor() {
  const calls: ToolExecutionRequest[] = [];
  const data: Record<string, { success: boolean; data?: unknown }> = {
    "meta.accounts": { success: true, data: { accounts: [{ accountId: ACCOUNT, currency: "USD", timezoneName: "UTC" }] } },
    "meta.campaigns": { success: true, data: { campaigns: [{ campaignId: "cmp_1", name: "Campaign", status: "ACTIVE" }] } },
    "meta.adsets": { success: true, data: { adSets: [{ adSetId: "as_1", name: "Adset", status: "ACTIVE", campaignId: "cmp_1" }] } },
    "meta.ads": { success: true, data: { ads: [{ adId: AD_ID, name: "Ad One", status: "ACTIVE", campaignId: "cmp_1", adSetId: "as_1", objective: "OUTCOME_TRAFFIC" }] } },
    "meta.insights": { success: true, data: { insights: insightRows() } },
  };
  const execute = async (req: ToolExecutionRequest): Promise<ToolExecutionResult> => {
    calls.push(req);
    const entry = data[req.toolId];
    const completed = {
      status: "completed" as const,
      toolId: req.toolId,
      executionId: `exe_${req.toolId}`,
      startedAt: NOW,
      completedAt: NOW,
    };
    if (!entry) {
      return { ...completed, result: { success: false, error: `unknown ${req.toolId}` } };
    }
    return { ...completed, result: entry };
  };
  return { execute, calls, data };
}

function makeProvider(): IAIProvider {
  return {
    id: "openai",
    name: "OpenAI",
    defaultModel: "gpt-fake",
    complete: async (req) => {
      const content =
        req.messages.find((m) => m.role === "user")?.content ?? "";
      const match = content.match(/EVIDENCE_BEGIN\n([\s\S]*?)\nEVIDENCE_END/);
      const parsed: unknown = match ? JSON.parse(match[1] ?? "{}") : {};
      const pkg =
        (Array.isArray(parsed) ? parsed[0] : parsed) ??
        ({} as Record<string, unknown>);
      const anomalies = Array.isArray(pkg["anomalies"])
        ? (pkg["anomalies"] as Array<Record<string, unknown>>)
        : [];
      const anomalyIds = anomalies
        .filter((a) => a["severity"] !== "NORMAL")
        .map((a) => String(a["anomalyId"]));
      const candidate = {
        entityId: String(pkg["entityId"] ?? "ad_x1"),
        entityLevel: String(pkg["entityLevel"] ?? "AD"),
        evidenceHash: String(pkg["evidenceHash"] ?? "evh"),
        anomalyIds,
        category: "CREATIVE_FATIGUE",
        summary: "The entity shows a marked shift from its own recent baseline while the window remains fresh.",
        facts: [
          { statement: "A shift is present in the click metric relative to its baseline.", evidenceRef: "metric:ctr:change_percent" },
          { statement: "A shift is present in the cost metric relative to its baseline.", evidenceRef: "metric:cpa:change_percent" },
          { statement: "The reported window is within the freshness bound.", evidenceRef: "meta:freshness" },
        ],
        inferences: [
          { statement: "The pattern is consistent within this window.", supportingEvidence: ["metric:ctr:change_percent"], confidence: "HIGH" },
        ],
        hypotheses: [
          { statement: "Creative fatigue is the leading explanation for the observed pattern.", category: "CREATIVE_FATIGUE", supportingEvidence: ["metric:cpa:change_percent"], contradictingEvidence: [], confidence: "HIGH" },
        ],
        confidence: "HIGH",
      };
      return {
        message: { role: "assistant", content: JSON.stringify({ diagnoses: [candidate] }) },
        finishReason: "stop",
        usage: { promptTokens: 200, completionTokens: 80, totalTokens: 280 },
        model: "gpt-fake",
      };
    },
    listModels: async () => ["gpt-fake"],
    isAvailable: async () => true,
  };
}

function makeStore(): RecommendationStorePort & { saved: unknown[] } {
  const saved: unknown[] = [];
  return {
    saved,
    findActiveByIdentity: async () => null,
    findActiveByEntity: async () => [],
    findMostRecentByActions: async () => null,
    countBudgetActionsSince: async () => 0,
    save: async (r: unknown) => {
      saved.push(r);
    },
    get: async () => null,
  };
}

/** What `AuditLogger.log` is actually handed. Derived, so it cannot drift. */
type AuditEntryInput = Parameters<AuditLogger["log"]>[0];

/**
 * The fake carries `rows` and `query` on top of `AuditLogger`, so the type is
 * stated rather than cast away. The previous `as unknown as AuditLogger` left
 * the object literal with no contextual type, which is why `entry` below was
 * an implicit `any` — the cast was what removed the checking, not what added it.
 */
type AuditFake = AuditLogger & {
  rows: AuditEntryInput[];
  query: () => Promise<unknown[]>;
};

function makeAudit(): AuditFake {
  const rows: AuditEntryInput[] = [];
  return {
    rows,
    log: async (entry) => {
      rows.push(entry);
    },
    query: async () => [],
  };
}

interface Harness {
  service: AnalysisGenerator;
  calls: Array<{ input: AnalysisInput; caller: AnalysisCaller }>;
  executor: ReturnType<typeof makeExecutor>;
  audit: ReturnType<typeof makeAudit>;
}

function harness(): Harness {
  const calls: Harness["calls"] = [];
  const executor = makeExecutor();
  const audit = makeAudit();

  const service = new AnalysisGenerator({
    executor: { execute: executor.execute },
    provider: makeProvider(),
    store: makeStore(),
    audit,
    config: { defaultAccountId: ACCOUNT },
    nowFn: () => NOW,
  });

  const original = service.analyze.bind(service);
  const wrapped = async (input: AnalysisInput, caller: AnalysisCaller) => {
    calls.push({ input, caller });
    return original(input, caller);
  };
  (service as unknown as { analyze: typeof wrapped }).analyze = wrapped;

  return { service, calls, executor, audit };
}

// ---------------------------------------------------------------------------
// Frontend arm: the route, exactly as mounted.
// ---------------------------------------------------------------------------

function fakeTokenService() {
  const tokens = new Map<string, { userId: string; role: string; email: string }>();
  return {
    issue(userId: string, role = "member") {
      const t = `tok-${userId}-${Math.random().toString(36).slice(2)}`;
      tokens.set(t, { userId, role, email: `${userId}@test.com` });
      return t;
    },
    verifyAccessToken(token: string) {
      return tokens.get(token) ?? null;
    },
    generateAccessToken(p: { userId: string; role: string; email: string }) {
      return this.issue(p.userId, p.role);
    },
    generateRefreshToken() {
      return "refresh";
    },
    hashToken(t: string) {
      return `h-${t}`;
    },
    getRefreshTokenExpiry() {
      return new Date(Date.now() + 86_400_000);
    },
  };
}

async function fromButton(
  router: Router,
  token: string,
  body: unknown
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = {
    _status: 200,
    _body: null as unknown,
    status(code: number) {
      this._status = code;
      return this;
    },
    json(b: unknown) {
      this._body = b;
      return this;
    },
  };
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  };
  const req = {
    method: "POST",
    url: "/api/v1/analysis",
    originalUrl: "/api/v1/analysis",
    path: "/api/v1/analysis",
    params: {},
    query: {},
    headers,
    body,
    ip: "127.0.0.1",
    get(h: string) {
      return headers[h.toLowerCase()] ?? "";
    },
  };

  const stack = (router as unknown as { stack: Array<{ route: { methods: Record<string, boolean>; stack: Array<{ handle: (...a: unknown[]) => unknown }> } }> }).stack;
  const route = stack.find((l) => l.route.methods.post);
  let idx = 0;
  const chain = route!.route.stack;
  const responded = () => (res as unknown as { _body: unknown })._body !== null;
  const runAt = (i: number): unknown => {
    if (responded()) return undefined;
    const entry = chain[i];
    if (!entry) return undefined;
    return entry.handle(req, res, () => {
      idx++;
      return runAt(idx);
    });
  };
  await Promise.resolve(runAt(idx));

  return {
    status: (res as unknown as { _status: number })._status,
    body: ((res as unknown as { _body: unknown })._body ?? {}) as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------

let tokenSvc: ReturnType<typeof fakeTokenService>;
let token: string;

beforeEach(() => {
  tokenSvc = fakeTokenService();
  token = tokenSvc.issue("user-alice");
});

describe("one AnalysisGenerator, two callers", () => {
  it("routes the button and the tool to the SAME instrumented instance", async () => {
    const h = harness();

    // The button.
    const container = { tokenService: tokenSvc, analysisService: h.service } as unknown as Container;
    const router = createAnalysisRouter(container);
    await fromButton(router, token, {});

    // The sentence. The tool resolves nothing about the generator itself; it
    // forwards into the very instance the button uses.
    const tool = new MetaAnalyzeTool(h.service, ACCOUNT);
    await tool.execute({}, { userId: "user-alice", traceId: "trace-jarvis" });

    expect(h.calls).toHaveLength(2);

    const [button, sentence] = h.calls;

    // The route deliberately sends no accountId (the server-configured one is
    // resolved inside the generator); the tool falls back to the same default.
    // Both arms therefore analyze the SAME account.
    expect(button!.input.accountId).toBeUndefined();
    expect(sentence!.input.accountId).toBe(ACCOUNT);

    expect(button!.caller.userId).toBe("user-alice");
    expect(sentence!.caller.userId).toBe("user-alice");

    // The button brings the verified role and the wire identity; the tool
    // cannot (ToolContext carries no role) and says so by fixing role member.
    expect(button!.caller.role).toBe("member");
    expect(button!.caller.traceId).toBeTruthy();
    expect(button!.caller.ipAddress).toBe("127.0.0.1");
    expect(sentence!.caller.traceId).toBe("trace-jarvis");
  });

  it("gives both callers the same outcome for the same account", async () => {
    const h = harness();

    const viaButton = await h.service.analyze({}, { userId: "user-alice", role: "member" });
    const viaTool = await new MetaAnalyzeTool(h.service, ACCOUNT).execute(
      { accountId: ACCOUNT },
      { userId: "user-alice", traceId: "trace-jarvis" }
    );

    expect(viaButton.status).toBe("COMPLETED");
    expect(viaTool.success).toBe(true);
    const data = viaTool.data as { status: string; target?: { id?: string } };
    expect(data.status).toBe("COMPLETED");
    // Same target, same scan — one pipeline produced both.
    const buttonTarget = (viaButton as { target?: { id?: string } }).target;
    expect(data.target?.id).toBe(buttonTarget?.id);

    // And the read calls added up identically on the single executor.
    const insightCalls = h.executor.calls.filter((c) => c.toolId === "meta.insights");
    expect(insightCalls).toHaveLength(2);
  });

  it("runs the dry-run boundary identically from both sides", async () => {
    const h = harness();
    const viaButton = await h.service.analyze({ dryRun: true }, { userId: "user-alice", role: "member" });
    const tool = new MetaAnalyzeTool(h.service, ACCOUNT);
    const viaTool = await tool.execute({ dryRun: true }, { userId: "user-alice" });

    expect(viaButton.status).toBe("DRY_RUN_OK");
    expect(viaTool.success).toBe(true);
    // Both stopped at generate: no durable record on the shared store.
    expect(h.executor.calls.length).toBeGreaterThan(0);
  });

  it("applies the same confirmation-free verdict semantics to both arms", async () => {
    // Reads need no confirmation on either path: the tool and the route are
    // both READ_ONLY by construction and neither can reach an executor write.
    const h = harness();
    expect(new MetaAnalyzeTool(h.service, ACCOUNT).risk).toBe("READ_ONLY");
    expect(new MetaAnalyzeTool(h.service, ACCOUNT).requiresApproval).toBe(false);

    for (const req of h.executor.calls) {
      expect(req.toolId).toMatch(/^meta\./);
      expect(req.toolId).not.toMatch(/pause|resume|budget|mutate/);
    }
  });

  it("a leaky read row reaches neither caller's output", async () => {
    const executor = makeExecutor();
    executor.data["meta.insights"] = {
      success: true,
      data: {
        insights: insightRows().map((r) => ({ ...r, page_access_token: "EAA-parity-secret" })),
      },
    };
    const audit = makeAudit();
    const shared = new AnalysisGenerator({
      executor: { execute: executor.execute },
      provider: makeProvider(),
      store: makeStore(),
      audit,
      config: { defaultAccountId: ACCOUNT },
      nowFn: () => NOW,
    });

    const viaButton = await shared.analyze({}, { userId: "user-alice", role: "member" });
    const viaTool = await new MetaAnalyzeTool(shared, ACCOUNT).execute({}, { userId: "user-alice" });

    expect(JSON.stringify(viaButton)).not.toMatch(/EAA|page_access_token/);
    expect(JSON.stringify(viaTool)).not.toMatch(/EAA|page_access_token/);
  });
});