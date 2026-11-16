// ---------------------------------------------------------------------------
// Phase 19, P0 — the real-Chromium end-to-end test. OPT-IN.
//
// Run ONLY through `node scripts/browser-e2e/run.mjs`, which starts the
// isolated browser service (real Debian/glibc Chromium, the reviewed seccomp
// profile, the fixture egress) and passes its address and throwaway
// credentials in. Without JARVIS_BROWSER_E2E=1 every test here is skipped, and
// `pnpm test` never collects this file at all (vitest.browser-e2e.config.ts).
//
// THE PATH UNDER TEST — every link is the production class, none is a fake:
//
//   a person's request (the scripted model stands in for the LLM's choice)
//     -> Orchestrator + BrowserAgent (its policy, its tool allowlist)
//     -> ToolApprovalService (security) for an approval-gated write
//     -> ToolExecutor (PermissionService, ApprovalService, the shared-
//        connection access gate)
//     -> the browser tools (journal, approval consumption, write scope)
//     -> RemoteBrowserRuntime (the Organization from the real resolver)
//     -> BrowserServiceClient -> the signed request over REAL mutual TLS
//     -> the browser service -> real Chromium -> the egress proxy's policy
//     -> a controlled fixture site.
//
// What is in memory, not PostgreSQL: the approval rows (MemoryOrgApprovals,
// which applies the Phase 17 Organization rules), the tenancy, the execution
// journal and the audit sink. Their PostgreSQL behaviour is pinned by the
// @jarvis/db suites; this test is about the browser path.
//
// Not covered here because it does not exist: there is no user-facing route or
// UI that returns a screenshot or a downloaded file. Artifacts are checked
// through the store's own scoped interface — `browser.upload`, which resolves
// an id only in the caller's scope, here, and the store's scoped reads inside
// the container (scripts/browser-e2e/fixture/verify-artifacts.mjs).
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";

import { AGENT_IDS, AgentRegistry, BrowserAgent, ConversationalAssistant, Orchestrator } from "@jarvis/agents";
import {
  BrowserServiceClient,
  BrowserServiceError,
  RemoteBrowserRuntime,
  checkBrowserServiceClientTls,
  nodeBrowserServiceTransport,
  probeBrowserService,
  readBrowserServiceEndpoint,
  type BrowserServiceEndpointConfig,
  type BrowserServiceTransport,
} from "@jarvis/browser-protocol";
import {
  BROWSER_TOOL_IDS,
  COMPUTER_CONTROL_ALREADY_UNKNOWN_MESSAGE,
  COMPUTER_CONTROL_OUTCOME_UNKNOWN_MESSAGE,
  SHARED_INTEGRATION_CONNECTORS,
  computeParamsHash,
  type AICompletionRequest,
  type AICompletionResponse,
  type AuditEntry,
  type AuditLogger,
  type IAIProvider,
  type IApprovalConsumptionPort,
  type IAuditRepository,
  type IToolExecutor,
  type Role,
  type ToolExecutionRequest,
  type ToolExecutionResult,
} from "@jarvis/core";
import {
  ApprovalService,
  AuditLogger as RedactingAuditLogger,
  PermissionService,
  ToolApprovalService,
} from "@jarvis/security";
import { MemoryExecutionJournal, ToolExecutor, ToolRegistry, createBrowserTools } from "@jarvis/tools";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createBrowserSessionTenantResolver,
  createBrowserWriteScopeResolver,
  createSharedConnectionToolGate,
} from "../../src/services/tenancy/shared-connection-access.js";
import { MemoryOrgApprovals } from "../helpers/memory-org-approvals.js";
import { accessOver, memoryTenancy, type MemoryTenancy } from "../helpers/shared-access.js";

const ENABLED = process.env.JARVIS_BROWSER_E2E === "1";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set: run node scripts/browser-e2e/run.mjs`);
  return value;
}

// The fixture's download, byte for byte (scripts/browser-e2e/fixture/fixture-egress.mjs).
const REPORT_CSV = "id,name,amount\n1,alpha,10\n2,beta,20\n3,gamma,30\n";
const REPORT_SHA256 = createHash("sha256").update(REPORT_CSV).digest("hex");
const CONFIDENTIAL = "CONFIDENTIAL-FIXTURE-CONTENT-5c2e91";

// One Organization owns the browser connection. Its owner requests writes and
// its admin approves them (Phase 17: never the requester). The outsider
// belongs to another Organization.
const ORG_A = "org-a-e2e";
const ORG_B = "org-b-e2e";
const OWNER = "owner-a-e2e";
const ADMIN = "admin-a-e2e";
const OUTSIDER = "owner-b-e2e";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The LLM's choice of tool, scripted: the model is not what this test is about. */
class ScriptedProvider implements IAIProvider {
  readonly id = "scripted-e2e";
  readonly name = "Scripted E2E model";
  readonly defaultModel = "scripted";
  private queue: AICompletionResponse[] = [];

  callTool(name: string, args: Record<string, unknown>): void {
    this.queue.push(
      {
        message: { role: "assistant", content: "", toolCalls: [{ id: `call-${this.queue.length}`, name, arguments: args }] },
        finishReason: "tool_calls",
        model: "scripted",
      },
      { message: { role: "assistant", content: "done" }, finishReason: "stop", model: "scripted" }
    );
  }

  async complete(_request: AICompletionRequest): Promise<AICompletionResponse> {
    return (
      this.queue.shift() ?? { message: { role: "assistant", content: "done" }, finishReason: "stop", model: "scripted" }
    );
  }

  async listModels(): Promise<string[]> {
    return [this.defaultModel];
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

class MemoryAudit implements IAuditRepository {
  readonly entries: AuditEntry[] = [];
  async create(entry: Omit<AuditEntry, "id" | "timestamp">): Promise<AuditEntry> {
    const row = { ...entry, id: `audit-${this.entries.length + 1}`, timestamp: new Date() } as AuditEntry;
    this.entries.push(row);
    return row;
  }
  async query(): Promise<AuditEntry[]> {
    return [...this.entries];
  }
}

interface Sent {
  operation: string;
  status: number | "transport-error";
}

describe.skipIf(!ENABLED)("the browser path, end to end, against real Chromium (Phase 19, P0)", () => {
  let fixture: string;
  let config: BrowserServiceEndpointConfig;
  let tlsDir: string;
  let tenancy: MemoryTenancy;
  let approvals: MemoryOrgApprovals;
  let journal: MemoryExecutionJournal;
  let consumption: IApprovalConsumptionPort;
  let registry: ToolRegistry;
  let executor: ToolExecutor;
  let orchestrator: Orchestrator;
  let provider: ScriptedProvider;
  let client: BrowserServiceClient;
  const sent: Sent[] = [];
  const executed: Array<{ request: ToolExecutionRequest; result: ToolExecutionResult }> = [];
  const audit = new MemoryAudit();
  /**
   * The executor's audit rows as production stores them: written by the real
   * AuditLogger, so after its redaction. Never the logger's raw input.
   */
  const executorAudit = new MemoryAudit();
  /** Every error text any layer surfaced. None may carry a secret or a page's contents. */
  const surfaced: string[] = [];
  const results: Record<string, unknown> = {};
  let turn = 0;

  /** The real transport, observed: what the service received, and how it answered. */
  const recordingTransport: BrowserServiceTransport = async (request) => {
    const body = JSON.parse(Buffer.from(request.body).toString("utf8")) as { operation: string };
    try {
      const response = await nodeBrowserServiceTransport(request);
      sent.push({ operation: body.operation, status: response.status });
      return response;
    } catch (error) {
      sent.push({ operation: body.operation, status: "transport-error" });
      throw error;
    }
  };

  function toolsOver(clientFor: BrowserServiceClient) {
    const access = accessOver(tenancy);
    const runtime = new RemoteBrowserRuntime({ client: clientFor, tenant: createBrowserSessionTenantResolver(access) });
    const toolRegistry = new ToolRegistry();
    for (const tool of createBrowserTools(runtime, journal, consumption, createBrowserWriteScopeResolver(access))) {
      toolRegistry.register(tool);
    }
    const auditLogger = new RedactingAuditLogger(executorAudit);
    const toolExecutor = new ToolExecutor(toolRegistry, new PermissionService(), new ApprovalService(approvals), auditLogger, {
      accessGate: createSharedConnectionToolGate(access),
    });
    return { toolRegistry, toolExecutor };
  }

  beforeAll(() => {
    fixture = required("JARVIS_BROWSER_E2E_FIXTURE_HOST");
    tlsDir = required("JARVIS_BROWSER_E2E_TLS_DIR");
    const read = readBrowserServiceEndpoint({
      BROWSER_SERVICE_URL: required("JARVIS_BROWSER_E2E_URL"),
      BROWSER_SERVICE_KEY_ID: required("JARVIS_BROWSER_E2E_KEY_ID"),
      BROWSER_SERVICE_SHARED_SECRET: required("JARVIS_BROWSER_E2E_SECRET"),
      BROWSER_SERVICE_PEER_IDENTITY: required("JARVIS_BROWSER_E2E_PEER"),
      BROWSER_SERVICE_TIMEOUT_MS: "60000",
      BROWSER_SERVICE_CLIENT_CERT_PATH: join(tlsDir, "api", "client.crt"),
      BROWSER_SERVICE_CLIENT_KEY_PATH: join(tlsDir, "api", "client.key"),
      BROWSER_SERVICE_CA_PATH: join(tlsDir, "api", "ca.crt"),
    });
    if (read.state !== "ready") throw new Error(`the E2E endpoint is not usable: ${read.state}`);
    config = read.config;

    const browser = SHARED_INTEGRATION_CONNECTORS.browser;
    tenancy = memoryTenancy({
      owners: { [`${browser.providerId}/${browser.connector}`]: ORG_A },
      members: [
        { userId: OWNER, tenantId: ORG_A, role: "owner" },
        { userId: ADMIN, tenantId: ORG_A, role: "admin" },
        { userId: OUTSIDER, tenantId: ORG_B, role: "owner" },
      ],
    });
    approvals = new MemoryOrgApprovals(tenancy);
    journal = new MemoryExecutionJournal();
    // Spending an approval claims the execution in the same step, as the
    // PostgreSQL store does in one transaction: burn, claim, or roll back.
    consumption = {
      async consumeForExecution(input) {
        const spent = await approvals.consumeForExecution(input);
        if (!spent.ok) return spent;
        const claimed = await journal.claimForExecution(input.executionId, { ownerId: "approval-store", leaseMs: 120_000 });
        if (claimed) return spent;
        const row = approvals.rows.get(input.approvalId);
        if (row) row.status = "approved";
        return { ok: false, reason: "execution not claimable" };
      },
    };

    client = new BrowserServiceClient({ config, transport: recordingTransport });
    const built = toolsOver(client);
    registry = built.toolRegistry;
    executor = built.toolExecutor;

    provider = new ScriptedProvider();
    const agents = new AgentRegistry({ requirePolicy: true });
    agents.register(new ConversationalAssistant({ provider }));
    agents.register(new BrowserAgent({ provider }));
    const recorder: IToolExecutor = {
      execute: async (request) => {
        const result = await executor.execute(request);
        executed.push({ request, result });
        return result;
      },
    };
    orchestrator = new Orchestrator(agents, recorder, { log: async () => undefined } as unknown as AuditLogger, {
      toolRegistry: registry,
      permissionChecker: new PermissionService(),
      toolApprovalService: new ToolApprovalService(approvals, audit, new PermissionService()),
      accessGate: createSharedConnectionToolGate(accessOver(tenancy)),
    });
  });

  afterAll(() => {
    const out = process.env.JARVIS_BROWSER_E2E_RESULTS;
    if (out && results.screenshotId && results.downloadId) {
      writeFileSync(
        out,
        JSON.stringify({
          owner: { userId: OWNER, organizationId: ORG_A },
          strangers: [
            { userId: ADMIN, organizationId: ORG_A },
            { userId: OUTSIDER, organizationId: ORG_B },
            { userId: OWNER, organizationId: ORG_B },
          ],
          screenshotId: results.screenshotId,
          downloadId: results.downloadId,
          downloadSha256: REPORT_SHA256,
        })
      );
    }
  });

  const page = (path: string) => `http://${fixture}${path}`;

  /**
   * One chat turn: the model asks for one tool, the orchestrator decides what happens.
   *
   * `message` is the owner's own words. For a read it does not matter; for a write
   * the orchestrator's write-intent gate reads it, verbatim, before any approval can
   * exist, so a write test must say what it wants done.
   */
  async function ask(userId: string, toolId: string, params: Record<string, unknown>, message = `please use ${toolId}`) {
    turn += 1;
    const before = executed.length;
    const sentBefore = sent.length;
    provider.callTool(toolId, params);
    const response = await orchestrator.process(
      { message, agentId: AGENT_IDS.browser, stream: false },
      {
        auth: { userId, role: "owner" as Role, email: `${userId}@e2e.test` },
        conversationId: `conv-${userId}`,
        traceId: `trace-e2e-${turn}`,
      }
    );
    return { response, executed: executed.slice(before), sent: sent.slice(sentBefore) };
  }

  /** The confirm path: the requester runs an approved write with its approval id. */
  async function confirm(userId: string, toolId: string, params: Record<string, unknown>, approvalId?: string) {
    turn += 1;
    const result = await executor.execute({
      toolId,
      params,
      userId,
      role: "owner" as Role,
      traceId: `trace-e2e-${turn}`,
      ...(approvalId ? { approvalId } : {}),
    });
    if (result.error) surfaced.push(result.error);
    return result;
  }

  /** What the site has received, read through the same real browser path. */
  async function siteState(): Promise<{
    requests: number;
    submits: Array<{ email: string }>;
    slowSubmits: number;
    downloads: number;
  }> {
    const result = await confirm(OWNER, BROWSER_TOOL_IDS.extract, { url: page("/state"), selectors: { state: "#state" } });
    expect(result.status, result.error).toBe("completed");
    const fields = (result.result?.data as { fields?: Record<string, string> }).fields ?? {};
    return JSON.parse(fields.state ?? "{}");
  }

  async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 8_000): Promise<T> {
    const until = Date.now() + ms;
    let value = await read();
    while (!done(value) && Date.now() < until) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      value = await read();
    }
    return value;
  }

  function journalRow(userId: string, toolId: string, params: Record<string, unknown>) {
    return journal.begin({
      userId,
      toolId,
      idempotencyKey: `${toolId}:${computeParamsHash(params)}`,
      paramsHash: computeParamsHash(params),
      provider: "browser",
    });
  }

  async function serviceRefusal(promise: Promise<unknown>): Promise<BrowserServiceError> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserServiceError);
      surfaced.push((error as Error).message);
      return error as BrowserServiceError;
    }
    throw new Error("the service accepted a request it must refuse");
  }

  // -------------------------------------------------------------------------
  // Start-up: the same three checks the API makes
  // -------------------------------------------------------------------------

  it("passes the API's start-up checks: configuration, TLS material, and the authenticated probe", async () => {
    expect(config.baseUrl).toMatch(/^https:\/\/localhost:\d+$/);
    const tls = checkBrowserServiceClientTls(config.tls!, config.peerIdentity);
    expect(tls.ok).toBe(true);
    await expect(probeBrowserService(config)).resolves.toEqual({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Reads, through the orchestrator
  // -------------------------------------------------------------------------

  it("navigates: the orchestrator picks browser.navigate, the service opens a session, Chromium loads the fixture", async () => {
    const { executed: ran, sent: wire } = await ask(OWNER, BROWSER_TOOL_IDS.navigate, { url: page("/") });
    expect(ran.map((r) => r.request.toolId)).toEqual([BROWSER_TOOL_IDS.navigate]);
    expect(ran[0]!.result.status, ran[0]!.result.error).toBe("completed");
    const data = ran[0]!.result.result?.data as { title: string; status: number; url: string };
    expect(data.title).toBe("JARVIS E2E Fixture");
    expect(data.status).toBe(200);
    expect(data.url).toBe(page("/"));
    // The real service received exactly this, and answered every call.
    expect(wire.map((w) => w.operation)).toEqual(["session.open", "browser.navigate", "session.close"]);
    expect(wire.every((w) => w.status === 200)).toBe(true);
  });

  it("inspects: the page's controls, with selectors a later action can use", async () => {
    const { executed: ran } = await ask(OWNER, BROWSER_TOOL_IDS.inspect, { url: page("/") });
    expect(ran[0]!.result.status, ran[0]!.result.error).toBe("completed");
    const elements = (ran[0]!.result.result?.data as { elements: Array<{ tag: string; label: string; href?: string }> }).elements;
    expect(elements.some((e) => e.tag === "button" && /send/i.test(e.label))).toBe(true);
    expect(elements.some((e) => e.tag === "a" && (e.href ?? "").endsWith("/files/report.csv"))).toBe(true);
    expect(elements.some((e) => e.tag === "input")).toBe(true);
  });

  it("extracts: the rendered DOM, including what the page's own script wrote — proof a real engine rendered it", async () => {
    const { executed: ran } = await ask(OWNER, BROWSER_TOOL_IDS.extract, {
      url: page("/"),
      selectors: { marker: "#marker", script: "#js" },
    });
    expect(ran[0]!.result.status, ran[0]!.result.error).toBe("completed");
    const data = ran[0]!.result.result?.data as { text: string; fields: Record<string, string> };
    expect(data.fields.marker).toBe("fixture-marker-7c1d");
    expect(data.fields.script).toBe("rendered-by-chromium-42");
    expect(data.text).toContain("JARVIS E2E Fixture");
  });

  it("captures a screenshot: a stored PNG, returned by id and never inline", async () => {
    const { executed: ran } = await ask(OWNER, BROWSER_TOOL_IDS.screenshot, { url: page("/") });
    expect(ran[0]!.result.status, ran[0]!.result.error).toBe("completed");
    const data = ran[0]!.result.result?.data as { screenshotId: string; byteSize: number; format: string };
    expect(data.screenshotId).toMatch(UUID);
    expect(data.format).toBe("png");
    expect(data.byteSize).toBeGreaterThan(1_000);
    expect(JSON.stringify(data)).not.toMatch(/iVBORw0KGgo|base64/);
    results.screenshotId = data.screenshotId;
  });

  // -------------------------------------------------------------------------
  // Navigation and egress policy
  // -------------------------------------------------------------------------

  it("refuses the metadata address, a name off the allowlist, and a name that resolves privately", async () => {
    const before = (await siteState()).requests;
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://not-allowlisted.jarvis-p19.net/",
      `http://private.${fixture}/`,
    ]) {
      const result = await confirm(OWNER, BROWSER_TOOL_IDS.navigate, { url });
      const data = result.result?.data as { status?: number; title?: string } | undefined;
      // Refused before the browser, or answered by the proxy's refusal — never the site.
      const reachedSite = result.status === "completed" && data?.status === 200 && data?.title === "JARVIS E2E Fixture";
      expect(reachedSite, url).toBe(false);
      expect(result.status === "completed" ? data?.status : "refused", url).not.toBe(200);
    }
    // Nothing reached the fixture but this test's second state read. The fixture
    // counts the read that reports the count, so the first read is inside `before`.
    expect((await siteState()).requests).toBe(before + 1);
  });

  it("ends a navigation that never answers at the browser's own deadline", async () => {
    const started = Date.now();
    const result = await confirm(OWNER, BROWSER_TOOL_IDS.navigate, { url: page("/slow") });
    expect(result.status).not.toBe("completed");
    expect(Date.now() - started).toBeLessThan(45_000);
  });

  // -------------------------------------------------------------------------
  // Approval-gated writes
  // -------------------------------------------------------------------------

  const DOWNLOAD = () => ({ url: page("/"), selector: "#dl" });
  // The request names the file, the page and the link. "download" is not one of the
  // gate's action verbs, so the request also says "click" and "save": a bare
  // "Download report.csv from …" is held as ambiguous and never reaches an approval.
  const DOWNLOAD_REQUEST = () =>
    `Please download report.csv from ${page("/")}: click the "Download the report" link and save the file.`;

  it("download: needs approval, refuses the requester as approver, runs once when approved, never twice", async () => {
    const params = DOWNLOAD();
    const proposed = await ask(OWNER, BROWSER_TOOL_IDS.download, params, DOWNLOAD_REQUEST());
    // The turn stops at approval and nothing is sent. Download is LOW_IMPACT, so
    // ToolApprovalService passes it to the executor, whose own approval gate opens
    // the approval and runs nothing: one call, answered "approval_pending".
    expect(proposed.executed.map((entry) => entry.result.status)).toEqual(["approval_pending"]);
    expect(proposed.sent).toEqual([]);
    const pending = [...approvals.rows.values()].find((row) => row.toolId === BROWSER_TOOL_IDS.download && row.status === "pending");
    expect(pending, "a pending approval").toBeDefined();
    expect(pending!.tenantId).toBe(ORG_A);

    // Without an approval the executor refuses, and the site sees no download.
    const unapproved = await confirm(OWNER, BROWSER_TOOL_IDS.download, params);
    expect(unapproved.status).not.toBe("completed");
    expect((await siteState()).downloads).toBe(0);

    // Phase 17: the requester cannot approve their own Organization's write.
    expect(await approvals.decide(pending!.id, OWNER, "approved")).toBe("self_approval_forbidden");
    expect(await approvals.decide(pending!.id, ADMIN, "approved")).toBe("ok");

    const done = await confirm(OWNER, BROWSER_TOOL_IDS.download, params, pending!.id);
    expect(done.status, done.error).toBe("completed");
    const data = done.result?.data as { downloadId: string; byteSize: number; mimeType: string; fileName: string };
    expect(data.downloadId).toMatch(UUID);
    expect(data.mimeType).toBe("text/csv");
    expect(data.byteSize).toBe(Buffer.byteLength(REPORT_CSV));
    expect(data.fileName.startsWith(data.downloadId)).toBe(true);
    expect(approvals.status(pending!.id)).toBe("consumed");
    expect((await journalRow(OWNER, BROWSER_TOOL_IDS.download, params)).status).toBe("SUCCEEDED");
    expect((await siteState()).downloads).toBe(1);
    results.downloadId = data.downloadId;

    // The spent approval cannot be replayed.
    const replay = await confirm(OWNER, BROWSER_TOOL_IDS.download, params, pending!.id);
    expect(replay.status).not.toBe("completed");
    expect((await siteState()).downloads).toBe(1);
  });

  const SUBMIT = () => ({ url: page("/"), selector: "#send", fields: { "#email": "e2e@example.test" } });
  // The request names the form, the page and the data it sends.
  const SUBMIT_REQUEST = () => `Submit the contact form on ${page("/")} with the email e2e@example.test.`;

  it("submit: needs approval, is refused unapproved, reaches the site exactly once when approved", async () => {
    const params = SUBMIT();
    const proposed = await ask(OWNER, BROWSER_TOOL_IDS.submit, params, SUBMIT_REQUEST());
    expect(proposed.executed).toEqual([]);
    expect(proposed.sent).toEqual([]);
    const pending = [...approvals.rows.values()].find((row) => row.toolId === BROWSER_TOOL_IDS.submit && row.status === "pending")!;
    expect(pending).toBeDefined();

    const unapproved = await confirm(OWNER, BROWSER_TOOL_IDS.submit, params);
    expect(unapproved.status).not.toBe("completed");
    expect((await siteState()).submits).toEqual([]);

    expect(await approvals.decide(pending.id, ADMIN, "approved")).toBe("ok");
    const done = await confirm(OWNER, BROWSER_TOOL_IDS.submit, params, pending.id);
    expect(done.status, done.error).toBe("completed");
    expect(approvals.status(pending.id)).toBe("consumed");
    expect((await journalRow(OWNER, BROWSER_TOOL_IDS.submit, params)).status).toBe("SUCCEEDED");

    // The click sends the form; the site's side, read back through the browser.
    const state = await eventually(siteState, (s) => s.submits.length > 0);
    expect(state.submits).toEqual([{ email: "e2e@example.test" }]);

    const replay = await confirm(OWNER, BROWSER_TOOL_IDS.submit, params, pending.id);
    expect(replay.status).not.toBe("completed");
    expect((await siteState()).submits).toHaveLength(1);
  });

  it("an unknown outcome is recorded as UNKNOWN and never sent again, even with a new approval", async () => {
    // A client with a short deadline: the write is still in progress (the
    // button appears after 4 s) when the API stops waiting.
    const slowClient = new BrowserServiceClient({ config: { ...config, timeoutMs: 3_000 }, transport: recordingTransport });
    const slow = toolsOver(slowClient);
    const params = { url: page("/slow-form"), selector: "#slow-send", fields: { "#slow-email": "slow@example.test" } };

    const first = await approvals.create({
      userId: OWNER,
      toolId: BROWSER_TOOL_IDS.submit,
      action: "execute",
      params,
      paramsHash: computeParamsHash(params),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    } as never);
    expect(await approvals.decide(first.id, ADMIN, "approved")).toBe("ok");

    const outcome = await slow.toolExecutor.execute({
      toolId: BROWSER_TOOL_IDS.submit,
      params,
      userId: OWNER,
      role: "owner" as Role,
      traceId: "trace-e2e-unknown-1",
      approvalId: first.id,
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toBe(COMPUTER_CONTROL_OUTCOME_UNKNOWN_MESSAGE);
    surfaced.push(outcome.error ?? "");
    const row = await journalRow(OWNER, BROWSER_TOOL_IDS.submit, params);
    expect(row.status).toBe("UNKNOWN");

    // A person approves the same submit again: it is refused before any request.
    const second = await approvals.create({
      userId: OWNER,
      toolId: BROWSER_TOOL_IDS.submit,
      action: "execute",
      params,
      paramsHash: computeParamsHash(params),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    } as never);
    expect(await approvals.decide(second.id, ADMIN, "approved")).toBe("ok");
    const sentBefore = sent.length;
    const again = await slow.toolExecutor.execute({
      toolId: BROWSER_TOOL_IDS.submit,
      params,
      userId: OWNER,
      role: "owner" as Role,
      traceId: "trace-e2e-unknown-2",
      approvalId: second.id,
    });
    expect(again.status).toBe("failed");
    expect(again.error).toBe(COMPUTER_CONTROL_ALREADY_UNKNOWN_MESSAGE);
    expect(sent.length).toBe(sentBefore);
    expect(approvals.status(second.id)).toBe("approved");

    // Whatever happened to the first, the site never received it twice.
    await new Promise((resolveWait) => setTimeout(resolveWait, 6_000));
    expect((await siteState()).slowSubmits).toBeLessThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // Artifacts and tenancy
  // -------------------------------------------------------------------------

  async function approvedUpload(requester: string, approver: string, downloadId: string) {
    const params = { url: page("/upload-form"), selector: "#file", downloadId };
    const approval = await approvals.create({
      userId: requester,
      toolId: BROWSER_TOOL_IDS.upload,
      action: "execute",
      params,
      paramsHash: computeParamsHash(params),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    } as never);
    expect(await approvals.decide(approval.id, approver, "approved")).toBe("ok");
    return confirm(requester, BROWSER_TOOL_IDS.upload, params, approval.id);
  }

  it("an artifact is usable by its owner, in its Organization, and by no one else", async () => {
    const downloadId = results.downloadId as string;
    expect(downloadId).toMatch(UUID);

    const own = await approvedUpload(OWNER, ADMIN, downloadId);
    expect(own.status, own.error).toBe("completed");

    // Another user of the SAME Organization: the store does not find it.
    const colleague = await approvedUpload(ADMIN, OWNER, downloadId);
    expect(colleague.status).not.toBe("completed");

    // Another Organization, directly against the service with the real client:
    // a session of its own, and the owner's id is not found in its scope.
    const outsider = { userId: OUTSIDER, organizationId: ORG_B };
    const opened = (await client.execute({ operation: "session.open", subject: outsider })) as { sessionId: string };
    try {
      await client.execute({ operation: BROWSER_TOOL_IDS.navigate, sessionId: opened.sessionId, subject: outsider, payload: { url: page("/upload-form") } });
      const refused = await serviceRefusal(
        client.execute({
          operation: BROWSER_TOOL_IDS.upload,
          sessionId: opened.sessionId,
          subject: outsider,
          payload: { url: page("/upload-form"), selector: "#file", downloadId },
        })
      );
      expect(refused.code).not.toBe("UNAUTHENTICATED");
    } finally {
      await client.execute({ operation: "session.close", sessionId: opened.sessionId, subject: outsider });
    }
  });

  it("a session is its owner's alone: another Organization, another user, or a false Organization claim is refused", async () => {
    const owner = { userId: OWNER, organizationId: ORG_A };
    const opened = (await client.execute({ operation: "session.open", subject: owner })) as { sessionId: string };
    try {
      await client.execute({ operation: BROWSER_TOOL_IDS.navigate, sessionId: opened.sessionId, subject: owner, payload: { url: page("/confidential") } });
      for (const intruder of [
        { userId: OUTSIDER, organizationId: ORG_B },
        { userId: ADMIN, organizationId: ORG_A },
        { userId: OWNER, organizationId: ORG_B },
      ]) {
        const refused = await serviceRefusal(
          client.execute({
            operation: BROWSER_TOOL_IDS.extract,
            sessionId: opened.sessionId,
            subject: intruder,
            payload: { url: page("/confidential") },
          })
        );
        expect(refused.code).toBe("CROSS_TENANT_DENIED");
        expect(refused.message).not.toContain(CONFIDENTIAL);
      }
      // The owner still can.
      const own = (await client.execute({
        operation: BROWSER_TOOL_IDS.extract,
        sessionId: opened.sessionId,
        subject: owner,
        payload: { url: page("/confidential") },
      })) as { text: string };
      expect(own.text).toContain(CONFIDENTIAL);
    } finally {
      await client.execute({ operation: "session.close", sessionId: opened.sessionId, subject: owner });
    }
  });

  it("an account outside the owning Organization is refused before any request is made", async () => {
    const { response, sent: wire, executed: ran } = await ask(OUTSIDER, BROWSER_TOOL_IDS.navigate, { url: page("/") });
    expect(wire).toEqual([]);
    for (const r of ran) expect(r.result.status).not.toBe("completed");
    expect(JSON.stringify(response)).not.toContain("JARVIS E2E Fixture");
  });

  // -------------------------------------------------------------------------
  // Sessions that are not live
  // -------------------------------------------------------------------------

  it("refuses an id that was never issued, a closed session, and an expired one", async () => {
    const owner = { userId: OWNER, organizationId: ORG_A };
    const unknown = await serviceRefusal(
      client.execute({
        operation: BROWSER_TOOL_IDS.inspect,
        sessionId: "11111111-1111-4111-8111-111111111111",
        subject: owner,
        payload: { url: page("/") },
      })
    );
    expect(unknown.code).toBe("SESSION_NOT_FOUND");

    const closed = (await client.execute({ operation: "session.open", subject: owner })) as { sessionId: string };
    await client.execute({ operation: "session.close", sessionId: closed.sessionId, subject: owner });
    expect(
      (
        await serviceRefusal(
          client.execute({ operation: BROWSER_TOOL_IDS.navigate, sessionId: closed.sessionId, subject: owner, payload: { url: page("/") } })
        )
      ).code
    ).toBe("SESSION_NOT_FOUND");

    // The E2E project's session TTL is 30 s.
    const expiring = (await client.execute({ operation: "session.open", subject: owner })) as { sessionId: string };
    await new Promise((resolveWait) => setTimeout(resolveWait, 32_000));
    const expired = await serviceRefusal(
      client.execute({ operation: BROWSER_TOOL_IDS.navigate, sessionId: expiring.sessionId, subject: owner, payload: { url: page("/") } })
    );
    expect(["SESSION_EXPIRED", "SESSION_NOT_FOUND"]).toContain(expired.code);
  });

  // -------------------------------------------------------------------------
  // Configuration and connection failures, against the real service
  // -------------------------------------------------------------------------

  it("refuses a wrong signing secret, and a certificate for another identity", async () => {
    const wrongSecret = new BrowserServiceClient({ config: { ...config, secret: "f".repeat(64) } });
    const refused = await serviceRefusal(wrongSecret.execute({ operation: "session.open", subject: { userId: OWNER, organizationId: ORG_A } }));
    expect(refused.code).toBe("UNAUTHENTICATED");
    expect(await probeBrowserService({ ...config, secret: "f".repeat(64) })).toMatchObject({ ok: false, reason: "authentication" });

    const other = {
      ...config,
      tls: { certPath: join(tlsDir, "refused", "other.crt"), keyPath: join(tlsDir, "refused", "other.key"), caPath: config.tls!.caPath },
    };
    expect(checkBrowserServiceClientTls(other.tls, config.peerIdentity)).toMatchObject({ ok: false, problem: "wrong-identity" });
    expect(await probeBrowserService(other)).toMatchObject({ ok: false, reason: "authentication" });
  });

  it("refuses a connection that presents no client certificate, or one from an untrusted CA", async () => {
    const port = Number(new URL(config.baseUrl).port);
    const attempt = (extra: { cert?: Buffer; key?: Buffer }) =>
      new Promise<{ status: number | null }>((resolveAttempt) => {
        const req = httpsRequest(
          {
            hostname: "localhost",
            port,
            path: "/v1/execute",
            method: "POST",
            ca: readFileSync(config.tls!.caPath!),
            headers: { "content-type": "application/json" },
            ...extra,
          },
          (res) => {
            res.resume();
            res.on("end", () => resolveAttempt({ status: res.statusCode ?? null }));
          }
        );
        req.on("error", () => resolveAttempt({ status: null }));
        req.end("{}");
      });
    expect((await attempt({})).status).not.toBe(200);
    const stranger = await attempt({
      cert: readFileSync(join(tlsDir, "refused", "stranger.crt")),
      key: readFileSync(join(tlsDir, "refused", "stranger.key")),
    });
    expect(stranger.status).not.toBe(200);
    expect(await probeBrowserService({
      ...config,
      tls: { certPath: join(tlsDir, "refused", "stranger.crt"), keyPath: join(tlsDir, "refused", "stranger.key"), caPath: config.tls!.caPath },
    })).toMatchObject({ ok: false });
  });

  it("reports a missing certificate file, an unavailable service and an unusable URL without sending anything", async () => {
    const missing = { ...config, tls: { ...config.tls!, certPath: join(tlsDir, "api", "missing.crt") } };
    expect(checkBrowserServiceClientTls(missing.tls, config.peerIdentity)).toMatchObject({ ok: false, problem: "unreadable" });
    expect(await probeBrowserService(missing)).toMatchObject({ ok: false, reason: "client-credentials-unreadable" });

    const server = createServer();
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const closedPort = (server.address() as AddressInfo).port;
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    const down = { ...config, baseUrl: `https://localhost:${closedPort}` };
    expect(await probeBrowserService(down)).toMatchObject({ ok: false, reason: "unreachable" });
    const unavailable = await serviceRefusal(
      new BrowserServiceClient({ config: down }).execute({ operation: "session.open", subject: { userId: OWNER, organizationId: ORG_A } })
    );
    expect(unavailable.code).toBe("UNAVAILABLE");
    expect(unavailable.outcome).toBe("not-sent");

    expect(readBrowserServiceEndpoint({ BROWSER_SERVICE_URL: "http://localhost:3200" })).toMatchObject({ state: "invalid", problem: "invalid-url" });
    expect(readBrowserServiceEndpoint({ BROWSER_SERVICE_URL: "not a url" })).toMatchObject({ state: "invalid", problem: "invalid-url" });
  });

  // -------------------------------------------------------------------------
  // Nothing leaked
  // -------------------------------------------------------------------------

  it("never let a secret, key material, a TLS path or a page's contents into an error or an audit row", () => {
    const keyLine = readFileSync(join(tlsDir, "api", "client.key"), "utf8").split("\n")[1]!;
    const everything = JSON.stringify({ surfaced, audit: audit.entries, executorAudit: executorAudit.entries });
    expect(surfaced.length).toBeGreaterThan(5);
    expect(everything).not.toContain(config.secret);
    expect(everything).not.toContain(keyLine);
    expect(everything).not.toMatch(/BEGIN (EC |RSA )?PRIVATE KEY|BEGIN CERTIFICATE/);
    expect(everything).not.toContain(tlsDir.replace(/\\/g, "\\\\"));
    expect(everything).not.toContain(CONFIDENTIAL);
    // What a person had typed into a form, in every submit this run made.
    expect(everything).not.toContain("e2e@example.test");
    expect(everything).not.toContain("slow@example.test");

    // The submits were recorded, and each row is the value-free record: the action,
    // its fixed summary, the origin and the field NAMES (never their values).
    const submitRows = executorAudit.entries.filter((row) => row.toolId === BROWSER_TOOL_IDS.submit);
    const fieldNames = submitRows.map(
      (row) => (row.parameters as { details?: Array<{ label: string; value: string }> }).details?.find((d) => d.label === "Fields")?.value
    );
    expect(fieldNames).toContain("#email");
    expect(fieldNames).toContain("#slow-email");
    for (const row of submitRows) {
      expect(Object.keys(row.parameters ?? {}).sort()).toEqual(["action", "details", "summary", "targetResource"]);
    }
  });
});
