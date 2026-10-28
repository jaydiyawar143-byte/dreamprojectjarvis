// ---------------------------------------------------------------------------
// Phase 19, Stage 19.2 audit (H2) — what a failed call says it may have done.
//
// Phase 19.1's rule: an external write whose outcome is uncertain is recorded
// UNKNOWN and never retried. Over the network that rule needs the client to
// tell three things apart, and these tests pin each boundary:
//
//   not-sent   the request never left — a known failure, safe to try again;
//   no-effect  it was sent and the service refused it before acting, or the
//              operation was a read or a session operation;
//   uncertain  a WRITE was sent and no definitive answer came back.
//
// `phase` and `sideEffectPossible` are what the execution journal reads; they
// are asserted beside the outcome so the journal's view cannot drift from it.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import {
  BROWSER_SERVICE_ERROR_CODES,
  BROWSER_SERVICE_ERROR_MESSAGES,
  BrowserServiceClient,
  BrowserServiceError,
  BrowserServiceTransportError,
  RemoteBrowserRuntime,
  failureEnvelope,
  isBrowserServiceWriteOperation,
  nodeBrowserServiceTransport,
  outcomeOfServiceRefusal,
  successEnvelope,
  type BrowserServiceEndpointConfig,
  type BrowserServiceErrorCode,
  type BrowserServiceOperation,
  type BrowserServiceTransport,
  type BrowserServiceTransportResponse,
} from "../src/index.js";

const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const SECRET = "0123456789abcdef0123456789abcdef";
const NOW = 1_700_000_000_000;
const SUBJECT = { userId: "user-1", organizationId: "org-1" };
const PAGE = { url: "https://example.com/", title: "Example", status: 200 };

function endpoint(overrides: Partial<BrowserServiceEndpointConfig> = {}): BrowserServiceEndpointConfig {
  return {
    baseUrl: "https://browser-service:3200",
    keyId: "api-key-1",
    secret: SECRET,
    peerIdentity: "jarvis-api",
    timeoutMs: 5_000,
    tls: { certPath: "client.pem", keyPath: "client-key.pem", caPath: "ca.pem" },
    ...overrides,
  };
}

function client(transport: BrowserServiceTransport, overrides: Partial<BrowserServiceEndpointConfig> = {}) {
  return new BrowserServiceClient({ config: endpoint(overrides), transport, now: () => NOW });
}

function requestIdOf(body: Uint8Array): string {
  return String((JSON.parse(Buffer.from(body).toString("utf8")) as { requestId: string }).requestId);
}

function refusal(code: BrowserServiceErrorCode, status = 502): BrowserServiceTransport {
  return async (request) => ({
    status,
    headers: {},
    body: JSON.stringify(failureEnvelope(requestIdOf(request.body), code)),
    tooLarge: false,
  });
}

const SUBMIT = {
  operation: "browser.submit" as const,
  sessionId: SESSION_ID,
  subject: SUBJECT,
  payload: { url: PAGE.url, selector: "#send" },
};

const NAVIGATE = {
  operation: "browser.navigate" as const,
  sessionId: SESSION_ID,
  subject: SUBJECT,
  payload: { url: PAGE.url },
};

async function failureOf(promise: Promise<unknown>): Promise<BrowserServiceError> {
  const caught = await promise.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (error: unknown) => error
  );
  expect(caught).toBeInstanceOf(BrowserServiceError);
  return caught as BrowserServiceError;
}

function expectUncertain(error: BrowserServiceError, code: BrowserServiceErrorCode): void {
  expect(error.code).toBe(code);
  expect(error.outcome).toBe("uncertain");
  expect(error.phase).toBe("in-flight");
  expect(error.sideEffectPossible).toBe(true);
  // Told as what it is, whatever failed: never "not available" for a submit
  // that may have reached the site.
  expect(error.message).toBe(BROWSER_SERVICE_ERROR_MESSAGES.UNKNOWN_OUTCOME);
}

function expectNoEffect(error: BrowserServiceError, code: BrowserServiceErrorCode): void {
  expect(error.code).toBe(code);
  expect(error.outcome).toBe("no-effect");
  expect(error.phase).toBe("in-flight");
  expect(error.sideEffectPossible).toBe(false);
  expect(error.message).toBe(BROWSER_SERVICE_ERROR_MESSAGES[code]);
}

function expectNotSent(error: BrowserServiceError, code: BrowserServiceErrorCode): void {
  expect(error.code).toBe(code);
  expect(error.outcome).toBe("not-sent");
  expect(error.phase).toBe("before-send");
  expect(error.sideEffectPossible).toBe(false);
  expect(error.message).toBe(BROWSER_SERVICE_ERROR_MESSAGES[code]);
}

describe("which operations can reach a site", () => {
  it("is exactly core's six approval-gated browser actions", () => {
    const writes = ["browser.click", "browser.type", "browser.select", "browser.submit", "browser.download", "browser.upload"];
    for (const operation of writes) expect(isBrowserServiceWriteOperation(operation)).toBe(true);
    for (const operation of ["browser.navigate", "browser.inspect", "browser.extract", "browser.screenshot", "session.open", "session.close", "", 1]) {
      expect(isBrowserServiceWriteOperation(operation)).toBe(false);
    }
  });
});

describe("a write that fails before it is sent is a known failure", () => {
  it("an oversized request", async () => {
    let calls = 0;
    const transport: BrowserServiceTransport = async () => {
      calls += 1;
      throw new Error("never");
    };
    const small = new BrowserServiceClient({ config: endpoint(), transport, now: () => NOW, maxRequestBytes: 64 });
    expectNotSent(await failureOf(small.execute(SUBMIT)), "TOO_LARGE");
    expect(calls).toBe(0);
  });

  it("a deadline that had already passed", async () => {
    let calls = 0;
    const transport: BrowserServiceTransport = async () => {
      calls += 1;
      throw new Error("never");
    };
    const controller = new AbortController();
    controller.abort();
    expectNotSent(await failureOf(client(transport).execute(SUBMIT, controller.signal)), "TIMEOUT");
    expect(calls).toBe(0);
  });

  it("a transport that proves the request never left", async () => {
    const transport: BrowserServiceTransport = async () => {
      throw new BrowserServiceTransportError(false);
    };
    expectNotSent(await failureOf(client(transport).execute(SUBMIT)), "UNAVAILABLE");
  });
});

describe("a write that was sent and not definitively answered is uncertain", () => {
  it("UNAVAILABLE — the connection failed after the request was written", async () => {
    // The submit reached the service — and, through it, the site — and then
    // the connection dropped before the answer arrived.
    let reachedSite = 0;
    const transport: BrowserServiceTransport = async () => {
      reachedSite += 1;
      throw new BrowserServiceTransportError(true);
    };
    expectUncertain(await failureOf(client(transport).execute(SUBMIT)), "UNAVAILABLE");
    expect(reachedSite).toBe(1);
  });

  it("UNAVAILABLE — a transport that cannot say whether it sent", async () => {
    const transport: BrowserServiceTransport = async () => {
      throw new Error("socket hang up");
    };
    const error = await failureOf(client(transport).execute(SUBMIT));
    expectUncertain(error, "UNAVAILABLE");
    expect(error.message).not.toContain("socket");
  });

  it("TIMEOUT — the client's own deadline, after the request left", async () => {
    const transport: BrowserServiceTransport = (request) =>
      new Promise((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new BrowserServiceTransportError(true)));
      });
    expectUncertain(await failureOf(client(transport, { timeoutMs: 20 }).execute(SUBMIT)), "TIMEOUT");
  });

  it("TIMEOUT, UNKNOWN_OUTCOME, PROVIDER_ERROR, REPLAY_DETECTED and UNAVAILABLE from the service", async () => {
    for (const code of ["TIMEOUT", "UNKNOWN_OUTCOME", "PROVIDER_ERROR", "REPLAY_DETECTED", "UNAVAILABLE"] as const) {
      expectUncertain(await failureOf(client(refusal(code)).execute(SUBMIT)), code);
    }
  });

  it("PROVIDER_ERROR — an answer that is not an envelope", async () => {
    const transport: BrowserServiceTransport = async () => ({
      status: 502,
      headers: {},
      body: "<html>bad gateway</html>",
      tooLarge: false,
    });
    expectUncertain(await failureOf(client(transport).execute(SUBMIT)), "PROVIDER_ERROR");
  });

  it("PROVIDER_ERROR — an answer to another request", async () => {
    const transport: BrowserServiceTransport = async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify(successEnvelope("33333333-3333-4333-8333-333333333333", {})),
      tooLarge: false,
    });
    expectUncertain(await failureOf(client(transport).execute(SUBMIT)), "PROVIDER_ERROR");
  });

  it("TOO_LARGE — an answer too big to read", async () => {
    const transport: BrowserServiceTransport = async () => ({ status: 200, headers: {}, body: "", tooLarge: true });
    expectUncertain(await failureOf(client(transport).execute(SUBMIT)), "TOO_LARGE");
  });

  it("holds for every one of the six writes", async () => {
    for (const operation of ["browser.click", "browser.type", "browser.select", "browser.submit", "browser.download", "browser.upload"] as const) {
      const transport: BrowserServiceTransport = async () => {
        throw new BrowserServiceTransportError(true);
      };
      const error = await failureOf(client(transport).execute({ ...SUBMIT, operation }));
      expectUncertain(error, "UNAVAILABLE");
    }
  });
});

describe("a refusal the service sent before acting is a known failure", () => {
  it("for each code on the allowlist", async () => {
    const refusedBefore = [
      "INVALID_REQUEST",
      "UNSUPPORTED_VERSION",
      "UNKNOWN_OPERATION",
      "UNAUTHENTICATED",
      "REQUEST_EXPIRED",
      "NOT_AUTHORIZED",
      "CROSS_TENANT_DENIED",
      "SESSION_NOT_FOUND",
      "SESSION_EXPIRED",
      "LIMIT_EXCEEDED",
      "TOO_LARGE",
    ] as const;
    for (const code of refusedBefore) {
      expectNoEffect(await failureOf(client(refusal(code, 400)).execute(SUBMIT)), code);
    }
  });

  it("and every other code is uncertain for a write — the allowlist is closed", () => {
    const uncertain = BROWSER_SERVICE_ERROR_CODES.filter((code) => outcomeOfServiceRefusal(code, true) === "uncertain");
    expect([...uncertain].sort()).toEqual(
      ["PROVIDER_ERROR", "REPLAY_DETECTED", "TIMEOUT", "UNAVAILABLE", "UNKNOWN_OUTCOME"].sort()
    );
  });
});

describe("a read or a session operation never has an uncertain outcome", () => {
  it("whatever went wrong after it was sent", async () => {
    const operations: Array<{ operation: BrowserServiceOperation; sessionId?: string; payload?: Record<string, unknown> }> = [
      NAVIGATE,
      { operation: "session.open" },
      { operation: "session.close", sessionId: SESSION_ID },
    ];
    for (const input of operations) {
      const dropped: BrowserServiceTransport = async () => {
        throw new BrowserServiceTransportError(true);
      };
      expectNoEffect(await failureOf(client(dropped).execute({ ...input, subject: SUBJECT })), "UNAVAILABLE");
      expectNoEffect(
        await failureOf(client(refusal("UNKNOWN_OUTCOME")).execute({ ...input, subject: SUBJECT })),
        "UNKNOWN_OUTCOME"
      );
    }
  });
});

describe("RemoteBrowserRuntime keeps the outcome", () => {
  function scripted(onWrite: () => BrowserServiceTransportResponse | Promise<BrowserServiceTransportResponse>) {
    const operations: string[] = [];
    const transport: BrowserServiceTransport = async (request) => {
      const body = JSON.parse(Buffer.from(request.body).toString("utf8")) as {
        requestId: string;
        operation: string;
      };
      operations.push(body.operation);
      const ok = (result: unknown): BrowserServiceTransportResponse => ({
        status: 200,
        headers: {},
        body: JSON.stringify(successEnvelope(body.requestId, result)),
        tooLarge: false,
      });
      if (body.operation === "session.open") return ok({ sessionId: SESSION_ID, expiresAt: NOW + 60_000, ttlMs: 60_000 });
      if (body.operation === "session.close") return ok({ closed: true });
      if (body.operation === "browser.navigate") {
        return ok({ action: "browser.navigate", ok: true, page: PAGE, redirected: false });
      }
      const response = await onWrite();
      return { ...response, body: response.body.replace("__REQUEST_ID__", body.requestId) };
    };
    const remote = new RemoteBrowserRuntime({
      client: client(transport),
      tenant: { resolveSessionOrganization: async () => ({ ok: true, organizationId: "org-1" }) },
    });
    return { remote, operations };
  }

  it("a write whose result does not match what was asked is uncertain — it ran", async () => {
    const { remote } = scripted(() => ({
      status: 200,
      headers: {},
      body: JSON.stringify(
        successEnvelope("__REQUEST_ID__", { action: "browser.inspect", ok: true, page: PAGE, elements: [], truncated: false })
      ),
      tooLarge: false,
    }));
    const error = await failureOf(
      remote.withSession("user-1", async (session) => {
        await session.navigate(PAGE.url);
        return session.submit("#send");
      })
    );
    expectUncertain(error, "PROVIDER_ERROR");
  });

  it("a write the service answered UNKNOWN_OUTCOME stays uncertain through the runtime", async () => {
    const { remote, operations } = scripted(() => ({
      status: 502,
      headers: {},
      body: JSON.stringify(failureEnvelope("__REQUEST_ID__", "UNKNOWN_OUTCOME")),
      tooLarge: false,
    }));
    const error = await failureOf(
      remote.withSession("user-1", async (session) => {
        await session.navigate(PAGE.url);
        return session.click("#go");
      })
    );
    expectUncertain(error, "UNKNOWN_OUTCOME");
    expect(operations).toEqual(["session.open", "browser.navigate", "browser.click", "session.close"]);
  });

  it("an action before any navigation is refused before anything is sent", async () => {
    const { remote, operations } = scripted(() => {
      throw new Error("never");
    });
    const error = await failureOf(remote.withSession("user-1", async (session) => session.submit("#send")));
    expectNotSent(error, "PROVIDER_ERROR");
    expect(operations).toEqual(["session.open", "session.close"]);
  });

  it("a tenant refusal is refused before anything is sent", async () => {
    const remote = new RemoteBrowserRuntime({
      client: client(async () => {
        throw new Error("never");
      }),
      tenant: { resolveSessionOrganization: async () => ({ ok: false }) },
    });
    expectNotSent(await failureOf(remote.withSession("user-1", async () => "never")), "NOT_AUTHORIZED");
  });
});

describe("the node transport refuses anything but mutual TLS (Stage 19.2 audit, M2)", () => {
  const base = {
    method: "POST" as const,
    headers: {},
    body: new Uint8Array(),
    signal: new AbortController().signal,
    maxResponseBytes: 1_024,
  };

  it("never opens a plain http connection", async () => {
    const error = await nodeBrowserServiceTransport({
      ...base,
      url: new URL("http://127.0.0.1:9/v1/execute"),
      tls: { certPath: "client.pem", keyPath: "client-key.pem", caPath: null },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BrowserServiceTransportError);
    expect((error as BrowserServiceTransportError).requestSent).toBe(false);
  });

  it("never sends without the API's client certificate", async () => {
    const error = await nodeBrowserServiceTransport({
      ...base,
      url: new URL("https://127.0.0.1:9/v1/execute"),
      tls: null,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BrowserServiceTransportError);
    expect((error as BrowserServiceTransportError).requestSent).toBe(false);
  });

  it("an unreadable certificate file is a refusal before sending, without its path", async () => {
    const error = await nodeBrowserServiceTransport({
      ...base,
      url: new URL("https://127.0.0.1:9/v1/execute"),
      tls: { certPath: "/nonexistent/jarvis-client.pem", keyPath: "/nonexistent/key.pem", caPath: null },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BrowserServiceTransportError);
    expect((error as BrowserServiceTransportError).requestSent).toBe(false);
    expect((error as Error).message).not.toContain("nonexistent");
  });
});
