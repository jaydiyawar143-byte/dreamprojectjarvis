// ---------------------------------------------------------------------------
// Phase 19, P0 — the functions that run inside a browsed page, and the
// contract Playwright runs them under.
//
// The first real-Chromium E2E found that `inspect` threw and `extract`
// returned nothing. Their in-page scripts were SOURCE STRINGS. playwright-core
// 1.63 sends a string with `isFunction: false`, evaluates it as an expression,
// and returns what it evaluates to — here, the arrow function itself,
// uncalled, which serializes to `undefined`. The fake page in session.test.ts
// matched on the strings' contents, so no test could see it.
//
// This file reproduces Playwright 1.63's contract exactly (client:
// `String(pageFunction)` and `isFunction: typeof pageFunction === "function"`;
// page: `normalizeEvaluationExpression`, `eval`, then call only when
// `isFunction` is true, then return by value). It runs each function from its
// own source text in an ISOLATED context whose only globals are a small fake
// DOM, which proves the functions are self-contained.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { createBrowserConfig } from "../src/config.js";
import { DownloadStore } from "../src/download.js";
import { inspectPageElements, pageBodyText, pageFieldValues } from "../src/page-scripts.js";
import { BrowserSession, type PageLike, type RouteLike } from "../src/session.js";

// ---------------------------------------------------------------------------
// A small DOM: enough for the three functions, nothing more.
// ---------------------------------------------------------------------------

class FakeElement {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  value?: string;

  constructor(
    readonly tag: string,
    readonly attrs: Record<string, string> = {},
    readonly text = "",
    readonly size = { width: 100, height: 20 }
  ) {
    if (attrs.value !== undefined) this.value = attrs.value;
  }

  append(...children: FakeElement[]): this {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
    return this;
  }

  get tagName(): string {
    return this.tag.toUpperCase();
  }
  get id(): string {
    return this.attrs.id ?? "";
  }
  get href(): string | undefined {
    return this.tag === "a" && this.attrs.href ? `http://fixture.example${this.attrs.href}` : undefined;
  }
  get innerText(): string {
    return [this.text, ...this.children.map((child) => child.innerText)].filter(Boolean).join(" ");
  }
  get textContent(): string {
    return this.innerText;
  }
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
  getBoundingClientRect(): { width: number; height: number } {
    return this.size;
  }
  private descendants(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
  private static matches(element: FakeElement, selector: string): boolean {
    const part = selector.trim();
    if (/[^a-z0-9#[\]_-]/i.test(part)) throw new Error(`SyntaxError: '${part}' is not a valid selector`);
    if (part.startsWith("#")) return element.id === part.slice(1);
    const attr = /^([a-z]+)\[([a-z-]+)\]$/.exec(part);
    if (attr) return element.tag === attr[1] && element.attrs[attr[2]!] !== undefined;
    return element.tag === part;
  }
  querySelectorAll(selector: string): FakeElement[] {
    const parts = selector.split(",");
    return this.descendants().filter((element) => parts.some((part) => FakeElement.matches(element, part)));
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  cloneNode(): FakeElement {
    const copy = new FakeElement(this.tag, { ...this.attrs }, this.text, this.size);
    copy.append(...this.children.map((child) => child.cloneNode()));
    return copy;
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
}

function fixtureBody(): FakeElement {
  return new FakeElement("body").append(
    new FakeElement("h1", {}, "JARVIS fixture"),
    new FakeElement("p", { id: "marker" }, "fixture-marker-7c1d"),
    new FakeElement("script", {}, "document.title = 'never extracted'"),
    new FakeElement("style", {}, ".never { extracted: true }"),
    new FakeElement("a", { id: "dl", href: "/files/report.csv" }, "Download the report"),
    new FakeElement("form", { id: "contact" }).append(
      new FakeElement("input", { id: "email", name: "email", type: "text", placeholder: "Your email" }),
      new FakeElement("input", { name: "topic", type: "text", value: "billing" }),
      new FakeElement("button", { "data-testid": "send-button", type: "submit" }, "Send"),
      new FakeElement("button", { id: "hidden" }, "Hidden", { width: 0, height: 0 }),
      new FakeElement("button", { id: "labelled", "aria-label": "A very long accessible label for this button" }, "x")
    )
  );
}

/** A page context with nothing in it but the fake DOM: no Node, no module scope. */
function pageRealm(body: FakeElement) {
  return createContext({
    document: {
      body,
      querySelectorAll: (selector: string) => body.querySelectorAll(selector),
      querySelector: (selector: string) => body.querySelector(selector),
    },
    CSS: { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`) },
  });
}

/** playwright-core 1.63's `normalizeEvaluationExpression`, as shipped. */
function normalizeEvaluationExpression(expression: string, isFunction: boolean): string {
  let text = expression.trim();
  if (isFunction) {
    try {
      new Function(`(${text})`);
    } catch {
      text = text.startsWith("async ") ? `async function ${text.slice("async ".length)}` : `function ${text}`;
    }
  }
  if (/^(async)?\s*function(\s|\()/.test(text)) text = `(${text})`;
  return text;
}

/**
 * `page.evaluate` as playwright-core 1.63 performs it: the client sends the
 * source and `isFunction: typeof pageFunction === "function"`; the page
 * evaluates, calls only when `isFunction` is true, and returns BY VALUE (a
 * function is not a value: it arrives as `undefined`).
 */
function playwrightEvaluate(body: FakeElement, pageFunction: unknown, arg?: unknown): unknown {
  const isFunction = typeof pageFunction === "function";
  const expression = normalizeEvaluationExpression(String(pageFunction), isFunction);
  let result: unknown = runInContext(expression, pageRealm(body));
  if (isFunction === true) result = (result as (value: unknown) => unknown)(arg);
  if (typeof result === "function" || result === undefined) return undefined;
  return JSON.parse(JSON.stringify(result));
}

// ---------------------------------------------------------------------------
// 1. The defect, and the functions that replace the strings
// ---------------------------------------------------------------------------

describe("Phase 19, P0 — in-page functions under Playwright 1.63's evaluate contract", () => {
  it("a SOURCE STRING is evaluated and never called: the defect the E2E found", () => {
    const body = fixtureBody();
    // The same source, passed as a string, as session.ts did before the fix.
    expect(playwrightEvaluate(body, String(inspectPageElements), { limit: 50, maxLabel: 20 })).toBeUndefined();
    expect(playwrightEvaluate(body, String(pageBodyText))).toBeUndefined();
    expect(playwrightEvaluate(body, String(pageFieldValues), [["marker", "#marker"]])).toBeUndefined();
  });

  it("inspectPageElements runs from its own source and lists the controls, with usable selectors", () => {
    const elements = playwrightEvaluate(fixtureBody(), inspectPageElements, { limit: 50, maxLabel: 20 }) as Array<
      Record<string, string>
    >;
    expect(elements).toEqual([
      { selector: "#dl", tag: "a", label: "Download the report", href: "http://fixture.example/files/report.csv" },
      { selector: "#contact", tag: "form", label: "Send Hidden x" },
      { selector: "#email", tag: "input", label: "Your email", type: "text" },
      { selector: 'input[name="topic"]', tag: "input", label: "billing", type: "text" },
      { selector: '[data-testid="send-button"]', tag: "button", label: "Send", type: "submit" },
      // The zero-size button is skipped; the aria-label wins and is cut to maxLabel.
      { selector: "#labelled", tag: "button", label: "A very long accessib" },
    ]);
  });

  it("inspectPageElements stops at the limit it is given", () => {
    const elements = playwrightEvaluate(fixtureBody(), inspectPageElements, { limit: 2, maxLabel: 20 }) as unknown[];
    expect(elements).toHaveLength(2);
  });

  it("pageBodyText runs from its own source and returns the text without script or style", () => {
    const body = fixtureBody();
    const text = playwrightEvaluate(body, pageBodyText) as string;
    expect(text).toContain("JARVIS fixture");
    expect(text).toContain("fixture-marker-7c1d");
    expect(text).not.toContain("never extracted");
    // It reads a clone: the live page is not changed.
    expect(body.querySelectorAll("script")).toHaveLength(1);
  });

  it("pageFieldValues runs from its own source: one value per selector, '' for none or an invalid selector", () => {
    expect(
      playwrightEvaluate(fixtureBody(), pageFieldValues, [
        ["marker", "#marker"],
        ["topic", "#missing"],
        ["broken", "p!!"],
      ])
    ).toEqual({ marker: "fixture-marker-7c1d", topic: "", broken: "" });
  });

  it("each function is self-contained: no module helper, import or name-keeping call in its source", () => {
    for (const fn of [inspectPageElements, pageBodyText, pageFieldValues]) {
      const source = String(fn);
      expect(source).not.toMatch(/__name|require\(|import\(|\bexports\b|_page_scripts|_core\./);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The session, end to end, against a page that honours that contract
// ---------------------------------------------------------------------------

class PlaywrightContractPage implements PageLike {
  private currentUrl = "about:blank";
  readonly body = fixtureBody();

  async goto(url: string) {
    this.currentUrl = url;
    return { status: () => 200 };
  }
  url(): string {
    return this.currentUrl;
  }
  async title(): Promise<string> {
    return "JARVIS fixture";
  }
  async content(): Promise<string> {
    return "";
  }
  async screenshot(): Promise<Buffer> {
    return Buffer.alloc(0);
  }
  async click(): Promise<void> {}
  async fill(): Promise<void> {}
  async selectOption(): Promise<unknown> {
    return [];
  }
  async evaluate<R, A>(pageFunction: (arg: A) => R, arg?: A): Promise<R> {
    return playwrightEvaluate(this.body, pageFunction, arg) as R;
  }
  async waitForTimeout(): Promise<void> {}
  setDefaultTimeout(): void {}
  setDefaultNavigationTimeout(): void {}
  async waitForEvent(): Promise<never> {
    throw new Error("no download");
  }
  async setInputFiles(): Promise<void> {}
}

async function session(page: PageLike): Promise<BrowserSession> {
  const root = await mkdtemp(join(tmpdir(), "jarvis-page-scripts-"));
  const config = createBrowserConfig({ chromePath: "C:/fake/chrome.exe", downloadDir: root }, {} as NodeJS.ProcessEnv);
  const downloads = new DownloadStore({
    root,
    maxBytes: 1024 * 1024,
    retentionMs: 60 * 60 * 1000,
    maxBytesPerUser: 10 * 1024 * 1024,
    maxBytesPerOrganization: 10 * 1024 * 1024,
    maxArtifactsPerUser: 10,
    maxArtifactsPerOrganization: 10,
  });
  return new BrowserSession({
    page,
    context: { route: async (_p: string, _h: (route: RouteLike) => Promise<void>) => undefined, close: async () => undefined },
    config,
    policy: { resolveHost: async () => ["93.184.216.34"] },
    downloads,
    userId: "user-1",
    organizationId: "org-1",
  });
}

describe("Phase 19, P0 — BrowserSession.inspect and extract read the page", () => {
  it("inspect returns the page's controls (before the fix it threw: the result was undefined)", async () => {
    const browserSession = await session(new PlaywrightContractPage());
    await browserSession.navigate("http://fixture.example/");
    const inspected = await browserSession.inspect();
    expect(inspected.title).toBe("JARVIS fixture");
    expect(inspected.elements.map((element) => element.selector)).toEqual([
      "#dl",
      "#contact",
      "#email",
      'input[name="topic"]',
      '[data-testid="send-button"]',
      "#labelled",
    ]);
  });

  it("extract returns the page's text and the named fields (before the fix both were empty)", async () => {
    const browserSession = await session(new PlaywrightContractPage());
    await browserSession.navigate("http://fixture.example/");
    const extracted = await browserSession.extract({ marker: "#marker", missing: "#nope" });
    expect(extracted.text).toContain("fixture-marker-7c1d");
    expect(extracted.text).not.toContain("never extracted");
    expect(extracted.fields).toEqual({ marker: "fixture-marker-7c1d", missing: "" });
  });

  it("session.ts hands page.evaluate the functions, never a string", () => {
    const source = readFileSync(new URL("../src/session.ts", import.meta.url), "utf8");
    const calls = [...source.matchAll(/\.evaluate(?:<[^>]*>)?\(\s*([^,)\s]+)/g)].map((match) => match[1]);
    expect(calls.sort()).toEqual(["inspectPageElements", "pageBodyText", "pageFieldValues"]);
    expect(source).not.toMatch(/_SCRIPT\s*=\s*`/);
  });
});
