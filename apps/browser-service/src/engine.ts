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
  createBrowserConfig,
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

/** Switches that turn Chromium's sandbox, or part of it, off. Never passed. */
const SANDBOX_DISABLING_SWITCHES: readonly string[] = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-namespace-sandbox",
  "--disable-seccomp-filter-sandbox",
  "--disable-gpu-sandbox",
  "--no-zygote-sandbox",
];

/** The fields of Playwright's launch options this service sets. */
export interface SandboxedChromiumLaunchOptions {
  executablePath: string;
  headless: boolean;
  chromiumSandbox: true;
  args: string[];
}

/**
 * The one set of launch options the service uses.
 *
 * `--disable-dev-shm-usage` remains: it is about `/dev/shm` size in a
 * container, not about privilege. The rest suppress background traffic that a
 * JARVIS session has no reason to make.
 */
export function sandboxedChromiumLaunchOptions(config: {
  chromePath: string;
  headless: boolean;
}): SandboxedChromiumLaunchOptions {
  const args = [
    "--disable-dev-shm-usage",
    "--disable-background-networking",
    "--disable-sync",
    "--no-first-run",
    "--no-default-browser-check",
  ];
  for (const arg of args) {
    if (SANDBOX_DISABLING_SWITCHES.some((switchName) => arg === switchName || arg.startsWith(`${switchName}=`))) {
      throw new Error("browser service configuration error: a launch argument disables the Chromium sandbox");
    }
  }
  return {
    executablePath: config.chromePath,
    headless: config.headless,
    // Playwright's default is false, which appends --no-sandbox (H1).
    chromiumSandbox: true,
    args,
  };
}

/** Chromium, launched with its sandbox — or not at all. */
const launchSandboxedChromium: BrowserLauncher = async (config) => {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch(sandboxedChromiumLaunchOptions(config));
  return browser as unknown as BrowserLike;
};

export interface BrowserEngineHandle {
  engine: BrowserRuntimePort;
  chromiumEnabled: boolean;
  shutdown(): Promise<void>;
}

const RUNTIME_SESSION_GRACE_MS = 10_000;

export function createBrowserEngine(config: BrowserServiceConfig): BrowserEngineHandle {
  if (!config.chromiumEnabled) {
    const engine = new DisabledBrowserEngine();
    return { engine, chromiumEnabled: false, shutdown: () => engine.shutdown() };
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
    },
    process.env
  );

  const runtime = new BrowserRuntime({ config: browserConfig, launcher: launchSandboxedChromium });
  return {
    engine: runtime,
    chromiumEnabled: true,
    shutdown: () => runtime.shutdown(),
  };
}
