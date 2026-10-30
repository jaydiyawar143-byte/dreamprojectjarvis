// ---------------------------------------------------------------------------
// Phase 19, Stage 19.2 — the browser service itself.
//
// A REAL mutual-TLS server on 127.0.0.1 with a REAL signed client over the
// real `node:https` transport. The certificates are made for the run by
// `helpers/test-tls.ts`. The engine is a fake, so no browser starts and no
// external site is reached; everything else — the handshake, the certificate
// identity, the signature check, the nonce store, the session registry, the
// result contract — is the code that would run in production.
//
// The fake engine also makes the important negative assertions possible: a
// cross-Organization request is refused BEFORE the session is touched, a
// disabled engine never opens a context, and a provider error's own words
// never reach a response or a log.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { rmSync, readFileSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";

import {
  BROWSER_SERVICE_HEADERS,
  BrowserServiceClient,
  BrowserServiceError,
  ProcessNonceStore,
  computeBodySha256,
  computeRequestSignature,
  type SignedRequestParts,
} from "@jarvis/browser-protocol";
import type { BrowserRuntimePort, BrowserSessionPort } from "@jarvis/core";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { loadBrowserServiceConfig, type BrowserServiceConfig } from "../src/config.js";
import { DisabledBrowserEngine, sandboxedChromiumLaunchOptions } from "../src/engine.js";
import { BrowserSessionRegistry } from "../src/session-registry.js";
import { createBrowserServiceHealthServer, createBrowserServiceServer } from "../src/server.js";
import { createTestTls } from "./helpers/test-tls.js";

const NOW = 1_700_000_000_000;
const SECRET = "0123456789abcdef0123456789abcdef";
const KEY_ID = "api-key-1";
const PEER = "jarvis-api";
const USER = "user-1";
const ORG = "org-1";
const SUBJECT = { userId: USER, organizationId: ORG };

const TLS = createTestTls(PEER);
afterAll(() => rmSync(TLS.dir, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function testConfig(overrides: Partial<BrowserServiceConfig> = {}): BrowserServiceConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    healthPort: 0,
    keyId: KEY_ID,
    secret: SECRET,
    peerIdentity: PEER,
    tls: { certPath: TLS.serverCertPath, keyPath: TLS.serverKeyPath, caPath: TLS.caPath },
    healthToken: null,
    clockSkewMs: 60_000,
    sessionTtlMs: 60_000,
    maxSessions: 4,
    maxSessionsPerOrganization: 4,
    requestTimeoutMs: 4_000,
    maxBodyBytes: 64 * 1024,
    chromiumEnabled: false,
    egressProxy: null,
    chromium: {
      headless: true,
      maxConcurrentSessions: 4,
      navigationTimeoutMs: 5_000,
      downloadDir: "unused",
      domainAllowlist: [],
      artifacts: {
        retentionHours: null,
        quotaBytesPerUser: 100 * 1024 * 1024,
        quotaBytesPerOrganization: 500 * 1024 * 1024,
        maxCountPerUser: 200,
        maxCountPerOrganization: 1_000,
        sweepIntervalMs: 600_000,
      },
    },
    ...overrides,
  };
}

interface FakeCalls {
  opened: number;
  closed: number;
  navigated: string[];
  clicked: string[];
  inspected: number;
  /** Phase 19.4: the Organization each session was opened for. */
  organizations: Array<string | undefined>;
}

function fakeEngine(overrides: Partial<BrowserSessionPort> = {}): {
  engine: BrowserRuntimePort;
  calls: FakeCalls;
} {
  const calls: FakeCalls = { opened: 0, closed: 0, navigated: [], clicked: [], inspected: 0, organizations: [] };
  const page = { url: "https://example.com/", title: "Example", status: 200 };
  const session: BrowserSessionPort = {
    navigate: async (url) => {
      calls.navigated.push(url);
      return { url, title: "Example", status: 200, redirected: false };
    },
    inspect: async () => {
      calls.inspected += 1;
      return { ...page, elements: [], truncated: false };
    },
    extract: async () => ({ ...page, text: "hello", fields: {}, truncated: false }),
    screenshot: async () => ({
      ...page,
      screenshotId: "44444444-4444-4444-8444-444444444444",
      byteSize: 128,
      format: "png",
    }),
    click: async (selector) => {
      calls.clicked.push(selector);
      return { ...page, selector, navigated: false };
    },
    type: async (selector) => ({ ...page, selector, navigated: false }),
    select: async (selector) => ({ ...page, selector, navigated: false }),
    submit: async (selector) => ({ ...page, selector, navigated: true }),
    download: async () => ({
      downloadId: "dl-1",
      fileName: "report.pdf",
      byteSize: 10,
      mimeType: "application/pdf",
      sourceOrigin: "https://example.com",
    }),
    upload: async (selector, downloadId) => ({
      ...page,
      selector,
      downloadId,
      fileName: "report.pdf",
    }),
    ...overrides,
  };

  const engine: BrowserRuntimePort = {
    withSession: async (_userId, run, options) => {
      calls.opened += 1;
      calls.organizations.push(options?.organizationId);
      try {
        return await run(session);
      } finally {
        calls.closed += 1;
      }
    },
    shutdown: async () => undefined,
  };
  return { engine, calls };
}

interface Service {
  config: BrowserServiceConfig;
  registry: BrowserSessionRegistry;
  server: Server;
  baseUrl: string;
  logs: Array<{ event: string; fields?: Record<string, string | number | boolean> }>;
  close(): Promise<void>;
}

const running: Service[] = [];

async function startService(
  engine: BrowserRuntimePort,
  overrides: Partial<BrowserServiceConfig> = {},
  clock: () => number = () => NOW
): Promise<Service> {
  const config = testConfig(overrides);
  const registry = new BrowserSessionRegistry(engine, {
    sessionTtlMs: config.sessionTtlMs,
    maxSessions: config.maxSessions,
    maxSessionsPerOrganization: config.maxSessionsPerOrganization,
    openTimeoutMs: config.requestTimeoutMs,
    now: clock,
  });
  const logs: Service["logs"] = [];
  const server = createBrowserServiceServer({
    config,
    registry,
    nonces: new ProcessNonceStore(clock),
    chromiumEnabled: config.chromiumEnabled,
    now: clock,
    log: (event, fields) => logs.push({ event, fields }),
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const service: Service = {
    config,
    registry,
    server,
    baseUrl: `https://127.0.0.1:${address.port}`,
    logs,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await registry.shutdown();
    },
  };
  running.push(service);
  return service;
}

const healthServers: Server[] = [];

async function startHealth(
  overrides: Partial<BrowserServiceConfig> = {}
): Promise<{ baseUrl: string; server: Server }> {
  const config = testConfig(overrides);
  const server = createBrowserServiceHealthServer({ config, chromiumEnabled: config.chromiumEnabled });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  healthServers.push(server);
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

afterEach(async () => {
  while (running.length > 0) {
    const service = running.pop();
    if (service) await service.close();
  }
  while (healthServers.length > 0) {
    const server = healthServers.pop();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

const API_TLS = { certPath: TLS.clientCertPath, keyPath: TLS.clientKeyPath, caPath: TLS.caPath };

function clientFor(
  service: Service,
  clock: () => number = () => NOW,
  overrides: { baseUrl?: string; timeoutMs?: number; tls?: typeof API_TLS | null } = {}
): BrowserServiceClient {
  return new BrowserServiceClient({
    config: {
      baseUrl: overrides.baseUrl ?? service.baseUrl,
      keyId: KEY_ID,
      secret: SECRET,
      peerIdentity: PEER,
      timeoutMs: overrides.timeoutMs ?? 3_000,
      tls: overrides.tls === undefined ? API_TLS : overrides.tls,
    },
    now: clock,
    nonce: () => randomUUID().replace(/-/g, ""),
  });
}

function tick(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RawResponse {
  status: number;
  body: string;
  json: unknown;
}

/** Which certificate a raw request presents. `none` presents no certificate at all. */
type Presenting = "api" | "other" | "stranger" | "none";

function clientCertificate(presenting: Presenting): { cert?: Buffer; key?: Buffer } {
  switch (presenting) {
    case "api":
      return { cert: readFileSync(TLS.clientCertPath), key: readFileSync(TLS.clientKeyPath) };
    case "other":
      return { cert: readFileSync(TLS.otherClientCertPath), key: readFileSync(TLS.otherClientKeyPath) };
    case "stranger":
      return { cert: readFileSync(TLS.strangerCertPath), key: readFileSync(TLS.strangerKeyPath) };
    case "none":
      return {};
  }
}

function collect(
  resolve: (value: RawResponse) => void,
  reject: (error: unknown) => void
): (response: IncomingMessage) => void {
  return (response) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let json: unknown = null;
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        json = null;
      }
      resolve({ status: response.statusCode ?? 0, body: text, json });
    });
    response.on("error", reject);
  };
}

function sendRaw(
  service: Service,
  body: string,
  headers: Record<string, string>,
  options: { method?: string; path?: string; presenting?: Presenting } = {}
): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const request = httpsRequest(
      new URL(options.path ?? "/v1/execute", service.baseUrl),
      {
        method: options.method ?? "POST",
        headers: { "content-type": "application/json", ...headers },
        ca: readFileSync(TLS.caPath),
        ...clientCertificate(options.presenting ?? "api"),
      },
      collect(resolve, reject)
    );
    request.on("error", reject);
    request.end(body);
  });
}

/** A plain-HTTP request, for the loopback health listener and for refusals. */
function sendPlain(
  baseUrl: string,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const request = httpRequest(
      new URL(options.path ?? "/healthz", baseUrl),
      { method: options.method ?? "GET", headers: options.headers ?? {} },
      collect(resolve, reject)
    );
    request.on("error", reject);
    request.end(options.body ?? "");
  });
}

function signedHeaders(
  body: string,
  overrides: { timestamp?: string; nonce?: string; secret?: string; keyId?: string } = {}
): Record<string, string> {
  const timestamp = overrides.timestamp ?? String(NOW);
  const nonce = overrides.nonce ?? randomUUID().replace(/-/g, "");
  const parts: SignedRequestParts = {
    method: "POST",
    path: "/v1/execute",
    timestamp,
    nonce,
    keyId: overrides.keyId ?? KEY_ID,
    bodySha256: computeBodySha256(Buffer.from(body)),
    peerIdentity: PEER,
  };
  return {
    [BROWSER_SERVICE_HEADERS.keyId]: parts.keyId,
    [BROWSER_SERVICE_HEADERS.timestamp]: parts.timestamp,
    [BROWSER_SERVICE_HEADERS.nonce]: parts.nonce,
    [BROWSER_SERVICE_HEADERS.bodySha256]: parts.bodySha256,
    [BROWSER_SERVICE_HEADERS.signature]: computeRequestSignature(
      overrides.secret ?? SECRET,
      parts
    ),
  };
}

// ---------------------------------------------------------------------------
// Configuration: fail closed, and name the field, never the value
// ---------------------------------------------------------------------------

describe("loadBrowserServiceConfig", () => {
  const base = {
    BROWSER_SERVICE_KEY_ID: KEY_ID,
    BROWSER_SERVICE_SHARED_SECRET: SECRET,
    BROWSER_SERVICE_PEER_IDENTITY: PEER,
    BROWSER_SERVICE_TLS_CERT_PATH: "cert.pem",
    BROWSER_SERVICE_TLS_KEY_PATH: "key.pem",
    BROWSER_SERVICE_TLS_CA_PATH: "ca.pem",
  };

  it("refuses to start without a key, a secret or a peer identity", () => {
    expect(() => loadBrowserServiceConfig({})).toThrow(/BROWSER_SERVICE_KEY_ID/);
    expect(() =>
      loadBrowserServiceConfig({ ...base, BROWSER_SERVICE_SHARED_SECRET: "" })
    ).toThrow(/BROWSER_SERVICE_SHARED_SECRET/);
    expect(() => loadBrowserServiceConfig({ ...base, BROWSER_SERVICE_PEER_IDENTITY: "" })).toThrow(
      /BROWSER_SERVICE_PEER_IDENTITY/
    );
  });

  it("refuses a short secret without quoting it", () => {
    let message = "";
    try {
      loadBrowserServiceConfig({ ...base, BROWSER_SERVICE_SHARED_SECRET: "abc" });
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toContain("BROWSER_SERVICE_SHARED_SECRET");
    expect(message).not.toContain("abc");
  });

  it("requires every piece of mutual TLS material", () => {
    for (const name of [
      "BROWSER_SERVICE_TLS_CERT_PATH",
      "BROWSER_SERVICE_TLS_KEY_PATH",
      "BROWSER_SERVICE_TLS_CA_PATH",
    ] as const) {
      expect(() => loadBrowserServiceConfig({ ...base, [name]: "" })).toThrow(new RegExp(name));
    }
  });

  it("refuses to switch mutual TLS off — there is no plain-HTTP mode (Stage 19.2 audit, M2)", () => {
    for (const value of ["false", "0", "no", "off"]) {
      expect(() => loadBrowserServiceConfig({ ...base, BROWSER_SERVICE_REQUIRE_MTLS: value })).toThrow(
        /BROWSER_SERVICE_REQUIRE_MTLS can only be true/
      );
    }
    // Stating the only mode is harmless.
    expect(loadBrowserServiceConfig({ ...base, BROWSER_SERVICE_REQUIRE_MTLS: "true" }).tls).toEqual(
      { certPath: "cert.pem", keyPath: "key.pem", caPath: "ca.pem" }
    );
  });

  it("refuses the forwarded-identity mode, with or without TLS material (Stage 19.2 audit, M2)", () => {
    expect(() =>
      loadBrowserServiceConfig({ ...base, BROWSER_SERVICE_TRUST_FORWARDED_PEER_IDENTITY: "true" })
    ).toThrow(/BROWSER_SERVICE_TRUST_FORWARDED_PEER_IDENTITY is not supported/);
    // The old insecure combination: no certificate, identity from a header.
    expect(() =>
      loadBrowserServiceConfig({
        BROWSER_SERVICE_KEY_ID: KEY_ID,
        BROWSER_SERVICE_SHARED_SECRET: SECRET,
        BROWSER_SERVICE_PEER_IDENTITY: PEER,
        BROWSER_SERVICE_REQUIRE_MTLS: "false",
        BROWSER_SERVICE_TRUST_FORWARDED_PEER_IDENTITY: "true",
      })
    ).toThrow();
    expect(() =>
      loadBrowserServiceConfig({ ...base, BROWSER_SERVICE_TRUST_FORWARDED_PEER_IDENTITY: "false" })
    ).not.toThrow();
  });

  it("is Chromium-off by default and starts no browser", () => {
    const config = loadBrowserServiceConfig(base);
    expect(config.chromiumEnabled).toBe(false);
    // Reachable from another container only when the deployment says so.
    expect(config.host).toBe("127.0.0.1");
    expect(config.tls).toEqual({ certPath: "cert.pem", keyPath: "key.pem", caPath: "ca.pem" });
    // Neither insecure switch survives into the configuration at all.
    expect(Object.keys(config)).not.toContain("requireMutualTls");
    expect(Object.keys(config)).not.toContain("trustForwardedPeerIdentity");
  });

  it("refuses to start Chromium without an egress proxy — there is no unproxied mode (Phase 19.3)", () => {
    expect(() => loadBrowserServiceConfig({ ...base, BROWSER_SERVICE_CHROMIUM_ENABLED: "true" })).toThrow(
      /BROWSER_SERVICE_EGRESS_PROXY_URL is required/
    );
    const config = loadBrowserServiceConfig({
      ...base,
      BROWSER_SERVICE_CHROMIUM_ENABLED: "true",
      BROWSER_SERVICE_EGRESS_PROXY_URL: "http://browser-egress:3128",
      // Phase 19.4: Chromium also needs its durable artifact store.
      BROWSER_SERVICE_DOWNLOAD_DIR: "/var/lib/jarvis-browser/artifacts",
      BROWSER_ARTIFACT_RETENTION_HOURS: "24",
    });
    expect(config.egressProxy).toEqual({ url: "http://browser-egress:3128", host: "browser-egress", port: 3128 });
    // Chromium off needs no proxy.
    expect(loadBrowserServiceConfig(base).egressProxy).toBeNull();
  });

  it("refuses an egress proxy URL it could not hand Chromium exactly", () => {
    for (const url of [
      "https://browser-egress:3128",
      "http://user:pw@browser-egress:3128",
      "http://browser-egress:3128/path",
      "http://browser-egress:3128/?q=1",
      "http://[::1]:3128",
      "socks5://browser-egress:1080",
      "not a url",
    ]) {
      expect(() => loadBrowserServiceConfig({ ...base, BROWSER_SERVICE_EGRESS_PROXY_URL: url }), url).toThrow(
        /BROWSER_SERVICE_EGRESS_PROXY_URL must be/
      );
    }
  });

  it("refuses Chromium without a durable artifact directory and a retention (Phase 19.4)", () => {
    const chromium = {
      ...base,
      BROWSER_SERVICE_CHROMIUM_ENABLED: "true",
      BROWSER_SERVICE_EGRESS_PROXY_URL: "http://browser-egress:3128",
    };
    expect(() => loadBrowserServiceConfig({ ...chromium, BROWSER_ARTIFACT_RETENTION_HOURS: "24" })).toThrow(
      /BROWSER_SERVICE_DOWNLOAD_DIR is required/
    );
    expect(() =>
      loadBrowserServiceConfig({ ...chromium, BROWSER_SERVICE_DOWNLOAD_DIR: "/var/lib/jarvis-browser/artifacts" })
    ).toThrow(/BROWSER_ARTIFACT_RETENTION_HOURS is required/);
    expect(() =>
      loadBrowserServiceConfig({ ...chromium, BROWSER_SERVICE_DOWNLOAD_DIR: "relative/dir", BROWSER_ARTIFACT_RETENTION_HOURS: "24" })
    ).toThrow(/must be an absolute path/);

    const config = loadBrowserServiceConfig({
      ...chromium,
      BROWSER_SERVICE_DOWNLOAD_DIR: "/var/lib/jarvis-browser/artifacts",
      BROWSER_ARTIFACT_RETENTION_HOURS: "72",
      BROWSER_ARTIFACT_QUOTA_BYTES_PER_USER: "1048576",
    });
    expect(config.chromium.downloadDir).toBe("/var/lib/jarvis-browser/artifacts");
    expect(config.chromium.artifacts).toMatchObject({ retentionHours: 72, quotaBytesPerUser: 1_048_576, maxCountPerUser: 200 });
    // With Chromium off, nothing is stored and nothing is required.
    expect(loadBrowserServiceConfig(base).chromium.artifacts.retentionHours).toBeNull();
  });

  it("refuses artifact limits out of range, naming the field", () => {
    for (const [name, value] of [
      ["BROWSER_ARTIFACT_RETENTION_HOURS", "0"],
      ["BROWSER_ARTIFACT_RETENTION_HOURS", "9999"],
      ["BROWSER_ARTIFACT_QUOTA_BYTES_PER_USER", "0"],
      ["BROWSER_ARTIFACT_QUOTA_BYTES_PER_ORGANIZATION", "-5"],
      ["BROWSER_ARTIFACT_MAX_COUNT_PER_USER", "abc"],
      ["BROWSER_ARTIFACT_SWEEP_INTERVAL_MS", "10"],
    ]) {
      expect(() => loadBrowserServiceConfig({ ...base, [name!]: value }), name).toThrow(new RegExp(name!));
    }
  });

  it("gives the loopback health listener its own port", () => {
    expect(loadBrowserServiceConfig(base).healthPort).toBe(3201);
    expect(loadBrowserServiceConfig({ ...base, BROWSER_SERVICE_HEALTH_PORT: "4000" }).healthPort).toBe(4000);
    expect(() =>
      loadBrowserServiceConfig({ ...base, BROWSER_SERVICE_PORT: "3300", BROWSER_SERVICE_HEALTH_PORT: "3300" })
    ).toThrow(/BROWSER_SERVICE_HEALTH_PORT must differ/);
  });

  it("bounds every limit it accepts", () => {
    expect(() =>
      loadBrowserServiceConfig({ ...base, BROWSER_SERVICE_SESSION_TTL_MS: "0" })
    ).toThrow(/BROWSER_SERVICE_SESSION_TTL_MS/);
    expect(() =>
      loadBrowserServiceConfig({ ...base, BROWSER_SERVICE_MAX_SESSIONS: "99" })
    ).toThrow(/BROWSER_SERVICE_MAX_SESSIONS/);
    expect(() =>
      loadBrowserServiceConfig({ ...base, BROWSER_SERVICE_MAX_BODY_BYTES: "999999999" })
    ).toThrow(/BROWSER_SERVICE_MAX_BODY_BYTES/);
  });

});

// ---------------------------------------------------------------------------
// The disabled engine
// ---------------------------------------------------------------------------

describe("DisabledBrowserEngine", () => {
  it("refuses every session and starts nothing", async () => {
    const engine = new DisabledBrowserEngine();
    await expect(engine.withSession(USER, async () => "never")).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    await expect(engine.shutdown()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Health and routing
// ---------------------------------------------------------------------------

describe("browser service routing", () => {
  it("answers a fixed liveness body and nothing else", async () => {
    const service = await startService(fakeEngine().engine);
    const response = await sendRaw(service, "", {}, { method: "GET", path: "/healthz" });
    expect(response.status).toBe(200);
    expect(response.json).toEqual({
      status: "ok",
      service: "jarvis-browser",
      version: "jarvis-browser/1",
      chromium: "disabled",
    });
    expect(response.body).not.toContain(SECRET);
  });

  it("hides liveness behind its token when one is configured", async () => {
    const service = await startService(fakeEngine().engine, { healthToken: "health-token" });
    expect((await sendRaw(service, "", {}, { method: "GET", path: "/healthz" })).status).toBe(404);
    expect(
      (
        await sendRaw(service, "", { [BROWSER_SERVICE_HEADERS.healthToken]: "health-token" }, {
          method: "GET",
          path: "/healthz",
        })
      ).status
    ).toBe(200);
  });

  it("has no other route", async () => {
    const service = await startService(fakeEngine().engine);
    expect((await sendRaw(service, "", {}, { method: "GET", path: "/v1/browser" })).status).toBe(404);
    expect((await sendRaw(service, "", {}, { method: "GET", path: "/v1/execute" })).status).toBe(405);
  });

  it("answers liveness on the service port only to a peer with a valid client certificate", async () => {
    const service = await startService(fakeEngine().engine);
    expect((await sendRaw(service, "", {}, { method: "GET", path: "/healthz", presenting: "api" })).status).toBe(200);
    for (const presenting of ["none", "stranger"] as const) {
      const refused = await sendRaw(service, "", {}, { method: "GET", path: "/healthz", presenting }).then(
        () => "answered",
        () => "refused"
      );
      expect(refused, presenting).toBe("refused");
    }
  });
});

// ---------------------------------------------------------------------------
// Mutual TLS — the only mode (Stage 19.2 audit, M2)
// ---------------------------------------------------------------------------

describe("browser service mutual TLS", () => {
  function openBody(): string {
    return JSON.stringify({
      version: "jarvis-browser/1",
      requestId: randomUUID(),
      operation: "session.open",
      subject: SUBJECT,
    });
  }

  it("refuses the handshake without a certificate, or with one from another CA — before any route", async () => {
    const fake = fakeEngine();
    const service = await startService(fake.engine);
    for (const presenting of ["none", "stranger"] as const) {
      const body = openBody();
      const outcome = await sendRaw(service, body, signedHeaders(body), { presenting }).then(
        () => "answered",
        () => "refused"
      );
      expect(outcome, presenting).toBe("refused");
    }
    expect(fake.calls.opened).toBe(0);
  });

  it("refuses plain HTTP on the service port", async () => {
    const fake = fakeEngine();
    const service = await startService(fake.engine);
    const body = openBody();
    const outcome = await sendPlain(service.baseUrl.replace("https:", "http:"), {
      method: "POST",
      path: "/v1/execute",
      headers: { "content-type": "application/json", ...signedHeaders(body) },
      body,
    }).then(
      (response) => response.status,
      () => "refused"
    );
    expect(outcome).not.toBe(200);
    expect(fake.calls.opened).toBe(0);
  });

  it("refuses a trusted certificate for another identity, whatever a header claims", async () => {
    const fake = fakeEngine();
    const service = await startService(fake.engine);
    const body = openBody();
    // The old forwarded-identity header, naming the provisioned API. It is not
    // read: the identity is the certificate's, and this one is someone else's.
    const response = await sendRaw(
      service,
      body,
      { ...signedHeaders(body), "x-jarvis-peer-identity": PEER },
      { presenting: "other" }
    );
    expect(response.status).toBe(401);
    expect(response.json).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
    expect(fake.calls.opened).toBe(0);
  });

  it("the API's client refuses to send over plain http or without its certificate", async () => {
    const fake = fakeEngine();
    const service = await startService(fake.engine);
    const plain = clientFor(service, () => NOW, { baseUrl: service.baseUrl.replace("https:", "http:") });
    const bare = clientFor(service, () => NOW, { tls: null });
    for (const client of [plain, bare]) {
      const error = await client
        .execute({ operation: "session.open", subject: SUBJECT })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(BrowserServiceError);
      expect(error).toMatchObject({ outcome: "not-sent", phase: "before-send" });
    }
    expect(fake.calls.opened).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The loopback health listener (Stage 19.2 audit, M1)
// ---------------------------------------------------------------------------

describe("browser service loopback health listener", () => {
  it("answers the same fixed liveness body over plain HTTP on loopback", async () => {
    const health = await startHealth({ chromiumEnabled: false });
    const response = await sendPlain(health.baseUrl);
    expect(response.status).toBe(200);
    expect(response.json).toEqual({
      status: "ok",
      service: "jarvis-browser",
      version: "jarvis-browser/1",
      chromium: "disabled",
    });
  });

  it("has no route to a browser operation", async () => {
    const health = await startHealth();
    const body = JSON.stringify({
      version: "jarvis-browser/1",
      requestId: randomUUID(),
      operation: "session.open",
      subject: SUBJECT,
    });
    const execute = await sendPlain(health.baseUrl, {
      method: "POST",
      path: "/v1/execute",
      headers: { "content-type": "application/json", ...signedHeaders(body) },
      body,
    });
    expect(execute.status).toBe(404);
    expect(execute.body).toBe("");
    for (const path of ["/v1/execute", "/", "/healthz/../v1/execute", "/v1/browser"]) {
      expect((await sendPlain(health.baseUrl, { path })).status, path).toBe(404);
    }
    expect((await sendPlain(health.baseUrl, { method: "POST" })).status).toBe(405);
  });

  it("requires the health token when one is configured", async () => {
    const health = await startHealth({ healthToken: "health-token" });
    expect((await sendPlain(health.baseUrl)).status).toBe(404);
    expect(
      (await sendPlain(health.baseUrl, { headers: { [BROWSER_SERVICE_HEADERS.healthToken]: "wrong-token!" } })).status
    ).toBe(404);
    expect(
      (await sendPlain(health.baseUrl, { headers: { [BROWSER_SERVICE_HEADERS.healthToken]: "health-token" } })).status
    ).toBe(200);
  });

  it("refuses a peer that is not loopback, even if it were bound wider", () => {
    const server = createBrowserServiceHealthServer({ config: { healthToken: null }, chromiumEnabled: false });
    const handler = server.listeners("request")[0] as (request: IncomingMessage, response: ServerResponse) => void;
    const answer = (remoteAddress: string) => {
      let status = 0;
      const response = {
        headersSent: false,
        writeHead(code: number) {
          status = code;
          return this;
        },
        end() {
          return this;
        },
      } as unknown as ServerResponse;
      handler(
        { socket: { remoteAddress }, url: "/healthz", method: "GET", headers: {} } as unknown as IncomingMessage,
        response
      );
      return status;
    };
    expect(answer("10.0.0.5")).toBe(404);
    expect(answer("172.18.0.3")).toBe(404);
    expect(answer("127.0.0.1")).toBe(200);
    expect(answer("::1")).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Chromium's sandbox (Stage 19.2 audit, H1)
// ---------------------------------------------------------------------------

describe("Chromium launch options", () => {
  const EGRESS = { url: "http://browser-egress:3128", host: "browser-egress" };

  it("ask Playwright for the sandbox explicitly, and pass nothing that disables it", () => {
    const options = sandboxedChromiumLaunchOptions({ chromePath: "/usr/bin/chromium", headless: true, egressProxy: EGRESS });
    // Playwright appends --no-sandbox unless this is exactly true.
    expect(options.chromiumSandbox).toBe(true);
    expect(options.executablePath).toBe("/usr/bin/chromium");
    for (const arg of options.args) {
      expect(arg).not.toMatch(/sandbox|zygote/i);
    }
  });

  it("send every connection to the egress proxy, and let Chromium resolve nothing else (Phase 19.3)", () => {
    const options = sandboxedChromiumLaunchOptions({ chromePath: "/usr/bin/chromium", headless: true, egressProxy: EGRESS });
    // Playwright's own option; with no `bypass` it also proxies loopback.
    expect(options.proxy).toEqual({ server: "http://browser-egress:3128" });
    expect(options.args).toContain("--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE browser-egress");
    expect(options.args).toContain("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
    // Nothing that would route around the proxy.
    for (const arg of options.args) {
      expect(arg).not.toMatch(/^--(no-proxy-server|proxy-server|proxy-bypass-list|proxy-auto-detect|proxy-pac-url)/);
    }
  });

  it("refuse a proxy host that could smuggle another rule into the resolver", () => {
    for (const host of ["browser-egress , EXCLUDE *", "evil host", "[::1]", ""]) {
      expect(() =>
        sandboxedChromiumLaunchOptions({ chromePath: "/x", headless: true, egressProxy: { url: "http://x:1", host } })
      ).toThrow(/egress proxy host/);
    }
  });
});

// ---------------------------------------------------------------------------
// What a failed write says it may have done (Stage 19.2 audit, H2)
// ---------------------------------------------------------------------------

describe("browser service write outcomes", () => {
  async function openSession(client: BrowserServiceClient): Promise<string> {
    const opened = (await client.execute({ operation: "session.open", subject: SUBJECT })) as { sessionId: string };
    return opened.sessionId;
  }

  function submit(sessionId: string) {
    return {
      operation: "browser.submit" as const,
      sessionId,
      subject: SUBJECT,
      payload: { url: "https://example.com/", selector: "#send" },
    };
  }

  it("a submit that reached the site before the connection failed is uncertain", async () => {
    let reachedSite = 0;
    let service!: Service;
    const fake = fakeEngine({
      submit: async () => {
        // The action happens; then the connection is lost before any answer.
        reachedSite += 1;
        service.server.closeAllConnections();
        return new Promise(() => undefined);
      },
    });
    service = await startService(fake.engine);
    const client = clientFor(service);
    const sessionId = await openSession(client);

    const error = await client.execute(submit(sessionId)).catch((caught: unknown) => caught);
    expect(reachedSite).toBe(1);
    expect(error).toBeInstanceOf(BrowserServiceError);
    expect(error).toMatchObject({ code: "UNAVAILABLE", outcome: "uncertain", phase: "in-flight", sideEffectPossible: true });
  });

  it("a write the browser failed is UNKNOWN_OUTCOME, never a plain failure — and carries none of its words", async () => {
    const fake = fakeEngine({
      submit: async () => {
        throw new Error("Action failed: SUPER-SECRET https://internal.example/");
      },
    });
    const service = await startService(fake.engine);
    const client = clientFor(service);
    const sessionId = await openSession(client);

    const error = await client.execute(submit(sessionId)).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "UNKNOWN_OUTCOME", outcome: "uncertain", sideEffectPossible: true });
    expect((error as Error).message).not.toContain("SUPER-SECRET");
    expect(JSON.stringify(service.logs)).not.toContain("SUPER-SECRET");
  });

  it("a write cut off by the service's deadline is TIMEOUT, and uncertain", async () => {
    const fake = fakeEngine({
      click: (_selector, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("Browser action aborted")));
        }),
    });
    const service = await startService(fake.engine, { requestTimeoutMs: 80 });
    const client = clientFor(service);
    const sessionId = await openSession(client);
    const error = await client
      .execute({ ...submit(sessionId), operation: "browser.click", payload: { url: "https://example.com/", selector: "#go" } })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "TIMEOUT", outcome: "uncertain" });
  });

  it("a write whose result breaks the contract has run: UNKNOWN_OUTCOME, not PROVIDER_ERROR", async () => {
    const fake = fakeEngine({
      submit: async () => ({ url: "https://example.com/", title: "Example", status: 200 }) as never,
    });
    const service = await startService(fake.engine);
    const client = clientFor(service);
    const sessionId = await openSession(client);
    const error = await client.execute(submit(sessionId)).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "UNKNOWN_OUTCOME", outcome: "uncertain" });
  });

  it("a write refused before it reached the browser stays a known failure", async () => {
    const fake = fakeEngine();
    const service = await startService(fake.engine);
    const client = clientFor(service);
    const sessionId = await openSession(client);

    const otherTenant = await client
      .execute({ ...submit(sessionId), subject: { userId: "intruder", organizationId: "org-2" } })
      .catch((caught: unknown) => caught);
    expect(otherTenant).toMatchObject({ code: "CROSS_TENANT_DENIED", outcome: "no-effect", sideEffectPossible: false });

    const missing = await client.execute(submit(randomUUID())).catch((caught: unknown) => caught);
    expect(missing).toMatchObject({ code: "SESSION_NOT_FOUND", outcome: "no-effect", sideEffectPossible: false });
  });

  it("a read the browser failed stays an ordinary provider failure", async () => {
    const fake = fakeEngine({
      inspect: async () => {
        throw new Error("boom");
      },
    });
    const service = await startService(fake.engine);
    const client = clientFor(service);
    const sessionId = await openSession(client);
    const error = await client
      .execute({ operation: "browser.inspect", sessionId, subject: SUBJECT, payload: { url: "https://example.com/" } })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "PROVIDER_ERROR", outcome: "no-effect" });
  });
});

// ---------------------------------------------------------------------------
// Authentication, replay and size
// ---------------------------------------------------------------------------

describe("browser service authentication", () => {
  it("refuses an unsigned request before any work", async () => {
    const fake = fakeEngine();
    const service = await startService(fake.engine);
    const body = JSON.stringify({
      version: "jarvis-browser/1",
      requestId: randomUUID(),
      operation: "session.open",
      subject: SUBJECT,
    });
    const response = await sendRaw(service, body, {});
    expect(response.status).toBe(401);
    expect(response.json).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    expect(fake.calls.opened).toBe(0);
  });

  it("refuses a wrong secret, an expired request and a replay", async () => {
    const fake = fakeEngine();
    const service = await startService(fake.engine);
    const body = JSON.stringify({
      version: "jarvis-browser/1",
      requestId: randomUUID(),
      operation: "session.open",
      subject: SUBJECT,
    });

    const wrong = await sendRaw(service, body, signedHeaders(body, { secret: "f".repeat(32) }));
    expect(wrong.status).toBe(401);
    expect(wrong.json).toMatchObject({ error: { code: "UNAUTHENTICATED" } });

    const expired = await sendRaw(
      service,
      body,
      signedHeaders(body, { timestamp: String(NOW - 120_000) })
    );
    expect(expired.json).toMatchObject({ error: { code: "REQUEST_EXPIRED" } });

    const headers = signedHeaders(body, { nonce: "abcdefghijklmnopqrstuvwx" });
    const first = await sendRaw(service, body, headers);
    expect(first.status).toBe(200);
    const replay = await sendRaw(service, body, headers);
    expect(replay.status).toBe(401);
    expect(replay.json).toMatchObject({ error: { code: "REPLAY_DETECTED" } });
    expect(fake.calls.opened).toBe(1);
  });

  it("refuses a request body over its ceiling", async () => {
    const fake = fakeEngine();
    const service = await startService(fake.engine, { maxBodyBytes: 1_024 });
    const body = JSON.stringify({
      version: "jarvis-browser/1",
      requestId: randomUUID(),
      operation: "session.open",
      subject: SUBJECT,
      payload: { padding: "x".repeat(4_000) },
    });
    expect(body.length).toBeGreaterThan(1_024);
    const response = await sendRaw(service, body, signedHeaders(body));
    expect(response.status).toBe(413);
    expect(response.json).toMatchObject({ error: { code: "TOO_LARGE" } });
    expect(fake.calls.opened).toBe(0);
  });

  it("refuses an unsupported version and an unknown operation", async () => {
    const service = await startService(fakeEngine().engine);

    const versioned = JSON.stringify({
      version: "jarvis-browser/9",
      requestId: randomUUID(),
      operation: "session.open",
      subject: SUBJECT,
    });
    const versionResponse = await sendRaw(service, versioned, signedHeaders(versioned));
    expect(versionResponse.status).toBe(400);
    expect(versionResponse.json).toMatchObject({ error: { code: "UNSUPPORTED_VERSION" } });

    const unknown = JSON.stringify({
      version: "jarvis-browser/1",
      requestId: randomUUID(),
      operation: "browser.launch",
      sessionId: randomUUID(),
      subject: SUBJECT,
      payload: {},
    });
    const unknownResponse = await sendRaw(service, unknown, signedHeaders(unknown));
    expect(unknownResponse.status).toBe(400);
    expect(unknownResponse.json).toMatchObject({ error: { code: "UNKNOWN_OPERATION" } });
  });
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

describe("browser service sessions", () => {
  it("opens, acts on, and closes one isolated session", async () => {
    const fake = fakeEngine();
    const service = await startService(fake.engine);
    const client = clientFor(service);

    const opened = (await client.execute({ operation: "session.open", subject: SUBJECT })) as {
      sessionId: string;
      ttlMs: number;
    };
    expect(opened.ttlMs).toBe(60_000);
    expect(fake.calls.opened).toBe(1);

    const navigated = await client.execute({
      operation: "browser.navigate",
      sessionId: opened.sessionId,
      subject: SUBJECT,
      payload: { url: "https://example.com/" },
    });
    expect(navigated).toEqual({
      action: "browser.navigate",
      ok: true,
      page: { url: "https://example.com/", title: "Example", status: 200 },
      redirected: false,
    });

    const clicked = await client.execute({
      operation: "browser.click",
      sessionId: opened.sessionId,
      subject: SUBJECT,
      payload: { url: "https://example.com/", selector: "#go" },
    });
    expect(clicked).toMatchObject({ ok: true, selector: "#go", navigated: false });
    expect(fake.calls.clicked).toEqual(["#go"]);

    const closed = await client.execute({
      operation: "session.close",
      sessionId: opened.sessionId,
      subject: SUBJECT,
    });
    expect(closed).toEqual({ closed: true });
    await tick();
    expect(fake.calls.closed).toBe(1);
    expect(service.registry.activeSessions).toBe(0);
  });

  it("opens the engine's session for the Organization the request was bound to (Phase 19.4)", async () => {
    const fake = fakeEngine();
    const service = await startService(fake.engine);
    await clientFor(service).execute({ operation: "session.open", subject: SUBJECT });
    // The browser's artifacts are scoped to this Organization and this user.
    expect(fake.calls.organizations).toEqual([ORG]);
  });

  it("refuses another Organization without touching the session", async () => {
    const fake = fakeEngine();
    const service = await startService(fake.engine);
    const client = clientFor(service);

    const opened = (await client.execute({ operation: "session.open", subject: SUBJECT })) as {
      sessionId: string;
    };

    const denied = await client
      .execute({
        operation: "browser.navigate",
        sessionId: opened.sessionId,
        subject: { userId: "intruder", organizationId: "org-2" },
        payload: { url: "https://example.com/" },
      })
      .catch((error: unknown) => error);
    expect(denied).toMatchObject({ code: "CROSS_TENANT_DENIED" });
    expect(fake.calls.navigated).toEqual([]);
    expect(fake.calls.opened).toBe(1);

    // The rightful owner is unaffected.
    await client.execute({
      operation: "browser.navigate",
      sessionId: opened.sessionId,
      subject: SUBJECT,
      payload: { url: "https://example.com/" },
    });
    expect(fake.calls.navigated).toEqual(["https://example.com/"]);
  });

  it("refuses a close from another Organization", async () => {
    const fake = fakeEngine();
    const service = await startService(fake.engine);
    const client = clientFor(service);
    const opened = (await client.execute({ operation: "session.open", subject: SUBJECT })) as {
      sessionId: string;
    };

    await expect(
      client.execute({
        operation: "session.close",
        sessionId: opened.sessionId,
        subject: { userId: "intruder", organizationId: "org-2" },
      })
    ).rejects.toMatchObject({ code: "CROSS_TENANT_DENIED" });
    expect(service.registry.activeSessions).toBe(1);
  });

  it("ends a session at its TTL, even if nobody closed it", async () => {
    let clock = NOW;
    const fake = fakeEngine();
    const service = await startService(fake.engine, {}, () => clock);
    const client = clientFor(service, () => clock);
    const opened = (await client.execute({ operation: "session.open", subject: SUBJECT })) as {
      sessionId: string;
    };

    clock = NOW + 60_001;
    service.registry.reap();
    await tick();
    expect(fake.calls.closed).toBe(1);

    const late = await client
      .execute({
        operation: "browser.inspect",
        sessionId: opened.sessionId,
        subject: SUBJECT,
        payload: { url: "https://example.com/" },
      })
      .catch((error: unknown) => error);
    expect(late).toMatchObject({ code: "SESSION_NOT_FOUND" });
    expect(fake.calls.inspected).toBe(0);
  });

  it("holds the configured number of sessions, and no more", async () => {
    const service = await startService(fakeEngine().engine, { maxSessions: 1, maxSessionsPerOrganization: 1 });
    const client = clientFor(service);
    await client.execute({ operation: "session.open", subject: SUBJECT });
    await expect(client.execute({ operation: "session.open", subject: SUBJECT })).rejects.toMatchObject({
      code: "LIMIT_EXCEEDED",
    });
  });

  it("gives up on an open that never becomes usable, and leaves nothing behind", async () => {
    const hanging: BrowserRuntimePort = {
      withSession: () => new Promise(() => undefined),
      shutdown: async () => undefined,
    };
    const service = await startService(hanging, { requestTimeoutMs: 60 });
    const client = clientFor(service);
    await expect(client.execute({ operation: "session.open", subject: SUBJECT })).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    expect(service.registry.activeSessions).toBe(0);
  });

  it("refuses every session when Chromium is off", async () => {
    const service = await startService(new DisabledBrowserEngine());
    const client = clientFor(service);
    await expect(client.execute({ operation: "session.open", subject: SUBJECT })).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
  });
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

describe("browser service redaction", () => {
  it("turns a provider's own error into a fixed sentence", async () => {
    const fake = fakeEngine({
      navigate: async () => {
        throw new Error("SUPER-SECRET https://internal.example/path cookie=abc");
      },
    });
    const service = await startService(fake.engine);
    const client = clientFor(service);
    const opened = (await client.execute({ operation: "session.open", subject: SUBJECT })) as {
      sessionId: string;
    };

    const error = await client
      .execute({
        operation: "browser.navigate",
        sessionId: opened.sessionId,
        subject: SUBJECT,
        payload: { url: "https://example.com/" },
      })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "PROVIDER_ERROR" });
    expect((error as Error).message).toBe("The browser could not perform the action.");
    expect((error as Error).message).not.toContain("SUPER-SECRET");

    const logged = JSON.stringify(service.logs);
    expect(logged).not.toContain("SUPER-SECRET");
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(PEER);
  });

  it("never puts the shared secret in a refusal", async () => {
    const service = await startService(fakeEngine().engine);
    const body = JSON.stringify({
      version: "jarvis-browser/1",
      requestId: randomUUID(),
      operation: "session.open",
      subject: SUBJECT,
    });
    const response = await sendRaw(service, body, signedHeaders(body, { secret: "f".repeat(32) }));
    expect(response.body).not.toContain(SECRET);
    expect(response.body).not.toContain("f".repeat(32));
  });
});

// ---------------------------------------------------------------------------
// The registry's own guarantees, without HTTP in the way
// ---------------------------------------------------------------------------

describe("BrowserSessionRegistry", () => {
  function registryFor(engine: BrowserRuntimePort, overrides: Partial<BrowserServiceConfig> = {}) {
    const config = testConfig(overrides);
    return new BrowserSessionRegistry(engine, {
      sessionTtlMs: config.sessionTtlMs,
      maxSessions: config.maxSessions,
      maxSessionsPerOrganization: config.maxSessionsPerOrganization,
      openTimeoutMs: config.requestTimeoutMs,
      now: () => NOW,
    });
  }

  it("refuses a session id that does not exist", async () => {
    const registry = registryFor(fakeEngine().engine);
    await expect(
      registry.execute(
        "99999999-9999-4999-8999-999999999999",
        SUBJECT,
        { action: "browser.inspect", url: "https://example.com/" }
      )
    ).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
  });

  it("closes everything it holds on shutdown", async () => {
    const fake = fakeEngine();
    const registry = registryFor(fake.engine);
    await registry.open(SUBJECT);
    await registry.shutdown();
    expect(registry.activeSessions).toBe(0);
  });
});
