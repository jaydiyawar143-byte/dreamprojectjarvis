// ---------------------------------------------------------------------------
// Sprint 7.1 / 7.2 — Browser runtime and session isolation.
//
// One Chrome process is shared; one browser CONTEXT is created per session and
// destroyed afterwards. That split is the isolation boundary: a context has its
// own cookie jar, storage, cache and permissions, so two users — or two
// requests from the same user — can never observe each other's state.
//
// Three properties this file is responsible for:
//
//   1. Every session gets a FRESH, EMPTY context. `storageState` is never
//      passed, so nothing is carried in and nothing is carried out. v1 stores
//      no browser credentials at all, which makes "the model must not see
//      cookies" true by construction rather than by filtering.
//
//   2. Every session is destroyed. `withSession` owns the `finally`, so a tool
//      cannot leak a context by forgetting to close one, and a crash in the
//      callback still releases the slot.
//
//   3. Concurrency is bounded. This runs inside the API process, and an
//      unbounded pool turns "open a web page" into a memory-exhaustion vector.
//      Waiters queue rather than being rejected, so a burst is slow instead of
//      failing.
//
// The Playwright import is lazy. A deployment with browsing switched off never
// loads it, and a missing browser binary surfaces at first use as an ordinary
// tool failure rather than as a boot crash.
// ---------------------------------------------------------------------------

import type {
  BrowserRuntimePort,
  BrowserSessionOptions,
  BrowserSessionPort,
} from "@jarvis/core";
import { JarvisError } from "@jarvis/core";

import type { BrowserConfig } from "./config.js";
import { navigationPolicyFor } from "./config.js";
import type { NavigationPolicyConfig } from "./navigation-policy.js";
import { DownloadStore } from "./download.js";
import { BrowserSession, type ContextLike, type PageLike } from "./session.js";

/** The slice of Playwright this runtime uses, so a test can substitute it. */
export interface BrowserLike {
  newContext(options?: Record<string, unknown>): Promise<PlaywrightContextLike>;
  close(): Promise<void>;
  isConnected?(): boolean;
}

export interface PlaywrightContextLike extends ContextLike {
  newPage(): Promise<PageLike>;
  setDefaultTimeout?(ms: number): void;
}

export type BrowserLauncher = (config: BrowserConfig) => Promise<BrowserLike>;

/**
 * Launches Chrome through playwright-core, driving the browser already on the
 * host rather than downloading one.
 *
 * Same approach as `.claude/skills/run-jarvis/driver.mjs`, which has been
 * driving this repo's own UI this way for several sprints.
 */
const launchChromium: BrowserLauncher = async (config) => {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({
    executablePath: config.chromePath,
    headless: config.headless,
    args: [
      // No sandbox assumptions: this may run as a non-root user in a container
      // without the kernel features Chrome's sandbox wants.
      "--no-sandbox",
      "--disable-dev-shm-usage",
      // Nothing in a JARVIS session should be talking to Google.
      "--disable-background-networking",
      "--disable-sync",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
  return browser as unknown as BrowserLike;
};

export interface BrowserRuntimeDeps {
  config: BrowserConfig;
  /** Overridden in tests; production gets Playwright. */
  launcher?: BrowserLauncher;
  /** Overridden in tests to permit a loopback mock server. */
  policy?: NavigationPolicyConfig;
  downloads?: DownloadStore;
}

function runtimeError(message: string): JarvisError {
  return new JarvisError("TOOL_UNAVAILABLE", message);
}

export class BrowserRuntime implements BrowserRuntimePort {
  private readonly config: BrowserConfig;
  private readonly launcher: BrowserLauncher;
  private readonly policy: NavigationPolicyConfig;
  private readonly downloads: DownloadStore;

  private browser: BrowserLike | null = null;
  private launching: Promise<BrowserLike> | null = null;
  private closed = false;

  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(deps: BrowserRuntimeDeps) {
    this.config = deps.config;
    this.launcher = deps.launcher ?? launchChromium;
    this.policy = deps.policy ?? navigationPolicyFor(deps.config);
    this.downloads =
      deps.downloads ??
      new DownloadStore({
        root: deps.config.downloadDir,
        maxBytes: deps.config.maxDownloadBytes,
      });
  }

  /**
   * Returns the shared browser, launching it once.
   *
   * Concurrent first calls share one launch — `launching` is the in-flight
   * promise — so a burst of requests at startup does not spawn several Chromes.
   */
  private async browserHandle(): Promise<BrowserLike> {
    if (this.closed) throw runtimeError("Browser runtime is shut down");
    if (this.browser && this.browser.isConnected?.() !== false) return this.browser;
    if (this.launching) return this.launching;

    this.launching = this.launcher(this.config)
      .then((browser) => {
        this.browser = browser;
        return browser;
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "browser launch failed";
        throw runtimeError(`Browser unavailable: ${message}`);
      })
      .finally(() => {
        this.launching = null;
      });

    return this.launching;
  }

  private async acquireSlot(): Promise<void> {
    if (this.active < this.config.maxConcurrentSessions) {
      this.active += 1;
      return;
    }
    await new Promise<void>((release) => this.waiters.push(release));
    this.active += 1;
  }

  private releaseSlot(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }

  async withSession<T>(
    userId: string,
    run: (session: BrowserSessionPort) => Promise<T>,
    options: BrowserSessionOptions = {}
  ): Promise<T> {
    if (typeof userId !== "string" || userId.length === 0) {
      throw runtimeError("A browser session requires a user id");
    }

    await this.acquireSlot();

    let context: PlaywrightContextLike | null = null;
    try {
      const browser = await this.browserHandle();

      // A FRESH, EMPTY context. No storageState, so no cookies, no localStorage
      // and no credentials are carried in from anywhere.
      context = await browser.newContext({
        acceptDownloads: true,
        bypassCSP: false,
        javaScriptEnabled: true,
      });

      const page = await context.newPage();
      page.setDefaultTimeout(this.config.navigationTimeoutMs);
      page.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);

      const session = new BrowserSession({
        page,
        context,
        config: this.config,
        policy: this.policy,
        downloads: this.downloads,
        userId,
      });
      await session.installNavigationGuard();

      return await this.withSessionDeadline(run(session), options.signal);
    } finally {
      // Always. A crashed callback, an aborted signal and a clean return all
      // land here, so a context can never outlive the call that made it.
      if (context) {
        await context.close().catch(() => undefined);
      }
      this.releaseSlot();
    }
  }

  /** Bounds the whole session, not just one action inside it. */
  private withSessionDeadline<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(runtimeError("Browser session exceeded its time limit"));
      }, this.config.sessionTimeoutMs);

      const onAbort = () => reject(runtimeError("Browser session aborted"));
      signal?.addEventListener("abort", onAbort, { once: true });

      work.then(resolve, reject).finally(() => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      });
    });
  }

  /**
   * Closes the shared browser.
   *
   * Registered with the existing `ShutdownLifecycle` so Chrome goes away during
   * RELEASE_RESOURCES rather than being orphaned when the API exits.
   */
  async shutdown(): Promise<void> {
    this.closed = true;
    const browser = this.browser;
    this.browser = null;
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }

  /** Test seam: how many sessions are running right now. */
  get activeSessions(): number {
    return this.active;
  }
}
