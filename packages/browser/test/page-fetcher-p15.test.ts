// Phase 15 — one bounded, address-pinned GET of a public page.
//
// Two layers of test:
//   - a fake transport, to pin the POLICY: what is refused before any byte is
//     sent, that every redirect hop is judged again, and that the connection
//     is aimed at exactly the address that was judged;
//   - the real `node:http` transport against a loopback server, to pin the
//     MECHANICS: the lookup pin, the byte ceiling on decoded bytes, encodings.
//
// The loopback server is reachable only because these tests build a policy by
// hand with `__unsafeAllowPrivateAddresses` — which no environment variable
// can set, and which the last test asserts production never does.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import {
  PAGE_FETCH_USER_AGENT,
  PageFetchError,
  PublicPageFetcher,
  type PageTransport,
  type PageTransportRequest,
  type PageTransportResponse,
} from "../src/page-fetcher.js";
import { isPageResearchEnabled, pageResearchPolicy } from "../src/config.js";

const PUBLIC_IP = "93.184.216.34";

const html = (body: string, headers: Record<string, string> = {}): PageTransportResponse => ({
  status: 200,
  headers: { "content-type": "text/html; charset=utf-8", ...headers },
  body: new TextEncoder().encode(body),
  truncated: false,
});

function recording(respond: (request: PageTransportRequest, call: number) => PageTransportResponse | Promise<PageTransportResponse>) {
  const calls: PageTransportRequest[] = [];
  const transport: PageTransport = async (request) => {
    calls.push(request);
    return respond(request, calls.length);
  };
  return { calls, transport };
}

const resolvesTo = (...addresses: string[]) => async () => addresses;

async function failure(promise: Promise<unknown>): Promise<PageFetchError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PageFetchError);
    return error as PageFetchError;
  }
  throw new Error("expected the fetch to be refused");
}

describe("what is refused before anything is sent", () => {
  it.each<[string, string, string]>([
    ["a private address", "https://intranet.example/", "10.0.0.5"],
    ["loopback", "https://local.example/", "127.0.0.1"],
    ["the cloud metadata address", "https://meta.example/", "169.254.169.254"],
    ["a link-local address", "https://ll.example/", "169.254.10.10"],
    ["an IPv6 loopback", "https://v6.example/", "::1"],
  ])("a host that resolves to %s", async (_label, url, address) => {
    const { calls, transport } = recording(() => html("<p>secret</p>"));
    const fetcher = new PublicPageFetcher({ policy: { resolveHost: resolvesTo(address) }, transport });
    const error = await failure(fetcher.fetch(url));
    expect(error.code).toBe("URL_NOT_ALLOWED");
    expect(error.denyReason).toBe("blocked-address");
    expect(calls).toHaveLength(0);
  });

  it("a host with one public and one private address — a rebinding attempt, not a partly valid target", async () => {
    const { calls, transport } = recording(() => html("x"));
    const fetcher = new PublicPageFetcher({ policy: { resolveHost: resolvesTo(PUBLIC_IP, "192.168.1.10") }, transport });
    expect((await failure(fetcher.fetch("https://mixed.example/"))).denyReason).toBe("blocked-address");
    expect(calls).toHaveLength(0);
  });

  it.each<[string, string, string]>([
    ["a literal metadata address", "http://169.254.169.254/latest/meta-data/", "blocked-address"],
    ["a literal loopback address", "http://127.0.0.1/admin", "blocked-address"],
    ["a file address", "file:///etc/passwd", "blocked-scheme"],
    ["a javascript address", "javascript:alert(1)", "blocked-scheme"],
    ["an ftp address", "ftp://example.com/file", "blocked-scheme"],
    ["credentials in the address", "https://user:pass@example.com/", "credentials-in-url"],
    ["a non-standard port", "https://example.com:8443/", "blocked-port"],
    ["a relative address", "/pricing", "invalid-url"],
    ["an address with a line break in it", "https://example.com/\nHost: evil", "invalid-url"],
  ])("%s", async (_label, url, reason) => {
    const { calls, transport } = recording(() => html("x"));
    const fetcher = new PublicPageFetcher({ policy: { resolveHost: resolvesTo(PUBLIC_IP) }, transport });
    const error = await failure(fetcher.fetch(url));
    expect(error.code).toBe("URL_NOT_ALLOWED");
    expect(error.denyReason).toBe(reason);
    expect(calls).toHaveLength(0);
  });

  it("a host that cannot be resolved — not knowing where it goes is not permission", async () => {
    const { calls, transport } = recording(() => html("x"));
    const fetcher = new PublicPageFetcher({
      policy: {
        resolveHost: async () => {
          throw new Error("ENOTFOUND");
        },
      },
      transport,
    });
    expect((await failure(fetcher.fetch("https://nowhere.example/"))).denyReason).toBe("dns-failure");
    expect(calls).toHaveLength(0);
  });

  it("a site outside the operator's allowlist", async () => {
    const { calls, transport } = recording(() => html("x"));
    const fetcher = new PublicPageFetcher({
      policy: { resolveHost: resolvesTo(PUBLIC_IP), domainAllowlist: ["mysite.example"] },
      transport,
    });
    expect((await failure(fetcher.fetch("https://other.example/"))).denyReason).toBe("not-allowlisted");
    expect(calls).toHaveLength(0);
    await expect(fetcher.fetch("https://blog.mysite.example/")).resolves.toMatchObject({ httpStatus: 200 });
  });

  it("something that is not a string", async () => {
    const fetcher = new PublicPageFetcher({ policy: {}, transport: recording(() => html("x")).transport });
    expect((await failure(fetcher.fetch({ url: "https://example.com" }))).denyReason).toBe("invalid-url");
  });

  it("never puts a credential from the address into its error message", async () => {
    const fetcher = new PublicPageFetcher({ policy: {}, transport: recording(() => html("x")).transport });
    const error = await failure(fetcher.fetch("https://admin:hunter2@example.com/"));
    expect(error.message).not.toContain("hunter2");
    expect(error.message).not.toContain("admin");
  });
});

describe("the connection goes to the address that was judged", () => {
  it("hands the transport exactly that address, and the real host name", async () => {
    const { calls, transport } = recording(() => html("<title>ok</title>"));
    const fetcher = new PublicPageFetcher({ policy: { resolveHost: resolvesTo(PUBLIC_IP) }, transport });
    await fetcher.fetch("https://example.com/pricing?x=1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.address).toBe(PUBLIC_IP);
    expect(calls[0]!.url.hostname).toBe("example.com");
    expect(calls[0]!.url.pathname + calls[0]!.url.search).toBe("/pricing?x=1");
  });

  it("a second, different DNS answer has nowhere to land: resolution happens once per hop", async () => {
    let lookups = 0;
    const { calls, transport } = recording(() => html("x"));
    const fetcher = new PublicPageFetcher({
      policy: {
        resolveHost: async () => {
          lookups += 1;
          return lookups === 1 ? [PUBLIC_IP] : ["10.0.0.1"];
        },
      },
      transport,
    });
    await fetcher.fetch("https://rebind.example/");
    expect(lookups).toBe(1);
    expect(calls[0]!.address).toBe(PUBLIC_IP);
  });

  it("sends no cookie, no credential and no referrer, and says who it is", async () => {
    const { calls, transport } = recording(() => html("x"));
    await new PublicPageFetcher({ policy: { resolveHost: resolvesTo(PUBLIC_IP) }, transport }).fetch("https://example.com/");
    const sent = Object.keys(calls[0]!.headers).map((name) => name.toLowerCase());
    expect(sent).not.toContain("cookie");
    expect(sent).not.toContain("authorization");
    expect(sent).not.toContain("referer");
    expect(calls[0]!.headers["user-agent"]).toBe(PAGE_FETCH_USER_AGENT);
  });
});

describe("redirects", () => {
  const redirect = (location: string | undefined, status = 302): PageTransportResponse => ({
    status,
    headers: location === undefined ? {} : { location },
    body: new Uint8Array(0),
    truncated: false,
  });

  it("follows a redirect, judging the new address too, and reports where the page came from", async () => {
    const resolved: string[] = [];
    const { calls, transport } = recording((_request, call) => (call === 1 ? redirect("https://www.example.com/new") : html("<title>new</title>")));
    const fetcher = new PublicPageFetcher({
      policy: {
        resolveHost: async (host) => {
          resolved.push(host);
          return [PUBLIC_IP];
        },
      },
      transport,
    });
    const page = await fetcher.fetch("https://example.com/old");
    expect(page).toMatchObject({ requestedUrl: "https://example.com/old", finalUrl: "https://www.example.com/new", redirects: 1 });
    expect(resolved).toEqual(["example.com", "www.example.com"]);
    expect(calls).toHaveLength(2);
  });

  it("resolves a relative Location against the page it came from", async () => {
    const { transport } = recording((_request, call) => (call === 1 ? redirect("/moved?x=1", 301) : html("x")));
    const page = await new PublicPageFetcher({ policy: { resolveHost: resolvesTo(PUBLIC_IP) }, transport }).fetch("https://example.com/a/b");
    expect(page.finalUrl).toBe("https://example.com/moved?x=1");
  });

  it.each<[string, string]>([
    ["a private address", "https://internal.example/admin"],
    ["the metadata address", "http://169.254.169.254/latest/meta-data/iam/"],
    ["a file address", "file:///etc/passwd"],
  ])("refuses a redirect to %s, and says it was a redirect", async (_label, location) => {
    const { calls, transport } = recording(() => redirect(location));
    const fetcher = new PublicPageFetcher({
      policy: { resolveHost: async (host) => (host === "internal.example" ? ["10.1.2.3"] : [PUBLIC_IP]) },
      transport,
    });
    const error = await failure(fetcher.fetch("https://example.com/"));
    expect(error.code).toBe("URL_NOT_ALLOWED");
    expect(error.message).toContain("redirected");
    expect(calls).toHaveLength(1);
  });

  it("stops after the redirect limit", async () => {
    const { calls, transport } = recording((request) => redirect(`https://example.com/hop${request.url.pathname.length}`));
    const fetcher = new PublicPageFetcher({ policy: { resolveHost: resolvesTo(PUBLIC_IP) }, transport, maxRedirects: 3 });
    expect((await failure(fetcher.fetch("https://example.com/"))).code).toBe("TOO_MANY_REDIRECTS");
    expect(calls).toHaveLength(4);
  });

  it("refuses a redirect that does not say where to", async () => {
    const { transport } = recording(() => redirect(undefined));
    const fetcher = new PublicPageFetcher({ policy: { resolveHost: resolvesTo(PUBLIC_IP) }, transport });
    expect((await failure(fetcher.fetch("https://example.com/"))).code).toBe("BAD_REDIRECT");
  });
});

describe("what comes back", () => {
  const fetcher = (transport: PageTransport, extra: { timeoutMs?: number } = {}) =>
    new PublicPageFetcher({ policy: { resolveHost: resolvesTo(PUBLIC_IP) }, transport, now: () => new Date("2026-10-12T09:00:00.000Z"), ...extra });

  it("returns the page with how it was fetched", async () => {
    const page = await fetcher(recording(() => html("<title>Hello</title>")).transport).fetch("https://example.com/");
    expect(page).toEqual({
      requestedUrl: "https://example.com/",
      finalUrl: "https://example.com/",
      httpStatus: 200,
      contentType: "text/html; charset=utf-8",
      html: "<title>Hello</title>",
      bytes: 20,
      truncated: false,
      redirects: 0,
      fetchedAt: "2026-10-12T09:00:00.000Z",
    });
  });

  it("a 404 page is still a page, with its status", async () => {
    const page = await fetcher(recording(() => ({ ...html("<h1>Not found</h1>"), status: 404 })).transport).fetch("https://example.com/missing");
    expect(page.httpStatus).toBe(404);
    expect(page.html).toContain("Not found");
  });

  it.each(["application/pdf", "image/png", "application/json", "application/octet-stream"])(
    "refuses a response declared as %s",
    async (type) => {
      const transport = recording(() => html("%PDF-1.4", { "content-type": type })).transport;
      expect((await failure(fetcher(transport).fetch("https://example.com/file"))).code).toBe("NOT_HTML");
    }
  );

  it("reads a page whose server sent no content type", async () => {
    const transport = recording(() => ({ status: 200, headers: {}, body: new TextEncoder().encode("<p>ok</p>"), truncated: false })).transport;
    await expect(fetcher(transport).fetch("https://example.com/")).resolves.toMatchObject({ contentType: null, html: "<p>ok</p>" });
  });

  it("decodes with the charset the server declared", async () => {
    const body = Buffer.from("<title>Caf\xe9</title>", "latin1");
    const transport = recording(() => ({ status: 200, headers: { "content-type": "text/html; charset=ISO-8859-1" }, body, truncated: false })).transport;
    expect((await fetcher(transport).fetch("https://example.com/")).html).toBe("<title>Café</title>");
  });

  it("falls back to the charset the page declares for itself", async () => {
    const body = Buffer.from('<meta charset="windows-1252"><title>Caf\xe9</title>', "latin1");
    const transport = recording(() => ({ status: 200, headers: { "content-type": "text/html" }, body, truncated: false })).transport;
    expect((await fetcher(transport).fetch("https://example.com/")).html).toContain("Café");
  });

  it("survives a charset label it does not know", async () => {
    const transport = recording(() => html("<p>ok</p>", { "content-type": "text/html; charset=not-a-real-charset" })).transport;
    expect((await fetcher(transport).fetch("https://example.com/")).html).toBe("<p>ok</p>");
  });

  it("says when the page was cut short", async () => {
    const transport = recording(() => ({ ...html("<p>partial"), truncated: true })).transport;
    expect((await fetcher(transport).fetch("https://example.com/")).truncated).toBe(true);
  });

  it("a network failure is reported in fixed words, without the underlying error", async () => {
    const transport: PageTransport = async () => {
      throw new Error("connect ECONNREFUSED 93.184.216.34:443 token=sk-secret");
    };
    const error = await failure(fetcher(transport).fetch("https://example.com/"));
    expect(error.code).toBe("NETWORK_ERROR");
    expect(error.message).toBe("The page could not be reached.");
  });

  it("gives up at its own deadline", async () => {
    const transport: PageTransport = ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const started = Date.now();
    const error = await failure(fetcher(transport, { timeoutMs: 80 }).fetch("https://example.com/slow"));
    expect(error.code).toBe("TIMEOUT");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("stops when the caller cancels, and says it was cancelled", async () => {
    const controller = new AbortController();
    const transport: PageTransport = ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const pending = fetcher(transport).fetch("https://example.com/slow", { signal: controller.signal });
    controller.abort();
    expect((await failure(pending)).code).toBe("ABORTED");
  });

  it("does not start at all for a caller that has already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const { calls, transport } = recording(() => html("x"));
    expect((await failure(fetcher(transport).fetch("https://example.com/", { signal: controller.signal }))).code).toBe("ABORTED");
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The real transport, against a loopback server
// ---------------------------------------------------------------------------

describe("the node:http transport", () => {
  let server: Server;
  let port: number;
  const seenHosts: string[] = [];
  const seenHeaders: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      seenHosts.push(String(req.headers.host));
      seenHeaders.push({ ...req.headers });
      const path = req.url ?? "/";
      if (path === "/gzip") {
        res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
        res.end(gzipSync("<title>Compressed</title>"));
      } else if (path === "/bomb") {
        // 4 MB of zeros compresses to a few KB: the ceiling must count what comes OUT.
        res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
        res.end(gzipSync(Buffer.alloc(4 * 1024 * 1024, 0x61)));
      } else if (path === "/big") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("x".repeat(50_000));
      } else if (path === "/redirect") {
        res.writeHead(302, { location: "/landed" });
        res.end("a redirect body that must never be read");
      } else if (path === "/landed") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<title>Landed</title>");
      } else if (path === "/hang") {
        res.writeHead(200, { "content-type": "text/html" });
        res.write("<p>started");
      } else {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<title>Loopback</title>");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const local = (extra: { maxBytes?: number; timeoutMs?: number } = {}) =>
    new PublicPageFetcher({
      policy: { allowedPorts: [port], __unsafeAllowPrivateAddresses: true, resolveHost: resolvesTo("127.0.0.1") },
      ...extra,
    });

  it("reads a page", async () => {
    const page = await local().fetch(`http://127.0.0.1:${port}/`);
    expect(page).toMatchObject({ httpStatus: 200, html: "<title>Loopback</title>", truncated: false });
  });

  it("connects to the judged address even when the name resolves nowhere, and still sends the real Host", async () => {
    seenHosts.length = 0;
    const page = await local().fetch(`http://pinned-host.invalid:${port}/`);
    expect(page.html).toBe("<title>Loopback</title>");
    expect(seenHosts).toEqual([`pinned-host.invalid:${port}`]);
  });

  it("puts nothing identifying in the request", async () => {
    seenHeaders.length = 0;
    await local().fetch(`http://127.0.0.1:${port}/`);
    const sent = seenHeaders[0]!;
    expect(sent.cookie).toBeUndefined();
    expect(sent.authorization).toBeUndefined();
    expect(sent.referer).toBeUndefined();
    expect(sent["user-agent"]).toBe(PAGE_FETCH_USER_AGENT);
  });

  it("decodes a compressed page", async () => {
    expect((await local().fetch(`http://127.0.0.1:${port}/gzip`)).html).toBe("<title>Compressed</title>");
  });

  it("stops at the byte ceiling and says the page was cut short", async () => {
    const page = await local({ maxBytes: 10_000 }).fetch(`http://127.0.0.1:${port}/big`);
    expect(page.bytes).toBe(10_000);
    expect(page.truncated).toBe(true);
  });

  it("counts decoded bytes, so a small compressed body cannot expand past the ceiling", async () => {
    const page = await local({ maxBytes: 100_000 }).fetch(`http://127.0.0.1:${port}/bomb`);
    expect(page.bytes).toBe(100_000);
    expect(page.truncated).toBe(true);
  });

  it("follows a redirect without reading the redirect's body", async () => {
    const page = await local().fetch(`http://127.0.0.1:${port}/redirect`);
    expect(page).toMatchObject({ html: "<title>Landed</title>", redirects: 1, finalUrl: `http://127.0.0.1:${port}/landed` });
  });

  it("gives up on a server that starts answering and never finishes", async () => {
    const error = await failure(local({ timeoutMs: 300 }).fetch(`http://127.0.0.1:${port}/hang`));
    expect(error.code).toBe("TIMEOUT");
  });

  it("reports a closed port as unreachable", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const deadPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const fetcher = new PublicPageFetcher({
      policy: { allowedPorts: [deadPort], __unsafeAllowPrivateAddresses: true, resolveHost: resolvesTo("127.0.0.1") },
    });
    expect((await failure(fetcher.fetch(`http://127.0.0.1:${deadPort}/`))).code).toBe("NETWORK_ERROR");
  });

  it("without the test-only flag, the same loopback server is refused", async () => {
    const fetcher = new PublicPageFetcher({ policy: { allowedPorts: [port] } });
    expect((await failure(fetcher.fetch(`http://127.0.0.1:${port}/`))).denyReason).toBe("blocked-address");
  });
});

describe("the switch and the policy an operator controls", () => {
  it("page research is off unless BROWSER_ENABLED is exactly true", () => {
    expect(isPageResearchEnabled({})).toBe(false);
    expect(isPageResearchEnabled({ BROWSER_ENABLED: "false" })).toBe(false);
    expect(isPageResearchEnabled({ BROWSER_ENABLED: "1" })).toBe(false);
    expect(isPageResearchEnabled({ BROWSER_ENABLED: "true" })).toBe(true);
  });

  it("needs no Chrome: the switch alone is enough", () => {
    expect(isPageResearchEnabled({ BROWSER_ENABLED: "true", CHROME_PATH: "Z:\\no\\such\\chrome.exe" })).toBe(true);
  });

  it("reads under the operator's own domain allowlist", () => {
    const policy = pageResearchPolicy({ BROWSER_DOMAIN_ALLOWLIST: " mysite.example , partner.example ,," });
    expect(policy.domainAllowlist).toEqual(["mysite.example", "partner.example"]);
    expect(pageResearchPolicy({}).domainAllowlist).toEqual([]);
  });

  it("no environment can switch the private-address protection off", () => {
    const policy = pageResearchPolicy({
      BROWSER_ENABLED: "true",
      __unsafeAllowPrivateAddresses: "true",
      BROWSER_ALLOW_PRIVATE: "true",
    } as unknown as NodeJS.ProcessEnv);
    expect(policy.__unsafeAllowPrivateAddresses).toBeUndefined();
    expect(policy.allowedPorts).toEqual([80, 443]);
    expect(policy.allowedSchemes).toEqual(["http:", "https:"]);
  });
});
