// ---------------------------------------------------------------------------
// Phase 19, Stage 19.2 — the browser service protocol, its signing and the
// API's typed client.
//
// These are the contract tests. They do not start a browser and they do not
// reach a network: the transport is a function, so every assertion here is
// about the bytes that WOULD cross the boundary and the refusals that happen
// before any do.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import {
  BROWSER_PROTOCOL_MAX_BODY_BYTES,
  BROWSER_SERVICE_HEADERS,
  BrowserServiceClient,
  BrowserServiceError,
  ProcessNonceStore,
  RemoteBrowserRuntime,
  canonicalRequestString,
  computeBodySha256,
  computeRequestSignature,
  failureEnvelope,
  isNonceShapeValid,
  isTimestampFresh,
  parseBrowserServiceRequest,
  parseBrowserServiceResponse,
  readBrowserServiceEndpoint,
  successEnvelope,
  verifyRequestSignature,
  verifySignedRequest,
  type BrowserServiceEndpointConfig,
  type BrowserServiceTransport,
  type BrowserServiceTransportRequest,
  type BrowserServiceTransportResponse,
  type SignedRequestParts,
} from "../src/index.js";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const SECRET = "0123456789abcdef0123456789abcdef";
const NOW = 1_700_000_000_000;
const PEER = "jarvis-api";
const KEY_ID = "api-key-1";

function endpoint(overrides: Partial<BrowserServiceEndpointConfig> = {}): BrowserServiceEndpointConfig {
  return {
    baseUrl: "https://browser-service:3200",
    keyId: KEY_ID,
    secret: SECRET,
    peerIdentity: PEER,
    timeoutMs: 5_000,
    // Paths only: these tests hand the client a transport of their own, so no
    // file is read and no socket is opened.
    tls: { certPath: "client.pem", keyPath: "client-key.pem", caPath: "ca.pem" },
    ...overrides,
  };
}

function envelope(action: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    version: "jarvis-browser/1",
    requestId: REQUEST_ID,
    operation: action,
    sessionId: SESSION_ID,
    subject: { userId: "user-1", organizationId: "org-1" },
    payload,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------

describe("browser service request contract", () => {
  it("accepts a navigate request and keeps the Phase 19.1 control request", () => {
    const parsed = parseBrowserServiceRequest(envelope("browser.navigate", { url: "https://example.com/" }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.operation).toBe("browser.navigate");
    expect(parsed.value.sessionId).toBe(SESSION_ID);
    expect(parsed.value.control?.action).toBe("browser.navigate");
  });

  it("accepts session.open without a session id and refuses a payload", () => {
    const opened = parseBrowserServiceRequest({
      version: "jarvis-browser/1",
      requestId: REQUEST_ID,
      operation: "session.open",
      subject: { userId: "user-1", organizationId: "org-1" },
    });
    expect(opened.ok).toBe(true);

    const withPayload = parseBrowserServiceRequest({
      version: "jarvis-browser/1",
      requestId: REQUEST_ID,
      operation: "session.open",
      subject: { userId: "user-1", organizationId: "org-1" },
      payload: { url: "https://example.com/" },
    });
    expect(withPayload).toEqual({ ok: false, code: "INVALID_REQUEST" });
  });

  it("refuses session.close without a session id", () => {
    const parsed = parseBrowserServiceRequest({
      version: "jarvis-browser/1",
      requestId: REQUEST_ID,
      operation: "session.close",
      subject: { userId: "user-1", organizationId: "org-1" },
    });
    expect(parsed).toEqual({ ok: false, code: "INVALID_REQUEST" });
  });

  it("refuses an unsupported version before anything else", () => {
    const parsed = parseBrowserServiceRequest({
      ...envelope("browser.navigate", { url: "https://example.com/" }),
      version: "jarvis-browser/2",
    });
    expect(parsed).toEqual({ ok: false, code: "UNSUPPORTED_VERSION" });
  });

  it("refuses a missing version as a malformed request", () => {
    const { version: _version, ...rest } = envelope("browser.navigate", { url: "https://example.com/" });
    expect(parseBrowserServiceRequest(rest)).toEqual({ ok: false, code: "INVALID_REQUEST" });
  });

  it("refuses an operation the service does not implement", () => {
    expect(parseBrowserServiceRequest(envelope("browser.launch", {}))).toEqual({
      ok: false,
      code: "UNKNOWN_OPERATION",
    });
    expect(parseBrowserServiceRequest(envelope("desktop.screen.read", {}))).toEqual({
      ok: false,
      code: "UNKNOWN_OPERATION",
    });
  });

  it("refuses a payload that names its own action", () => {
    expect(
      parseBrowserServiceRequest(
        envelope("browser.click", { action: "browser.submit", url: "https://example.com/", selector: "#go" })
      )
    ).toEqual({ ok: false, code: "INVALID_REQUEST" });
  });

  it("refuses a URL scheme the browser contract does not allow", () => {
    expect(parseBrowserServiceRequest(envelope("browser.navigate", { url: "javascript:alert(1)" }))).toEqual({
      ok: false,
      code: "INVALID_REQUEST",
    });
  });

  it("refuses an unknown envelope field and a malformed request id", () => {
    expect(
      parseBrowserServiceRequest({
        ...envelope("browser.navigate", { url: "https://example.com/" }),
        extra: true,
      })
    ).toEqual({ ok: false, code: "INVALID_REQUEST" });

    expect(
      parseBrowserServiceRequest({
        ...envelope("browser.navigate", { url: "https://example.com/" }),
        requestId: "not-a-uuid",
      })
    ).toEqual({ ok: false, code: "INVALID_REQUEST" });
  });

  it("refuses an empty subject", () => {
    expect(
      parseBrowserServiceRequest({
        ...envelope("browser.navigate", { url: "https://example.com/" }),
        subject: { userId: "", organizationId: "org-1" },
      })
    ).toEqual({ ok: false, code: "INVALID_REQUEST" });
  });
});

describe("browser service response contract", () => {
  it("round-trips a success", () => {
    const parsed = parseBrowserServiceResponse(successEnvelope(REQUEST_ID, { closed: true }));
    expect(parsed).toEqual({ ok: true, requestId: REQUEST_ID, result: { closed: true } });
  });

  it("returns the code, never the peer's sentence", () => {
    const forged = {
      ...failureEnvelope(REQUEST_ID, "PROVIDER_ERROR"),
      error: { code: "PROVIDER_ERROR", message: "token=abc123 at https://internal.example" },
    };
    const parsed = parseBrowserServiceResponse(forged);
    expect(parsed).toEqual({ ok: false, requestId: REQUEST_ID, code: "PROVIDER_ERROR" });
    expect(JSON.stringify(parsed)).not.toContain("abc123");
  });

  it("turns an unknown code into a provider failure", () => {
    const parsed = parseBrowserServiceResponse({
      ...failureEnvelope(REQUEST_ID, "PROVIDER_ERROR"),
      error: { code: "LEAK_EVERYTHING", message: "x" },
    });
    expect(parsed).toEqual({ ok: false, requestId: REQUEST_ID, code: "PROVIDER_ERROR" });
  });

  it("refuses a response from another protocol version", () => {
    const parsed = parseBrowserServiceResponse({
      ...successEnvelope(REQUEST_ID, {}),
      version: "jarvis-browser/9",
    });
    expect(parsed).toEqual({ ok: false, requestId: null, code: "UNSUPPORTED_VERSION" });
  });

  it("refuses a malformed response", () => {
    expect(parseBrowserServiceResponse({ ok: true })).toEqual({
      ok: false,
      requestId: null,
      code: "PROVIDER_ERROR",
    });
    expect(parseBrowserServiceResponse("not an object")).toEqual({
      ok: false,
      requestId: null,
      code: "PROVIDER_ERROR",
    });
  });
});

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

function parts(overrides: Partial<SignedRequestParts> = {}): SignedRequestParts {
  return {
    method: "POST",
    path: "/v1/execute",
    timestamp: String(NOW),
    nonce: "abcdefghijklmnop",
    keyId: KEY_ID,
    bodySha256: computeBodySha256(Buffer.from("{}")),
    peerIdentity: PEER,
    ...overrides,
  };
}

describe("signed requests", () => {
  it("derives one canonical string from every signed field", () => {
    const canonical = canonicalRequestString(parts());
    expect(canonical.split("\n")).toEqual([
      "jarvis-browser-request/1",
      "POST",
      "/v1/execute",
      String(NOW),
      "abcdefghijklmnop",
      KEY_ID,
      computeBodySha256(Buffer.from("{}")),
      PEER,
    ]);
  });

  it("verifies its own signature and rejects any changed field", () => {
    const signed = parts();
    const signature = computeRequestSignature(SECRET, signed);
    expect(verifyRequestSignature(SECRET, signed, signature)).toBe(true);
    expect(verifyRequestSignature(`${SECRET}x`, signed, signature)).toBe(false);
    expect(verifyRequestSignature(SECRET, { ...signed, path: "/v1/other" }, signature)).toBe(false);
    expect(verifyRequestSignature(SECRET, { ...signed, method: "GET" }, signature)).toBe(false);
    expect(verifyRequestSignature(SECRET, { ...signed, nonce: "ponmlkjihgfedcba" }, signature)).toBe(false);
    expect(verifyRequestSignature(SECRET, { ...signed, peerIdentity: "someone-else" }, signature)).toBe(false);
  });

  it("treats a malformed signature as a mismatch rather than a crash", () => {
    expect(verifyRequestSignature(SECRET, parts(), "not-hex")).toBe(false);
    expect(verifyRequestSignature(SECRET, parts(), "")).toBe(false);
  });

  it("bounds the timestamp window in both directions", () => {
    expect(isTimestampFresh(String(NOW), NOW, 60_000)).toBe(true);
    expect(isTimestampFresh(String(NOW - 59_000), NOW, 60_000)).toBe(true);
    expect(isTimestampFresh(String(NOW - 61_000), NOW, 60_000)).toBe(false);
    expect(isTimestampFresh(String(NOW + 61_000), NOW, 60_000)).toBe(false);
    expect(isTimestampFresh("yesterday", NOW, 60_000)).toBe(false);
  });

  it("only accepts nonces of a bounded, unambiguous shape", () => {
    expect(isNonceShapeValid("abcdefghijklmnop")).toBe(true);
    expect(isNonceShapeValid("short")).toBe(false);
    expect(isNonceShapeValid("has spaces in it here")).toBe(false);
    expect(isNonceShapeValid("x".repeat(200))).toBe(false);
  });

  it("spends a nonce once", () => {
    const store = new ProcessNonceStore(() => NOW);
    expect(store.use("abcdefghijklmnop", NOW + 1_000)).toBe(true);
    expect(store.use("abcdefghijklmnop", NOW + 1_000)).toBe(false);
    expect(store.size).toBe(1);
  });

  it("forgets a nonce once its window has passed", () => {
    let clock = NOW;
    const store = new ProcessNonceStore(() => clock);
    expect(store.use("abcdefghijklmnop", NOW + 1_000)).toBe(true);
    clock = NOW + 2_000;
    store.prune();
    expect(store.size).toBe(0);
    expect(store.use("abcdefghijklmnop", NOW + 2_000)).toBe(true);
  });
});

function verifyInput(body: Uint8Array, headers: Record<string, string>, nonces = new ProcessNonceStore(() => NOW)) {
  return {
    method: "POST",
    path: "/v1/execute",
    headers,
    body,
    peerIdentity: PEER,
    keys: [{ keyId: KEY_ID, secret: SECRET, identity: PEER }],
    now: NOW,
    clockSkewMs: 60_000,
    nonces,
  };
}

function signedHeaders(body: Uint8Array, overrides: Partial<SignedRequestParts> = {}): Record<string, string> {
  const signed = parts({ bodySha256: computeBodySha256(body), ...overrides });
  return {
    [BROWSER_SERVICE_HEADERS.keyId]: signed.keyId,
    [BROWSER_SERVICE_HEADERS.timestamp]: signed.timestamp,
    [BROWSER_SERVICE_HEADERS.nonce]: signed.nonce,
    [BROWSER_SERVICE_HEADERS.bodySha256]: signed.bodySha256,
    [BROWSER_SERVICE_HEADERS.signature]: computeRequestSignature(SECRET, signed),
  };
}

describe("verifySignedRequest", () => {
  const body = Buffer.from(JSON.stringify({ hello: "world" }));

  it("accepts a correctly signed request", async () => {
    const result = await verifySignedRequest(verifyInput(body, signedHeaders(body)));
    expect(result).toEqual({ ok: true, keyId: KEY_ID, identity: PEER });
  });

  it("refuses a request whose transport identity was not proven", async () => {
    const result = await verifySignedRequest({
      ...verifyInput(body, signedHeaders(body)),
      peerIdentity: null,
    });
    expect(result).toEqual({ ok: false, code: "UNAUTHENTICATED" });
  });

  it("refuses a missing header", async () => {
    const headers = signedHeaders(body);
    delete headers[BROWSER_SERVICE_HEADERS.signature];
    expect(await verifySignedRequest(verifyInput(body, headers))).toEqual({
      ok: false,
      code: "UNAUTHENTICATED",
    });
  });

  it("refuses an expired request", async () => {
    const headers = signedHeaders(body, { timestamp: String(NOW - 120_000) });
    expect(await verifySignedRequest(verifyInput(body, headers))).toEqual({
      ok: false,
      code: "REQUEST_EXPIRED",
    });
  });

  it("refuses a body that changed after signing", async () => {
    const headers = signedHeaders(body);
    const changed = Buffer.from(JSON.stringify({ hello: "tampered" }));
    expect(await verifySignedRequest(verifyInput(changed, headers))).toEqual({
      ok: false,
      code: "UNAUTHENTICATED",
    });
  });

  it("refuses an unknown key and a key bound to another identity", async () => {
    const headers = signedHeaders(body);
    const unknownKey = await verifySignedRequest({
      ...verifyInput(body, headers),
      keys: [{ keyId: "other-key", secret: SECRET, identity: PEER }],
    });
    expect(unknownKey).toEqual({ ok: false, code: "UNAUTHENTICATED" });

    const otherIdentity = await verifySignedRequest({
      ...verifyInput(body, headers),
      keys: [{ keyId: KEY_ID, secret: SECRET, identity: "someone-else" }],
    });
    expect(otherIdentity).toEqual({ ok: false, code: "UNAUTHENTICATED" });
  });

  it("refuses a replay and does not let a forged request spend the nonce", async () => {
    const nonces = new ProcessNonceStore(() => NOW);
    const headers = signedHeaders(body);

    const forged = { ...headers, [BROWSER_SERVICE_HEADERS.signature]: "0".repeat(64) };
    expect(await verifySignedRequest(verifyInput(body, forged, nonces))).toEqual({
      ok: false,
      code: "UNAUTHENTICATED",
    });

    // The forged attempt spent nothing, so the real request still works once.
    expect(await verifySignedRequest(verifyInput(body, headers, nonces))).toEqual({
      ok: true,
      keyId: KEY_ID,
      identity: PEER,
    });
    expect(await verifySignedRequest(verifyInput(body, headers, nonces))).toEqual({
      ok: false,
      code: "REPLAY_DETECTED",
    });
  });
});

// ---------------------------------------------------------------------------
// Endpoint configuration
// ---------------------------------------------------------------------------

describe("readBrowserServiceEndpoint", () => {
  const valid = {
    BROWSER_SERVICE_URL: "https://browser-service:3200/",
    BROWSER_SERVICE_KEY_ID: KEY_ID,
    BROWSER_SERVICE_SHARED_SECRET: SECRET,
    BROWSER_SERVICE_PEER_IDENTITY: PEER,
    BROWSER_SERVICE_CLIENT_CERT_PATH: "/run/secrets/api.pem",
    BROWSER_SERVICE_CLIENT_KEY_PATH: "/run/secrets/api-key.pem",
  };

  it("is absent only when no URL is asked for", () => {
    expect(readBrowserServiceEndpoint({}).state).toBe("absent");
  });

  it("is ready with a usable URL and credentials", () => {
    const read = readBrowserServiceEndpoint(valid);
    expect(read.state).toBe("ready");
    if (read.state !== "ready") return;
    expect(read.config.baseUrl).toBe("https://browser-service:3200");
    expect(read.config.tls).toEqual({
      certPath: "/run/secrets/api.pem",
      keyPath: "/run/secrets/api-key.pem",
      caPath: null,
    });
    expect(read.config.timeoutMs).toBe(30_000);
  });

  it("refuses plain http — the service accepts mutual TLS only (Stage 19.2 audit, M2)", () => {
    const read = readBrowserServiceEndpoint({ ...valid, BROWSER_SERVICE_URL: "http://browser-service:3200" });
    expect(read.state).toBe("invalid");
    if (read.state !== "invalid") return;
    expect(read.reason).toBe("BROWSER_SERVICE_URL must use https");
  });

  it("refuses an endpoint without the API's client certificate", () => {
    const { BROWSER_SERVICE_CLIENT_CERT_PATH: _cert, BROWSER_SERVICE_CLIENT_KEY_PATH: _key, ...bare } = valid;
    const read = readBrowserServiceEndpoint(bare);
    expect(read.state).toBe("invalid");
    if (read.state !== "invalid") return;
    expect(read.reason).toContain("mutual TLS");
    expect(readBrowserServiceEndpoint({ ...bare, BROWSER_SERVICE_CLIENT_KEY_PATH: "k.pem" }).state).toBe(
      "invalid"
    );
  });

  it("is invalid — not absent — when the operator asked for it but the configuration is unusable", () => {
    expect(readBrowserServiceEndpoint({ ...valid, BROWSER_SERVICE_URL: "ftp://host" }).state).toBe("invalid");
    expect(
      readBrowserServiceEndpoint({ ...valid, BROWSER_SERVICE_URL: "https://user:pass@host" }).state
    ).toBe("invalid");
    expect(
      readBrowserServiceEndpoint({ ...valid, BROWSER_SERVICE_URL: "https://host/?a=1" }).state
    ).toBe("invalid");
    expect(readBrowserServiceEndpoint({ ...valid, BROWSER_SERVICE_KEY_ID: "" }).state).toBe("invalid");
    expect(readBrowserServiceEndpoint({ ...valid, BROWSER_SERVICE_PEER_IDENTITY: "" }).state).toBe(
      "invalid"
    );
  });

  it("refuses a short secret without echoing it", () => {
    const read = readBrowserServiceEndpoint({ ...valid, BROWSER_SERVICE_SHARED_SECRET: "abc" });
    expect(read.state).toBe("invalid");
    if (read.state !== "invalid") return;
    expect(read.reason).toContain("BROWSER_SERVICE_SHARED_SECRET");
    expect(read.reason).not.toContain("abc");
  });

  it("requires a client certificate and key together", () => {
    const read = readBrowserServiceEndpoint({ ...valid, BROWSER_SERVICE_CLIENT_KEY_PATH: "" });
    expect(read.state).toBe("invalid");
  });

  it("refuses an out-of-range timeout", () => {
    expect(readBrowserServiceEndpoint({ ...valid, BROWSER_SERVICE_TIMEOUT_MS: "5" }).state).toBe(
      "invalid"
    );
  });
});

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

interface Captured {
  request: BrowserServiceTransportRequest;
  body: Record<string, unknown>;
}

function capturingTransport(
  responder: (body: Record<string, unknown>, call: number) => BrowserServiceTransportResponse | Promise<BrowserServiceTransportResponse>
): { transport: BrowserServiceTransport; captured: Captured[] } {
  const captured: Captured[] = [];
  const transport: BrowserServiceTransport = async (request) => {
    const body = JSON.parse(Buffer.from(request.body).toString("utf8")) as Record<string, unknown>;
    captured.push({ request, body });
    return responder(body, captured.length);
  };
  return { transport, captured };
}

function okResponse(body: Record<string, unknown>, result: unknown): BrowserServiceTransportResponse {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify(successEnvelope(String(body.requestId), result)),
    tooLarge: false,
  };
}

describe("BrowserServiceClient", () => {
  it("signs every request over its exact bytes and path", async () => {
    const { transport, captured } = capturingTransport((body) =>
      okResponse(body, { sessionId: SESSION_ID, expiresAt: NOW + 60_000, ttlMs: 60_000 })
    );
    const client = new BrowserServiceClient({
      config: endpoint(),
      transport,
      now: () => NOW,
      nonce: () => "abcdefghijklmnop",
    });

    const result = await client.execute({
      operation: "session.open",
      subject: { userId: "user-1", organizationId: "org-1" },
    });

    expect(result).toEqual({ sessionId: SESSION_ID, expiresAt: NOW + 60_000, ttlMs: 60_000 });
    expect(captured).toHaveLength(1);
    const { request, body } = captured[0];
    expect(request.url.pathname).toBe("/v1/execute");
    expect(body.operation).toBe("session.open");
    expect(body.subject).toEqual({ userId: "user-1", organizationId: "org-1" });

    // The identity is what the TLS stack proves from the client certificate;
    // the client sends no header that claims one (Stage 19.2 audit, M2).
    expect(Object.keys(request.headers).filter((name) => /identity|peer/i.test(name))).toEqual([]);
    const verification = await verifySignedRequest({
      method: "POST",
      path: "/v1/execute",
      headers: request.headers,
      body: Buffer.from(request.body),
      peerIdentity: PEER,
      keys: [{ keyId: KEY_ID, secret: SECRET, identity: PEER }],
      now: NOW,
      clockSkewMs: 60_000,
      nonces: new ProcessNonceStore(() => NOW),
    });
    expect(verification).toEqual({ ok: true, keyId: KEY_ID, identity: PEER });
    expect(request.tls).toEqual(endpoint().tls);
  });

  it("uses a fresh nonce for each request", async () => {
    const { transport, captured } = capturingTransport((body) => okResponse(body, {}));
    const client = new BrowserServiceClient({ config: endpoint(), transport, now: () => NOW });
    await client.execute({ operation: "session.open", subject: { userId: "u", organizationId: "o" } });
    await client.execute({ operation: "session.open", subject: { userId: "u", organizationId: "o" } });
    const first = captured[0].request.headers[BROWSER_SERVICE_HEADERS.nonce];
    const second = captured[1].request.headers[BROWSER_SERVICE_HEADERS.nonce];
    expect(first).not.toBe(second);
  });

  it("refuses an oversized request before opening a transport", async () => {
    const { transport, captured } = capturingTransport((body) => okResponse(body, {}));
    const client = new BrowserServiceClient({
      config: endpoint(),
      transport,
      maxRequestBytes: 128,
    });
    await expect(
      client.execute({
        operation: "browser.type",
        sessionId: SESSION_ID,
        subject: { userId: "u", organizationId: "o" },
        payload: { url: "https://example.com/", selector: "#field", text: "x".repeat(500) },
      })
    ).rejects.toMatchObject({ code: "TOO_LARGE" });
    expect(captured).toHaveLength(0);
  });

  it("throws the code from a failure response", async () => {
    const { transport } = capturingTransport((body) => ({
      status: 403,
      headers: {},
      body: JSON.stringify(failureEnvelope(String(body.requestId), "CROSS_TENANT_DENIED")),
      tooLarge: false,
    }));
    const client = new BrowserServiceClient({ config: endpoint(), transport, now: () => NOW });
    await expect(
      client.execute({ operation: "session.open", subject: { userId: "u", organizationId: "o" } })
    ).rejects.toMatchObject({ code: "CROSS_TENANT_DENIED" });
  });

  it("maps a transport failure to UNAVAILABLE without carrying its message", async () => {
    const transport: BrowserServiceTransport = async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.5:3200 (cert=/etc/secret.pem)");
    };
    const client = new BrowserServiceClient({ config: endpoint(), transport, now: () => NOW });
    const error = await client
      .execute({ operation: "session.open", subject: { userId: "u", organizationId: "o" } })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BrowserServiceError);
    expect((error as BrowserServiceError).code).toBe("UNAVAILABLE");
    expect((error as Error).message).toBe("The browser service is not available.");
    expect((error as Error).message).not.toContain("secret");
  });

  it("gives up at its own deadline", async () => {
    const transport: BrowserServiceTransport = (request) =>
      new Promise((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const client = new BrowserServiceClient({
      config: endpoint({ timeoutMs: 20 }),
      transport,
      now: () => NOW,
    });
    await expect(
      client.execute({ operation: "session.open", subject: { userId: "u", organizationId: "o" } })
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("refuses an oversized response, whether flagged or merely huge", async () => {
    const flagged: BrowserServiceTransport = async () => ({
      status: 200,
      headers: {},
      body: "",
      tooLarge: true,
    });
    const client = new BrowserServiceClient({ config: endpoint(), transport: flagged, now: () => NOW });
    await expect(
      client.execute({ operation: "session.open", subject: { userId: "u", organizationId: "o" } })
    ).rejects.toMatchObject({ code: "TOO_LARGE" });

    const huge: BrowserServiceTransport = async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify(successEnvelope(REQUEST_ID, { text: "x".repeat(4_096) })),
      tooLarge: false,
    });
    const small = new BrowserServiceClient({
      config: endpoint(),
      transport: huge,
      now: () => NOW,
      maxResponseBytes: 1_024,
    });
    await expect(
      small.execute({ operation: "session.open", subject: { userId: "u", organizationId: "o" } })
    ).rejects.toMatchObject({ code: "TOO_LARGE" });
  });

  it("refuses a malformed or non-JSON response", async () => {
    const malformed: BrowserServiceTransport = async () => ({
      status: 200,
      headers: {},
      body: '{"ok":true}',
      tooLarge: false,
    });
    const client = new BrowserServiceClient({ config: endpoint(), transport: malformed, now: () => NOW });
    await expect(
      client.execute({ operation: "session.open", subject: { userId: "u", organizationId: "o" } })
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });

    const html: BrowserServiceTransport = async () => ({
      status: 503,
      headers: {},
      body: "<html>down</html>",
      tooLarge: false,
    });
    const unavailable = new BrowserServiceClient({ config: endpoint(), transport: html, now: () => NOW });
    await expect(
      unavailable.execute({ operation: "session.open", subject: { userId: "u", organizationId: "o" } })
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("refuses to be constructed with a short secret", () => {
    expect(() => new BrowserServiceClient({ config: endpoint({ secret: "short" }) })).toThrow(
      /BROWSER_SERVICE_SHARED_SECRET/
    );
  });
});

// ---------------------------------------------------------------------------
// Remote runtime
// ---------------------------------------------------------------------------

const PAGE = { url: "https://example.com/", title: "Example", status: 200 };

function navigateResult() {
  return { action: "browser.navigate", ok: true, page: PAGE, redirected: false };
}

function inspectResult() {
  return { action: "browser.inspect", ok: true, page: PAGE, elements: [], truncated: false };
}

function clickResult() {
  return { action: "browser.click", ok: true, page: PAGE, selector: "#go", navigated: false };
}

describe("RemoteBrowserRuntime", () => {
  function runtime(
    transport: BrowserServiceTransport,
    tenant: { ok: true; organizationId: string } | { ok: false } = { ok: true, organizationId: "org-1" }
  ) {
    const client = new BrowserServiceClient({ config: endpoint(), transport, now: () => NOW });
    return new RemoteBrowserRuntime({ client, tenant: { resolveSessionOrganization: async () => tenant } });
  }

  it("opens, acts on the session it opened, and closes it", async () => {
    const { transport, captured } = capturingTransport((body) => {
      if (body.operation === "session.open") {
        return okResponse(body, { sessionId: SESSION_ID, expiresAt: NOW + 60_000, ttlMs: 60_000 });
      }
      if (body.operation === "session.close") return okResponse(body, { closed: true });
      if (body.operation === "browser.navigate") return okResponse(body, navigateResult());
      if (body.operation === "browser.inspect") return okResponse(body, inspectResult());
      if (body.operation === "browser.click") return okResponse(body, clickResult());
      throw new Error(`unexpected operation ${String(body.operation)}`);
    });

    const result = await runtime(transport).withSession("user-1", async (session) => {
      const navigated = await session.navigate("https://example.com/");
      const inspected = await session.inspect();
      const clicked = await session.click("#go");
      return { navigated, inspected, clicked };
    });

    expect(result.navigated).toEqual({ ...PAGE, redirected: false });
    expect(result.inspected).toEqual({ ...PAGE, elements: [], truncated: false });
    expect(result.clicked).toEqual({ ...PAGE, selector: "#go", navigated: false });

    expect(captured.map((entry) => entry.body.operation)).toEqual([
      "session.open",
      "browser.navigate",
      "browser.inspect",
      "browser.click",
      "session.close",
    ]);
    for (const entry of captured.slice(1)) {
      expect(entry.body.sessionId).toBe(SESSION_ID);
      expect(entry.body.subject).toEqual({ userId: "user-1", organizationId: "org-1" });
    }
    // Later actions carry the page the tool navigated to, because the Phase
    // 19.1 request shape names a page on every action.
    expect((captured[2].body.payload as Record<string, unknown>).url).toBe(PAGE.url);
  });

  it("refuses before any call when the server-side tenant read says no", async () => {
    const { transport, captured } = capturingTransport((body) => okResponse(body, {}));
    await expect(
      runtime(transport, { ok: false }).withSession("user-1", async () => "never")
    ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    expect(captured).toHaveLength(0);
  });

  it("refuses before any call when the tenant read fails", async () => {
    const { transport, captured } = capturingTransport((body) => okResponse(body, {}));
    const client = new BrowserServiceClient({ config: endpoint(), transport, now: () => NOW });
    const remote = new RemoteBrowserRuntime({
      client,
      tenant: {
        resolveSessionOrganization: async () => {
          throw new Error("database is down");
        },
      },
    });
    await expect(remote.withSession("user-1", async () => "never")).rejects.toMatchObject({
      code: "NOT_AUTHORIZED",
    });
    expect(captured).toHaveLength(0);
  });

  it("closes the session when the work throws", async () => {
    const { transport, captured } = capturingTransport((body) => {
      if (body.operation === "session.open") {
        return okResponse(body, { sessionId: SESSION_ID, expiresAt: NOW + 60_000, ttlMs: 60_000 });
      }
      return okResponse(body, { closed: true });
    });
    await expect(
      runtime(transport).withSession("user-1", async () => {
        throw new Error("tool failed");
      })
    ).rejects.toThrow("tool failed");
    expect(captured.map((entry) => entry.body.operation)).toEqual(["session.open", "session.close"]);
  });

  it("refuses a result that does not match the action's contract", async () => {
    const { transport } = capturingTransport((body) => {
      if (body.operation === "session.open") {
        return okResponse(body, { sessionId: SESSION_ID, expiresAt: NOW + 60_000, ttlMs: 60_000 });
      }
      if (body.operation === "session.close") return okResponse(body, { closed: true });
      return okResponse(body, clickResult());
    });
    await expect(
      runtime(transport).withSession("user-1", async (session) => {
        await session.navigate("https://example.com/");
        await session.inspect();
      })
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });

  it("refuses an action before the session has a page", async () => {
    const { transport, captured } = capturingTransport((body) => {
      if (body.operation === "session.open") {
        return okResponse(body, { sessionId: SESSION_ID, expiresAt: NOW + 60_000, ttlMs: 60_000 });
      }
      return okResponse(body, { closed: true });
    });
    await expect(
      runtime(transport).withSession("user-1", async (session) => session.inspect())
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    expect(captured.map((entry) => entry.body.operation)).toEqual(["session.open", "session.close"]);
  });

  it("bounds a request at the protocol body ceiling", () => {
    expect(BROWSER_PROTOCOL_MAX_BODY_BYTES).toBeLessThanOrEqual(64 * 1024);
  });
});
