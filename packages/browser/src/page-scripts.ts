// ---------------------------------------------------------------------------
// The code that runs INSIDE a browsed page (Phase 19, P0 fix).
//
// Each export is passed to Playwright's `page.evaluate` as a FUNCTION.
// Playwright ships a function's own source to the page and calls it with the
// serialized argument. A STRING it evaluates as an expression and does not call
// (playwright-core 1.63: `isFunction: typeof pageFunction === "function"`, then
// `if (isFunction === false) result = result`). The source strings these
// replaced therefore evaluated to the arrow function itself, which serializes
// to `undefined`:
//   - `inspect` threw on `undefined.slice`;
//   - `extract` returned no text and no fields.
// No real browser had run them until the Phase 19 real-Chromium E2E
// (docs/phases/phase-19.md §21).
//
// Because each function is sent to the page as its own source text:
//   - each is SELF-CONTAINED: no import, no module-level helper, no closure;
//   - none declares a nested function or class. A bundler that keeps names
//     would inject a helper call into the body, and the helper does not exist
//     in the page;
//   - the only input is the argument, which Playwright serializes as data.
//     Nothing a model says reaches these bodies.
//
// The package is compiled without the DOM library (it runs in Node), so the
// page's objects are reached through `globalThis`, typed with only the members
// used here.
// ---------------------------------------------------------------------------

import type { BrowserElementSummary } from "@jarvis/core";

/** The few members of a DOM element these functions read. */
interface PageElement {
  readonly tagName: string;
  readonly id: string;
  readonly innerText?: string;
  readonly textContent: string | null;
  readonly value?: unknown;
  readonly href?: string;
  getAttribute(name: string): string | null;
  getBoundingClientRect?(): { width: number; height: number };
  querySelectorAll(selector: string): Iterable<PageElement>;
  cloneNode(deep: boolean): PageElement;
  remove(): void;
}

/** The page globals these functions use. */
interface PageGlobals {
  document: {
    body: PageElement | null;
    querySelectorAll(selector: string): Iterable<PageElement>;
    querySelector(selector: string): PageElement | null;
  };
  CSS: { escape(value: string): string };
}

/** The interactive elements of the page, each with a selector a later action can use. */
export function inspectPageElements(options: { limit: number; maxLabel: number }): BrowserElementSummary[] {
  const page = globalThis as unknown as PageGlobals;
  const out: BrowserElementSummary[] = [];
  const nodes = page.document.querySelectorAll("a[href], button, input, select, textarea, form");
  for (const node of nodes) {
    if (out.length >= options.limit) break;
    const tag = node.tagName.toLowerCase();
    const rect = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
    if (rect && rect.width === 0 && rect.height === 0) continue;

    let selector = tag;
    if (node.id) selector = "#" + page.CSS.escape(node.id);
    else if (node.getAttribute("name")) selector = tag + '[name="' + node.getAttribute("name") + '"]';
    else if (node.getAttribute("data-testid")) selector = '[data-testid="' + node.getAttribute("data-testid") + '"]';

    const label = String(
      node.getAttribute("aria-label") || node.getAttribute("placeholder") || node.innerText || node.value || ""
    ).slice(0, options.maxLabel);

    const entry: BrowserElementSummary = { selector: selector, tag: tag, label: label };
    const type = node.getAttribute("type");
    if (type) entry.type = type;
    if (tag === "a" && node.href) entry.href = node.href;
    out.push(entry);
  }
  return out;
}

/** The page's visible text, without script, style, noscript or template contents. */
export function pageBodyText(): string {
  const page = globalThis as unknown as PageGlobals;
  const clone = page.document.body ? page.document.body.cloneNode(true) : null;
  if (!clone) return "";
  for (const node of clone.querySelectorAll("script, style, noscript, template")) {
    node.remove();
  }
  return clone.innerText || clone.textContent || "";
}

/** One value per named selector; a selector that matches nothing, or is invalid, gives "". */
export function pageFieldValues(entries: ReadonlyArray<readonly [string, string]>): Record<string, string> {
  const page = globalThis as unknown as PageGlobals;
  const out: Record<string, string> = {};
  for (const [key, selector] of entries) {
    try {
      const node = page.document.querySelector(selector);
      out[key] = node ? String(node.innerText || node.textContent || node.value || "") : "";
    } catch {
      out[key] = "";
    }
  }
  return out;
}
