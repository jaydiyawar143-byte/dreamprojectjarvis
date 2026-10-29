// ---------------------------------------------------------------------------
// Phase 19, Stage 19.3 — the browser's egress proxy.
//
// Two halves. The policy is pure and table-tested: every destination a page
// could aim the browser at — loopback, private, link-local, reserved and
// metadata addresses in every spelling the URL parser accepts, names no public
// site can hold, names that RESOLVE to any of those — is refused, and the one
// address a connection may use is the one that was judged.
//
// The proxy is tested over real sockets on 127.0.0.1. Its DNS and its dialling
// are seams: two public addresses (8.8.8.8 and 1.1.1.1) stand for "the
// internet" and are wired to local servers, and every dial is recorded. No
// test resolves a real name or opens a connection off this machine.
//
// Named `browser-service*`, the slice CI runs for this workspace.
// ---------------------------------------------------------------------------

import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as netConnect, createServer as createNetServer, Socket } from "node:net";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { loadEgressConfig } from "../src/egress/config.js";
import {
  judgeEgressTarget,
  parseConnectTarget,
  parseHttpProxyTarget,
  systemResolver,
  type EgressPolicy,
  type ResolveHost,
} from "../src/egress/policy.js";
import { createEgressHealthServer, createEgressProxy } from "../src/egress/proxy.js";

const POLICY: EgressPolicy = { allowedPorts: [80, 443], domainAllowlist: [], dnsTimeoutMs: 1_000 };

/** A resolver from a table; a host not in it does not exist. Records every question. */
function table(answers: Record<string, string[] | (() => string[])>) {
  const asked: string[] = [];
  const resolveHost: ResolveHost = async (host) => {
    asked.push(host);
    const answer = answers[host];
    if (answer === undefined) throw new Error("ENOTFOUND");
    return typeof answer === "function" ? answer() : answer;
  };
  return { resolveHost, asked };
}

const neverAsked: ResolveHost = async () => {
  throw new Error("the resolver must not be asked");
};

async function judge(authority: string, resolveHost: ResolveHost = neverAsked, policy: EgressPolicy = POLICY) {
  const target = parseConnectTarget(authority);
  if (!target) return { allowed: false as const, reason: "invalid-target", detail: "unparsed" };
  return judgeEgressTarget(target, policy, resolveHost);
}

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

describe("egress targets: only well-formed authorities are accepted", () => {
  it("parses host:port and [v6]:port", () => {
    expect(parseConnectTarget("www.example.com:443")).toEqual({ host: "www.example.com", port: 443 });
    expect(parseConnectTarget("[2606:4700::1111]:443")).toEqual({ host: "[2606:4700::1111]", port: 443 });
    expect(parseConnectTarget("WWW.Example.COM:80")).toEqual({ host: "www.example.com", port: 80 });
  });

  it.each([
    ["empty", ""],
    ["no port", "www.example.com"],
    ["an empty port", "www.example.com:"],
    ["port 0", "www.example.com:0"],
    ["port 65536", "www.example.com:65536"],
    ["a non-numeric port", "www.example.com:44x"],
    ["credentials", "user@www.example.com:443"],
    ["a path", "www.example.com/x:443"],
    ["a backslash", "www.example.com\\x:443"],
    ["whitespace", "www.exa mple.com:443"],
    ["a control character", "www.example.com\u0000:443"],
    ["an IPv6 zone id", "[fe80::1%25eth0]:443"],
    ["two ports", "www.example.com:443:1"],
    ["an unbracketed IPv6", "::1:443"],
    ["not a string", 443],
  ])("refuses %s", (_label, input) => {
    expect(parseConnectTarget(input)).toBeNull();
  });

  it("an absolute http:// URL is the only plain-HTTP request accepted", () => {
    expect(parseHttpProxyTarget("http://www.example.com/a?b=1#frag")).toEqual({
      host: "www.example.com",
      port: 80,
      path: "/a?b=1",
      hostHeader: "www.example.com",
    });
    expect(parseHttpProxyTarget("http://www.example.com:8080/")).toMatchObject({ port: 8080, hostHeader: "www.example.com:8080" });
    for (const input of ["/origin-form", "https://www.example.com/", "http://user:pw@www.example.com/", "ftp://x.example.com/", "http://", "http://www.example.com/a b"]) {
      expect(parseHttpProxyTarget(input), input).toBeNull();
    }
  });
});

describe("egress policy: loopback, private, link-local, reserved and metadata are refused — in every spelling", () => {
  it.each([
    ["loopback", "127.0.0.1:443"],
    ["loopback, hex", "0x7f.1:443"],
    ["loopback, one decimal number", "2130706433:443"],
    ["loopback, octal", "0177.0.0.1:443"],
    ["loopback, short form", "127.1:443"],
    ["loopback, percent-encoded", "%31%32%37.0.0.1:443"],
    ["loopback, trailing dot", "127.0.0.1.:443"],
    ["unspecified", "0:443"],
    ["IPv6 loopback", "[::1]:443"],
    ["IPv4-mapped loopback", "[::ffff:127.0.0.1]:443"],
    ["IPv4-mapped loopback, hex groups", "[::ffff:7f00:1]:443"],
    ["IPv4-compatible loopback", "[::127.0.0.1]:443"],
    ["NAT64 loopback", "[64:ff9b::7f00:1]:443"],
    ["6to4 loopback", "[2002:7f00:1::]:443"],
    ["Teredo", "[2001:0:4136:e378:8000:63bf:3fff:fdd2]:443"],
    ["RFC 1918 10/8", "10.0.0.1:443"],
    ["RFC 1918 172.16/12", "172.16.0.1:443"],
    ["RFC 1918 192.168/16", "192.168.1.1:443"],
    ["Docker's default bridge", "172.17.0.1:443"],
    ["CGNAT", "100.64.0.1:443"],
    ["link-local", "169.254.1.1:443"],
    ["IPv6 link-local", "[fe80::1]:443"],
    ["IPv6 unique local", "[fc00::1]:443"],
    ["IPv6 site-local", "[fec0::1]:443"],
    ["multicast", "224.0.0.1:443"],
    ["IPv6 multicast", "[ff02::1]:443"],
    ["broadcast", "255.255.255.255:443"],
    ["reserved 240/4", "240.0.0.1:443"],
    ["documentation", "192.0.2.10:443"],
  ])("refuses %s (%s) without asking DNS", async (_label, authority) => {
    const decision = await judge(authority);
    expect(decision).toMatchObject({ allowed: false, reason: "blocked-address" });
  });

  it.each([
    ["AWS/GCP/Azure IMDS", "169.254.169.254:80"],
    ["AWS IMDS, IPv4-mapped", "[::ffff:169.254.169.254]:80"],
    ["AWS IMDS, NAT64", "[64:ff9b::a9fe:a9fe]:80"],
    ["AWS IMDS, decimal", "2852039166:80"],
    ["AWS ECS task metadata", "169.254.170.2:80"],
    ["AWS IPv6 IMDS", "[fd00:ec2::254]:80"],
    ["Alibaba metadata", "100.100.100.200:80"],
    ["Azure WireServer", "168.63.129.16:80"],
  ])("refuses the cloud metadata endpoint %s (%s)", async (_label, authority) => {
    const decision = await judge(authority);
    expect(decision).toMatchObject({ allowed: false, reason: "blocked-address", detail: "cloud-metadata" });
  });

  it.each([
    ["GCP metadata by name", "metadata.google.internal:80", "cloud-metadata-name"],
    ["GCP metadata by name, fully qualified", "metadata.google.internal.:80", "cloud-metadata-name"],
    ["PostgreSQL's service name", "postgres:5432", null],
    ["the API's service name", "api:443", "single-label"],
    ["localhost", "localhost:443", "single-label"],
    ["a localhost subdomain", "app.localhost:443", "special-use-name"],
    ["an internal name", "svc.corp.internal:443", "special-use-name"],
    ["mDNS", "nas.local:443", "special-use-name"],
  ])("refuses %s by name, before any resolver is asked", async (_label, authority, detail) => {
    const decision = await judge(authority);
    expect(decision.allowed).toBe(false);
    // `postgres:5432` is refused for its port before its name is read.
    if (detail === null) expect(decision).toMatchObject({ reason: "blocked-port" });
    else expect(decision).toMatchObject({ reason: "blocked-hostname", detail });
  });
});

describe("egress policy: DNS is judged in full, and fails closed", () => {
  it("allows a name whose every answer is public, and names the address to dial", async () => {
    const dns = table({ "www.example.com": ["8.8.8.8", "8.8.4.4"] });
    const decision = await judge("www.example.com:443", dns.resolveHost);
    expect(decision).toEqual({ allowed: true, host: "www.example.com", port: 443, address: "8.8.8.8" });
    expect(dns.asked).toEqual(["www.example.com"]);
  });

  it.each([
    ["a private answer", ["10.0.0.5"], "private"],
    ["a loopback answer", ["127.0.0.1"], "loopback"],
    ["the metadata address", ["169.254.169.254"], "cloud-metadata"],
    ["an IPv4-mapped metadata answer", ["::ffff:169.254.169.254"], "cloud-metadata"],
    ["one public and one private answer", ["8.8.8.8", "10.0.0.5"], "private"],
    ["an IPv6 unique-local answer", ["fd12:3456::1"], "private"],
  ])("refuses a public-looking name that resolves to %s", async (_label, answers, detail) => {
    const decision = await judge("rebind.example.com:443", table({ "rebind.example.com": answers }).resolveHost);
    expect(decision).toMatchObject({ allowed: false, reason: "blocked-address", detail });
  });

  it("refuses a name that does not resolve, or resolves to nothing", async () => {
    expect(await judge("nowhere.example.com:443", table({}).resolveHost)).toMatchObject({ reason: "dns-failure" });
    expect(await judge("empty.example.com:443", table({ "empty.example.com": [] }).resolveHost)).toMatchObject({
      reason: "dns-failure",
    });
  });

  it("refuses when the resolver does not answer in time", async () => {
    const resolveHost = systemResolver(30, () => new Promise(() => undefined));
    const decision = await judge("slow.example.com:443", resolveHost);
    expect(decision).toMatchObject({ allowed: false, reason: "dns-failure" });
  });

  it("refuses a resolver answer that is not an address", async () => {
    const decision = await judge("junk.example.com:443", table({ "junk.example.com": ["not-an-ip"] }).resolveHost);
    expect(decision).toMatchObject({ allowed: false, reason: "blocked-address", detail: "unparsable" });
  });
});

describe("egress policy: ports and the operator's allowlist only narrow", () => {
  const dns = table({ "www.example.com": ["8.8.8.8"], "docs.example.com": ["8.8.8.8"], "other.org": ["1.1.1.1"], "notexample.com": ["1.1.1.1"] });

  it("allows only the configured ports", async () => {
    expect(await judge("www.example.com:22", dns.resolveHost)).toMatchObject({ reason: "blocked-port" });
    expect(await judge("www.example.com:8080", dns.resolveHost)).toMatchObject({ reason: "blocked-port" });
    expect(await judge("www.example.com:8443", dns.resolveHost, { ...POLICY, allowedPorts: [8443] })).toMatchObject({
      allowed: true,
    });
  });

  it("with an allowlist, allows the domain and its subdomains, and nothing else", async () => {
    const narrowed = { ...POLICY, domainAllowlist: ["example.com"] };
    expect(await judge("docs.example.com:443", dns.resolveHost, narrowed)).toMatchObject({ allowed: true });
    expect(await judge("other.org:443", dns.resolveHost, narrowed)).toMatchObject({ reason: "not-allowlisted" });
    expect(await judge("notexample.com:443", dns.resolveHost, narrowed)).toMatchObject({ reason: "not-allowlisted" });
    expect(await judge("8.8.8.8:443", dns.resolveHost, narrowed)).toMatchObject({ reason: "not-allowlisted" });
  });

  it("an allowlisted name that resolves privately is still refused", async () => {
    const narrowed = { ...POLICY, domainAllowlist: ["example.com"] };
    const decision = await judge("intranet.example.com:443", table({ "intranet.example.com": ["10.1.2.3"] }).resolveHost, narrowed);
    expect(decision).toMatchObject({ allowed: false, reason: "blocked-address" });
  });
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe("egress configuration fails closed", () => {
  it("defaults to ports 80 and 443, any public host, on loopback", () => {
    const config = loadEgressConfig({});
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(3128);
    expect(config.healthPort).toBe(3129);
    expect(config.policy).toEqual({ allowedPorts: [80, 443], domainAllowlist: [], dnsTimeoutMs: 5_000 });
  });

  it("normalises the allowlist and the ports", () => {
    const config = loadEgressConfig({
      BROWSER_EGRESS_ALLOWED_PORTS: "443, 443, 8443",
      BROWSER_EGRESS_DOMAIN_ALLOWLIST: "Example.COM, .docs.example.org",
    });
    expect(config.policy.allowedPorts).toEqual([443, 8443]);
    expect(config.policy.domainAllowlist).toEqual(["example.com", "docs.example.org"]);
  });

  it.each([
    ["a port of 0", { BROWSER_EGRESS_ALLOWED_PORTS: "0" }, /BROWSER_EGRESS_ALLOWED_PORTS/],
    ["a non-numeric port", { BROWSER_EGRESS_ALLOWED_PORTS: "https" }, /BROWSER_EGRESS_ALLOWED_PORTS/],
    ["too many ports", { BROWSER_EGRESS_ALLOWED_PORTS: Array.from({ length: 17 }, (_v, i) => String(i + 1)).join(",") }, /BROWSER_EGRESS_ALLOWED_PORTS/],
    ["an address in the allowlist", { BROWSER_EGRESS_DOMAIN_ALLOWLIST: "10.0.0.1" }, /BROWSER_EGRESS_DOMAIN_ALLOWLIST/],
    ["a single-label name in the allowlist", { BROWSER_EGRESS_DOMAIN_ALLOWLIST: "intranet" }, /BROWSER_EGRESS_DOMAIN_ALLOWLIST/],
    ["a special-use name in the allowlist", { BROWSER_EGRESS_DOMAIN_ALLOWLIST: "corp.internal" }, /BROWSER_EGRESS_DOMAIN_ALLOWLIST/],
    ["a metadata name in the allowlist", { BROWSER_EGRESS_DOMAIN_ALLOWLIST: "metadata.google.internal" }, /BROWSER_EGRESS_DOMAIN_ALLOWLIST/],
    ["the health port on the proxy port", { BROWSER_EGRESS_PORT: "4000", BROWSER_EGRESS_HEALTH_PORT: "4000" }, /BROWSER_EGRESS_HEALTH_PORT/],
    ["a DNS deadline out of range", { BROWSER_EGRESS_DNS_TIMEOUT_MS: "999999" }, /BROWSER_EGRESS_DNS_TIMEOUT_MS/],
    ["a connection ceiling out of range", { BROWSER_EGRESS_MAX_CONNECTIONS: "0" }, /BROWSER_EGRESS_MAX_CONNECTIONS/],
  ])("refuses %s", (_label, env, message) => {
    expect(() => loadEgressConfig(env)).toThrow(message);
  });
});

// ---------------------------------------------------------------------------
// The proxy, over real sockets
// ---------------------------------------------------------------------------

const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function listen<T extends Server>(server: T): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

interface Site {
  requests: Array<{ path: string; headers: IncomingMessage["headers"] }>;
}

/**
 * "The internet": 8.8.8.8 is an echo server (for tunnels) and 1.1.1.1 an HTTP
 * site. Every dial is recorded; any other address fails without dialling.
 */
async function internet(handler: (request: IncomingMessage, response: ServerResponse, site: Site) => void) {
  const echo = createNetServer((socket) => socket.pipe(socket));
  const echoPort = await listen(echo as unknown as Server);
  const site: Site = { requests: [] };
  const http = createHttpServer((request, response) => {
    site.requests.push({ path: request.url ?? "", headers: request.headers });
    handler(request, response, site);
  });
  const httpPort = await listen(http);
  const dials: string[] = [];
  const openSocket = (address: string, port: number): Socket => {
    dials.push(`${address}:${port}`);
    if (address === "8.8.8.8") return netConnect({ host: "127.0.0.1", port: echoPort });
    if (address === "1.1.1.1") return netConnect({ host: "127.0.0.1", port: httpPort });
    const refused = new Socket();
    setImmediate(() => refused.destroy(new Error("ECONNREFUSED")));
    return refused;
  };
  return { site, dials, openSocket };
}

async function startProxy(resolveHost: ResolveHost, openSocket: (address: string, port: number) => Socket, overrides: { maxConnections?: number } = {}) {
  const logs: Array<{ event: string; fields?: Record<string, string | number | boolean> }> = [];
  const proxy = createEgressProxy({
    policy: POLICY,
    connectTimeoutMs: 2_000,
    idleTimeoutMs: 5_000,
    maxConnections: overrides.maxConnections ?? 16,
    resolveHost,
    openSocket,
    log: (event, fields) => logs.push({ event, fields }),
  });
  const port = await listen(proxy);
  return { port, logs };
}

function connectThrough(proxyPort: number, authority: string): Promise<{ status: number; socket: Socket; denied?: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port: proxyPort, method: "CONNECT", path: authority });
    request.on("connect", (response, socket) => {
      sockets.push(socket);
      resolve({ status: response.statusCode ?? 0, socket, denied: response.headers["x-jarvis-egress-denied"] as string | undefined });
    });
    request.on("error", reject);
    request.end();
  });
}

function getThrough(proxyPort: number, url: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: IncomingMessage["headers"]; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port: proxyPort, method: "GET", path: url, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end();
  });
}

function echoOnce(socket: Socket, text: string): Promise<string> {
  return new Promise((resolve) => {
    socket.once("data", (data: Buffer) => resolve(data.toString("utf8")));
    socket.write(text);
  });
}

describe("the egress proxy tunnels only to the address it judged", () => {
  it("tunnels an allowed CONNECT to the judged address", async () => {
    const net = await internet(() => undefined);
    const dns = table({ "www.example.com": ["8.8.8.8"] });
    const proxy = await startProxy(dns.resolveHost, net.openSocket);

    const tunnel = await connectThrough(proxy.port, "www.example.com:443");
    expect(tunnel.status).toBe(200);
    expect(await echoOnce(tunnel.socket, "ping")).toBe("ping");
    expect(net.dials).toEqual(["8.8.8.8:443"]);
  });

  it("refuses a CONNECT to a name that resolves privately, and dials nothing", async () => {
    const net = await internet(() => undefined);
    const proxy = await startProxy(table({ "rebind.example.com": ["10.0.0.5"] }).resolveHost, net.openSocket);

    const tunnel = await connectThrough(proxy.port, "rebind.example.com:443");
    expect(tunnel.status).toBe(403);
    expect(tunnel.denied).toBe("blocked-address");
    expect(net.dials).toEqual([]);
    expect(proxy.logs).toContainEqual({
      event: "egress_denied",
      fields: { reason: "blocked-address", detail: "private", host: "rebind.example.com", port: 443, method: "CONNECT" },
    });
  });

  it("refuses an unusual spelling of loopback without asking DNS or dialling", async () => {
    const net = await internet(() => undefined);
    const proxy = await startProxy(neverAsked, net.openSocket);
    for (const authority of ["0x7f.1:443", "2130706433:443", "[::ffff:7f00:1]:443", "169.254.169.254:80"]) {
      const tunnel = await connectThrough(proxy.port, authority);
      expect(tunnel.status, authority).toBe(403);
    }
    expect(net.dials).toEqual([]);
  });

  it("DNS rebinding: a name that turns private is refused the next time, and only the judged address was ever dialled", async () => {
    const net = await internet(() => undefined);
    let answers = ["8.8.8.8"];
    const proxy = await startProxy(table({ "flip.example.com": () => answers }).resolveHost, net.openSocket);

    const first = await connectThrough(proxy.port, "flip.example.com:443");
    expect(first.status).toBe(200);
    answers = ["127.0.0.1"];
    const second = await connectThrough(proxy.port, "flip.example.com:443");
    expect(second.status).toBe(403);
    expect(net.dials).toEqual(["8.8.8.8:443"]);
  });

  it("refuses a malformed CONNECT target as invalid", async () => {
    const net = await internet(() => undefined);
    const proxy = await startProxy(neverAsked, net.openSocket);
    const tunnel = await connectThrough(proxy.port, "user@www.example.com:443");
    expect(tunnel.status).toBe(400);
    expect(tunnel.denied).toBe("invalid-target");
    expect(net.dials).toEqual([]);
  });

  it("answers 502 when the judged address cannot be reached", async () => {
    const net = await internet(() => undefined);
    const proxy = await startProxy(table({ "down.example.com": ["9.9.9.9"] }).resolveHost, net.openSocket);
    const tunnel = await connectThrough(proxy.port, "down.example.com:443");
    expect(tunnel.status).toBe(502);
    expect(net.dials).toEqual(["9.9.9.9:443"]);
  });

  it("refuses a connection over its ceiling", async () => {
    const net = await internet(() => undefined);
    const proxy = await startProxy(table({ "www.example.com": ["8.8.8.8"] }).resolveHost, net.openSocket, { maxConnections: 1 });
    const held = await connectThrough(proxy.port, "www.example.com:443");
    expect(held.status).toBe(200);
    const refused = await connectThrough(proxy.port, "www.example.com:443");
    expect(refused.status).toBe(503);
  });
});

describe("the egress proxy forwards plain HTTP to the judged address, and never follows a redirect", () => {
  it("forwards an absolute-form GET with its own Host header and no proxy headers", async () => {
    const net = await internet((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain", "x-site": "1" });
      response.end("hello");
    });
    const proxy = await startProxy(table({ "www.example.com": ["1.1.1.1"] }).resolveHost, net.openSocket);

    const answer = await getThrough(proxy.port, "http://www.example.com/page?q=1#ignored", {
      "proxy-authorization": "Basic c2VjcmV0",
      "proxy-connection": "keep-alive",
      "x-custom": "kept",
    });

    expect(answer).toMatchObject({ status: 200, body: "hello" });
    expect(answer.headers["x-site"]).toBe("1");
    expect(net.dials).toEqual(["1.1.1.1:80"]);
    expect(net.site.requests).toHaveLength(1);
    const seen = net.site.requests[0]!;
    expect(seen.path).toBe("/page?q=1");
    expect(seen.headers.host).toBe("www.example.com");
    expect(seen.headers["x-custom"]).toBe("kept");
    expect(seen.headers["proxy-authorization"]).toBeUndefined();
    expect(seen.headers["proxy-connection"]).toBeUndefined();
  });

  it("passes a redirect back, and judges the next hop on its own: a redirect to an internal name is refused", async () => {
    const net = await internet((_request, response) => {
      response.writeHead(302, { location: "http://internal.example.com/admin", "content-length": "0" });
      response.end();
    });
    const proxy = await startProxy(
      table({ "www.example.com": ["1.1.1.1"], "internal.example.com": ["10.0.0.5"] }).resolveHost,
      net.openSocket
    );

    const first = await getThrough(proxy.port, "http://www.example.com/");
    expect(first.status).toBe(302);
    expect(first.headers.location).toBe("http://internal.example.com/admin");
    // The proxy did not follow it.
    expect(net.site.requests).toHaveLength(1);

    const hop = await getThrough(proxy.port, first.headers.location!);
    expect(hop.status).toBe(403);
    expect(hop.headers["x-jarvis-egress-denied"]).toBe("blocked-address");
    expect(net.dials).toEqual(["1.1.1.1:80"]);
  });

  it("refuses an origin-form request, an https:// URL and a metadata URL", async () => {
    const net = await internet(() => undefined);
    const proxy = await startProxy(neverAsked, net.openSocket);
    expect((await getThrough(proxy.port, "/latest/meta-data/")).status).toBe(400);
    expect((await getThrough(proxy.port, "https://www.example.com/")).status).toBe(400);
    expect((await getThrough(proxy.port, "http://169.254.169.254/latest/meta-data/")).status).toBe(403);
    expect((await getThrough(proxy.port, "http://metadata.google.internal/computeMetadata/v1/")).status).toBe(403);
    expect(net.dials).toEqual([]);
  });

  it("refuses an HTTP Upgrade outside CONNECT", async () => {
    const net = await internet(() => undefined);
    const proxy = await startProxy(neverAsked, net.openSocket);
    const socket = netConnect({ host: "127.0.0.1", port: proxy.port });
    sockets.push(socket);
    const reply = await new Promise<string>((resolve) => {
      socket.once("data", (data: Buffer) => resolve(data.toString("utf8")));
      socket.write("GET http://www.example.com/ws HTTP/1.1\r\nHost: www.example.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    });
    expect(reply.startsWith("HTTP/1.1 400")).toBe(true);
    expect(net.dials).toEqual([]);
  });
});

describe("the egress proxy's health listener", () => {
  it("answers /healthz on loopback and nothing else", async () => {
    const health = createEgressHealthServer();
    const port = await listen(health);
    const ok = await getThrough(port, "/healthz");
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ status: "ok", service: "jarvis-browser-egress" });
    expect((await getThrough(port, "/other")).status).toBe(404);
    expect((await getThrough(port, "http://www.example.com/")).status).toBe(404);
  });

  it("refuses a peer that is not loopback", () => {
    const handler = createEgressHealthServer().listeners("request")[0] as (request: IncomingMessage, response: ServerResponse) => void;
    let status = 0;
    const response = { writeHead: (code: number) => ((status = code), response), end: () => response } as unknown as ServerResponse;
    handler({ socket: { remoteAddress: "172.18.0.4" }, url: "/healthz", method: "GET", headers: {} } as unknown as IncomingMessage, response);
    expect(status).toBe(404);
  });
});
