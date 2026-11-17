// ---------------------------------------------------------------------------
// Phase 19, P0 — the API's two start-up checks, against real material.
//
//   1. `checkBrowserServiceClientTls`: the API's own certificate, key and CA,
//      read from disk and parsed — real PEM files from the test CA, broken in
//      each way an operator can break them.
//   2. `probeBrowserService`: the authenticated no-op, sent over a real
//      mutual-TLS socket to the real service server (with a fake engine: no
//      browser starts, and none is needed — the probe opens no session).
//
// Every refusal is checked for what it must never say: a path, a file's
// contents, a key, the secret or the host.
// ---------------------------------------------------------------------------

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { join } from "node:path";

import {
  BROWSER_SERVICE_PROBE_MESSAGES,
  BROWSER_SERVICE_PROBE_SUBJECT,
  ProcessNonceStore,
  checkBrowserServiceClientTls,
  probeBrowserService,
  type BrowserServiceClientTls,
  type BrowserServiceEndpointConfig,
} from "@jarvis/browser-protocol";
import type { BrowserRuntimePort } from "@jarvis/core";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import type { BrowserServiceConfig } from "../src/config.js";
import { BrowserSessionRegistry } from "../src/session-registry.js";
import { createBrowserServiceServer } from "../src/server.js";
import { createTestTls } from "./helpers/test-tls.js";

const PEER = "jarvis-api";
const KEY_ID = "api-key-1";
const SECRET = "0123456789abcdef0123456789abcdef";
const TLS = createTestTls(PEER);
const SCRATCH = join(TLS.dir, "broken");
mkdirSync(SCRATCH, { recursive: true });
afterAll(() => rmSync(TLS.dir, { recursive: true, force: true }));

const GOOD: BrowserServiceClientTls = { certPath: TLS.clientCertPath, keyPath: TLS.clientKeyPath, caPath: TLS.caPath };
const DAY = 86_400_000;

function scratchFile(name: string, contents: string): string {
  const path = join(SCRATCH, name);
  writeFileSync(path, contents);
  return path;
}

/** What no start-up reason may contain. */
function expectNothingLeaked(text: string): void {
  expect(text).not.toContain(TLS.dir);
  expect(text).not.toContain(SCRATCH);
  expect(text).not.toMatch(/BEGIN|PRIVATE KEY|CERTIFICATE-----/);
  expect(text).not.toContain(readFileSync(TLS.clientKeyPath, "utf8").split("\n")[1]!);
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain("127.0.0.1");
}

// ---------------------------------------------------------------------------
// 1. The API's TLS material
// ---------------------------------------------------------------------------

describe("checkBrowserServiceClientTls — the API's own certificate, key and CA", () => {
  it("accepts a readable, matching, in-date pair that names the peer identity, and says when it expires", () => {
    const check = checkBrowserServiceClientTls(GOOD, PEER);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(Date.parse(check.clientCertificateNotAfter)).toBeGreaterThan(Date.now());
  });

  it("checks no CA when none is configured", () => {
    expect(checkBrowserServiceClientTls({ ...GOOD, caPath: null }, PEER).ok).toBe(true);
  });

  const cases: Array<[string, () => BrowserServiceClientTls, string, string, number?]> = [
    ["a certificate path that names nothing", () => ({ ...GOOD, certPath: join(SCRATCH, "missing.crt") }), "unreadable", "BROWSER_SERVICE_CLIENT_CERT_PATH"],
    ["a certificate path that names a directory", () => ({ ...GOOD, certPath: SCRATCH }), "unreadable", "BROWSER_SERVICE_CLIENT_CERT_PATH"],
    ["a key path that names nothing", () => ({ ...GOOD, keyPath: join(SCRATCH, "missing.key") }), "unreadable", "BROWSER_SERVICE_CLIENT_KEY_PATH"],
    ["a CA path that names nothing", () => ({ ...GOOD, caPath: join(SCRATCH, "missing-ca.crt") }), "unreadable", "BROWSER_SERVICE_CA_PATH"],
    ["a certificate file that is not a certificate", () => ({ ...GOOD, certPath: scratchFile("garbage.crt", "not a certificate") }), "invalid", "BROWSER_SERVICE_CLIENT_CERT_PATH"],
    ["a key file that is not a key", () => ({ ...GOOD, keyPath: scratchFile("garbage.key", "not a key either") }), "invalid", "BROWSER_SERVICE_CLIENT_KEY_PATH"],
    ["a key file that holds a certificate", () => ({ ...GOOD, keyPath: TLS.clientCertPath }), "invalid", "BROWSER_SERVICE_CLIENT_KEY_PATH"],
    ["a CA file that is not a certificate", () => ({ ...GOOD, caPath: scratchFile("garbage-ca.crt", "nope") }), "invalid", "BROWSER_SERVICE_CA_PATH"],
    ["a certificate with another certificate's key", () => ({ ...GOOD, keyPath: TLS.otherClientKeyPath }), "mismatched-pair", "BROWSER_SERVICE_CLIENT_KEY_PATH"],
    ["a certificate for another identity", () => ({ ...GOOD, certPath: TLS.otherClientCertPath, keyPath: TLS.otherClientKeyPath }), "wrong-identity", "BROWSER_SERVICE_PEER_IDENTITY"],
    ["an expired certificate", () => GOOD, "expired", "BROWSER_SERVICE_CLIENT_CERT_PATH", Date.now() + 2 * DAY],
    ["a certificate that is not valid yet", () => GOOD, "not-yet-valid", "BROWSER_SERVICE_CLIENT_CERT_PATH", Date.now() - DAY],
  ];

  it.each(cases)("refuses %s, naming the variable and nothing else", (_label, tls, problem, field, now) => {
    const check = checkBrowserServiceClientTls(tls(), PEER, now === undefined ? {} : { now });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.problem).toBe(problem);
    expect(check.reason).toContain(field);
    expectNothingLeaked(check.reason);
  });
});

// ---------------------------------------------------------------------------
// 2. The probe, over a real mutual-TLS socket
// ---------------------------------------------------------------------------

function serviceConfig(): BrowserServiceConfig {
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
        quotaBytesPerUser: 1024,
        quotaBytesPerOrganization: 1024,
        maxCountPerUser: 1,
        maxCountPerOrganization: 1,
        sweepIntervalMs: 600_000,
      },
    },
  };
}

interface Running {
  baseUrl: string;
  sessionsOpened: () => number;
  close(): Promise<void>;
}

const running: Running[] = [];
afterEach(async () => {
  while (running.length > 0) await running.pop()!.close();
});

async function startService(): Promise<Running> {
  let opened = 0;
  const engine: BrowserRuntimePort = {
    withSession: async () => {
      opened += 1;
      throw new Error("the probe must never open a browser session");
    },
    shutdown: async () => undefined,
  };
  const config = serviceConfig();
  const registry = new BrowserSessionRegistry(engine, {
    sessionTtlMs: config.sessionTtlMs,
    maxSessions: config.maxSessions,
    maxSessionsPerOrganization: config.maxSessionsPerOrganization,
    openTimeoutMs: config.requestTimeoutMs,
  });
  const server: Server = createBrowserServiceServer({
    config,
    registry,
    nonces: new ProcessNonceStore(Date.now),
    chromiumEnabled: false,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const service: Running = {
    baseUrl: `https://localhost:${port}`,
    sessionsOpened: () => opened,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await registry.shutdown();
    },
  };
  running.push(service);
  return service;
}

function endpoint(baseUrl: string, overrides: Partial<BrowserServiceEndpointConfig> = {}): BrowserServiceEndpointConfig {
  return { baseUrl, keyId: KEY_ID, secret: SECRET, peerIdentity: PEER, timeoutMs: 3_000, tls: GOOD, ...overrides };
}

/** A loopback port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("probeBrowserService — one authenticated no-op over the real protocol", () => {
  it("is accepted by a service that accepts this API, and opens no browser session", async () => {
    const service = await startService();
    await expect(probeBrowserService(endpoint(service.baseUrl))).resolves.toEqual({ ok: true });
    expect(service.sessionsOpened()).toBe(0);
    // Its subject is no person and no Organization.
    expect(BROWSER_SERVICE_PROBE_SUBJECT.userId).toBe("jarvis-startup-probe");
  });

  it("reports a wrong signing secret as authentication", async () => {
    const service = await startService();
    const result = await probeBrowserService(endpoint(service.baseUrl, { secret: "f".repeat(32) }));
    expect(result).toEqual({ ok: false, reason: "authentication", message: BROWSER_SERVICE_PROBE_MESSAGES.authentication });
  });

  it("reports a wrong key id as authentication", async () => {
    const service = await startService();
    const result = await probeBrowserService(endpoint(service.baseUrl, { keyId: "some-other-key" }));
    expect(result.ok ? null : result.reason).toBe("authentication");
  });

  it("reports a certificate for another identity as authentication", async () => {
    const service = await startService();
    const result = await probeBrowserService(
      endpoint(service.baseUrl, {
        tls: { certPath: TLS.otherClientCertPath, keyPath: TLS.otherClientKeyPath, caPath: TLS.caPath },
      })
    );
    expect(result.ok ? null : result.reason).toBe("authentication");
  });

  it("reports a clock far from the service's as clock skew", async () => {
    const service = await startService();
    const result = await probeBrowserService(endpoint(service.baseUrl), { now: () => Date.now() + 10 * 60_000 });
    expect(result.ok ? null : result.reason).toBe("clock-skew");
  });

  it("reports a CA that did not sign the service's certificate as a TLS handshake failure", async () => {
    const service = await startService();
    const result = await probeBrowserService(endpoint(service.baseUrl, { tls: { ...GOOD, caPath: TLS.strangerCertPath } }));
    expect(result.ok ? null : result.reason).toBe("tls-handshake");
  });

  it("does not get through with a client certificate the service does not trust", async () => {
    const service = await startService();
    const result = await probeBrowserService(
      endpoint(service.baseUrl, { tls: { certPath: TLS.strangerCertPath, keyPath: TLS.strangerKeyPath, caPath: TLS.caPath } })
    );
    expect(result.ok).toBe(false);
    // The service ends the handshake; the client sees an alert or a reset,
    // depending on the TLS version's timing. Either way it never authenticates.
    expect(["tls-handshake", "unreachable"]).toContain(result.ok ? null : result.reason);
  });

  it("reports nothing listening as unreachable", async () => {
    const port = await closedPort();
    const result = await probeBrowserService(endpoint(`https://localhost:${port}`));
    expect(result.ok ? null : result.reason).toBe("unreachable");
  });

  it("reports unreadable client credentials before anything is sent", async () => {
    const service = await startService();
    const result = await probeBrowserService(
      endpoint(service.baseUrl, { tls: { ...GOOD, certPath: join(SCRATCH, "missing.crt") } })
    );
    expect(result.ok ? null : result.reason).toBe("client-credentials-unreadable");
  });

  it("never names a host, a path, a key or the secret in what it reports", async () => {
    const port = await closedPort();
    const outcomes = [
      await probeBrowserService(endpoint(`https://localhost:${port}`)),
      await probeBrowserService(endpoint(`https://localhost:${port}`, { tls: { ...GOOD, certPath: join(SCRATCH, "x") } })),
    ];
    for (const outcome of outcomes) {
      expect(outcome.ok).toBe(false);
      if (outcome.ok) continue;
      expectNothingLeaked(outcome.message);
      expect(outcome.message).not.toContain(String(port));
      expect(outcome.message).not.toContain("localhost");
    }
  });
});
