// ---------------------------------------------------------------------------
// Phase 18, Stage 18.3B — the one live read an approved allow-list change
// makes, against a synthetic workflow built to leak.
//
// `GET /api/v1/workflows/{id}` returns everything: node parameters (with
// tokens, passwords, URLs and expressions), credential references, settings,
// static and pinned data. Only the webhook trigger's path, method and
// authentication mode — validated — and the versionId may come out. These
// tests feed the extractor and the client a hostile definition and check
// that nothing else does, in a result or in an error.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, afterEach } from "vitest";
import { createN8nConfig } from "../src/config.js";
import { createN8nApiClient } from "../src/api-client.js";
import { createN8nLibraryTriggerTargetSource } from "../src/library-source.js";
import { createN8nProvider } from "../src/provider.js";
import { extractWorkflowTriggerTarget } from "../src/trigger-target.js";

const API_KEY = "SECRET-API-KEY-VALUE";
const config = createN8nConfig({ baseUrl: "https://n8n.cloud.test", apiKey: API_KEY, callbackSecret: "cb", timeoutMs: 200 });

const SECRETS = [
  "sk-live-TOKEN-123",
  "hunter2",
  "Bearer abc.def.ghi",
  "https://internal.example/admin",
  "credential-secret-id",
  "PINNED-CUSTOMER-EMAIL@example.com",
  "STATIC-DATA-SECRET",
  "={{$env.SECRET_PATH}}",
  "jsCode-secret",
  "SETTINGS-ERROR-WORKFLOW",
];

/** A workflow definition carrying every kind of thing that must not leave. */
function hostileWorkflow(over: Record<string, unknown> = {}) {
  return {
    id: "wf-1",
    name: "Leak test https://internal.example/admin",
    active: true,
    versionId: "ver-7",
    settings: { errorWorkflow: "SETTINGS-ERROR-WORKFLOW", callerPolicy: "any" },
    staticData: { lastId: "STATIC-DATA-SECRET" },
    pinData: { Webhook: [{ json: { email: "PINNED-CUSTOMER-EMAIL@example.com" } }] },
    nodes: [
      {
        name: "Webhook",
        type: "n8n-nodes-base.webhook",
        webhookId: "11111111-2222-3333-4444-555555555555",
        parameters: { path: "invoice-in", httpMethod: "post", authentication: "none", responseMode: "onReceived", options: { rawBody: true } },
        credentials: { httpHeaderAuth: { id: "credential-secret-id", name: "prod header" } },
      },
      {
        name: "HTTP",
        type: "n8n-nodes-base.httpRequest",
        parameters: { url: "https://internal.example/admin", headers: { Authorization: "Bearer abc.def.ghi" }, token: "sk-live-TOKEN-123" },
        credentials: { httpBasicAuth: { id: "credential-secret-id", name: "admin" } },
      },
      { name: "Code", type: "n8n-nodes-base.code", parameters: { jsCode: "const p = 'hunter2'; // jsCode-secret" } },
      { name: "Disabled hook", type: "n8n-nodes-base.webhook", disabled: true, parameters: { path: "={{$env.SECRET_PATH}}", httpMethod: "POST" } },
    ],
    connections: { Webhook: { main: [[{ node: "HTTP" }]] } },
    ...over,
  };
}

const noSecrets = (value: unknown) => {
  const text = JSON.stringify(value);
  for (const secret of [...SECRETS, API_KEY]) expect(text, secret).not.toContain(secret);
};

afterEach(() => vi.restoreAllMocks());

describe("extractWorkflowTriggerTarget — the boundary", () => {
  it("keeps the versionId and, per ENABLED webhook node, only its validated path, method and auth mode", () => {
    const target = extractWorkflowTriggerTarget(hostileWorkflow());
    expect(target).toEqual({
      versionId: "ver-7",
      webhooks: [{ path: "invoice-in", method: "POST", authentication: "none" }],
    });
    noSecrets(target);
    expect(Object.keys(target!).sort()).toEqual(["versionId", "webhooks"]);
    expect(Object.keys(target!.webhooks[0]!).sort()).toEqual(["authentication", "method", "path"]);
  });

  it("turns a path that is an expression, a URL, traversal or an authority into null — never echoes it", () => {
    for (const path of ["={{$env.SECRET_PATH}}", "https://internal.example/admin", "../../admin", "//evil.example/x", "a b", "", 42, null]) {
      const target = extractWorkflowTriggerTarget(
        hostileWorkflow({ nodes: [{ type: "n8n-nodes-base.webhook", parameters: { path, httpMethod: "POST" } }] })
      );
      expect(target!.webhooks).toEqual([{ path: null, method: "POST", authentication: "none" }]);
      noSecrets(target);
    }
  });

  it("reports an unknown method or auth mode as null, and a missing auth mode as n8n's default", () => {
    const target = extractWorkflowTriggerTarget(
      hostileWorkflow({
        nodes: [
          { type: "n8n-nodes-base.webhook", parameters: { path: "a", httpMethod: "TRACE", authentication: "sk-live-TOKEN-123" } },
          { type: "n8n-nodes-base.webhook", parameters: { path: "b" } },
          { type: "n8n-nodes-base.webhook", parameters: { path: "c", httpMethod: "GET", authentication: "headerAuth" } },
        ],
      })
    );
    expect(target!.webhooks).toEqual([
      { path: "a", method: null, authentication: null },
      { path: "b", method: null, authentication: "none" },
      { path: "c", method: "GET", authentication: "headerAuth" },
    ]);
    noSecrets(target);
  });

  it("refuses what is not a workflow, and drops an invalid versionId", () => {
    for (const body of [null, "text", [], { nodes: "x" }, { data: [] }]) expect(extractWorkflowTriggerTarget(body)).toBeNull();
    expect(extractWorkflowTriggerTarget(hostileWorkflow({ versionId: "v 7; drop" }))!.versionId).toBeNull();
    expect(extractWorkflowTriggerTarget(hostileWorkflow({ nodes: [] }))).toEqual({ versionId: "ver-7", webhooks: [] });
  });
});

describe("the client and the library adapter", () => {
  it("reads one workflow with the key in a header and returns only the target", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify(hostileWorkflow()) } as Response);
    const result = await createN8nApiClient(config).getWorkflowTriggerTarget("wf-1");
    expect(result).toEqual({ ok: true, data: { versionId: "ver-7", webhooks: [{ path: "invoice-in", method: "POST", authentication: "none" }] } });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://n8n.cloud.test/api/v1/workflows/wf-1");
    expect((init as RequestInit).method).toBe("GET");
    expect(String(url)).not.toContain(API_KEY);
    noSecrets(result);
  });

  it("refuses an id that could leave the workflows path, without a request", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    for (const id of ["../executions", "wf/1", "https://evil", "", "a".repeat(200)]) {
      expect(await createN8nApiClient(config).getWorkflowTriggerTarget(id)).toMatchObject({ ok: false });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("passes on a code and a status — never n8n's words — when the read fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ message: "Workflow sk-live-TOKEN-123 not found at https://internal.example/admin" }),
    } as Response);
    const source = createN8nLibraryTriggerTargetSource(createN8nProvider({ config }));
    const result = await source.fetchTriggerTarget("wf-1");
    expect(result).toMatchObject({ ok: false, error: { httpStatus: 404 } });
    expect(Object.keys((result as { error: object }).error).sort()).toEqual(["code", "httpStatus"]);
    noSecrets(result);
  });

  it("answers a body that is not a workflow as a malformed response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ secret: "hunter2" }) } as Response);
    const result = await createN8nLibraryTriggerTargetSource(createN8nProvider({ config })).fetchTriggerTarget("wf-1");
    expect(result.ok).toBe(false);
    noSecrets(result);
  });
});
