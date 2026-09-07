// ---------------------------------------------------------------------------
// Sprint 7.2 — Browser session tests.
//
// Playwright is faked. What is under test is the DECISION LOGIC around the
// browser — what gets refused, what gets re-checked, what never leaves the
// façade — and a real Chrome would add process startup without adding a single
// assertion. The tests that genuinely need a browser live in the integration
// file and skip when none is installed.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BrowserSession, type PageLike, type RouteLike } from "../src/session.js";
import { DownloadStore } from "../src/download.js";
import { createBrowserConfig, type BrowserConfig } from "../src/config.js";
import type { NavigationPolicyConfig } from "../src/navigation-policy.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakePage implements PageLike {
  currentUrl = "about:blank";
  gotoCalls: string[] = [];
  clickCalls: string[] = [];
  fillCalls: Array<[string, string]> = [];
  selectCalls: Array<[string, string]> = [];
  setInputFilesCalls: Array<[string, string | string[]]> = [];
  pageTitle = "Example Domain";
  bodyText = "Hello world";
  evaluateResults = new Map<string, unknown>();
  /** URL the page ends up on after a goto or a click, when it differs. */
  navigateTo: string | null = null;

  async goto(url: string): Promise<{ status(): number } | null> {
    this.gotoCalls.push(url);
    this.currentUrl = this.navigateTo ?? url;
    return { status: () => 200 };
  }
  url(): string {
    return this.currentUrl;
  }
  async title(): Promise<string> {
    return this.pageTitle;
  }
  async content(): Promise<string> {
    return `<html><body>${this.bodyText}</body></html>`;
  }
  async screenshot(): Promise<Buffer> {
    return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
  }
  async click(selector: string): Promise<void> {
    this.clickCalls.push(selector);
    if (this.navigateTo) this.currentUrl = this.navigateTo;
  }
  async fill(selector: string, value: string): Promise<void> {
    this.fillCalls.push([selector, value]);
  }
  async selectOption(selector: string, value: string): Promise<unknown> {
    this.selectCalls.push([selector, value]);
    return [value];
  }
  async evaluate<T>(fn: string): Promise<T> {
    if (fn.includes("clone.innerText")) return this.bodyText as unknown as T;
    if (fn.includes("querySelectorAll")) {
      return (this.evaluateResults.get("inspect") ?? []) as T;
    }
    return (this.evaluateResults.get("fields") ?? {}) as T;
  }
  async waitForTimeout(): Promise<void> {}
  setDefaultTimeout(): void {}
  setDefaultNavigationTimeout(): void {}
  async waitForEvent(): Promise<never> {
    throw new Error("no download");
  }
  async setInputFiles(selector: string, files: string | string[]): Promise<void> {
    this.setInputFilesCalls.push([selector, files]);
  }
}

class FakeContext {
  handler: ((route: RouteLike) => Promise<void>) | null = null;
  closed = false;
  async route(_pattern: string, handler: (route: RouteLike) => Promise<void>) {
    this.handler = handler;
  }
  async close() {
    this.closed = true;
  }
}

function fakeRoute(url: string) {
  const calls = { continued: 0, aborted: 0, abortReason: "" };
  const route: RouteLike = {
    request: () => ({ url: () => url }),
    async abort(reason?: string) {
      calls.aborted += 1;
      calls.abortReason = reason ?? "";
    },
    async continue() {
      calls.continued += 1;
    },
  };
  return { route, calls };
}

let root: string;
let config: BrowserConfig;
let downloads: DownloadStore;

/** Resolver that answers with a public address unless told otherwise. */
const publicPolicy = (addresses: Record<string, string[]> = {}): NavigationPolicyConfig => ({
  resolveHost: async (host: string) => addresses[host] ?? ["93.184.216.34"],
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jarvis-session-"));
  config = createBrowserConfig(
    { chromePath: "C:/fake/chrome.exe", downloadDir: root, maxExtractChars: 50 },
    {} as NodeJS.ProcessEnv
  );
  downloads = new DownloadStore({ root, maxBytes: 1024 * 1024 });
});

function buildSession(
  page: FakePage,
  context: FakeContext,
  policy: NavigationPolicyConfig = publicPolicy(),
  userId = "user-1"
) {
  return new BrowserSession({
    page,
    context: context as unknown as FakeContext & { route: FakeContext["route"] },
    config,
    policy,
    downloads,
    userId,
  });
}

describe("Sprint 7.2 — navigation is validated before the browser is asked", () => {
  it("REFUSES a blocked URL without ever calling goto", async () => {
    const page = new FakePage();
    const session = buildSession(page, new FakeContext(), publicPolicy({ evil: ["127.0.0.1"] }));

    await expect(session.navigate("http://evil/")).rejects.toThrow(/Navigation refused/);
    expect(page.gotoCalls).toEqual([]);
  });

  it.each([
    ["file", "file:///etc/passwd"],
    ["javascript", "javascript:alert(1)"],
    ["data", "data:text/html,<b>x</b>"],
  ])("REFUSES the %s scheme without calling goto", async (_label, url) => {
    const page = new FakePage();
    const session = buildSession(page, new FakeContext());
    await expect(session.navigate(url)).rejects.toThrow(/Navigation refused/);
    expect(page.gotoCalls).toEqual([]);
  });

  it("ALLOWS a public URL", async () => {
    const page = new FakePage();
    const session = buildSession(page, new FakeContext());
    const result = await session.navigate("https://example.com/");
    expect(result.url).toBe("https://example.com/");
    expect(result.status).toBe(200);
    expect(result.redirected).toBe(false);
  });

  it("RE-CHECKS where a redirect actually landed", async () => {
    // The route gate refuses hops it can see, but the final URL gets its own
    // top-level judgement — a permitted origin on a blocked port, say.
    const page = new FakePage();
    page.navigateTo = "https://example.com:22/";
    const session = buildSession(page, new FakeContext());

    await expect(session.navigate("https://example.com/")).rejects.toThrow(
      /refused after redirect/
    );
  });

  it("reports a redirect that stayed acceptable", async () => {
    const page = new FakePage();
    page.navigateTo = "https://example.com/final";
    const session = buildSession(page, new FakeContext());
    const result = await session.navigate("https://example.com/start");
    expect(result.redirected).toBe(true);
    expect(result.url).toBe("https://example.com/final");
  });
});

describe("Sprint 7.5 — the per-request guard covers subresources", () => {
  it("continues an allowed request and aborts a blocked one", async () => {
    const context = new FakeContext();
    const session = buildSession(
      new FakePage(),
      context,
      publicPolicy({ "example.com": ["93.184.216.34"], internal: ["10.0.0.5"] })
    );
    await session.installNavigationGuard();
    expect(context.handler).toBeTruthy();

    const allowed = fakeRoute("https://example.com/logo.png");
    await context.handler!(allowed.route);
    expect(allowed.calls.continued).toBe(1);
    expect(allowed.calls.aborted).toBe(0);

    const blocked = fakeRoute("http://internal/admin");
    await context.handler!(blocked.route);
    expect(blocked.calls.aborted).toBe(1);
    expect(blocked.calls.abortReason).toBe("blockedbyclient");
  });

  it("aborts a subresource pointed at cloud metadata", async () => {
    const context = new FakeContext();
    const session = buildSession(new FakePage(), context, publicPolicy());
    await session.installNavigationGuard();

    const metadata = fakeRoute("http://169.254.169.254/latest/meta-data/");
    await context.handler!(metadata.route);
    expect(metadata.calls.aborted).toBe(1);
  });

  it("aborts an unparsable request URL", async () => {
    const context = new FakeContext();
    const session = buildSession(new FakePage(), context);
    await session.installNavigationGuard();

    const nonsense = fakeRoute("not a url");
    await context.handler!(nonsense.route);
    expect(nonsense.calls.aborted).toBe(1);
  });

  it("resolves each ORIGIN once, not each URL", async () => {
    // A page pulls dozens of assets from one host. Re-resolving per URL would
    // be slow and would point an amplifier at somebody's resolver.
    let lookups = 0;
    const context = new FakeContext();
    const session = buildSession(new FakePage(), context, {
      resolveHost: async () => {
        lookups += 1;
        return ["93.184.216.34"];
      },
    });
    await session.installNavigationGuard();

    for (let i = 0; i < 5; i++) {
      const asset = fakeRoute(`https://cdn.example.com/asset-${i}.png`);
      await context.handler!(asset.route);
      expect(asset.calls.continued).toBe(1);
    }
    expect(lookups).toBe(1);
  });
});

describe("Sprint 7.2 — reading requires an open page", () => {
  it.each([
    ["inspect", (s: BrowserSession) => s.inspect()],
    ["extract", (s: BrowserSession) => s.extract()],
    ["screenshot", (s: BrowserSession) => s.screenshot()],
    ["click", (s: BrowserSession) => s.click("#go")],
    ["type", (s: BrowserSession) => s.type("#q", "hi")],
  ])("REFUSES %s before navigate", async (_label, call) => {
    const session = buildSession(new FakePage(), new FakeContext());
    await expect(call(session)).rejects.toThrow(/navigate to a URL first/);
  });
});

describe("Sprint 7.9 — extraction is normalized and bounded", () => {
  it("truncates to the configured ceiling and says so", async () => {
    const page = new FakePage();
    page.bodyText = "x".repeat(500);
    const session = buildSession(page, new FakeContext());
    await session.navigate("https://example.com/");

    const result = await session.extract();
    expect(result.text.length).toBe(config.maxExtractChars);
    expect(result.truncated).toBe(true);
  });

  it("strips zero-width and bidi characters used to hide instructions", async () => {
    const page = new FakePage();
    // A zero-width space and a right-to-left override inside otherwise plain
    // text. normalizeText removes both.
    page.bodyText = "safe\u200btext\u202e";
    const session = buildSession(page, new FakeContext());
    await session.navigate("https://example.com/");

    const result = await session.extract();
    expect(result.text).not.toContain("\u200b");
    expect(result.text).not.toContain("\u202e");
    expect(result.text).toContain("safetext");
  });

  it("reports where the text came from", async () => {
    const page = new FakePage();
    const session = buildSession(page, new FakeContext());
    await session.navigate("https://example.com/article");

    const result = await session.extract();
    expect(result.url).toBe("https://example.com/article");
    expect(result.title).toBe("Example Domain");
  });
});

describe("Sprint 7.4 — acting re-checks where the action led", () => {
  it("REFUSES when a click navigates somewhere the policy would not allow", async () => {
    const page = new FakePage();
    const session = buildSession(page, new FakeContext(), publicPolicy({ intranet: ["10.0.0.9"] }));
    await session.navigate("https://example.com/");

    page.navigateTo = "http://intranet/secrets";
    await expect(session.click("#go")).rejects.toThrow(/navigated to a refused URL/);
  });

  it("reports a click that navigated somewhere acceptable", async () => {
    const page = new FakePage();
    const session = buildSession(page, new FakeContext());
    await session.navigate("https://example.com/");

    page.navigateTo = "https://example.com/next";
    const result = await session.click("#go");
    expect(result.navigated).toBe(true);
    expect(result.url).toBe("https://example.com/next");
    expect(result.selector).toBe("#go");
  });

  it("passes the typed value through to the page", async () => {
    const page = new FakePage();
    const session = buildSession(page, new FakeContext());
    await session.navigate("https://example.com/");

    await session.type("#q", "hello");
    expect(page.fillCalls).toEqual([["#q", "hello"]]);
  });
});

describe("Sprint 7.8 — uploads can only send back what the store already holds", () => {
  it("REFUSES an unknown download id", async () => {
    const page = new FakePage();
    const session = buildSession(page, new FakeContext());
    await session.navigate("https://example.com/");

    await expect(session.upload("#file", "no-such-id")).rejects.toThrow(/Unknown download id/);
    expect(page.setInputFilesCalls).toEqual([]);
  });

  it("REFUSES another user's download id", async () => {
    const stored = await downloads.storeBytes("user-2", {
      fileName: "a.pdf",
      bytes: Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]),
      sourceOrigin: "https://example.com",
    });

    const page = new FakePage();
    const session = buildSession(page, new FakeContext(), publicPolicy(), "user-1");
    await session.navigate("https://example.com/");

    await expect(session.upload("#file", stored.downloadId)).rejects.toThrow(
      /Unknown download id/
    );
    expect(page.setInputFilesCalls).toEqual([]);
  });

  it("uploads the owner's own file and never echoes the path back", async () => {
    const stored = await downloads.storeBytes("user-1", {
      fileName: "a.pdf",
      bytes: Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]),
      sourceOrigin: "https://example.com",
    });

    const page = new FakePage();
    const session = buildSession(page, new FakeContext(), publicPolicy(), "user-1");
    await session.navigate("https://example.com/");

    const result = await session.upload("#file", stored.downloadId);
    expect(page.setInputFilesCalls.length).toBe(1);
    expect(result.downloadId).toBe(stored.downloadId);
    expect(JSON.stringify(result)).not.toContain(root);
  });
});

describe("Sprint 7.6 — the façade never hands back a raw handle", () => {
  it("returns plain data from every read method", async () => {
    const page = new FakePage();
    const session = buildSession(page, new FakeContext());

    const navigate = await session.navigate("https://example.com/");
    const inspect = await session.inspect();
    const extract = await session.extract();
    const screenshot = await session.screenshot();

    for (const result of [navigate, inspect, extract, screenshot]) {
      // Structured-cloneable means there is no function, no Page, no Buffer of
      // cookies — nothing a caller could drive the browser with.
      expect(() => structuredClone(result)).not.toThrow();
      for (const value of Object.values(result)) {
        expect(typeof value).not.toBe("function");
      }
    }
  });

  it("stores a screenshot by id rather than returning the image", async () => {
    const page = new FakePage();
    const session = buildSession(page, new FakeContext());
    await session.navigate("https://example.com/");

    const result = await session.screenshot();
    expect(result.screenshotId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.format).toBe("png");
    expect(JSON.stringify(result)).not.toContain("data:image");
  });
});
