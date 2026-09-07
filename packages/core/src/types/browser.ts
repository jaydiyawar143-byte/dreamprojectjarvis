// ---------------------------------------------------------------------------
// Sprint 7.0 — Browser Agent contracts.
//
// The Browser Agent is a TOOL DOMAIN over the existing JARVIS pipeline, not a
// second authorization system. Nothing in this file knows how to drive Chrome:
// it declares what a browser action is allowed to look like and what it is
// allowed to return, so that the tool layer, the agent and the runtime all
// agree without importing each other.
//
// Every security property — the tool allowlist, permission checks, the approval
// gate, tenant isolation, the execution journal, audit — is inherited from the
// ordinary tool pipeline precisely because browsing does not reimplement it.
// The one thing browsing DOES add is a navigation policy, and that lives in
// @jarvis/browser because it needs DNS.
//
// This module is types and pure data only.
// ---------------------------------------------------------------------------

import { z } from "zod";

// ---------------------------------------------------------------------------
// Action policy — LOCKED Sprint 7 decision
// ---------------------------------------------------------------------------

/**
 * What a browser session may and may not be asked to do.
 *
 * The FORBIDDEN list is not a runtime filter — it is a statement of what the
 * runtime deliberately has no code path for. There is no shell tool, no
 * filesystem tool, no "evaluate arbitrary JavaScript" tool, and no way to hand
 * a raw Playwright handle to a caller. A capability that does not exist cannot
 * be talked into existing by a model, which is a stronger guarantee than a
 * denylist checked at call time.
 *
 * Credential handling is absent for the same reason: v1 stores no browser
 * credentials at all, so there is nothing for a prompt to extract. Every
 * session starts from an empty browser profile and is destroyed afterwards.
 */
export const BROWSER_ACTION_POLICY = Object.freeze({
  /** Reading a page never needs human approval. */
  readRequiresApproval: false,
  /**
   * Everything that touches a page requires approval in v1.
   *
   * The Sprint 6.10 gate refuses any non-READ_ONLY tool from an agent whose
   * policy sets `writesRequireApproval` unless the tool is itself
   * approval-gated. Clicking "Buy now" is a click, so the safe direction and
   * the architecturally permitted direction agree.
   */
  interactionRequiresApproval: true,
  /** No stored cookies, no stored credentials, no persisted browser profile. */
  persistsSession: false,
  /** The model never receives a page handle, a cookie, or a filesystem path. */
  exposesRawHandles: false,
} as const);

/** Capabilities the browser runtime intentionally does not implement. */
export const BROWSER_FORBIDDEN_CAPABILITIES: readonly string[] = Object.freeze([
  "shell-execution",
  "arbitrary-filesystem-access",
  "arbitrary-script-evaluation",
  "credential-storage",
  "cookie-extraction",
  "captcha-solving",
  "authentication-bypass",
  "cross-tenant-access",
]);

// ---------------------------------------------------------------------------
// Tool identity
// ---------------------------------------------------------------------------

/**
 * Registry ids for the browser tools.
 *
 * Dotted, like every other tool id in the repo (`meta.insights`,
 * `whatsapp.send`). The container sanitizes dots out before the ids reach a
 * model and maps them back on the way in.
 */
export const BROWSER_TOOL_IDS = Object.freeze({
  navigate: "browser.navigate",
  inspect: "browser.inspect",
  extract: "browser.extract",
  screenshot: "browser.screenshot",
  click: "browser.click",
  type: "browser.type",
  select: "browser.select",
  submit: "browser.submit",
  download: "browser.download",
  upload: "browser.upload",
} as const);

export type BrowserToolId = (typeof BROWSER_TOOL_IDS)[keyof typeof BROWSER_TOOL_IDS];

/** Read-only tools: no approval, no page mutation. */
export const BROWSER_READ_TOOL_IDS: readonly string[] = Object.freeze([
  BROWSER_TOOL_IDS.navigate,
  BROWSER_TOOL_IDS.inspect,
  BROWSER_TOOL_IDS.extract,
  BROWSER_TOOL_IDS.screenshot,
]);

/** Tools that act on a page. Every one is approval-gated. */
export const BROWSER_ACTION_TOOL_IDS: readonly string[] = Object.freeze([
  BROWSER_TOOL_IDS.click,
  BROWSER_TOOL_IDS.type,
  BROWSER_TOOL_IDS.select,
  BROWSER_TOOL_IDS.submit,
  BROWSER_TOOL_IDS.download,
  BROWSER_TOOL_IDS.upload,
]);

export const ALL_BROWSER_TOOL_IDS: readonly string[] = Object.freeze([
  ...BROWSER_READ_TOOL_IDS,
  ...BROWSER_ACTION_TOOL_IDS,
]);

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/**
 * A CSS selector supplied by the model.
 *
 * Bounded in length and refused outright when it carries the angle brackets or
 * braces that mean somebody is trying to pass markup or script where a selector
 * belongs. Playwright would reject most of these anyway; refusing here keeps
 * the rejection in our own error vocabulary rather than a library's.
 */
export const BrowserSelectorSchema = z
  .string()
  .min(1, "selector is required")
  .max(512, "selector is too long")
  .refine((value) => !/[<>{}]/.test(value), "selector must not contain markup");

/** Text typed into a field. Bounded so a single call cannot paste a novel. */
export const BrowserInputTextSchema = z.string().max(10_000, "text is too long");

export const BROWSER_MAX_EXTRACT_FIELDS = 25;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** Where a page ended up, which is not always where it was asked to go. */
export interface BrowserPageIdentity {
  /** The URL after every redirect. */
  url: string;
  /** The page title, empty when the document has none. */
  title: string;
  /** HTTP status of the main document, null when the browser reported none. */
  status: number | null;
}

export interface BrowserNavigateResult extends BrowserPageIdentity {
  /** True when the final URL differs from the requested one. */
  redirected: boolean;
}

/** One interactive element the agent could act on next. */
export interface BrowserElementSummary {
  /** A selector stable enough to pass back into a later call. */
  selector: string;
  /** `a`, `button`, `input`, `select`, `textarea`, `form`. */
  tag: string;
  /** Visible label, placeholder or accessible name. Truncated. */
  label: string;
  /** `input` type, when the element has one. */
  type?: string;
  /** Present for links only, and always an absolute URL. */
  href?: string;
}

export interface BrowserInspectResult extends BrowserPageIdentity {
  elements: BrowserElementSummary[];
  /** True when the element list was cut short by the cap. */
  truncated: boolean;
}

export interface BrowserExtractResult extends BrowserPageIdentity {
  /** Normalized page text, capped. */
  text: string;
  /** Per-selector extractions, present only when selectors were requested. */
  fields: Record<string, string>;
  /** True when `text` was cut short by the cap. */
  truncated: boolean;
}

export interface BrowserScreenshotResult extends BrowserPageIdentity {
  /**
   * Opaque id of the stored image.
   *
   * A screenshot is never returned inline: a base64 PNG of a full page is
   * enormous, and putting one into a model context is both expensive and
   * useless to it.
   */
  screenshotId: string;
  byteSize: number;
  format: "png";
}

/** The result of acting on a page. */
export interface BrowserActionResult extends BrowserPageIdentity {
  /** Which element was acted on, echoed back for the audit trail. */
  selector: string;
  /** True when the action caused the page to navigate. */
  navigated: boolean;
}

export interface BrowserDownloadResult {
  /** Opaque handle. Never a filesystem path — the model must not learn one. */
  downloadId: string;
  fileName: string;
  byteSize: number;
  /** Canonical type for the detected format, not the server's claim. */
  mimeType: string;
  /** Origin the file came from, for audit. */
  sourceOrigin: string;
}

export interface BrowserUploadResult extends BrowserPageIdentity {
  selector: string;
  /** The handle that was uploaded, echoed for audit. */
  downloadId: string;
  fileName: string;
}

// ---------------------------------------------------------------------------
// The port the tool layer talks to
// ---------------------------------------------------------------------------

export interface BrowserSessionOptions {
  /** Forwarded from `ToolContext.signal` so the executor's deadline wins. */
  signal?: AbortSignal;
}

/**
 * One isolated browsing session.
 *
 * Implemented by @jarvis/browser over Playwright; the tool layer only ever sees
 * this interface, so no tool can reach a `Page`, a `BrowserContext`, a cookie
 * jar or a filesystem path. That containment is structural, not conventional.
 */
export interface BrowserSessionPort {
  navigate(url: string, options?: BrowserSessionOptions): Promise<BrowserNavigateResult>;
  inspect(options?: BrowserSessionOptions): Promise<BrowserInspectResult>;
  extract(
    selectors?: Record<string, string>,
    options?: BrowserSessionOptions
  ): Promise<BrowserExtractResult>;
  screenshot(options?: BrowserSessionOptions): Promise<BrowserScreenshotResult>;
  click(selector: string, options?: BrowserSessionOptions): Promise<BrowserActionResult>;
  type(
    selector: string,
    text: string,
    options?: BrowserSessionOptions
  ): Promise<BrowserActionResult>;
  select(
    selector: string,
    value: string,
    options?: BrowserSessionOptions
  ): Promise<BrowserActionResult>;
  submit(selector: string, options?: BrowserSessionOptions): Promise<BrowserActionResult>;
  download(
    selector: string,
    options?: BrowserSessionOptions
  ): Promise<BrowserDownloadResult>;
  upload(
    selector: string,
    downloadId: string,
    options?: BrowserSessionOptions
  ): Promise<BrowserUploadResult>;
}

/**
 * Opens an isolated session for one user and guarantees it is destroyed.
 *
 * The callback shape exists so no caller can hold a session past its cleanup —
 * `withSession` owns the `finally`, not the tool.
 */
export interface BrowserRuntimePort {
  withSession<T>(
    userId: string,
    run: (session: BrowserSessionPort) => Promise<T>,
    options?: BrowserSessionOptions
  ): Promise<T>;
  shutdown(): Promise<void>;
}
