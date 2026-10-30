// ---------------------------------------------------------------------------
// Phase 19, Stage 19.2 audit (H2) — a remote submit that may have reached the
// site is never sent twice.
//
// The audit's finding, reproduced end to end and pinned: before the fix, a
// submit that reached the site and then lost its answer — a timeout, a dropped
// connection, a provider error, an unknown outcome — left the journal FAILED,
// and a second approval sent it again. Two submits reached the site.
//
// Everything below is the production path except the network: the executor,
// its grant, the browser tools, the journal, the approval store's single-use
// claim, `RemoteBrowserRuntime` and `BrowserServiceClient`. The transport is a
// script standing in for the browser service AND the site behind it, so it can
// count how many submits the site received and choose how each answer is lost.
// ---------------------------------------------------------------------------

import {
  BrowserServiceClient,
  BROWSER_SERVICE_ERROR_MESSAGES,
  BrowserServiceTransportError,
  RemoteBrowserRuntime,
  failureEnvelope,
  successEnvelope,
  type BrowserServiceErrorCode,
  type BrowserServiceTransport,
  type BrowserServiceTransportResponse,
} from "@jarvis/browser-protocol";
import {
  BROWSER_TOOL_IDS,
  COMPUTER_CONTROL_ALREADY_UNKNOWN_MESSAGE,
  COMPUTER_CONTROL_OUTCOME_UNKNOWN_MESSAGE,
  computeParamsHash,
  type Approval,
  type AuditLogger,
  type BrowserWriteScopePort,
  type IApprovalConsumptionPort,
  type IApprovalManager,
  type IPermissionChecker,
  type ITool,
  type Role,
  type ToolAccessGate,
} from "@jarvis/core";
import { MemoryExecutionJournal, ToolExecutor, createBrowserTools } from "@jarvis/tools";
import { beforeEach, describe, expect, it } from "vitest";

const USER = "owner-1";
const ORG = "org-1";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const PAGE = { url: "https://example.com/form", title: "Form", status: 200 };
const SUBMIT = { url: PAGE.url, selector: "#send", fields: { "#email": "ada@example.com" } };

// ---------------------------------------------------------------------------
// The approval store, as the real one behaves: single use, bound to user,
// tool, parameters and the Organization the server resolved; spending claims
// the journal row in the same step.
// ---------------------------------------------------------------------------

interface Row {
  params: Record<string, unknown>;
  paramsHash: string;
  tenantId: string;
  consumed: boolean;
}

class Store implements IApprovalConsumptionPort {
  rows = new Map<string, Row>();
  constructor(private readonly journal: MemoryExecutionJournal) {}

  approve(id: string, params: Record<string, unknown>): void {
    this.rows.set(id, { params, paramsHash: computeParamsHash(params), tenantId: ORG, consumed: false });
  }

  async consumeForExecution(input: Parameters<IApprovalConsumptionPort["consumeForExecution"]>[0]) {
    const row = this.rows.get(input.approvalId);
    if (!row) return { ok: false as const, reason: "not found" };
    if (row.consumed) return { ok: false as const, reason: "already consumed" };
    if (input.toolId !== BROWSER_TOOL_IDS.submit || input.userId !== USER) {
      return { ok: false as const, reason: "not bound" };
    }
    if (row.paramsHash !== input.paramsHash) return { ok: false as const, reason: "parameters changed" };
    if (input.tenantScope?.tenantId !== row.tenantId) return { ok: false as const, reason: "organization changed" };
    const claimed = await this.journal.claimForExecution(input.executionId, { ownerId: "store", leaseMs: 60_000 });
    if (!claimed) return { ok: false as const, reason: "execution not claimable" };
    row.consumed = true;
    return { ok: true as const };
  }
}

function managerFor(store: Store): IApprovalManager {
  const list = (toolId: string, userId: string): Approval[] =>
    [...store.rows.entries()]
      .filter(() => toolId === BROWSER_TOOL_IDS.submit && userId === USER)
      .map(([id, row]) => ({
        id,
        userId: USER,
        toolId,
        action: "execute",
        params: row.params,
        paramsHash: row.paramsHash,
        status: row.consumed ? ("consumed" as const) : ("approved" as const),
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        createdAt: new Date().toISOString(),
      }));
  return {
    requestApproval: async (request) => ({
      ...request,
      id: "apr-new",
      status: "pending" as const,
      createdAt: new Date().toISOString(),
    }),
    findExistingForTool: async (toolId, userId) => list(toolId, userId)[0] ?? null,
    findApprovalsForTool: async (toolId, userId) => list(toolId, userId),
  };
}

const allowAll: IPermissionChecker = { hasPermission: () => true };
const audit = { log: async () => undefined } as unknown as AuditLogger;
const allowGate: ToolAccessGate = { check: async () => ({ allowed: true }) };
const access: BrowserWriteScopePort = {
  resolveWriteScope: async () => ({
    ok: true,
    tenantScope: {
      tenantId: ORG,
      providerId: "browser",
      connector: "service",
      requesterRoles: ["owner", "admin"],
      approverRoles: ["owner", "admin"],
    },
  }),
};

// ---------------------------------------------------------------------------
// The browser service and the site, as a script.
// ---------------------------------------------------------------------------

/** How the answer to a submit is lost — or not. */
type SubmitScript =
  | { kind: "ok" }
  | { kind: "dropped-after-send" }
  | { kind: "client-timeout" }
  | { kind: "service-refused"; code: BrowserServiceErrorCode; reachedSite: boolean }
  | { kind: "not-an-envelope"; status: number }
  | { kind: "not-sent" };

interface Site {
  /** Submits the site received. The number that must never pass 1. */
  submits: number;
  operations: string[];
  subjects: unknown[];
  script: SubmitScript;
}

function serviceAndSite(site: Site): BrowserServiceTransport {
  return async (request) => {
    const body = JSON.parse(Buffer.from(request.body).toString("utf8")) as {
      requestId: string;
      operation: string;
      subject: unknown;
    };
    site.operations.push(body.operation);
    site.subjects.push(body.subject);
    const ok = (result: unknown): BrowserServiceTransportResponse => ({
      status: 200,
      headers: {},
      body: JSON.stringify(successEnvelope(body.requestId, result)),
      tooLarge: false,
    });

    switch (body.operation) {
      case "session.open":
        return ok({ sessionId: SESSION_ID, expiresAt: Date.now() + 60_000, ttlMs: 60_000 });
      case "session.close":
        return ok({ closed: true });
      case "browser.navigate":
        return ok({ action: "browser.navigate", ok: true, page: PAGE, redirected: false });
      case "browser.type":
        return ok({ action: "browser.type", ok: true, page: PAGE, selector: "#email", navigated: false });
      case "browser.submit":
        break;
      default:
        throw new Error(`unexpected operation ${body.operation}`);
    }

    const script = site.script;
    if (script.kind === "not-sent") throw new BrowserServiceTransportError(false);
    if (script.kind === "service-refused" && !script.reachedSite) {
      return {
        status: 404,
        headers: {},
        body: JSON.stringify(failureEnvelope(body.requestId, script.code)),
        tooLarge: false,
      };
    }

    // From here the submit reached the site.
    site.submits += 1;
    switch (script.kind) {
      case "ok":
        return ok({ action: "browser.submit", ok: true, page: PAGE, selector: "#send", navigated: true });
      case "dropped-after-send":
        throw new BrowserServiceTransportError(true);
      case "client-timeout":
        return new Promise((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(new BrowserServiceTransportError(true)));
        });
      case "service-refused":
        return {
          status: 502,
          headers: {},
          body: JSON.stringify(failureEnvelope(body.requestId, script.code)),
          tooLarge: false,
        };
      case "not-an-envelope":
        return { status: script.status, headers: {}, body: "<html>bad gateway</html>", tooLarge: false };
    }
  };
}

let journal: MemoryExecutionJournal;
let store: Store;
let site: Site;
let tools: Map<string, ITool>;
let executor: ToolExecutor;

beforeEach(() => {
  journal = new MemoryExecutionJournal();
  store = new Store(journal);
  site = { submits: 0, operations: [], subjects: [], script: { kind: "ok" } };
  const client = new BrowserServiceClient({
    config: {
      baseUrl: "https://browser-service:3200",
      keyId: "api-key-1",
      secret: "0123456789abcdef0123456789abcdef",
      peerIdentity: "jarvis-api",
      timeoutMs: 50,
      tls: { certPath: "api.pem", keyPath: "api-key.pem", caPath: "ca.pem" },
    },
    transport: serviceAndSite(site),
  });
  const runtime = new RemoteBrowserRuntime({
    client,
    tenant: { resolveSessionOrganization: async () => ({ ok: true, organizationId: ORG }) },
  });
  tools = new Map(createBrowserTools(runtime, journal, store, access).map((tool) => [tool.id, tool]));
  executor = new ToolExecutor({ get: (id: string) => tools.get(id) }, allowAll, managerFor(store), audit, {
    accessGate: allowGate,
  });
});

function submitWith(approvalId: string) {
  return executor.execute({
    toolId: BROWSER_TOOL_IDS.submit,
    params: SUBMIT,
    userId: USER,
    role: "owner" as Role,
    traceId: "trace-1",
    approvalId,
  });
}

async function journalRow() {
  return journal.begin({
    userId: USER,
    toolId: BROWSER_TOOL_IDS.submit,
    idempotencyKey: `${BROWSER_TOOL_IDS.submit}:${computeParamsHash(SUBMIT)}`,
    paramsHash: computeParamsHash(SUBMIT),
    provider: "browser",
  });
}

const UNCERTAIN: Array<[string, SubmitScript]> = [
  ["UNAVAILABLE — the connection dropped after the submit was sent", { kind: "dropped-after-send" }],
  ["TIMEOUT — the API's deadline passed after the submit was sent", { kind: "client-timeout" }],
  ["TIMEOUT — the service's own deadline cut the submit short", { kind: "service-refused", code: "TIMEOUT", reachedSite: true }],
  ["PROVIDER_ERROR — the browser failed during the submit", { kind: "service-refused", code: "PROVIDER_ERROR", reachedSite: true }],
  ["UNKNOWN_OUTCOME — the service could not tell", { kind: "service-refused", code: "UNKNOWN_OUTCOME", reachedSite: true }],
  ["UNAVAILABLE — the service answered unavailable after acting", { kind: "service-refused", code: "UNAVAILABLE", reachedSite: true }],
  ["PROVIDER_ERROR — an answer that is not an envelope", { kind: "not-an-envelope", status: 502 }],
];

describe("a remote submit whose outcome cannot be proven is UNKNOWN, and a new approval does not repeat it", () => {
  it.each(UNCERTAIN)("%s", async (_label, script) => {
    site.script = script;
    store.approve("apr-1", SUBMIT);

    const first = await submitWith("apr-1");
    expect(first.status).toBe("failed");
    expect(site.submits).toBe(1);
    // The person is told the outcome is unknown — not that the service was
    // unavailable, which would read as "nothing happened".
    expect(first.error).toContain("The outcome of the action is unknown");
    // Phase 19.5 — the same sentence the in-process browser now gives.
    expect(first.error).toBe(COMPUTER_CONTROL_OUTCOME_UNKNOWN_MESSAGE);
    expect(BROWSER_SERVICE_ERROR_MESSAGES.UNKNOWN_OUTCOME).toBe(COMPUTER_CONTROL_OUTCOME_UNKNOWN_MESSAGE);

    const row = await journalRow();
    expect(row.status).toBe("UNKNOWN");
    expect(row.errorCode).toBe("AMBIGUOUS_OUTCOME");
    expect(store.rows.get("apr-1")!.consumed).toBe(true);

    // A person approves the same submit again.
    store.approve("apr-2", SUBMIT);
    const operationsBefore = site.operations.length;
    const second = await submitWith("apr-2");

    expect(second.status).toBe("failed");
    // Phase 19.5: the refusal says why (was "Execution already unknown").
    expect(second.error).toBe(COMPUTER_CONTROL_ALREADY_UNKNOWN_MESSAGE);
    // Nothing reached the site, no browser session was opened, and the new
    // approval was not spent on a submit that never ran.
    expect(site.submits).toBe(1);
    expect(site.operations.length).toBe(operationsBefore);
    expect(store.rows.get("apr-2")!.consumed).toBe(false);
  });
});

describe("a remote submit known not to have run stays FAILED, and a new approval may run it once", () => {
  it.each([
    ["the request never left the API", { kind: "not-sent" } as SubmitScript],
    [
      "the service refused it before acting — no such session",
      { kind: "service-refused", code: "SESSION_NOT_FOUND", reachedSite: false } as SubmitScript,
    ],
    [
      "the service refused it before acting — another tenant's session",
      { kind: "service-refused", code: "CROSS_TENANT_DENIED", reachedSite: false } as SubmitScript,
    ],
  ])("%s", async (_label, script) => {
    site.script = script;
    store.approve("apr-1", SUBMIT);

    const first = await submitWith("apr-1");
    expect(first.status).toBe("failed");
    expect(site.submits).toBe(0);
    expect((await journalRow()).status).toBe("FAILED");

    site.script = { kind: "ok" };
    store.approve("apr-2", SUBMIT);
    const second = await submitWith("apr-2");
    expect(second.status, second.error).toBe("completed");
    expect(site.submits).toBe(1);
    expect((await journalRow()).status).toBe("SUCCEEDED");

    // Each approval was spent exactly once.
    expect(store.rows.get("apr-1")!.consumed).toBe(true);
    expect(store.rows.get("apr-2")!.consumed).toBe(true);
  });
});

describe("the protections around the remote write are unchanged", () => {
  it("a spent approval cannot be replayed", async () => {
    store.approve("apr-1", SUBMIT);
    expect((await submitWith("apr-1")).status).toBe("completed");
    const replay = await submitWith("apr-1");
    expect(replay.status).toBe("approval_pending");
    expect(site.submits).toBe(1);
  });

  it("every request is bound to the Organization the server resolved", async () => {
    store.approve("apr-1", SUBMIT);
    await submitWith("apr-1");
    expect(site.subjects.length).toBeGreaterThan(0);
    for (const subject of site.subjects) expect(subject).toEqual({ userId: USER, organizationId: ORG });
  });

  it("a submit called around the executor is refused before the browser", async () => {
    store.approve("apr-1", SUBMIT);
    const direct = await tools
      .get(BROWSER_TOOL_IDS.submit)!
      .execute(SUBMIT, { userId: USER, traceId: "trace-1", approvalId: "apr-1" });
    expect(direct.success).toBe(false);
    expect(site.operations).toEqual([]);
    expect(store.rows.get("apr-1")!.consumed).toBe(false);
  });
});
