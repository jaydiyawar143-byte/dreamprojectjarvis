// ---------------------------------------------------------------------------
// Phase 19, Stage 19.2 — the browser engine, and its disabled default.
//
// Two engines:
//
//   DisabledBrowserEngine  what a deployment gets unless it explicitly turns
//                          Chromium on. Every session is refused UNAVAILABLE;
//                          nothing is launched, nothing is imported.
//
//   BrowserRuntime         the existing, tested @jarvis/browser runtime, with
//                          a launcher that does NOT pass --no-sandbox.
//
// The second is the whole reason this is a separate application: Chromium now
// runs in its own process and its own container. The runtime's own session
// guarantees — a fresh context per session, a destroyed context afterwards, a
// bounded pool — are inherited rather than reimplemented.
//
// The launcher is the one deliberate divergence from the API's old in-process
// runtime: Chromium's sandbox is ON (ADR-19-010). If the deployment cannot give
// Chromium the kernel features its sandbox needs, the browser does not run; it
// is not forced to run unsandboxed.
//
// "Not passing --no-sandbox" is NOT enough, and that was the Stage 19.2 audit's
// H1. Playwright (1.63.0, checked in its coreBundle) appends `--no-sandbox`
// itself unless the launch options say `chromiumSandbox: true` — its default
// is false. So the option is set explicitly, in ONE builder that the launcher
// and the tests both use, and that builder refuses any argument that would
// switch the sandbox off. With the option set, a host without a usable sandbox
// fails the launch ("Chromium sandboxing failed!"); the runtime reports that
// as the browser being unavailable. There is no retry without it.
// ---------------------------------------------------------------------------

import {
  BrowserRuntime,
  artifactStoreFor,
  createBrowserConfig,
  navigationPolicyFor,
  type ArtifactSweepResult,
  type BrowserLauncher,
  type BrowserLike,
} from "@jarvis/browser";
import { BrowserServiceError } from "@jarvis/browser-protocol";
import type { BrowserRuntimePort, BrowserSessionPort } from "@jarvis/core";

import type { BrowserServiceConfig } from "./config.js";

export class DisabledBrowserEngine implements BrowserRuntimePort {
  async withSession<T>(
    _userId: string,
    _run: (session: BrowserSessionPort) => Promise<T>
  ): Promise<T> {
    throw new BrowserServiceError("UNAVAILABLE");
  }

  async shutdown(): Promise<void> {
    return undefined;
  }
}

/**
 * Switches never passed: those that turn Chromium's sandbox, or part of it,
 * off, and those that would let it reach the network some way other than the
 * egress proxy (Phase 19.3).
 */
const FORBIDDEN_SWITCHES: readonly string[] = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-namespace-sandbox",
  "--disable-seccomp-filter-sandbox",
  "--disable-gpu-sandbox",
  "--no-zygote-sandbox",
  "--no-proxy-server",
  "--proxy-auto-detect",
  "--proxy-pac-url",
  "--proxy-bypass-list",
  "--proxy-server",
];

/** The fields of Playwright's launch options this service sets. */
export interface SandboxedChromiumLaunchOptions {
  executablePath: string;
  headless: boolean;
  chromiumSandbox: true;
  /**
   * The egress proxy, through Playwright's own option. With no `bypass`, it
   * also sends loopback through the proxy (`<-loopback>`), so `localhost` is
   * judged like any other destination instead of being dialled directly.
   */
  proxy: { server: string };
  args: string[];
}

/**
 * The one set of launch options the service uses.
 *
 * `--disable-dev-shm-usage` remains: it is about `/dev/shm` size in a
 * container, not about privilege. The rest suppress background traffic that a
 * JARVIS session has no reason to make.
 *
 * Phase 19.3: every connection goes to the egress proxy, and the resolver can
 * resolve the proxy's name and nothing else (`MAP * ~NOTFOUND`), so Chromium
 * never learns an address the proxy did not judge. WebRTC may not send UDP
 * outside the proxy.
 */
export function sandboxedChromiumLaunchOptions(config: {
  chromePath: string;
  headless: boolean;
  egressProxy: { url: string; host: string };
}): SandboxedChromiumLaunchOptions {
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(config.egressProxy.host)) {
    throw new Error("browser service configuration error: the egress proxy host cannot be named in a resolver rule");
  }
  const args = [
    "--disable-dev-shm-usage",
    "--disable-background-networking",
    "--disable-sync",
    "--no-first-run",
    "--no-default-browser-check",
    // One argv element, so no shell quoting: the value is the rule itself.
    `--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE ${config.egressProxy.host}`,
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  ];
  for (const arg of args) {
    if (FORBIDDEN_SWITCHES.some((switchName) => arg === switchName || arg.startsWith(`${switchName}=`))) {
      throw new Error(
        "browser service configuration error: a launch argument disables the Chromium sandbox or bypasses the egress proxy"
      );
    }
  }
  return {
    executablePath: config.chromePath,
    headless: config.headless,
    // Playwright's default is false, which appends --no-sandbox (H1).
    chromiumSandbox: true,
    proxy: { server: config.egressProxy.url },
    args,
  };
}

/** Chromium, launched with its sandbox and behind the egress proxy — or not at all. */
function sandboxedChromiumLauncher(egressProxy: { url: string; host: string }): BrowserLauncher {
  return async (config) => {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch(
      sandboxedChromiumLaunchOptions({ chromePath: config.chromePath, headless: config.headless, egressProxy })
    );
    return browser as unknown as BrowserLike;
  };
}

export interface BrowserEngineHandle {
  engine: BrowserRuntimePort;
  chromiumEnabled: boolean;
  shutdown(): Promise<void>;
  /** Phase 19.4 — removes expired and half-written artifacts. Absent while Chromium is off. */
  sweepArtifacts?(): Promise<ArtifactSweepResult>;
}

export type BrowserEngineLog = (event: string, fields?: Record<string, string | number | boolean>) => void;

const RUNTIME_SESSION_GRACE_MS = 10_000;

export function createBrowserEngine(config: BrowserServiceConfig, log?: BrowserEngineLog): BrowserEngineHandle {
  if (!config.chromiumEnabled) {
    const engine = new DisabledBrowserEngine();
    return { engine, chromiumEnabled: false, shutdown: () => engine.shutdown() };
  }
  // Phase 19.3, fail closed: the config loader already refuses this, and the
  // engine refuses it again for a config built any other way.
  if (!config.egressProxy) {
    throw new Error(
      "browser service configuration error: Chromium is enabled without an egress proxy; refusing to start a browser with unrestricted networking"
    );
  }

  const browserConfig = createBrowserConfig(
    {
      headless: config.chromium.headless,
      maxConcurrentSessions: config.chromium.maxConcurrentSessions,
      navigationTimeoutMs: config.chromium.navigationTimeoutMs,
      // The registry ends a session at its own TTL; this is the backstop for a
      // context whose close is lost, not the primary deadline.
      sessionTimeoutMs: Math.min(
        240_000,
        config.sessionTtlMs + RUNTIME_SESSION_GRACE_MS
      ),
      downloadDir: config.chromium.downloadDir,
      domainAllowlist: config.chromium.domainAllowlist,
      // Phase 19.4 — durable, scoped artifact storage (ADR-19-007).
      ...(config.chromium.artifacts.retentionHours === null
        ? {}
        : { artifactRetentionHours: config.chromium.artifacts.retentionHours }),
      artifactQuotaBytesPerUser: config.chromium.artifacts.quotaBytesPerUser,
      artifactQuotaBytesPerOrganization: config.chromium.artifacts.quotaBytesPerOrganization,
      artifactMaxCountPerUser: config.chromium.artifacts.maxCountPerUser,
      artifactMaxCountPerOrganization: config.chromium.artifacts.maxCountPerOrganization,
    },
    process.env
  );
  // Refuses without a retention policy, so a Chromium engine never exists
  // without durable, bounded storage behind it.
  const downloads = artifactStoreFor(browserConfig, log);

  const runtime = new BrowserRuntime({
    config: browserConfig,
    launcher: sandboxedChromiumLauncher(config.egressProxy),
    // Every rule of the navigation policy still runs in this process; host
    // names are resolved, judged and pinned by the egress proxy, which is the
    // only resolver Chromium can use (Phase 19.3).
    policy: { ...navigationPolicyFor(browserConfig), addressCheck: "literal-only" },
    downloads,
  });
  return {
    engine: runtime,
    chromiumEnabled: true,
    shutdown: () => runtime.shutdown(),
    sweepArtifacts: () => runtime.sweepArtifacts(),
  };
}
