// ---------------------------------------------------------------------------
// Phase 19, Stage 19.2 audit (H1) — the engine asks for Chromium's sandbox.
//
// Playwright appends `--no-sandbox` to every Chromium launch unless the launch
// options carry `chromiumSandbox: true`; its default is false. Leaving the
// flag out of `args` is therefore not enough, and a test that only reads
// `args` would pass on an unsandboxed browser.
//
// These tests replace `playwright-core` with a stand-in that records what the
// real engine path — `createBrowserEngine` → `BrowserRuntime` → the launcher —
// hands to `chromium.launch`, so no browser starts. The stand-in then fails
// the way Playwright does on a host with no usable sandbox, to show that the
// failure is a refused session and that nothing relaunches without it.
//
// The real-browser check (S10) is `scripts/s10-sandbox-check.mjs`; it is not
// run here because it needs a Chromium.
// ---------------------------------------------------------------------------

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const launches = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("playwright-core", () => ({
  chromium: {
    launch: async (options: Record<string, unknown>) => {
      launches.push(options);
      // What Playwright reports when the host cannot give Chromium a sandbox.
      throw new Error("Chromium sandboxing failed! No usable sandbox!");
    },
  },
}));

import type { BrowserServiceConfig } from "../src/config.js";
import { createBrowserEngine } from "../src/engine.js";

const downloadDir = mkdtempSync(join(tmpdir(), "jarvis-browser-sandbox-"));
const previousChromePath = process.env.CHROME_PATH;
// Any existing file satisfies the runtime's executable lookup; the stand-in
// launcher never runs it.
process.env.CHROME_PATH = process.execPath;

afterAll(() => {
  if (previousChromePath === undefined) delete process.env.CHROME_PATH;
  else process.env.CHROME_PATH = previousChromePath;
  rmSync(downloadDir, { recursive: true, force: true });
});

function enabledConfig(): BrowserServiceConfig {
  return {
    host: "127.0.0.1",
    port: 3200,
    healthPort: 3201,
    keyId: "api-key-1",
    secret: "0123456789abcdef0123456789abcdef",
    peerIdentity: "jarvis-api",
    tls: { certPath: "unused", keyPath: "unused", caPath: "unused" },
    healthToken: null,
    clockSkewMs: 60_000,
    sessionTtlMs: 60_000,
    maxSessions: 2,
    maxSessionsPerOrganization: 2,
    requestTimeoutMs: 4_000,
    maxBodyBytes: 64 * 1024,
    chromiumEnabled: true,
    egressProxy: { url: "http://browser-egress:3128", host: "browser-egress", port: 3128 },
    chromium: {
      headless: true,
      maxConcurrentSessions: 2,
      navigationTimeoutMs: 5_000,
      downloadDir,
      domainAllowlist: [],
      artifacts: {
        retentionHours: 24,
        quotaBytesPerUser: 100 * 1024 * 1024,
        quotaBytesPerOrganization: 500 * 1024 * 1024,
        maxCountPerUser: 200,
        maxCountPerOrganization: 1_000,
        sweepIntervalMs: 600_000,
      },
    },
  };
}

beforeEach(() => {
  launches.length = 0;
});

describe("the browser engine's Chromium launch", () => {
  it("asks for the sandbox explicitly, through the real engine path", async () => {
    const handle = createBrowserEngine(enabledConfig());
    expect(handle.chromiumEnabled).toBe(true);
    await handle.engine.withSession("user-1", async () => "never", { organizationId: "org-1" }).catch(() => undefined);

    expect(launches).toHaveLength(1);
    const options = launches[0]!;
    expect(options.chromiumSandbox).toBe(true);
    expect(options.headless).toBe(true);
    expect(options.args as string[]).not.toContain("--no-sandbox");
    for (const arg of options.args as string[]) expect(arg).not.toMatch(/sandbox|zygote/i);
    // Phase 19.3: the same real path sends everything to the egress proxy.
    expect(options.proxy).toEqual({ server: "http://browser-egress:3128" });
    expect(options.args as string[]).toContain("--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE browser-egress");
    expect(options.args as string[]).toContain("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
    await handle.shutdown();
  });

  it("refuses to build a Chromium engine without an artifact retention, and launches nothing (Phase 19.4)", () => {
    const config = enabledConfig();
    expect(() =>
      createBrowserEngine({ ...config, chromium: { ...config.chromium, artifacts: { ...config.chromium.artifacts, retentionHours: null } } })
    ).toThrow(/BROWSER_ARTIFACT_RETENTION_HOURS/);
    expect(launches).toHaveLength(0);
  });

  it("gives the service a sweep for its artifacts (Phase 19.4)", async () => {
    const handle = createBrowserEngine(enabledConfig());
    expect(await handle.sweepArtifacts?.()).toEqual({
      expired: 0,
      orphans: 0,
      partial: 0,
      corrupt: 0,
      preserved: 0,
      skipped: 0,
      failed: 0,
    });
    expect(launches).toHaveLength(0);
    await handle.shutdown();
  });

  it("refuses to build a Chromium engine without an egress proxy, and launches nothing", () => {
    expect(() => createBrowserEngine({ ...enabledConfig(), egressProxy: null })).toThrow(
      /without an egress proxy; refusing to start a browser with unrestricted networking/
    );
    expect(launches).toHaveLength(0);
  });

  it("fails closed when the host has no usable sandbox — and never relaunches without it", async () => {
    const handle = createBrowserEngine(enabledConfig());
    let ran = false;
    const first = await handle.engine
      .withSession(
        "user-1",
        async () => {
          ran = true;
        },
        { organizationId: "org-1" }
      )
      .then(
        () => "opened",
        (error: unknown) => (error instanceof Error ? error.message : "refused")
      );
    expect(first).toMatch(/Browser unavailable/);
    expect(ran).toBe(false);

    // A second session tries again — with the sandbox again.
    await handle.engine.withSession("user-2", async () => undefined, { organizationId: "org-1" }).catch(() => undefined);
    expect(launches.length).toBe(2);
    expect(launches.every((options) => options.chromiumSandbox === true)).toBe(true);
    await handle.shutdown();
  });

  it("launches nothing while Chromium is switched off", async () => {
    const handle = createBrowserEngine({ ...enabledConfig(), chromiumEnabled: false });
    await handle.engine.withSession("user-1", async () => "never", { organizationId: "org-1" }).catch(() => undefined);
    expect(launches).toHaveLength(0);
  });
});
