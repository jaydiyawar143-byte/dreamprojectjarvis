import { describe, it, expect, vi } from "vitest";
import type { Router } from "express";
import { createN8nConfig, signCallback, type N8nConfig } from "@jarvis/n8n";
import { N8nTriggerWorkflowTool, MockN8nProvider, mockKeyDeriver } from "@jarvis/tools";
import { ToolApprovalService, PermissionService } from "@jarvis/security";
import type {
  IN8nRepository,
  N8nWorkflowRecord,
  N8nExecutionRecord,
  N8nCallbackEvent,
  RecordCallbackResult,
  ITool,
} from "@jarvis/core";
import { createN8nRouter } from "../src/routes/n8n.js";

// ---------------------------------------------------------------------------
// Sprint 5.4 — n8n API tests
//
// No live n8n instance, no network, no database. Callback signatures are
// computed with a synthetic secret so this suite runs identically anywhere.
// ---------------------------------------------------------------------------

const CALLBACK_SECRET = "test-callback-secret";
const API_KEY = "test-api-key";
const TOKEN_A = "token-user-1";
const TOKEN_B = "token-user-2";

const config: N8nConfig = createN8nConfig({
  baseUrl: "https://n8n.internal.test",
  apiKey: API_KEY,
  callbackSecret: CALLBACK_SECRET,
  callbackMaxAgeMs: 300_000,
});

const NOW = new Date("2026-09-05T12:00:00Z");
const FRESH = new Date(NOW.getTime() - 30_000).toISOString();
const STALE = new Date(NOW.getTime() - 3_600_000).toISOString();

class MemoryN8nRepo implements IN8nRepository {
  workflows: N8nWorkflowRecord[] = [
    { id: "wf-1", userId: "user-1", name: "Daily report", webhookPath: "daily", isActive: true, createdAt: NOW },
    { id: "wf-2", userId: "user-2", name: "Theirs", webhookPath: "theirs", isActive: true, createdAt: NOW },
  ];
  executions: N8nExecutionRecord[] = [
    {
      id: "exec-1",
      userId: "user-1",
      workflowId: "wf-1",
      idempotencyKey: "k1",
      remoteExecutionId: null,
      status: "TRIGGERED",
      payloadHash: "h1",
      callbackEventId: null,
      resultSummary: null,
      errorCode: null,
      traceId: "trace-1",
      triggeredAt: NOW,
      completedAt: null,
    },
    {
      id: "exec-2",
      userId: "user-2",
      workflowId: "wf-2",
      idempotencyKey: "k2",
      remoteExecutionId: null,
      status: "TRIGGERED",
      payloadHash: "h2",
      callbackEventId: null,
      resultSummary: null,
      errorCode: null,
      traceId: "trace-2",
      triggeredAt: NOW,
      completedAt: null,
    },
  ];

  async findWorkflowForUser(userId: string, workflowId: string) {
    return this.workflows.find((w) => w.id === workflowId && w.userId === userId && w.isActive) ?? null;
  }
  async listWorkflowsForUser(userId: string) {
    return this.workflows.filter((w) => w.userId === userId && w.isActive);
  }
  async beginExecution(): Promise<{ record: N8nExecutionRecord; created: boolean }> {
    throw new Error("not used in route tests");
  }
  async markTriggered() {}
  async markFailed() {}

  async applyCallback(event: N8nCallbackEvent): Promise<RecordCallbackResult> {
    const row = this.executions.find((e) => e.id === event.executionId);
    if (!row) return { applied: false, duplicate: false, notFound: true };

    // Attribution comes from the stored row, never from the payload.
    const owner = { userId: row.userId, traceId: row.traceId };
    if (row.callbackEventId !== null) {
      return { applied: false, duplicate: true, notFound: false, ...owner };
    }
    // Mirrors the unique constraint on callback_event_id.
    if (this.executions.some((e) => e.callbackEventId === event.eventId)) {
      return { applied: false, duplicate: true, notFound: false, ...owner };
    }
    row.callbackEventId = event.eventId;
    row.status = event.status === "success" ? "SUCCEEDED" : "FAILED";
    row.resultSummary = event.summary ?? row.resultSummary;
    row.errorCode = event.status === "error" ? "WORKFLOW_FAILED" : null;
    row.completedAt = new Date();
    return { applied: true, duplicate: false, notFound: false, ...owner };
  }

  async listExecutionsForUser(userId: string, options?: { workflowId?: string; limit?: number }) {
    return this.executions
      .filter((e) => e.userId === userId && (!options?.workflowId || e.workflowId === options.workflowId))
      .slice(0, options?.limit ?? 50);
  }
  async findExecutionForUser(userId: string, executionId: string) {
    return this.executions.find((e) => e.id === executionId && e.userId === userId) ?? null;
  }
}

// ---------------------------------------------------------------------------
// Router harness — mirrors dashboard-api.test.ts, no supertest dependency
// ---------------------------------------------------------------------------

interface TestResponse {
  status: number;
  body: any;
}

async function call(
  router: Router,
  method: string,
  path: string,
  options: { token?: string; rawBody?: Buffer; signature?: string } = {}
): Promise<TestResponse> {
  const parsed = new URL(path, "http://test");
  const pathname = parsed.pathname;

  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.signature) headers["x-jarvis-signature"] = options.signature;

  const res = {
    _status: 200,
    _body: null as unknown,
    status(code: number) { this._status = code; return this; },
    json(body: unknown) { this._body = body; return this; },
    type() { return this; },
    send(body: unknown) { this._body = body; return this; },
  };

  const stack =
    ((router as unknown as {
      stack: Array<{
        route?: {
          path: string;
          methods: Record<string, boolean>;
          stack: Array<{ handle: (...args: any[]) => unknown }>;
        };
      }>;
    }).stack) ?? [];

  for (const layer of stack) {
    if (!layer.route) continue;
    if (!layer.route.methods[method.toLowerCase()]) continue;
    const pattern = "^" + layer.route.path.replace(/:[^/]+/g, "([^/]+)") + "$";
    const match = pathname.match(new RegExp(pattern));
    if (!match) continue;

    // Recover :id style params so /executions/:id resolves.
    const names = (layer.route.path.match(/:[^/]+/g) ?? []).map((n) => n.slice(1));
    const params: Record<string, string> = {};
    names.forEach((n, i) => { params[n] = match[i + 1]; });

    const req = {
      method,
      url: pathname + parsed.search,
      originalUrl: pathname + parsed.search,
      path: pathname,
      params,
      query: Object.fromEntries(parsed.searchParams),
      headers,
      body: options.rawBody,
      get(header: string) { return headers[header.toLowerCase()]; },
    };

    const chain = layer.route.stack;
    const responded = () => (res as unknown as { _body: unknown })._body !== null;
    const runAt = (i: number): unknown => {
      if (responded()) return undefined;
      const entry = chain[i];
      if (!entry) return undefined;
      if (entry.handle.length >= 3) {
        // Skip body parsers: the harness supplies req.body as raw bytes.
        const name = entry.handle.name;
        if (name === "jsonParser" || name === "rawParser") return runAt(i + 1);
        return new Promise<void>((resolveStep) => {
          entry.handle(req, res, () => resolveStep());
          if (responded()) resolveStep();
        }).then(() => runAt(i + 1));
      }
      return entry.handle(req, res);
    };

    await runAt(0);
    return {
      status: (res as unknown as { _status: number })._status,
      body: (res as unknown as { _body: unknown })._body,
    };
  }
  return { status: 404, body: { success: false, error: { code: "NO_ROUTE" } } };
}

function makeHarness() {
  const repo = new MemoryN8nRepo();
  const auditEntries: any[] = [];
  const auditLogger = {
    log: vi.fn(async (entry: any) => {
      auditEntries.push(entry);
    }),
  };
  const tokenService = {
    verifyAccessToken: (token: string) => {
      if (token === TOKEN_A) return { userId: "user-1", role: "member", email: "a@test.local" };
      if (token === TOKEN_B) return { userId: "user-2", role: "member", email: "b@test.local" };
      return null;
    },
  };
  const router = createN8nRouter({ tokenService } as never, {
    repo,
    config,
    auditLogger: auditLogger as never,
    now: () => NOW,
  });
  return { router, repo, auditEntries, auditLogger };
}

function signedBody(payload: unknown, secret = CALLBACK_SECRET) {
  const rawBody = Buffer.from(JSON.stringify(payload), "utf8");
  return { rawBody, signature: signCallback(rawBody, secret) };
}

const callbackFor = (overrides: Record<string, unknown> = {}) => ({
  eventId: "evt-1",
  executionId: "exec-1",
  status: "success",
  summary: "workflow finished",
  timestamp: FRESH,
  ...overrides,
});

describe("Sprint 5.4 — POST /callback webhook validation", () => {
  it("applies a valid signed callback", async () => {
    const h = makeHarness();
    const { rawBody, signature } = signedBody(callbackFor());

    const res = await call(h.router, "POST", "/callback", { rawBody, signature });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ applied: true, status: "success" });
    expect(h.repo.executions[0].status).toBe("SUCCEEDED");
    expect(h.repo.executions[0].resultSummary).toBe("workflow finished");
  });

  it("records an error callback as a failed execution", async () => {
    const h = makeHarness();
    const { rawBody, signature } = signedBody(
      callbackFor({ status: "error", errorMessage: "node failed" })
    );
    await call(h.router, "POST", "/callback", { rawBody, signature });

    expect(h.repo.executions[0].status).toBe("FAILED");
    expect(h.repo.executions[0].errorCode).toBe("WORKFLOW_FAILED");
  });

  describe("signature enforcement", () => {
    it("REJECTS a wrong secret", async () => {
      const h = makeHarness();
      const { rawBody, signature } = signedBody(callbackFor(), "attacker-secret");

      const res = await call(h.router, "POST", "/callback", { rawBody, signature });

      expect(res.status).toBe(401);
      expect(h.repo.executions[0].status).toBe("TRIGGERED");
    });

    it("REJECTS the outbound API key used as a callback credential", async () => {
      // The API key travels to n8n and may be visible to workflow authors, so
      // it must never authenticate an inbound request.
      const h = makeHarness();
      const { rawBody, signature } = signedBody(callbackFor(), API_KEY);
      expect((await call(h.router, "POST", "/callback", { rawBody, signature })).status).toBe(401);
    });

    it("REJECTS an unsigned callback", async () => {
      const h = makeHarness();
      const { rawBody } = signedBody(callbackFor());
      expect((await call(h.router, "POST", "/callback", { rawBody })).status).toBe(401);
    });

    it("REJECTS a tampered body under a captured signature", async () => {
      const h = makeHarness();
      const { signature } = signedBody(callbackFor());
      // Retarget the callback at another tenant's execution.
      const tampered = Buffer.from(JSON.stringify(callbackFor({ executionId: "exec-2" })), "utf8");

      const res = await call(h.router, "POST", "/callback", { rawBody: tampered, signature });

      expect(res.status).toBe(401);
      expect(h.repo.executions[1].status).toBe("TRIGGERED");
    });

    it("does not explain WHY a signature failed", async () => {
      const h = makeHarness();
      const { rawBody } = signedBody(callbackFor());
      const res = await call(h.router, "POST", "/callback", { rawBody, signature: "sha256=deadbeef" });
      expect(JSON.stringify(res.body)).not.toMatch(/MALFORMED|MISMATCH|MISSING_HEADER/);
      expect(res.body.error.message).toBe("Invalid signature");
    });
  });

  describe("replay and duplicate suppression", () => {
    it("applies a redelivered callback ONCE", async () => {
      const h = makeHarness();
      const { rawBody, signature } = signedBody(callbackFor());

      const first = await call(h.router, "POST", "/callback", { rawBody, signature });
      const second = await call(h.router, "POST", "/callback", { rawBody, signature });

      expect(first.body.data.applied).toBe(true);
      expect(second.status).toBe(200);
      expect(second.body.data).toMatchObject({ applied: false, reason: "duplicate" });
    });

    it("does not let a second event overwrite a completed execution", async () => {
      const h = makeHarness();
      const first = signedBody(callbackFor({ eventId: "evt-1", status: "success" }));
      await call(h.router, "POST", "/callback", first);

      const second = signedBody(callbackFor({ eventId: "evt-2", status: "error" }));
      const res = await call(h.router, "POST", "/callback", second);

      expect(res.body.data.reason).toBe("duplicate");
      expect(h.repo.executions[0].status).toBe("SUCCEEDED");
    });

    it("REJECTS a stale callback even when correctly signed", async () => {
      const h = makeHarness();
      const { rawBody, signature } = signedBody(callbackFor({ timestamp: STALE }));

      const res = await call(h.router, "POST", "/callback", { rawBody, signature });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ applied: false, reason: "stale" });
      expect(h.repo.executions[0].status).toBe("TRIGGERED");
    });
  });

  describe("malformed and unknown input", () => {
    it("rejects an unparseable body with 400", async () => {
      const h = makeHarness();
      const rawBody = Buffer.from("not json", "utf8");
      const res = await call(h.router, "POST", "/callback", {
        rawBody,
        signature: signCallback(rawBody, CALLBACK_SECRET),
      });
      expect(res.status).toBe(400);
    });

    it.each([
      ["missing eventId", { executionId: "exec-1", status: "success" }],
      ["missing executionId", { eventId: "e", status: "success" }],
      ["invalid status", { eventId: "e", executionId: "exec-1", status: "maybe" }],
    ])("rejects a callback with %s", async (_label, payload) => {
      const h = makeHarness();
      const res = await call(h.router, "POST", "/callback", signedBody(payload));
      expect(res.status).toBe(400);
    });

    it("answers 200 for an unknown execution id so n8n stops retrying", async () => {
      const h = makeHarness();
      const res = await call(
        h.router,
        "POST",
        "/callback",
        signedBody(callbackFor({ executionId: "exec-does-not-exist" }))
      );
      expect(res.status).toBe(200);
      expect(res.body.data.reason).toBe("unknown_execution");
    });
  });

  describe("audit metadata", () => {
    it("writes an audit entry attributed to the OWNING user", async () => {
      const h = makeHarness();
      await call(h.router, "POST", "/callback", signedBody(callbackFor()));

      expect(h.auditLogger.log).toHaveBeenCalled();
      expect(h.auditEntries[0]).toMatchObject({
        // Attribution comes from the stored execution row, never the payload.
        userId: "user-1",
        action: "n8n.callback",
        toolId: "n8n.trigger",
        result: "success",
        traceId: "trace-1",
      });
      expect(h.auditEntries[0].metadata).toMatchObject({
        executionId: "exec-1",
        eventId: "evt-1",
      });
    });

    it("records a failed workflow as a failure result", async () => {
      const h = makeHarness();
      await call(h.router, "POST", "/callback", signedBody(callbackFor({ status: "error" })));
      expect(h.auditEntries[0].result).toBe("failure");
    });

    it("does NOT let the payload dictate the audited tenant", async () => {
      const h = makeHarness();
      // The payload names user-2; the execution row belongs to user-1.
      await call(
        h.router,
        "POST",
        "/callback",
        signedBody(callbackFor({ userId: "user-2", tenant: "user-2" }))
      );
      expect(h.auditEntries[0].userId).toBe("user-1");
    });

    it("does not write an audit entry for a rejected signature", async () => {
      const h = makeHarness();
      const { rawBody, signature } = signedBody(callbackFor(), "attacker");
      await call(h.router, "POST", "/callback", { rawBody, signature });
      expect(h.auditLogger.log).not.toHaveBeenCalled();
    });
  });
});

describe("Sprint 5.4 — authenticated read routes", () => {
  it("requires a bearer token on /workflows and /executions", async () => {
    const h = makeHarness();
    expect((await call(h.router, "GET", "/workflows")).status).toBe(401);
    expect((await call(h.router, "GET", "/executions")).status).toBe(401);
  });

  it("rejects an invalid token", async () => {
    const h = makeHarness();
    expect((await call(h.router, "GET", "/workflows", { token: "bogus" })).status).toBe(401);
  });

  it("returns only the caller's workflows", async () => {
    const h = makeHarness();
    const a = await call(h.router, "GET", "/workflows", { token: TOKEN_A });
    expect(a.body.data.count).toBe(1);
    expect(a.body.data.workflows[0].name).toBe("Daily report");

    const b = await call(h.router, "GET", "/workflows", { token: TOKEN_B });
    expect(b.body.data.workflows[0].name).toBe("Theirs");
  });

  it("NEVER exposes the webhook path to a client", async () => {
    // The path is the address of a live automation endpoint.
    const h = makeHarness();
    const res = await call(h.router, "GET", "/workflows", { token: TOKEN_A });
    const blob = JSON.stringify(res.body);
    expect(blob).not.toContain("daily");
    expect(blob).not.toContain("webhookPath");
  });

  it("returns only the caller's executions", async () => {
    const h = makeHarness();
    const a = await call(h.router, "GET", "/executions", { token: TOKEN_A });
    expect(a.body.data.count).toBe(1);
    expect(a.body.data.executions[0].id).toBe("exec-1");
  });

  it("ignores a userId supplied in the query string", async () => {
    const h = makeHarness();
    const res = await call(h.router, "GET", "/executions?userId=user-1", { token: TOKEN_B });
    expect(res.body.data.executions.every((e: any) => e.id !== "exec-1")).toBe(true);
  });

  it("reports another tenant's execution as NOT FOUND, not FORBIDDEN", async () => {
    // 403 would confirm the id exists.
    const h = makeHarness();
    const res = await call(h.router, "GET", "/executions/exec-2", { token: TOKEN_A });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("returns the caller's own execution with audit metadata", async () => {
    const h = makeHarness();
    const res = await call(h.router, "GET", "/executions/exec-1", { token: TOKEN_A });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: "exec-1",
      workflowId: "wf-1",
      status: "TRIGGERED",
      traceId: "trace-1",
    });
  });

  it("never exposes credentials in any read response", async () => {
    const h = makeHarness();
    for (const path of ["/workflows", "/executions", "/executions/exec-1"]) {
      const res = await call(h.router, "GET", path, { token: TOKEN_A });
      const blob = JSON.stringify(res.body);
      for (const secret of [API_KEY, CALLBACK_SECRET, "apiKey", "callbackSecret"]) {
        expect(blob).not.toContain(secret);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Approval boundary — verified against the REAL ToolApprovalService
// ---------------------------------------------------------------------------

describe("Sprint 5.4 — approval boundary", () => {
  function makeApprovalService() {
    const approvalRepo = {
      create: vi.fn(async (data: any) => ({
        id: "appr-1",
        ...data,
        status: "pending",
        expiresAt: new Date(Date.now() + 600000),
      })),
      findById: vi.fn(async () => null),
      findExistingForTool: vi.fn(async () => null),
      update: vi.fn(async () => undefined),
    };
    const auditRepo = { create: vi.fn(async () => ({ id: "a1" })), query: vi.fn(async () => []) };
    return {
      service: new ToolApprovalService(
        approvalRepo as never,
        auditRepo as never,
        new PermissionService() as never
      ),
      approvalRepo,
    };
  }

  const triggerTool = (): ITool =>
    new N8nTriggerWorkflowTool(
      new MockN8nProvider(),
      new MemoryN8nRepo(),
      mockKeyDeriver
    ) as unknown as ITool;

  const params = { workflowId: "wf-1", payload: { x: 1 } };

  it("REQUIRES approval before a workflow may be triggered", async () => {
    const { service, approvalRepo } = makeApprovalService();
    const check = await service.checkPreExecution(triggerTool(), params, {
      userId: "user-1",
      role: "admin",
      traceId: "t-1",
    });

    // Gated by the existing RISK_REQUIRES_APPROVAL table — no n8n-specific
    // code path and no bypass.
    expect(check.requiresApproval).toBe(true);
    expect(check.allowed).toBe(false);
    expect(approvalRepo.create).toHaveBeenCalled();
  });

  it("denies a viewer who lacks write permission", async () => {
    const { service } = makeApprovalService();
    const check = await service.checkPreExecution(triggerTool(), params, {
      userId: "user-1",
      role: "viewer",
      traceId: "t-2",
    });
    expect(check.allowed).toBe(false);
    expect(check.reason).toMatch(/permission/i);
  });

  it("rejects a trigger with no workflowId before raising an approval", async () => {
    const { service, approvalRepo } = makeApprovalService();
    const check = await service.checkPreExecution(triggerTool(), {}, {
      userId: "user-1",
      role: "admin",
      traceId: "t-3",
    });
    expect(check.allowed).toBe(false);
    expect(approvalRepo.create).not.toHaveBeenCalled();
  });
});
