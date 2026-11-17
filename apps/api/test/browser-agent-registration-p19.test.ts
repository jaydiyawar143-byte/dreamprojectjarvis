// ---------------------------------------------------------------------------
// Phase 19 — Browser Agent chat integration, step 1: does the REAL composition
// root register the browser tools and the Browser Agent?
//
// WHY THIS FILE EXISTS. The real-Chromium E2E (test/e2e/browser-real-chromium)
// builds its own registry, registers the Browser Agent unconditionally and
// names it on every request. It never calls `getContainer()`, so it proves the
// path below the agent and nothing about start-up. The container's own wiring
// tests (sprint7-browser-wiring, browser-service-diagnostics) read
// `container.ts` as text. Nothing ran the start-up itself, which is where a
// chat request either finds a Browser Agent or silently lands on the general
// assistant, which has no browser tool at all.
//
// WHAT IS REAL. The container, the registry, the agent policies, the agents
// and the tool definitions each agent was handed. The browser-service
// endpoint is read from the environment exactly as in production, and the
// API's TLS files are real PEM files from a throwaway test CA, checked by the
// real `checkBrowserServiceClientTls`. Nothing reaches a network, a database
// or Docker: building the container opens no connection.
//
// WHAT IS NOT. Only the background reachability probe, which would open a
// socket to the service. It is replaced by a recorder, so the tests can say
// whether start-up asked for it.
//
// THE ENVIRONMENT IS PINNED. `@jarvis/config` loads a `.env` from the working
// directory when it is imported. Every variable the browser branch reads is
// therefore set or unset here explicitly, so no machine's own configuration
// can decide an outcome.
//
// FAIL CLOSED, PROVEN. Every refusal below runs with a real executable as
// CHROME_PATH and an artifact retention set: if a refused browser-service
// configuration ever fell back to the in-process browser, tools would appear
// and the test would fail.
//
// NOT COVERED, AND WHY. `construction_failed` cannot be reached from
// configuration today: the only check the client's constructor makes (a
// shared secret of 32 characters) is made first by the endpoint reader. An
// expired or not-yet-valid certificate needs a certificate with chosen dates,
// which the shared test CA does not issue; `checkBrowserServiceClientTls`
// itself is tested for those in apps/browser-service
// (browser-service-startup-checks-p19).
// ---------------------------------------------------------------------------

import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { AIToolDefinition } from "@jarvis/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/browser-service-diagnostics.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/browser-service-diagnostics.js")>()),
  startBrowserServiceProbe: vi.fn(),
}));

import { startBrowserServiceProbe } from "../src/services/browser-service-diagnostics.js";
import { getContainer, resetContainer } from "../src/services/container.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const JWT_SECRET = "Zk4pQ7vR2mX9tL6wB3nH8sD5gY1jF0cA";
/** The identity the client certificate names, and the API presents. */
const PEER = "jarvis-api";
const KEY_ID = "api-key-p19-registration";
/** Shaped like the real thing and good for nothing: no request is ever signed with it. */
const SECRET = "p19-registration-not-a-real-secret-0123456789";
/** `.invalid` never resolves, so even a probe that escaped the recorder could reach nothing. */
const SERVICE_URL = "https://browser-service.invalid:3200";

const BROWSER_AGENT = "browser-agent";
const GENERAL_ASSISTANT = "conversational-assistant";
const READ_TOOLS = ["browser.navigate", "browser.inspect", "browser.extract", "browser.screenshot"];
const ACTION_TOOLS = [
  "browser.click",
  "browser.type",
  "browser.select",
  "browser.submit",
  "browser.download",
  "browser.upload",
];
const ALL_BROWSER_TOOLS = [...READ_TOOLS, ...ACTION_TOOLS];
/** A registry id as a model is shown it: dots are not legal in a function name. */
const asOffered = (toolId: string): string => toolId.replace(/\./g, "-");

interface TestTlsMaterial {
  dir: string;
  caPath: string;
  clientCertPath: string;
  clientKeyPath: string;
  /** A client certificate, signed by the same CA, for an identity other than PEER. */
  otherClientCertPath: string;
  otherClientKeyPath: string;
}

// The browser service's own throwaway-CA helper (P-256 keys per run, one day,
// written to a fresh temporary directory), loaded at run time exactly as
// scripts/browser-e2e/run.mjs loads it, rather than copied.
const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const TLS_HELPER = pathToFileURL(resolve(here, "../../browser-service/test/helpers/test-tls.ts")).href;

let tls: TestTlsMaterial;
let scratch: string;
let downloads: string;

beforeAll(async () => {
  const { createTestTls } = (await import(TLS_HELPER)) as { createTestTls: (identity: string) => TestTlsMaterial };
  tls = createTestTls(PEER);
  scratch = mkdtempSync(join(tmpdir(), "jarvis-p19-registration-"));
  downloads = join(scratch, "artifacts");
});

afterAll(() => {
  rmSync(tls.dir, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * A working browser-service configuration, with the in-process browser ARMED
 * beside it, plus `overrides`. Every variable the container's browser branch
 * reads is named here, set or unset.
 */
function useEnvironment(overrides: Record<string, string | undefined> = {}): void {
  const environment: Record<string, string | undefined> = {
    NODE_ENV: "development",
    JWT_SECRET,
    JARVIS_MCP_ENABLED: "false",
    OPENAI_API_KEY: undefined,
    META_ACCESS_TOKEN: undefined,
    META_AD_ACCOUNT_ID: undefined,
    // No key: browser writes cannot be sealed, so only the reads register.
    JARVIS_ENCRYPTION_KEY: undefined,

    BROWSER_ENABLED: "true",
    BROWSER_SERVICE_URL: SERVICE_URL,
    BROWSER_SERVICE_KEY_ID: KEY_ID,
    BROWSER_SERVICE_SHARED_SECRET: SECRET,
    BROWSER_SERVICE_PEER_IDENTITY: PEER,
    BROWSER_SERVICE_TIMEOUT_MS: undefined,
    BROWSER_SERVICE_CLIENT_CERT_PATH: tls.clientCertPath,
    BROWSER_SERVICE_CLIENT_KEY_PATH: tls.clientKeyPath,
    BROWSER_SERVICE_CA_PATH: tls.caPath,

    // The in-process browser, ready to register if anything ever fell back to
    // it: an executable that exists, a retention policy, a private directory.
    CHROME_PATH: process.execPath,
    BROWSER_ARTIFACT_RETENTION_HOURS: "24",
    BROWSER_DOWNLOAD_DIR: downloads,
    BROWSER_DOMAIN_ALLOWLIST: undefined,
    BROWSER_HEADLESS: undefined,
    BROWSER_MAX_SESSIONS: undefined,
    BROWSER_NAVIGATION_TIMEOUT_MS: undefined,
    BROWSER_SESSION_TIMEOUT_MS: undefined,
    BROWSER_MAX_EXTRACT_CHARS: undefined,
    BROWSER_MAX_DOWNLOAD_BYTES: undefined,
    BROWSER_ARTIFACT_QUOTA_BYTES_PER_USER: undefined,
    BROWSER_ARTIFACT_QUOTA_BYTES_PER_ORGANIZATION: undefined,
    BROWSER_ARTIFACT_MAX_COUNT_PER_USER: undefined,
    BROWSER_ARTIFACT_MAX_COUNT_PER_ORGANIZATION: undefined,
    ...overrides,
  };
  for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value);
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

let logged: string[];
const probe = vi.mocked(startBrowserServiceProbe);

beforeEach(() => {
  resetContainer();
  probe.mockClear();
  logged = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  resetContainer();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Start-up lines with this `event`, parsed. */
function events(name: string): Array<Record<string, unknown>> {
  return logged.flatMap((line) => {
    if (!line.includes(`"${name}"`)) return [];
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      return parsed.event === name ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

const registered = (toolId: string): boolean => getContainer().toolRegistry.get(toolId) !== undefined;

/** The function names the Browser Agent was handed: what a model can ask it to call. */
function offeredToBrowserAgent(): string[] {
  const agent = getContainer().agentRegistry.get(BROWSER_AGENT) as unknown as
    | { providerTools?: AIToolDefinition[] }
    | undefined;
  expect(agent, "the Browser Agent should be registered").toBeDefined();
  return (agent!.providerTools ?? []).map((definition) => definition.name);
}

/** Nothing a start-up line says may be the secret or name where the TLS files are. */
function expectNothingLeaked(): void {
  const text = logged.join("\n");
  expect(text).not.toContain(SECRET);
  for (const dir of [tls.dir, scratch]) {
    expect(text).not.toContain(dir);
    // A Windows path inside a JSON line has its backslashes doubled.
    expect(text).not.toContain(JSON.stringify(dir).slice(1, -1));
  }
  expect(text).not.toMatch(/BEGIN |PRIVATE KEY/);
}

/** No browser tool, no Browser Agent, no browser runtime announced, no probe — and the server still answers. */
function expectNoBrowsing(): void {
  const container = getContainer();
  for (const toolId of ALL_BROWSER_TOOLS) expect(container.toolRegistry.get(toolId), toolId).toBeUndefined();
  expect(container.agentRegistry.get(BROWSER_AGENT)).toBeUndefined();
  expect(events("browser_tools_enabled")).toEqual([]);
  expect(probe).not.toHaveBeenCalled();
  expect(container.agentRegistry.get(GENERAL_ASSISTANT)).toBeDefined();
}

// ---------------------------------------------------------------------------
// 1. A valid browser-service configuration
// ---------------------------------------------------------------------------

describe("a valid browser-service configuration", () => {
  it("registers browser.navigate and the other page reads", () => {
    useEnvironment();

    for (const toolId of READ_TOOLS) expect(registered(toolId), toolId).toBe(true);
  });

  it("registers the Browser Agent", () => {
    useEnvironment();

    const agent = getContainer().agentRegistry.get(BROWSER_AGENT);
    expect(agent).toBeDefined();
    expect(agent!.id).toBe(BROWSER_AGENT);
  });

  it("offers the Browser Agent the page reads, by the names a model calls them, and no action it could not run", () => {
    useEnvironment();

    const offered = offeredToBrowserAgent();
    for (const toolId of READ_TOOLS) expect(offered, toolId).toContain(asOffered(toolId));
    for (const toolId of ACTION_TOOLS) expect(offered, toolId).not.toContain(asOffered(toolId));
  });

  it("without an encryption key, registers no action and says why", () => {
    useEnvironment();

    for (const toolId of ACTION_TOOLS) expect(registered(toolId), toolId).toBe(false);
    const unavailable = events("browser_writes_unavailable");
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]).toMatchObject({ level: "warn" });
    expect(String(unavailable[0]!.reason)).toContain("JARVIS_ENCRYPTION_KEY");
  });

  it("with an encryption key, registers the six approval-gated actions and offers them to the Browser Agent", () => {
    useEnvironment({ JARVIS_ENCRYPTION_KEY: randomBytes(32).toString("base64") });

    for (const toolId of ALL_BROWSER_TOOLS) expect(registered(toolId), toolId).toBe(true);
    for (const toolId of ACTION_TOOLS) expect(getContainer().toolRegistry.get(toolId)!.requiresApproval, toolId).toBe(true);
    const offered = offeredToBrowserAgent();
    for (const toolId of ALL_BROWSER_TOOLS) expect(offered, toolId).toContain(asOffered(toolId));
    expect(events("browser_writes_unavailable")).toEqual([]);
  });

  it("says at start-up that browsing runs on the service over mutual TLS, and leaks nothing", () => {
    useEnvironment();
    getContainer();

    const enabled = events("browser_tools_enabled");
    expect(enabled).toHaveLength(1);
    expect(enabled[0]).toMatchObject({
      level: "info",
      mode: "remote",
      serviceHost: "browser-service.invalid:3200",
      timeoutMs: 30_000,
      mutualTls: true,
    });
    expect(Date.parse(String(enabled[0]!.clientCertificateNotAfter))).toBeGreaterThan(Date.now());
    expect(events("browser_registration_skipped")).toEqual([]);
    expect(events("browser_tools_disabled")).toEqual([]);
    expectNothingLeaked();
  });

  it("starts the background reachability check once, for the configured service", () => {
    useEnvironment();
    getContainer();

    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0]![0].config).toMatchObject({
      baseUrl: SERVICE_URL,
      keyId: KEY_ID,
      peerIdentity: PEER,
      tls: { certPath: tls.clientCertPath, keyPath: tls.clientKeyPath, caPath: tls.caPath },
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Browsing switched off
// ---------------------------------------------------------------------------

describe("BROWSER_ENABLED is not exactly true", () => {
  it.each([
    ["false", "false"],
    ["unset", undefined],
    ["TRUE in capitals", "TRUE"],
    ["a truthy word", "yes"],
    ["true with a space", " true"],
  ])("registers no browser tool and no Browser Agent when it is %s, even with a working service configured", (_label, value) => {
    useEnvironment({ BROWSER_ENABLED: value });

    expectNoBrowsing();
    const disabled = events("browser_tools_disabled");
    expect(disabled).toHaveLength(1);
    expect(disabled[0]).toMatchObject({ level: "info", cause: "disabled", browserServiceConfigured: true });
    expect(String(disabled[0]!.reason)).toContain("BROWSER_ENABLED");
  });
});

// ---------------------------------------------------------------------------
// 3. An unusable browser-service configuration
// ---------------------------------------------------------------------------

describe("an unusable browser-service configuration fails closed", () => {
  it.each<[string, Record<string, string | undefined>, string, string]>([
    ["an http URL", { BROWSER_SERVICE_URL: "http://browser-service.invalid:3200" }, "invalid_service_url", "BROWSER_SERVICE_URL"],
    ["a URL that does not parse", { BROWSER_SERVICE_URL: "not a url" }, "invalid_service_url", "BROWSER_SERVICE_URL"],
    ["a URL carrying credentials", { BROWSER_SERVICE_URL: "https://user:pass@browser-service.invalid:3200" }, "invalid_service_url", "BROWSER_SERVICE_URL"],
    ["no key id", { BROWSER_SERVICE_KEY_ID: undefined }, "configuration_missing", "BROWSER_SERVICE_KEY_ID"],
    ["no shared secret", { BROWSER_SERVICE_SHARED_SECRET: undefined }, "configuration_missing", "BROWSER_SERVICE_SHARED_SECRET"],
    ["a shared secret under 32 characters", { BROWSER_SERVICE_SHARED_SECRET: "too-short-p19" }, "configuration_invalid", "BROWSER_SERVICE_SHARED_SECRET"],
    ["no peer identity", { BROWSER_SERVICE_PEER_IDENTITY: undefined }, "configuration_missing", "BROWSER_SERVICE_PEER_IDENTITY"],
    ["a timeout out of range", { BROWSER_SERVICE_TIMEOUT_MS: "999999" }, "configuration_invalid", "BROWSER_SERVICE_TIMEOUT_MS"],
    ["no client certificate path", { BROWSER_SERVICE_CLIENT_CERT_PATH: undefined }, "configuration_missing", "BROWSER_SERVICE_CLIENT_CERT_PATH"],
    ["no client key path", { BROWSER_SERVICE_CLIENT_KEY_PATH: undefined }, "configuration_missing", "BROWSER_SERVICE_CLIENT_KEY_PATH"],
  ])("with %s: no browser tool, no Browser Agent, no fallback to the in-process browser", (_label, overrides, cause, variable) => {
    useEnvironment(overrides);

    expectNoBrowsing();
    const skipped = events("browser_registration_skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ level: "warn", cause });
    expect(String(skipped[0]!.reason)).toContain(variable);
    expectNothingLeaked();
  });
});

// ---------------------------------------------------------------------------
// 4. TLS material the service would refuse
// ---------------------------------------------------------------------------

describe("client TLS material that fails the start-up check fails closed", () => {
  const notAFile = () => join(scratch, "no-such-file.pem");
  const notACertificate = () => {
    const path = join(scratch, "not-a-certificate.crt");
    writeFileSync(path, "this file holds no certificate\n");
    return path;
  };

  it.each<[string, () => Record<string, string>, string, string]>([
    ["a certificate path that names no file", () => ({ BROWSER_SERVICE_CLIENT_CERT_PATH: notAFile() }), "tls_material_unreadable", "BROWSER_SERVICE_CLIENT_CERT_PATH"],
    ["a key path that names no file", () => ({ BROWSER_SERVICE_CLIENT_KEY_PATH: notAFile() }), "tls_material_unreadable", "BROWSER_SERVICE_CLIENT_KEY_PATH"],
    ["a CA path that names no file", () => ({ BROWSER_SERVICE_CA_PATH: notAFile() }), "tls_material_unreadable", "BROWSER_SERVICE_CA_PATH"],
    ["a certificate file that holds no certificate", () => ({ BROWSER_SERVICE_CLIENT_CERT_PATH: notACertificate() }), "tls_material_invalid", "BROWSER_SERVICE_CLIENT_CERT_PATH"],
    ["a certificate and a key that are not a pair", () => ({ BROWSER_SERVICE_CLIENT_KEY_PATH: tls.otherClientKeyPath }), "tls_material_invalid", "BROWSER_SERVICE_CLIENT_KEY_PATH"],
    [
      "a certificate for another identity",
      () => ({ BROWSER_SERVICE_CLIENT_CERT_PATH: tls.otherClientCertPath, BROWSER_SERVICE_CLIENT_KEY_PATH: tls.otherClientKeyPath }),
      "tls_material_invalid",
      "BROWSER_SERVICE_PEER_IDENTITY",
    ],
  ])("with %s: no browser tool, no Browser Agent, no fallback to the in-process browser", (_label, overrides, cause, variable) => {
    useEnvironment(overrides());

    expectNoBrowsing();
    const skipped = events("browser_registration_skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ level: "warn", cause });
    expect(String(skipped[0]!.reason)).toContain(variable);
    expectNothingLeaked();
  });
});

// ---------------------------------------------------------------------------
// 4b. What a browsing request is told where there is no Browser Agent
// ---------------------------------------------------------------------------

describe("what a browsing request is told where there is no Browser Agent", () => {
  /** The sentence the container handed the orchestrator the chat route calls. */
  const toldToOrchestrator = (): unknown =>
    (getContainer().orchestrator as unknown as { browsingUnavailableReason: string | null }).browsingUnavailableReason;

  it("nothing, where the Browser Agent is registered", () => {
    useEnvironment();

    expect(getContainer().browsingUnavailableReason).toBeNull();
    expect(toldToOrchestrator()).toBeNull();
  });

  it("that browsing is switched off, and how an administrator switches it on, when BROWSER_ENABLED is not true", () => {
    useEnvironment({ BROWSER_ENABLED: "false" });

    const reason = getContainer().browsingUnavailableReason;
    expect(reason).toContain("switched off");
    expect(reason).toContain("BROWSER_ENABLED=true");
    expect(reason).toContain("nothing was opened");
    expect(toldToOrchestrator()).toBe(reason);
  });

  it("that the browser could not be set up, and nothing of why, when browsing is on and registration refused", () => {
    useEnvironment({ BROWSER_SERVICE_CLIENT_CERT_PATH: tls.otherClientCertPath, BROWSER_SERVICE_CLIENT_KEY_PATH: tls.otherClientKeyPath });

    const reason = getContainer().browsingUnavailableReason!;
    expect(reason).toContain("could not be set up");
    expect(reason).toContain("nothing was opened");
    // Why is the operator's to read in the start-up log, not the person's.
    expect(reason).not.toMatch(/BROWSER_SERVICE_|browser-service\.invalid|https?:\/\//);
    expect(reason).not.toContain(SECRET);
    expect(toldToOrchestrator()).toBe(reason);
  });
});

// ---------------------------------------------------------------------------
// 5. The in-process browser's own start-up conditions (no service URL)
// ---------------------------------------------------------------------------

describe("without a browser-service URL, the in-process browser's conditions decide", () => {
  it("with no Chrome to drive, registers no browser tool and no Browser Agent", () => {
    useEnvironment({ BROWSER_SERVICE_URL: undefined, CHROME_PATH: join(tmpdir(), "p19-no-such-browser.exe") });

    expectNoBrowsing();
    const disabled = events("browser_tools_disabled");
    expect(disabled).toHaveLength(1);
    expect(String(disabled[0]!.reason)).toContain("CHROME_PATH");
  });

  it("with no artifact retention policy, registers no browser tool and no Browser Agent", () => {
    useEnvironment({ BROWSER_SERVICE_URL: undefined, BROWSER_ARTIFACT_RETENTION_HOURS: undefined });

    expectNoBrowsing();
    const skipped = events("browser_registration_skipped");
    expect(skipped).toHaveLength(1);
    expect(String(skipped[0]!.reason)).toContain("BROWSER_ARTIFACT_RETENTION_HOURS");
  });

  it("with Chrome and a retention policy, registers the same reads and the Browser Agent, and probes no service", async () => {
    useEnvironment({ BROWSER_SERVICE_URL: undefined });

    for (const toolId of READ_TOOLS) expect(registered(toolId), toolId).toBe(true);
    expect(getContainer().agentRegistry.get(BROWSER_AGENT)).toBeDefined();
    for (const toolId of READ_TOOLS) expect(offeredToBrowserAgent(), toolId).toContain(asOffered(toolId));
    const enabled = events("browser_tools_enabled");
    expect(enabled).toHaveLength(1);
    expect(enabled[0]).toMatchObject({ mode: "local" });
    expect(probe).not.toHaveBeenCalled();

    // Start-up sweeps the artifact store in the background, which is also
    // what creates it in the configured directory. Its marker is the store's
    // last write; waiting for it means removing the directory afterwards is
    // final, instead of being undone by a sweep still in flight.
    await vi.waitFor(() => expect(existsSync(join(downloads, ".jarvis-artifact-store"))).toBe(true));
  });
});
