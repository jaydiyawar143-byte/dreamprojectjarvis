// ---------------------------------------------------------------------------
// Sprint 7.2 — The browser session façade.
//
// This is the ONLY thing the tool layer ever holds. It takes a Playwright
// `Page` in its constructor and never gives one back: no method returns a
// `Page`, a `BrowserContext`, a `Frame`, a cookie or a filesystem path. A tool
// therefore cannot reach `page.evaluate`, `context.cookies()` or
// `page.goto(anything)` even if a model talks it into trying, because there is
// no expression that produces the handle.
//
// SSRF containment lives in two places here, and it needs both:
//
//   1. `navigate()` validates the target before the browser is asked for it.
//   2. `context.route()` validates EVERY request the page makes, which is what
//      catches redirects, iframes, XHR, images and any other subresource. A
//      check that only guards the top-level navigation is trivially walked past
//      by a page that redirects or fetches on its own.
//
// Decisions are cached per ORIGIN, not per URL. The address check is a property
// of the host, so caching per URL would re-resolve DNS for every image on a
// page — slow, and a needless amplifier pointed at somebody's resolver.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type {
  BrowserActionResult,
  BrowserExtractResult,
  BrowserInspectResult,
  BrowserNavigateResult,
  BrowserPageIdentity,
  BrowserScreenshotResult,
  BrowserSessionOptions,
  BrowserSessionPort,
  BrowserDownloadResult,
  BrowserUploadResult,
  BrowserElementSummary,
} from "@jarvis/core";
import { JarvisError, BROWSER_MAX_EXTRACT_FIELDS } from "@jarvis/core";
import { normalizeText, normalizeInlineText } from "@jarvis/memory";

import type { BrowserConfig } from "./config.js";
import type { NavigationPolicyConfig } from "./navigation-policy.js";
import { validateNavigationTarget } from "./navigation-policy.js";
import type { DownloadStore } from "./download.js";

/** Minimal shape of the Playwright objects we use, so tests can fake them. */
export interface PageLike {
  goto(url: string, options?: Record<string, unknown>): Promise<ResponseLike | null>;
  url(): string;
  title(): Promise<string>;
  content(): Promise<string>;
  screenshot(options?: Record<string, unknown>): Promise<Buffer>;
  click(selector: string, options?: Record<string, unknown>): Promise<void>;
  fill(selector: string, value: string, options?: Record<string, unknown>): Promise<void>;
  selectOption(
    selector: string,
    value: string,
    options?: Record<string, unknown>
  ): Promise<unknown>;
  evaluate<T>(fn: string, arg?: unknown): Promise<T>;
  waitForTimeout(ms: number): Promise<void>;
  setDefaultTimeout(ms: number): void;
  setDefaultNavigationTimeout(ms: number): void;
  waitForEvent(event: "download", options?: { timeout?: number }): Promise<DownloadLike>;
  setInputFiles(
    selector: string,
    files: string | string[],
    options?: Record<string, unknown>
  ): Promise<void>;
}

export interface ResponseLike {
  status(): number;
}

/** Playwright's download handle. Never returned to a caller. */
export interface DownloadLike {
  suggestedFilename(): string;
  path(): Promise<string | null>;
  failure(): Promise<string | null>;
  delete(): Promise<void>;
}

export interface RouteLike {
  request(): { url(): string; resourceType?(): string };
  abort(reason?: string): Promise<void>;
  continue(): Promise<void>;
}

export interface ContextLike {
  route(pattern: string, handler: (route: RouteLike) => Promise<void>): Promise<void>;
  close(): Promise<void>;
}

export interface BrowserSessionDeps {
  page: PageLike;
  context: ContextLike;
  config: BrowserConfig;
  policy: NavigationPolicyConfig;
  downloads: DownloadStore;
  userId: string;
}

const MAX_INSPECT_ELEMENTS = 60;
const MAX_LABEL_LENGTH = 120;

function browserError(message: string, details?: Record<string, unknown>): JarvisError {
  return new JarvisError("TOOL_EXECUTION_FAILED", message, details);
}

/** Rejects as soon as the caller's signal aborts, so a deadline actually bites. */
function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(browserError("Browser action aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(browserError("Browser action aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export class BrowserSession implements BrowserSessionPort {
  private readonly page: PageLike;
  private readonly context: ContextLike;
  private readonly config: BrowserConfig;
  private readonly policy: NavigationPolicyConfig;
  private readonly downloads: DownloadStore;
  private readonly userId: string;

  /** origin -> allowed. Bounded so a hostile page cannot grow it without limit. */
  private readonly originDecisions = new Map<string, boolean>();
  private static readonly MAX_CACHED_ORIGINS = 200;

  /** Set once `navigate` has succeeded; every other method requires it. */
  private navigated = false;

  constructor(deps: BrowserSessionDeps) {
    this.page = deps.page;
    this.context = deps.context;
    this.config = deps.config;
    this.policy = deps.policy;
    this.downloads = deps.downloads;
    this.userId = deps.userId;
  }

  /**
   * Installs the per-request gate.
   *
   * Called once by the runtime when the session is built. Anything the page
   * asks for that the policy refuses is aborted before a socket is opened.
   */
  async installNavigationGuard(): Promise<void> {
    await this.context.route("**/*", async (route) => {
      const requestUrl = route.request().url();
      const allowed = await this.isOriginAllowed(requestUrl);
      if (allowed) {
        await route.continue();
        return;
      }
      await route.abort("blockedbyclient");
    });
  }

  private async isOriginAllowed(requestUrl: string): Promise<boolean> {
    let origin: string;
    try {
      const parsed = new URL(requestUrl);
      origin = parsed.origin;
    } catch {
      return false;
    }

    const cached = this.originDecisions.get(origin);
    if (cached !== undefined) return cached;

    const decision = await validateNavigationTarget(requestUrl, this.policy);
    if (this.originDecisions.size >= BrowserSession.MAX_CACHED_ORIGINS) {
      // A page that touches 200 origins is not one we need to keep optimising
      // for; drop the oldest rather than letting the map grow unbounded.
      const oldest = this.originDecisions.keys().next();
      if (!oldest.done) this.originDecisions.delete(oldest.value);
    }
    this.originDecisions.set(origin, decision.allowed);
    return decision.allowed;
  }

  private requireNavigated(): void {
    if (!this.navigated) {
      throw browserError("No page is open; navigate to a URL first");
    }
  }

  private async identity(): Promise<BrowserPageIdentity> {
    const [url, title] = await Promise.all([
      Promise.resolve(this.page.url()),
      this.page.title().catch(() => ""),
    ]);
    return { url, title: title ?? "", status: this.lastStatus };
  }

  private lastStatus: number | null = null;

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  async navigate(
    url: string,
    options: BrowserSessionOptions = {}
  ): Promise<BrowserNavigateResult> {
    const decision = await validateNavigationTarget(url, this.policy);
    if (!decision.allowed) {
      throw browserError(`Navigation refused: ${decision.detail}`, {
        reason: decision.reason,
      });
    }

    const response = await withAbort(
      this.page.goto(decision.url, {
        waitUntil: "domcontentloaded",
        timeout: this.config.navigationTimeoutMs,
      }),
      options.signal
    ).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "navigation failed";
      throw browserError(`Navigation failed: ${message}`);
    });

    this.lastStatus = response ? response.status() : null;
    this.navigated = true;

    // Where we ENDED UP is re-checked. The route gate already refused any hop
    // it disliked, but a page can also reach a permitted-origin URL we would
    // still refuse at the top level (a blocked port, say).
    const finalUrl = this.page.url();
    const finalDecision = await validateNavigationTarget(finalUrl, this.policy);
    if (!finalDecision.allowed) {
      throw browserError(`Navigation refused after redirect: ${finalDecision.detail}`, {
        reason: finalDecision.reason,
      });
    }

    const title = await this.page.title().catch(() => "");
    return {
      url: finalUrl,
      title: title ?? "",
      status: this.lastStatus,
      redirected: finalUrl !== decision.url,
    };
  }

  async inspect(options: BrowserSessionOptions = {}): Promise<BrowserInspectResult> {
    this.requireNavigated();

    const raw = await withAbort(
      this.page.evaluate<BrowserElementSummary[]>(INSPECT_SCRIPT, {
        limit: MAX_INSPECT_ELEMENTS + 1,
        maxLabel: MAX_LABEL_LENGTH,
      }),
      options.signal
    ).catch(() => [] as BrowserElementSummary[]);

    const truncated = raw.length > MAX_INSPECT_ELEMENTS;
    const elements = raw.slice(0, MAX_INSPECT_ELEMENTS).map((element) => ({
      ...element,
      label: normalizeInlineText(element.label ?? "").slice(0, MAX_LABEL_LENGTH),
    }));

    return { ...(await this.identity()), elements, truncated };
  }

  async extract(
    selectors: Record<string, string> = {},
    options: BrowserSessionOptions = {}
  ): Promise<BrowserExtractResult> {
    this.requireNavigated();

    const entries = Object.entries(selectors).slice(0, BROWSER_MAX_EXTRACT_FIELDS);

    const [bodyText, fieldValues] = await Promise.all([
      withAbort(
        this.page.evaluate<string>(BODY_TEXT_SCRIPT),
        options.signal
      ).catch(() => ""),
      entries.length > 0
        ? withAbort(
            this.page.evaluate<Record<string, string>>(FIELDS_SCRIPT, entries),
            options.signal
          ).catch(() => ({}) as Record<string, string>)
        : Promise.resolve({} as Record<string, string>),
    ]);

    // normalizeText strips zero-width and bidi controls, which is the defence
    // against invisible characters smuggling instructions into the extract.
    const normalized = normalizeText(bodyText ?? "");
    const truncated = normalized.length > this.config.maxExtractChars;
    const text = truncated ? normalized.slice(0, this.config.maxExtractChars) : normalized;

    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(fieldValues ?? {})) {
      fields[key] = normalizeInlineText(String(value)).slice(0, 2000);
    }

    return { ...(await this.identity()), text, fields, truncated };
  }

  async screenshot(options: BrowserSessionOptions = {}): Promise<BrowserScreenshotResult> {
    this.requireNavigated();

    const buffer = await withAbort(
      this.page.screenshot({ type: "png", fullPage: false }),
      options.signal
    ).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "screenshot failed";
      throw browserError(`Screenshot failed: ${message}`);
    });

    const stored = await this.downloads.storeBytes(this.userId, {
      fileName: `screenshot-${randomUUID()}.png`,
      bytes: buffer,
      mimeType: "image/png",
      sourceOrigin: safeOrigin(this.page.url()),
    });

    return {
      ...(await this.identity()),
      screenshotId: stored.downloadId,
      byteSize: stored.byteSize,
      format: "png",
    };
  }

  // -------------------------------------------------------------------------
  // Act — every one of these is reached only through an approved tool
  // -------------------------------------------------------------------------

  private async act(
    selector: string,
    run: () => Promise<void>,
    options: BrowserSessionOptions
  ): Promise<BrowserActionResult> {
    this.requireNavigated();
    const before = this.page.url();

    await withAbort(run(), options.signal).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "action failed";
      throw browserError(`Action failed: ${message}`, { selector });
    });

    const after = this.page.url();
    if (after !== before) {
      // A click can navigate. The destination gets the same scrutiny as an
      // explicit navigate would, and a refusal here is a hard failure rather
      // than a page we quietly keep reading.
      const decision = await validateNavigationTarget(after, this.policy);
      if (!decision.allowed) {
        throw browserError(`Action navigated to a refused URL: ${decision.detail}`, {
          reason: decision.reason,
        });
      }
    }

    return { ...(await this.identity()), selector, navigated: after !== before };
  }

  async click(
    selector: string,
    options: BrowserSessionOptions = {}
  ): Promise<BrowserActionResult> {
    return this.act(
      selector,
      () => this.page.click(selector, { timeout: this.config.navigationTimeoutMs }),
      options
    );
  }

  async type(
    selector: string,
    text: string,
    options: BrowserSessionOptions = {}
  ): Promise<BrowserActionResult> {
    return this.act(
      selector,
      () => this.page.fill(selector, text, { timeout: this.config.navigationTimeoutMs }),
      options
    );
  }

  async select(
    selector: string,
    value: string,
    options: BrowserSessionOptions = {}
  ): Promise<BrowserActionResult> {
    return this.act(
      selector,
      async () => {
        await this.page.selectOption(selector, value, {
          timeout: this.config.navigationTimeoutMs,
        });
      },
      options
    );
  }

  async submit(
    selector: string,
    options: BrowserSessionOptions = {}
  ): Promise<BrowserActionResult> {
    // Submitting is a click on the submit control. There is deliberately no
    // `form.submit()` path: that bypasses the page's own validation and any
    // confirmation the site puts in front of the action.
    return this.act(
      selector,
      () => this.page.click(selector, { timeout: this.config.navigationTimeoutMs }),
      options
    );
  }

  /**
   * Clicks something that produces a file, and keeps the file.
   *
   * Playwright writes the download to a temporary path of its own choosing.
   * We read it, hand it to the store — which sniffs the format, enforces the
   * size cap and generates its own filename — and then delete the temporary
   * copy. The remote server's suggested filename is passed along only as a
   * hint for choosing between text formats; it never becomes a path component.
   */
  async download(
    selector: string,
    options: BrowserSessionOptions = {}
  ): Promise<BrowserDownloadResult> {
    this.requireNavigated();
    const origin = safeOrigin(this.page.url());

    const [download] = await withAbort(
      Promise.all([
        this.page.waitForEvent("download", { timeout: this.config.navigationTimeoutMs }),
        this.page.click(selector, { timeout: this.config.navigationTimeoutMs }),
      ]),
      options.signal
    ).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "download failed";
      throw browserError(`Download failed: ${message}`, { selector });
    });

    const failure = await download.failure().catch(() => null);
    if (failure) throw browserError(`Download failed: ${failure}`, { selector });

    const temporaryPath = await download.path().catch(() => null);
    if (!temporaryPath) throw browserError("Download produced no file", { selector });

    try {
      const bytes = await readFile(temporaryPath);
      const stored = await this.downloads.storeBytes(this.userId, {
        fileName: download.suggestedFilename(),
        bytes,
        sourceOrigin: origin,
      });
      return {
        downloadId: stored.downloadId,
        fileName: stored.fileName,
        byteSize: stored.byteSize,
        mimeType: stored.mimeType,
        sourceOrigin: stored.sourceOrigin,
      };
    } finally {
      await download.delete().catch(() => undefined);
    }
  }

  /**
   * Attaches a previously downloaded file to a file input.
   *
   * The only thing a caller can name is a `downloadId` this store already
   * issued to THIS user. There is no parameter that accepts a path, so
   * "upload /etc/shadow" has no expressible form — the containment is the
   * absence of the capability, not a check on its argument.
   */
  async upload(
    selector: string,
    downloadId: string,
    options: BrowserSessionOptions = {}
  ): Promise<BrowserUploadResult> {
    this.requireNavigated();

    const record = this.downloads.get(this.userId, downloadId);
    if (!record) {
      throw browserError("Unknown download id", { downloadId });
    }
    const path = await this.downloads.resolveForUpload(this.userId, downloadId);
    if (!path) {
      throw browserError("Stored file is no longer available", { downloadId });
    }

    await withAbort(
      this.page.setInputFiles(selector, path, {
        timeout: this.config.navigationTimeoutMs,
      }),
      options.signal
    ).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "upload failed";
      throw browserError(`Upload failed: ${message}`, { selector });
    });

    return {
      ...(await this.identity()),
      selector,
      downloadId,
      fileName: record.fileName,
    };
  }
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// In-page scripts
//
// Passed to `page.evaluate` as SOURCE STRINGS built here, never assembled from
// model output. Nothing a model says reaches these bodies; the only thing that
// crosses is the argument, which Playwright serialises as data.
// ---------------------------------------------------------------------------

const INSPECT_SCRIPT = `(options) => {
  const out = [];
  const nodes = document.querySelectorAll('a[href], button, input, select, textarea, form');
  for (const node of nodes) {
    if (out.length >= options.limit) break;
    const tag = node.tagName.toLowerCase();
    const rect = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
    if (rect && rect.width === 0 && rect.height === 0) continue;

    let selector = tag;
    if (node.id) selector = '#' + CSS.escape(node.id);
    else if (node.getAttribute('name')) selector = tag + '[name="' + node.getAttribute('name') + '"]';
    else if (node.getAttribute('data-testid')) selector = '[data-testid="' + node.getAttribute('data-testid') + '"]';

    const label = (node.getAttribute('aria-label') || node.getAttribute('placeholder') ||
      node.innerText || node.value || '').toString().slice(0, options.maxLabel);

    const entry = { selector: selector, tag: tag, label: label };
    const type = node.getAttribute('type');
    if (type) entry.type = type;
    if (tag === 'a' && node.href) entry.href = node.href;
    out.push(entry);
  }
  return out;
}`;

const BODY_TEXT_SCRIPT = `() => {
  const clone = document.body ? document.body.cloneNode(true) : null;
  if (!clone) return '';
  for (const node of clone.querySelectorAll('script, style, noscript, template')) {
    node.remove();
  }
  return clone.innerText || clone.textContent || '';
}`;

const FIELDS_SCRIPT = `(entries) => {
  const out = {};
  for (const [key, selector] of entries) {
    try {
      const node = document.querySelector(selector);
      out[key] = node ? (node.innerText || node.textContent || node.value || '') : '';
    } catch (err) {
      out[key] = '';
    }
  }
  return out;
}`;
