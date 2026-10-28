// ---------------------------------------------------------------------------
// Phase 19, Stage 19.2 — sessions, and the one place a tenant is bound.
//
// A session is opened by the API for ONE server-resolved subject. The binding
// is stored here and checked on EVERY later request. That is what makes a
// request-body organization id harmless: the body may claim anything, but a
// claim that differs from the binding is refused without the session being
// touched, and the binding itself came from the API's own authorization read.
//
// Isolation is a fresh browser context per session, inherited from
// @jarvis/browser. Two sessions — same user or different users — share no
// cookie jar and no storage. Artifacts are NOT per session: downloads and
// screenshots go to the runtime's one DownloadStore, keyed by user id, so every
// session of the same user in this process — in any Organization — can name
// them, and no other user can. Organization-scoped, durable artifacts are
// Stage 19.4. A session is ended by close, by expiry, or by process shutdown;
// all three reach the runtime's `finally`, which closes the context.
//
// Expiry is enforced here rather than only in the runtime because the service
// holds the session across requests: a client that stops talking must not keep
// a context alive, and the runtime's deadline is a backstop, not the clock the
// protocol promises.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";

import {
  BrowserServiceError,
  isBrowserServiceWriteOperation,
  type BrowserServiceSubject,
} from "@jarvis/browser-protocol";
import {
  BROWSER_TOOL_IDS,
  type BrowserControlRequest,
  type BrowserRuntimePort,
  type BrowserSessionPort,
} from "@jarvis/core";

export interface BrowserSessionRegistryOptions {
  sessionTtlMs: number;
  maxSessions: number;
  maxSessionsPerOrganization: number;
  /** How long `open` waits for a context to become usable. */
  openTimeoutMs: number;
  now?: () => number;
}

interface SessionEntry {
  readonly id: string;
  readonly subject: BrowserServiceSubject;
  readonly expiresAt: number;
  session: BrowserSessionPort | null;
  ended: boolean;
  closeSignal: () => void;
  resolveReady: () => void;
  rejectReady: (error: unknown) => void;
  readySettled: boolean;
}

export interface OpenedSession {
  sessionId: string;
  expiresAt: number;
  ttlMs: number;
}

function mapEngineError(error: unknown, write: boolean, signal?: AbortSignal): BrowserServiceError {
  // Stage 19.2 audit (H2). A write has been handed to the browser by the time
  // anything here can fail, and nothing in the engine's error says on which
  // side of the click, keystroke or submit it happened. So a failed write is
  // never reported as a plain failure: it is TIMEOUT when the deadline cut it
  // short and UNKNOWN_OUTCOME otherwise, and the API records either as UNKNOWN
  // — never retried. Refusals that precede the action (no session, another
  // tenant's session, an expired one) are thrown before `dispatch` and keep
  // their own codes.
  if (write) return new BrowserServiceError(signal?.aborted ? "TIMEOUT" : "UNKNOWN_OUTCOME");
  if (error instanceof BrowserServiceError) return error;
  if (signal?.aborted) return new BrowserServiceError("TIMEOUT");
  // A runtime's own error message can carry a URL, a page detail or a browser
  // diagnostic. None of it crosses the boundary. A read that could not be
  // performed is a provider failure; an engine that could not produce a
  // session at all is `UNAVAILABLE`, decided by the caller.
  return new BrowserServiceError("PROVIDER_ERROR");
}

function mapOpenError(error: unknown): BrowserServiceError {
  if (error instanceof BrowserServiceError) return error;
  return new BrowserServiceError("UNAVAILABLE");
}

export class BrowserSessionRegistry {
  private readonly entries = new Map<string, SessionEntry>();
  private readonly now: () => number;

  constructor(
    private readonly engine: BrowserRuntimePort,
    private readonly options: BrowserSessionRegistryOptions
  ) {
    this.now = options.now ?? Date.now;
  }

  get activeSessions(): number {
    return this.entries.size;
  }

  /** Ends every session whose TTL has passed. Safe to call at any time. */
  reap(): void {
    const now = this.now();
    for (const entry of [...this.entries.values()]) {
      if (entry.expiresAt <= now) this.end(entry);
    }
  }

  async open(subject: BrowserServiceSubject): Promise<OpenedSession> {
    this.reap();

    if (this.entries.size >= this.options.maxSessions) {
      throw new BrowserServiceError("LIMIT_EXCEEDED");
    }
    let forOrganization = 0;
    for (const entry of this.entries.values()) {
      if (entry.subject.organizationId === subject.organizationId) forOrganization += 1;
    }
    if (forOrganization >= this.options.maxSessionsPerOrganization) {
      throw new BrowserServiceError("LIMIT_EXCEEDED");
    }

    const id = randomUUID();
    const expiresAt = this.now() + this.options.sessionTtlMs;

    // The check above and the insert below happen in the same synchronous
    // turn, so two opens cannot both pass the ceiling.
    let closeSignal!: () => void;
    const closing = new Promise<void>((resolve) => {
      closeSignal = resolve;
    });
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const entry: SessionEntry = {
      id,
      subject: { userId: subject.userId, organizationId: subject.organizationId },
      expiresAt,
      session: null,
      ended: false,
      closeSignal,
      resolveReady,
      rejectReady,
      readySettled: false,
    };
    this.entries.set(id, entry);

    const run = this.engine.withSession(
      subject.userId,
      async (session) => {
        entry.session = session;
        if (!entry.ended) {
          entry.readySettled = true;
          entry.resolveReady();
        }
        // Held until the session is ended. The runtime's `finally` owns the
        // context and runs when this resolves, whatever the reason.
        await closing;
      },
      {}
    );

    run.then(
      () => undefined,
      (error: unknown) => {
        if (!entry.readySettled) {
          entry.readySettled = true;
          entry.rejectReady(error);
        }
      }
    ).finally(() => {
      entry.ended = true;
      this.entries.delete(entry.id);
      entry.closeSignal();
    });

    const readyOutcome = await Promise.race([
      ready.then(
        () => ({ kind: "ready" as const }),
        (error: unknown) => ({ kind: "failed" as const, error })
      ),
      this.delay(this.options.openTimeoutMs).then(() => ({ kind: "timeout" as const })),
    ]);

    if (readyOutcome.kind === "ready") {
      return { sessionId: id, expiresAt, ttlMs: this.options.sessionTtlMs };
    }

    // Nothing is left behind on a failed or slow open: ending the entry
    // resolves the held callback, so a context that appears later is closed
    // immediately by the runtime's `finally`.
    this.end(entry);
    throw readyOutcome.kind === "timeout"
      ? new BrowserServiceError("TIMEOUT")
      : mapOpenError(readyOutcome.error);
  }

  /**
   * Run one typed browser action against a session.
   *
   * The binding check happens before the session is read, so a request from
   * another Organization cannot observe whether its id is live.
   */
  async execute(
    sessionId: string,
    subject: BrowserServiceSubject,
    control: BrowserControlRequest,
    signal?: AbortSignal
  ): Promise<unknown> {
    this.reap();

    const entry = this.entries.get(sessionId);
    if (!entry) throw new BrowserServiceError("SESSION_NOT_FOUND");
    this.assertBinding(entry, subject);
    if (entry.expiresAt <= this.now()) {
      this.end(entry);
      throw new BrowserServiceError("SESSION_EXPIRED");
    }

    const session = entry.session;
    if (!session || entry.ended) throw new BrowserServiceError("SESSION_NOT_FOUND");

    try {
      return await this.dispatch(session, control, signal);
    } catch (error) {
      throw mapEngineError(error, isBrowserServiceWriteOperation(control.action), signal);
    }
  }

  /** Idempotent: closing a session that is already gone is not an error. */
  async close(sessionId: string, subject: BrowserServiceSubject): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.assertBinding(entry, subject);
    this.end(entry);
  }

  /** Ends every session, then gives the runtime a turn to close its contexts. */
  async shutdown(): Promise<void> {
    for (const entry of [...this.entries.values()]) this.end(entry);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await this.engine.shutdown();
  }

  private assertBinding(entry: SessionEntry, subject: BrowserServiceSubject): void {
    if (
      entry.subject.userId !== subject.userId ||
      entry.subject.organizationId !== subject.organizationId
    ) {
      throw new BrowserServiceError("CROSS_TENANT_DENIED");
    }
  }

  private end(entry: SessionEntry): void {
    if (entry.ended) return;
    entry.ended = true;
    this.entries.delete(entry.id);
    entry.closeSignal();
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      // An unref'd timer must not keep a shutting-down process alive.
      timer.unref?.();
    });
  }

  private async dispatch(
    session: BrowserSessionPort,
    control: BrowserControlRequest,
    signal?: AbortSignal
  ): Promise<unknown> {
    const options = { signal };

    // Only `browser.navigate` navigates. Every other action acts on the
    // session's CURRENT page: the Phase 19.1 request shape names a page on
    // every action (a tool call navigates and then acts), but honouring that
    // field here would let a request redirect a session between the navigation
    // an approval was given for and the action itself. The result carries the
    // page identity that was actually acted on, so the API always learns where
    // the action happened.
    switch (control.action) {
      case BROWSER_TOOL_IDS.navigate: {
        const result = await session.navigate(control.url, options);
        return {
          action: control.action,
          ok: true,
          page: { url: result.url, title: result.title, status: result.status },
          redirected: result.redirected,
        };
      }
      case BROWSER_TOOL_IDS.inspect: {
        const result = await session.inspect(options);
        return {
          action: control.action,
          ok: true,
          page: { url: result.url, title: result.title, status: result.status },
          elements: result.elements,
          truncated: result.truncated,
        };
      }
      case BROWSER_TOOL_IDS.extract: {
        const result = await session.extract(control.selectors, options);
        return {
          action: control.action,
          ok: true,
          page: { url: result.url, title: result.title, status: result.status },
          text: result.text,
          fields: result.fields,
          truncated: result.truncated,
        };
      }
      case BROWSER_TOOL_IDS.screenshot: {
        const result = await session.screenshot(options);
        return {
          action: control.action,
          ok: true,
          page: { url: result.url, title: result.title, status: result.status },
          screenshotId: result.screenshotId,
          byteSize: result.byteSize,
          format: result.format,
        };
      }
      case BROWSER_TOOL_IDS.click: {
        const result = await session.click(control.selector, options);
        return this.actionResult(control.action, result);
      }
      case BROWSER_TOOL_IDS.type: {
        const result = await session.type(control.selector, control.text, options);
        return this.actionResult(control.action, result);
      }
      case BROWSER_TOOL_IDS.select: {
        const result = await session.select(control.selector, control.value, options);
        return this.actionResult(control.action, result);
      }
      case BROWSER_TOOL_IDS.submit: {
        const result = await session.submit(control.selector, options);
        return this.actionResult(control.action, result);
      }
      case BROWSER_TOOL_IDS.download: {
        const result = await session.download(control.selector, options);
        return {
          action: control.action,
          ok: true,
          downloadId: result.downloadId,
          fileName: result.fileName,
          byteSize: result.byteSize,
          mimeType: result.mimeType,
          sourceOrigin: result.sourceOrigin,
        };
      }
      case BROWSER_TOOL_IDS.upload: {
        const result = await session.upload(control.selector, control.downloadId, options);
        return {
          action: control.action,
          ok: true,
          page: { url: result.url, title: result.title, status: result.status },
          selector: result.selector,
          downloadId: result.downloadId,
          fileName: result.fileName,
        };
      }
    }
  }

  private actionResult(
    action:
      | typeof BROWSER_TOOL_IDS.click
      | typeof BROWSER_TOOL_IDS.type
      | typeof BROWSER_TOOL_IDS.select
      | typeof BROWSER_TOOL_IDS.submit,
    result: { url: string; title: string; status: number | null; selector: string; navigated: boolean }
  ): unknown {
    return {
      action,
      ok: true,
      page: { url: result.url, title: result.title, status: result.status },
      selector: result.selector,
      navigated: result.navigated,
    };
  }
}
