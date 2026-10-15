import { describe, it, expect, vi, afterEach } from "vitest";
import { createN8nConfig } from "../src/config.js";
import {
  createN8nApiClient,
  N8N_MAX_PAGE_SIZE,
  N8N_MAX_LIST_PAGES,
} from "../src/api-client.js";
import { createN8nProvider } from "../src/provider.js";

// ---------------------------------------------------------------------------
// n8n Public REST API client
//
// No live n8n instance and no network: every request is served by a stub, so
// this suite asserts the WIRE CONTRACT (header, path, pagination) and the
// failure classification without ever needing a real key.
// ---------------------------------------------------------------------------

const API_KEY = "SECRET-API-KEY-VALUE";
const BASE_URL = "https://n8n.cloud.test";

const config = createN8nConfig({
  baseUrl: BASE_URL,
  apiKey: API_KEY,
  callbackSecret: "callback-secret",
  timeoutMs: 200,
});

function jsonResponse(status: number, body: unknown) {
  const payload = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => payload,
  } as Response;
}

function stub(status: number, body: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(status, body));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("n8n Public API — authentication and request shape", () => {
  it("sends the key in the X-N8N-API-KEY header, never in the URL", async () => {
    const spy = stub(200, { data: [{ id: "wf-1", name: "Daily", active: true }], nextCursor: null });

    const result = await createN8nApiClient(config).listWorkflows({ limit: 50 });

    expect(result.ok).toBe(true);
    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toBe(`${BASE_URL}/api/v1/workflows?limit=50`);
    expect(String(url)).not.toContain(API_KEY);
    expect((init!.headers as Record<string, string>)["X-N8N-API-KEY"]).toBe(API_KEY);
  });

  it("uses the n8n documented endpoint path", async () => {
    const spy = stub(200, { data: [], nextCursor: null });
    await createN8nApiClient(config).listWorkflows();
    expect(new URL(String(spy.mock.calls[0]![0])).pathname).toBe("/api/v1/workflows");
  });

  it("normalizes a workflow page and carries the cursor", async () => {
    stub(200, {
      data: [
        { id: "wf-1", name: "Daily", active: true, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z", extra: "dropped" },
        { id: "wf-2", active: false },
        { name: "no id — dropped" },
      ],
      nextCursor: "cursor-2",
    });

    const result = await createN8nApiClient(config).listWorkflows();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.nextCursor).toBe("cursor-2");
    expect(result.data.workflows).toEqual([
      { id: "wf-1", name: "Daily", active: true, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z" },
      { id: "wf-2", name: "", active: false, createdAt: null, updatedAt: null },
    ]);
  });

  it("treats an empty instance as a successful read", async () => {
    stub(200, { data: [], nextCursor: null });
    const result = await createN8nApiClient(config).checkConnection();
    expect(result).toEqual({ ok: true, data: { workflowCount: 0 } });
  });

  it("clamps a limit to n8n's maximum", async () => {
    const spy = stub(200, { data: [], nextCursor: null });
    await createN8nApiClient(config).listWorkflows({ limit: 100_000 });
    expect(new URL(String(spy.mock.calls[0]![0])).searchParams.get("limit")).toBe(String(N8N_MAX_PAGE_SIZE));
  });

  it("passes execution filters through as query parameters", async () => {
    const spy = stub(200, { data: [], nextCursor: null });
    await createN8nApiClient(config).listExecutions({ limit: 10, workflowId: "wf-1", status: "error" });
    const url = new URL(String(spy.mock.calls[0]![0]));
    expect(url.pathname).toBe("/api/v1/executions");
    expect(url.searchParams.get("workflowId")).toBe("wf-1");
    expect(url.searchParams.get("status")).toBe("error");
  });

  it("reads a single execution's status by id", async () => {
    const spy = stub(200, { id: "exec-9", workflowId: "wf-1", status: "error", finished: true });
    const result = await createN8nApiClient(config).getExecution("exec-9");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      id: "exec-9",
      workflowId: "wf-1",
      status: "error",
      finished: true,
      startedAt: null,
      stoppedAt: null,
    });
    expect(new URL(String(spy.mock.calls[0]![0])).pathname).toBe("/api/v1/executions/exec-9");
  });

  it("refuses an execution id that could escape the configured path", async () => {
    const spy = stub(200, { id: "x" });
    const result = await createN8nApiClient(config).getExecution("../../evil");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_REQUEST");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("n8n Public API — pagination", () => {
  it("follows nextCursor across pages and stops at the end", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: "wf-1" }], nextCursor: "c2" }))
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: "wf-2" }], nextCursor: "c3" }))
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: "wf-3" }], nextCursor: null }));

    const result = await createN8nApiClient(config).listAllWorkflows({ pageSize: 2 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.workflows.map((w) => w.id)).toEqual(["wf-1", "wf-2", "wf-3"]);
    expect(result.data.truncated).toBe(false);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(new URL(String(spy.mock.calls[1]![0])).searchParams.get("cursor")).toBe("c2");
  });

  it("stops at maxPages and reports the traversal as truncated", async () => {
    let page = 0;
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => jsonResponse(200, { data: [{ id: "wf" }], nextCursor: `c${++page}` }));

    const result = await createN8nApiClient(config).listAllWorkflows({ maxPages: 3 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.truncated).toBe(true);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("never follows more than the hard page ceiling", async () => {
    let page = 0;
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => jsonResponse(200, { data: [], nextCursor: `c${++page}` }));

    await createN8nApiClient(config).listAllWorkflows();
    expect(spy).toHaveBeenCalledTimes(N8N_MAX_LIST_PAGES);
  });

  it("stops if n8n ever repeats a cursor, rather than looping forever", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => jsonResponse(200, { data: [], nextCursor: "stuck" }));

    const result = await createN8nApiClient(config).listAllWorkflows();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.truncated).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("n8n Public API — failure classification", () => {
  it("reports a rejected key as AUTHENTICATION_REQUIRED with no side effect", async () => {
    stub(401, { message: "unauthorized" });
    const result = await createN8nApiClient(config).listWorkflows();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("AUTHENTICATION_REQUIRED");
    expect(result.error.sideEffectPossible).toBe(false);
    expect(result.error.retryable).toBe(false);
  });

  it("treats a 403 as AUTHORIZATION_FAILED", async () => {
    stub(403, { message: "forbidden" });
    const result = await createN8nApiClient(config).checkConnection();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("AUTHORIZATION_FAILED");
  });

  it("reports a 500 as a failure that may have run", async () => {
    stub(500, { message: "boom" });
    const result = await createN8nApiClient(config).listExecutions();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("WORKFLOW_FAILED");
  });

  it("allows a retry only for rate limiting", async () => {
    stub(429, {});
    const result = await createN8nApiClient(config).listWorkflows();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("RATE_LIMITED");
    expect(result.error.retryable).toBe(true);
    expect(result.error.sideEffectPossible).toBe(false);
  });

  it("classifies an abort as a timeout with NO possible side effect", async () => {
    // A read that times out may have reached n8n, but a GET cannot change
    // anything there — unlike a trigger, which may have started a run.
    const shortConfig = createN8nConfig({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      callbackSecret: "s",
      timeoutMs: 20,
    });
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal;
        signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      })
    );

    const result = await createN8nApiClient(shortConfig).listWorkflows();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("TOOL_TIMEOUT");
    expect(result.error.sideEffectPossible).toBe(false);
  });

  it("reports a transport failure as NETWORK_ERROR", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await createN8nApiClient(config).listWorkflows();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NETWORK_ERROR");
    expect(result.error.sideEffectPossible).toBe(false);
  });
});

describe("n8n Public API — malformed responses", () => {
  it.each([
    ["a body with no data array", { nextCursor: null }],
    ["a data field that is not an array", { data: "nope" }],
    ["an array body", []],
    ["null", null],
  ])("refuses %s rather than inventing a page", async (_label, body) => {
    stub(200, body);
    const result = await createN8nApiClient(config).listWorkflows();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_REQUEST");
    expect(result.error.message).toBe("n8n returned an unexpected response shape");
  });

  it("does not echo a non-JSON body back to the caller", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => `<html>Traffic successfully made it to the ngrok agent ${API_KEY}</html>`,
    } as Response);

    const result = await createN8nApiClient(config).listWorkflows();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).not.toContain(API_KEY);
    expect(result.error.message).toBe("n8n returned an unexpected response shape");
  });
});

describe("n8n Public API — no credential leaks", () => {
  it("keeps the key out of returned data and error messages", async () => {
    stub(401, { message: "apiKey=leaked rejected" });
    const result = await createN8nApiClient(config).checkConnection();

    expect(result.ok).toBe(false);
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(API_KEY);
    if (!result.ok) expect(result.error.message).not.toContain("leaked");
  });

  it("builds every request against the configured origin only", async () => {
    const spy = stub(200, { data: [], nextCursor: null });
    // A cursor is attacker-influenced in principle; it must not move the request.
    await createN8nApiClient(config).listWorkflows({ cursor: "../../evil" });
    const url = new URL(String(spy.mock.calls[0]![0]));
    expect(url.origin).toBe(BASE_URL);
    expect(url.pathname).toBe("/api/v1/workflows");
  });
});

describe("n8n Public API — provider surface", () => {
  it("exposes the read-only methods on the shared provider", async () => {
    stub(200, { data: [{ id: "wf-1" }], nextCursor: null });
    const provider = createN8nProvider({ config });

    expect(typeof provider.checkConnection).toBe("function");
    expect(typeof provider.listWorkflows).toBe("function");
    expect(typeof provider.listAllWorkflows).toBe("function");
    expect(typeof provider.listExecutions).toBe("function");
    expect(typeof provider.getExecution).toBe("function");

    const result = await provider.checkConnection();
    expect(result).toEqual({ ok: true, data: { workflowCount: 1 } });
  });

  it("accepts an injected api client", async () => {
    const calls: unknown[] = [];
    const provider = createN8nProvider({
      config,
      apiClient: {
        listWorkflows: async (params) => {
          calls.push(params);
          return { ok: true, data: { workflows: [], nextCursor: null } };
        },
        listAllWorkflows: async () => ({ ok: true, data: { workflows: [], truncated: false } }),
        listExecutions: async () => ({ ok: true, data: { executions: [], nextCursor: null } }),
        getExecution: async () => ({
          ok: true,
          data: { id: "exec-1", workflowId: null, status: null, finished: null, startedAt: null, stoppedAt: null },
        }),
        checkConnection: async () => ({ ok: true, data: { workflowCount: 0 } }),
      },
    });

    await provider.listWorkflows({ limit: 5 });
    expect(calls).toEqual([{ limit: 5 }]);
  });
});
