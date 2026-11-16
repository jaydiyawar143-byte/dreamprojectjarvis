// ---------------------------------------------------------------------------
// Phase 19, P0 — the start-up probe's classification, and the configuration
// problem an operator is told about.
//
// The real-socket cases (wrong secret, wrong identity, untrusted CA, nothing
// listening, unreadable files) are in apps/browser-service's
// browser-service-startup-checks-p19 test. These are the answers a live
// service cannot easily be made to give: another protocol version, a 503, a
// deadline, an acknowledgement that is not one — and what the probe sends.
// ---------------------------------------------------------------------------

import {
  BROWSER_PROTOCOL_VERSION,
  BROWSER_SERVICE_PROBE_MESSAGES,
  BROWSER_SERVICE_PROBE_SUBJECT,
  BrowserServiceTransportError,
  failureEnvelope,
  probeBrowserService,
  readBrowserServiceEndpoint,
  successEnvelope,
  transportFailureOf,
  type BrowserServiceEndpointConfig,
  type BrowserServiceErrorCode,
  type BrowserServiceTransport,
} from "@jarvis/browser-protocol";
import { describe, expect, it } from "vitest";

const CONFIG: BrowserServiceEndpointConfig = {
  baseUrl: "https://browser-service:3200",
  keyId: "api-key-1",
  secret: "0123456789abcdef0123456789abcdef",
  peerIdentity: "jarvis-api",
  timeoutMs: 1_000,
  tls: { certPath: "client.crt", keyPath: "client.key", caPath: "ca.crt" },
};

interface Sent {
  operation: string;
  sessionId?: string;
  subject: unknown;
  version: string;
  payload?: unknown;
}

function answering(answer: (sent: Sent, requestId: string) => ReturnType<BrowserServiceTransport>) {
  const sent: Sent[] = [];
  const transport: BrowserServiceTransport = async (request) => {
    const body = JSON.parse(Buffer.from(request.body).toString("utf8")) as Sent & { requestId: string };
    sent.push(body);
    return answer(body, body.requestId);
  };
  return { transport, sent };
}

const refusal = (code: BrowserServiceErrorCode, status: number) =>
  answering(async (_sent, requestId) => ({
    status,
    headers: {},
    body: JSON.stringify(failureEnvelope(requestId, code)),
    tooLarge: false,
  }));

describe("what the probe sends", () => {
  it("is one signed session.close, for a fresh random session id, as the probe subject, with no payload", async () => {
    const { transport, sent } = answering(async (_sent, requestId) => ({
      status: 200,
      headers: {},
      body: JSON.stringify(successEnvelope(requestId, { closed: true })),
      tooLarge: false,
    }));
    await expect(probeBrowserService(CONFIG, { transport })).resolves.toEqual({ ok: true });
    await probeBrowserService(CONFIG, { transport });
    expect(sent).toHaveLength(2);
    for (const body of sent) {
      expect(body.operation).toBe("session.close");
      expect(body.version).toBe(BROWSER_PROTOCOL_VERSION);
      expect(body.subject).toEqual(BROWSER_SERVICE_PROBE_SUBJECT);
      expect(body.payload).toBeUndefined();
      expect(body.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    }
    // A new id every time: never one a person's session could hold.
    expect(sent[0]!.sessionId).not.toBe(sent[1]!.sessionId);
  });
});

describe("how the probe classifies the service's answer", () => {
  const cases: Array<[string, () => ReturnType<typeof answering>, string]> = [
    ["another protocol version", () => refusal("UNSUPPORTED_VERSION", 400), "protocol-version"],
    ["a request outside the clock window", () => refusal("REQUEST_EXPIRED", 401), "clock-skew"],
    ["an unauthenticated request", () => refusal("UNAUTHENTICATED", 401), "authentication"],
    ["a replayed nonce", () => refusal("REPLAY_DETECTED", 401), "authentication"],
    ["a service that says it is unavailable", () => refusal("UNAVAILABLE", 503), "service-unavailable"],
    ["a refusal no probe should get", () => refusal("INVALID_REQUEST", 400), "unexpected-response"],
    [
      "an acknowledgement that is not { closed: true }",
      () =>
        answering(async (_sent, requestId) => ({
          status: 200,
          headers: {},
          body: JSON.stringify(successEnvelope(requestId, { closed: false })),
          tooLarge: false,
        })),
      "unexpected-response",
    ],
    [
      "an answer that is not an envelope",
      () => answering(async () => ({ status: 502, headers: {}, body: "<html>bad gateway</html>", tooLarge: false })),
      "unexpected-response",
    ],
    [
      "a refused connection",
      () =>
        answering(async () => {
          throw new BrowserServiceTransportError(false, "network");
        }),
      "unreachable",
    ],
    [
      "a failed TLS handshake",
      () =>
        answering(async () => {
          throw new BrowserServiceTransportError(false, "tls");
        }),
      "tls-handshake",
    ],
    [
      "client files that cannot be read",
      () =>
        answering(async () => {
          throw new BrowserServiceTransportError(false, "credentials");
        }),
      "client-credentials-unreadable",
    ],
  ];

  it.each(cases)("%s", async (_label, make, reason) => {
    const { transport } = make();
    const result = await probeBrowserService(CONFIG, { transport });
    expect(result).toEqual({
      ok: false,
      reason,
      message: BROWSER_SERVICE_PROBE_MESSAGES[reason as keyof typeof BROWSER_SERVICE_PROBE_MESSAGES],
    });
  });

  it("reports a service that never answers as a timeout, within the client's deadline", async () => {
    const transport: BrowserServiceTransport = (request) =>
      new Promise((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new BrowserServiceTransportError(true)));
      });
    const started = Date.now();
    const result = await probeBrowserService(CONFIG, { transport });
    expect(result.ok ? null : result.reason).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("never throws, whatever the transport does", async () => {
    const transport: BrowserServiceTransport = async () => {
      throw new TypeError("something nobody expected");
    };
    await expect(probeBrowserService(CONFIG, { transport })).resolves.toMatchObject({ ok: false });
  });

  it("says nothing but fixed sentences", () => {
    for (const message of Object.values(BROWSER_SERVICE_PROBE_MESSAGES)) {
      expect(message).not.toMatch(/\$\{|https?:\/\/|\/run\/|BEGIN/);
    }
  });
});

describe("transportFailureOf — a failure's kind from its code, never its message", () => {
  it.each([
    ["ECONNREFUSED", "network"],
    ["ECONNRESET", "network"],
    ["ENOTFOUND", "network"],
    ["EAI_AGAIN", "network"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "tls"],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "tls"],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "tls"],
    ["SELF_SIGNED_CERT_IN_CHAIN", "tls"],
    ["CERT_HAS_EXPIRED", "tls"],
    ["ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED", "tls"],
    ["ABORT_ERR", "unknown"],
  ])("%s is %s", (code, failure) => {
    expect(transportFailureOf(Object.assign(new Error("irrelevant: /secret/path 10.1.2.3"), { code }))).toBe(failure);
  });

  it("is unknown for anything without a code", () => {
    expect(transportFailureOf(new Error("no code"))).toBe("unknown");
    expect(transportFailureOf(null)).toBe("unknown");
    expect(transportFailureOf("ECONNREFUSED")).toBe("unknown");
  });

  it("keeps an older two-argument-less construction valid: unknown by default", () => {
    expect(new BrowserServiceTransportError(false).failure).toBe("unknown");
  });
});

describe("readBrowserServiceEndpoint — which kind of mistake an invalid configuration is", () => {
  const valid = {
    BROWSER_SERVICE_URL: "https://browser-service:3200",
    BROWSER_SERVICE_KEY_ID: "api-key-1",
    BROWSER_SERVICE_SHARED_SECRET: "0123456789abcdef0123456789abcdef",
    BROWSER_SERVICE_PEER_IDENTITY: "jarvis-api",
    BROWSER_SERVICE_CLIENT_CERT_PATH: "/run/jarvis-browser-tls/client.crt",
    BROWSER_SERVICE_CLIENT_KEY_PATH: "/run/jarvis-browser-tls/client.key",
  };

  it.each([
    ["an unparsable URL", { BROWSER_SERVICE_URL: "not a url" }, "invalid-url"],
    ["plain http", { BROWSER_SERVICE_URL: "http://browser-service:3200" }, "invalid-url"],
    ["credentials in the URL", { BROWSER_SERVICE_URL: "https://u:p@browser-service:3200" }, "invalid-url"],
    ["a query in the URL", { BROWSER_SERVICE_URL: "https://browser-service:3200/?x=1" }, "invalid-url"],
    ["no key id", { BROWSER_SERVICE_KEY_ID: "" }, "missing"],
    ["no secret", { BROWSER_SERVICE_SHARED_SECRET: "" }, "missing"],
    ["no peer identity", { BROWSER_SERVICE_PEER_IDENTITY: "" }, "missing"],
    ["no client certificate", { BROWSER_SERVICE_CLIENT_CERT_PATH: "" }, "missing"],
    ["a short secret", { BROWSER_SERVICE_SHARED_SECRET: "tiny-s3cret" }, "invalid-value"],
    ["a timeout out of range", { BROWSER_SERVICE_TIMEOUT_MS: "5" }, "invalid-value"],
  ])("%s is %s", (_label, change, problem) => {
    const read = readBrowserServiceEndpoint({ ...valid, ...change });
    expect(read.state).toBe("invalid");
    if (read.state !== "invalid") return;
    expect(read.problem).toBe(problem);
    expect(read.reason).not.toContain("tiny-s3cret");
    expect(read.reason).not.toContain("u:p");
  });

  it("is still ready for a complete configuration, and absent without a URL", () => {
    expect(readBrowserServiceEndpoint(valid).state).toBe("ready");
    expect(readBrowserServiceEndpoint({}).state).toBe("absent");
  });
});
