// ---------------------------------------------------------------------------
// Phase 19, Stage 19.2 — the typed client behind the existing browser tools.
//
// It implements the SAME `BrowserRuntimePort` the in-process runtime does, so
// not one tool changed: `createBrowserTools(runtime, …)` receives this instead
// of a Playwright runtime. The execution grant, the approval gate, the
// Organization write scope and the journal all still run in the executor and
// the tools, BEFORE any method here is reached.
//
// The session is opened per `withSession` call and closed in `finally`. That
// mirrors the in-process runtime's guarantee — a session never outlives the
// call that created it — and means an approval-gated tool that pauses for a
// person does not keep a browser context alive in the service.
//
// The Organization is resolved by the API server-side through
// `BrowserSessionTenantPort`; it is never read from a tool parameter or a
// request body. The service binds that organization to the session and
// refuses every later request whose claim differs.
// ---------------------------------------------------------------------------

import {
  BrowserControlResultSchema,
  BROWSER_TOOL_IDS,
  type BrowserActionResult,
  type BrowserControlActionId,
  type BrowserDownloadResult,
  type BrowserExtractResult,
  type BrowserInspectResult,
  type BrowserNavigateResult,
  type BrowserRuntimePort,
  type BrowserScreenshotResult,
  type BrowserSessionOptions,
  type BrowserSessionPort,
  type BrowserUploadResult,
} from "@jarvis/core";

import type { BrowserServiceClient } from "./client.js";
import {
  BrowserServiceSessionOpenedSchema,
  isBrowserServiceWriteOperation,
  type BrowserServiceSubject,
} from "./contract.js";
import { BrowserServiceError } from "./errors.js";

/**
 * A result that does not match what was asked for (Stage 19.2 audit, H2).
 *
 * The service answered, so for a write the action ran or may have run: the
 * outcome is uncertain, never a failure that a new approval could repeat. For
 * a read there is nothing outside JARVIS to be uncertain about.
 */
function unexpectedResult(action: BrowserControlActionId): BrowserServiceError {
  return new BrowserServiceError(
    "PROVIDER_ERROR",
    isBrowserServiceWriteOperation(action) ? "uncertain" : "no-effect"
  );
}

/**
 * The API's server-side answer to "which Organization owns this browser
 * connection for this user?".
 *
 * Implemented over the Phase 17 shared-connection reader. A resolver that
 * throws, or answers `ok: false`, refuses the session: an authorization
 * lookup that cannot be made is never an allow.
 */
export interface BrowserSessionTenantPort {
  resolveSessionOrganization(
    userId: string
  ): Promise<{ ok: true; organizationId: string } | { ok: false }>;
}

export interface RemoteBrowserRuntimeDeps {
  client: BrowserServiceClient;
  tenant: BrowserSessionTenantPort;
}

export class RemoteBrowserRuntime implements BrowserRuntimePort {
  constructor(private readonly deps: RemoteBrowserRuntimeDeps) {}

  async withSession<T>(
    userId: string,
    run: (session: BrowserSessionPort) => Promise<T>,
    options: BrowserSessionOptions = {}
  ): Promise<T> {
    if (typeof userId !== "string" || userId.length === 0) {
      throw new BrowserServiceError("NOT_AUTHORIZED");
    }

    let resolved: { ok: true; organizationId: string } | { ok: false };
    try {
      resolved = await this.deps.tenant.resolveSessionOrganization(userId);
    } catch {
      throw new BrowserServiceError("NOT_AUTHORIZED");
    }
    if (!resolved.ok) throw new BrowserServiceError("NOT_AUTHORIZED");

    const subject: BrowserServiceSubject = {
      userId,
      organizationId: resolved.organizationId,
    };

    const openedRaw = await this.deps.client.execute(
      { operation: "session.open", subject },
      options.signal
    );
    const opened = BrowserServiceSessionOpenedSchema.safeParse(openedRaw);
    // A session operation acts on nothing outside JARVIS; a session that was
    // opened and not understood is reaped by the service's TTL.
    if (!opened.success) throw new BrowserServiceError("PROVIDER_ERROR", "no-effect");

    const session = new RemoteBrowserSession(this.deps.client, subject, opened.data.sessionId);
    try {
      return await run(session);
    } finally {
      // No caller signal here: a turn that timed out must still release its
      // browser context. The service's own session TTL is the backstop if this
      // close is lost.
      await this.deps.client
        .execute({
          operation: "session.close",
          sessionId: opened.data.sessionId,
          subject,
        })
        .catch(() => undefined);
    }
  }

  /**
   * Nothing to close in the API.
   *
   * Sessions are owned by the service and closed by `withSession`; the client
   * is stateless. Registered with the shutdown lifecycle anyway so the shape
   * matches every other runtime port.
   */
  async shutdown(): Promise<void> {
    return undefined;
  }
}

/**
 * One remote session.
 *
 * The only fields that cross the wire are the ones the Phase 19.1 request
 * contract already permits. There is no method here for a cookie, a raw page
 * handle, a script, a file path or a CDP command, and none can be added
 * without adding an operation the service does not implement.
 */
class RemoteBrowserSession implements BrowserSessionPort {
  /**
   * The final URL of the last successful navigation.
   *
   * The Phase 19.1 browser contract names a page on EVERY action — a tool call
   * navigates and then acts. Over a stateful remote session the navigation is
   * its own RPC, so later actions carry the page they were navigated to. The
   * service acts on the session's current page and ignores this field for
   * every action except `browser.navigate`, so it cannot redirect a session;
   * it is here because the contract requires it, and it is the final URL (not
   * the requested one) because that is the page the tool actually acted on.
   */
  private lastUrl: string | null = null;

  constructor(
    private readonly client: BrowserServiceClient,
    private readonly subject: BrowserServiceSubject,
    private readonly sessionId: string
  ) {}

  private requireUrl(): string {
    // Every tool navigates before it acts. A caller that did not is refused
    // rather than sent to a page it never asked the service to open — before
    // anything is sent, so the refusal is a known failure.
    if (this.lastUrl === null) throw new BrowserServiceError("PROVIDER_ERROR", "not-sent");
    return this.lastUrl;
  }

  private async call(
    action: BrowserControlActionId,
    payload: Record<string, unknown>,
    options?: BrowserSessionOptions
  ) {
    const raw = await this.client.execute(
      { operation: action, sessionId: this.sessionId, subject: this.subject, payload },
      options?.signal
    );
    const parsed = BrowserControlResultSchema.safeParse(raw);
    if (!parsed.success || parsed.data.action !== action) {
      // A result for another action, or one that does not match the contract,
      // is not something to guess at. It is refused as a provider failure.
      throw unexpectedResult(action);
    }
    return parsed.data;
  }

  async navigate(url: string, options?: BrowserSessionOptions): Promise<BrowserNavigateResult> {
    const result = await this.call(BROWSER_TOOL_IDS.navigate, { url }, options);
    if (result.action !== BROWSER_TOOL_IDS.navigate) throw unexpectedResult(BROWSER_TOOL_IDS.navigate);
    this.lastUrl = result.page.url;
    return { ...result.page, redirected: result.redirected };
  }

  async inspect(options?: BrowserSessionOptions): Promise<BrowserInspectResult> {
    const result = await this.call(BROWSER_TOOL_IDS.inspect, { url: this.requireUrl() }, options);
    if (result.action !== BROWSER_TOOL_IDS.inspect) throw unexpectedResult(BROWSER_TOOL_IDS.inspect);
    return { ...result.page, elements: result.elements, truncated: result.truncated };
  }

  async extract(
    selectors?: Record<string, string>,
    options?: BrowserSessionOptions
  ): Promise<BrowserExtractResult> {
    const payload =
      selectors === undefined
        ? { url: this.requireUrl() }
        : { url: this.requireUrl(), selectors };
    const result = await this.call(BROWSER_TOOL_IDS.extract, payload, options);
    if (result.action !== BROWSER_TOOL_IDS.extract) throw unexpectedResult(BROWSER_TOOL_IDS.extract);
    return { ...result.page, text: result.text, fields: result.fields, truncated: result.truncated };
  }

  async screenshot(options?: BrowserSessionOptions): Promise<BrowserScreenshotResult> {
    const result = await this.call(
      BROWSER_TOOL_IDS.screenshot,
      { url: this.requireUrl() },
      options
    );
    if (result.action !== BROWSER_TOOL_IDS.screenshot) throw unexpectedResult(BROWSER_TOOL_IDS.screenshot);
    return {
      ...result.page,
      screenshotId: result.screenshotId,
      byteSize: result.byteSize,
      format: result.format,
    };
  }

  async click(selector: string, options?: BrowserSessionOptions): Promise<BrowserActionResult> {
    return this.action(BROWSER_TOOL_IDS.click, { url: this.requireUrl(), selector }, options);
  }

  async type(
    selector: string,
    text: string,
    options?: BrowserSessionOptions
  ): Promise<BrowserActionResult> {
    return this.action(BROWSER_TOOL_IDS.type, { url: this.requireUrl(), selector, text }, options);
  }

  async select(
    selector: string,
    value: string,
    options?: BrowserSessionOptions
  ): Promise<BrowserActionResult> {
    return this.action(
      BROWSER_TOOL_IDS.select,
      { url: this.requireUrl(), selector, value },
      options
    );
  }

  async submit(selector: string, options?: BrowserSessionOptions): Promise<BrowserActionResult> {
    return this.action(BROWSER_TOOL_IDS.submit, { url: this.requireUrl(), selector }, options);
  }

  private async action(
    id:
      | typeof BROWSER_TOOL_IDS.click
      | typeof BROWSER_TOOL_IDS.type
      | typeof BROWSER_TOOL_IDS.select
      | typeof BROWSER_TOOL_IDS.submit,
    payload: Record<string, unknown>,
    options?: BrowserSessionOptions
  ): Promise<BrowserActionResult> {
    const result = await this.call(id, payload, options);
    if (
      result.action !== BROWSER_TOOL_IDS.click &&
      result.action !== BROWSER_TOOL_IDS.type &&
      result.action !== BROWSER_TOOL_IDS.select &&
      result.action !== BROWSER_TOOL_IDS.submit
    ) {
      throw unexpectedResult(id);
    }
    return { ...result.page, selector: result.selector, navigated: result.navigated };
  }

  async download(
    selector: string,
    options?: BrowserSessionOptions
  ): Promise<BrowserDownloadResult> {
    const result = await this.call(
      BROWSER_TOOL_IDS.download,
      { url: this.requireUrl(), selector },
      options
    );
    if (result.action !== BROWSER_TOOL_IDS.download) throw unexpectedResult(BROWSER_TOOL_IDS.download);
    return {
      downloadId: result.downloadId,
      fileName: result.fileName,
      byteSize: result.byteSize,
      mimeType: result.mimeType,
      sourceOrigin: result.sourceOrigin,
    };
  }

  async upload(
    selector: string,
    downloadId: string,
    options?: BrowserSessionOptions
  ): Promise<BrowserUploadResult> {
    const result = await this.call(
      BROWSER_TOOL_IDS.upload,
      { url: this.requireUrl(), selector, downloadId },
      options
    );
    if (result.action !== BROWSER_TOOL_IDS.upload) throw unexpectedResult(BROWSER_TOOL_IDS.upload);
    return {
      ...result.page,
      selector: result.selector,
      downloadId: result.downloadId,
      fileName: result.fileName,
    };
  }
}
