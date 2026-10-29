// ---------------------------------------------------------------------------
// Phase 19, Stage 19.3 — S11: a real Chromium, launched exactly as the browser
// service launches it, reaches nothing except through the egress proxy, and
// the proxy refuses what the policy refuses.
//
// Two modes:
//
//   local (default) — offline, on any machine with a Chromium:
//     pnpm --filter @jarvis/browser-service build
//     CHROME_PATH=... node apps/browser-service/scripts/s11-egress-check.mjs
//   It starts the proxy in-process with its DNS and its dialling replaced: one
//   made-up name resolves to a "public" address that is wired to a page served
//   on 127.0.0.1, other names resolve privately or not at all, and the proxy
//   dials nothing else. Nothing leaves the machine. It proves the APPLICATION
//   layer: Chromium sends every request — top-level, subresource, fetch,
//   loopback — to the proxy, and the proxy refuses and never dials what the
//   policy refuses.
//
//   container — inside the running browser-service container:
//     docker compose exec browser-service node apps/browser-service/scripts/s11-egress-check.mjs --container
//   It proves the NETWORK layer: from the browser container, without the
//   proxy, nothing answers — not the internet, not PostgreSQL, not the host's
//   published ports, not the metadata address — and the proxy refuses those
//   destinations when asked. Not runnable outside the compose stack.
//
// It prints pass/fail lines and the switch names it checked; never a page.
// ---------------------------------------------------------------------------

import { createServer } from "node:http";
import { connect, Socket } from "node:net";

const results = [];
const record = (name, pass, detail) => results.push({ name, pass, detail });
const finish = () => {
  let failed = 0;
  for (const { name, pass, detail } of results) {
    if (!pass) failed += 1;
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
  }
  console.log(`S11: ${results.length - failed} passed, ${failed} failed (${process.argv.includes("--container") ? "container" : "local"} mode)`);
  process.exit(failed === 0 ? 0 : 1);
};

/** True when a TCP connection to host:port is refused, times out or cannot route. */
function unreachable(host, port, timeoutMs = 3_000) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(true));
    socket.once("connect", () => done(false));
    socket.once("error", () => done(true));
  });
}

async function containerMode() {
  const proxyUrl = process.env.BROWSER_SERVICE_EGRESS_PROXY_URL;
  record("BROWSER_SERVICE_EGRESS_PROXY_URL is set", Boolean(proxyUrl), proxyUrl ? "set" : "missing");
  // Direct paths that the internal network must not offer. Addresses, so no
  // DNS is involved; port 443/80/5432/5433/3101 are the ones that matter.
  const direct = [
    ["a public address, directly", "1.1.1.1", 443],
    ["the metadata address, directly", "169.254.169.254", 80],
    ["PostgreSQL by service name", "postgres", 5432],
    ["the Docker host gateway (published PostgreSQL)", "172.17.0.1", 5433],
    ["the Docker host gateway (published API)", "172.17.0.1", 3101],
  ];
  // The host's address on THIS internal network's own bridge is the likeliest
  // leak: the published PostgreSQL (5433) and API (3101) listen on every host
  // address. Probed at the .1 of each of this container's IPv4 subnets.
  const { networkInterfaces } = await import("node:os");
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      const gateway = entry.address.split(".").slice(0, 3).concat("1").join(".");
      direct.push([`this network's gateway ${gateway} (published PostgreSQL)`, gateway, 5433]);
      direct.push([`this network's gateway ${gateway} (published API)`, gateway, 3101]);
    }
  }
  for (const [label, host, port] of direct) {
    record(`no route: ${label}`, await unreachable(host, port), `${host}:${port}`);
  }
  if (proxyUrl) {
    const proxy = new URL(proxyUrl);
    record("the egress proxy itself is reachable", !(await unreachable(proxy.hostname, Number(proxy.port))));
    for (const [label, authority] of [
      ["metadata through the proxy", "169.254.169.254:80"],
      ["PostgreSQL through the proxy", "postgres:5432"],
      ["the API through the proxy", "api:3001"],
    ]) {
      const status = await connectStatus(proxy.hostname, Number(proxy.port), authority);
      record(`refused: ${label}`, status === 403 || status === 400, `status ${status}`);
    }
  }
  finish();
}

function connectStatus(proxyHost, proxyPort, authority) {
  return new Promise((resolve) => {
    const socket = connect({ host: proxyHost, port: proxyPort });
    socket.setTimeout(10_000, () => {
      socket.destroy();
      resolve(0);
    });
    socket.once("error", () => resolve(0));
    socket.once("data", (data) => {
      socket.destroy();
      resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(data.toString("latin1"))?.[1] ?? 0));
    });
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  });
}

async function localMode() {
  const { resolveChromePath } = await import("@jarvis/browser");
  const { chromium } = await import("playwright-core");
  const { sandboxedChromiumLaunchOptions } = await import("../dist/engine.js");
  const { createEgressProxy } = await import("../dist/egress/proxy.js");

  const chromePath = process.env.CHROME_PATH?.trim() || resolveChromePath();
  if (!chromePath) {
    console.error("S11: no Chromium executable found; set CHROME_PATH");
    process.exit(2);
  }

  const ALLOWED = "allowed.egress-check.jarvis-s11.net";
  const PRIVATE = "private.egress-check.jarvis-s11.net";
  const PUBLIC_ADDRESS = "8.8.8.8"; // never dialled: wired to the local page below

  // The local "site". Its page asks for two things the policy refuses.
  const siteRequests = [];
  const site = createServer((request, response) => {
    siteRequests.push({ url: request.url, host: request.headers.host });
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      `<title>allowed</title><img src="http://169.254.169.254/latest/meta-data/">` +
        `<script>fetch("http://${PRIVATE}/x").catch(() => {}); fetch("http://127.0.0.1:${site.address().port}/direct").catch(() => {});</script>`
    );
  });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  const sitePort = site.address().port;

  const dials = [];
  const denials = [];
  const proxy = createEgressProxy({
    policy: { allowedPorts: [80, 443], domainAllowlist: [], dnsTimeoutMs: 1_000 },
    connectTimeoutMs: 2_000,
    idleTimeoutMs: 10_000,
    maxConnections: 64,
    resolveHost: async (host) => {
      if (host === ALLOWED) return [PUBLIC_ADDRESS];
      if (host === PRIVATE) return ["10.0.0.5"];
      throw new Error("ENOTFOUND");
    },
    openSocket: (address, port) => {
      dials.push(`${address}:${port}`);
      if (address === PUBLIC_ADDRESS && port === 80) return connect({ host: "127.0.0.1", port: sitePort });
      const refused = new Socket();
      setImmediate(() => refused.destroy(new Error("ECONNREFUSED")));
      return refused;
    },
    log: (event, fields) => {
      if (event === "egress_denied") denials.push(fields);
    },
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = proxy.address().port;

  const options = sandboxedChromiumLaunchOptions({
    chromePath,
    headless: true,
    egressProxy: { url: `http://127.0.0.1:${proxyPort}`, host: "127.0.0.1" },
  });
  const browser = await chromium.launch(options);
  try {
    const page = await browser.newPage();

    const allowed = await page.goto(`http://${ALLOWED}/`, { waitUntil: "load" }).catch((error) => error);
    record("an allowed name loads through the proxy", (await page.title().catch(() => "")) === "allowed", allowed?.status?.() ? `status ${allowed.status()}` : String(allowed?.message ?? "").slice(0, 60));
    await page.waitForTimeout(1_000);
    record("the page reached the site with its own Host header", siteRequests.some((r) => r.host === ALLOWED));

    const deniedHosts = new Set(denials.map((d) => d.host));
    record("its <img> to the metadata address went to the proxy and was refused", deniedHosts.has("169.254.169.254"));
    record("its fetch to a privately resolving name was refused", deniedHosts.has(PRIVATE));
    record("its fetch to 127.0.0.1 went to the proxy, not straight to loopback", deniedHosts.has("127.0.0.1"));

    const metadata = await page.goto("http://169.254.169.254/latest/meta-data/").catch((error) => error);
    record("a top-level navigation to the metadata address is refused", metadata?.status?.() === 403 || metadata instanceof Error, metadata?.status?.() ? `status ${metadata.status()}` : "navigation error");

    const tunnel = await page.goto(`https://${PRIVATE}/`).catch((error) => error);
    record("HTTPS to a privately resolving name fails at the proxy's CONNECT", tunnel instanceof Error, tunnel instanceof Error ? tunnel.message.split("\n")[0].slice(0, 60) : `status ${tunnel?.status?.()}`);

    const direct = siteRequests.filter((r) => r.url === "/direct").length;
    record("the local site was never reached except through the allowed name", direct === 0 && siteRequests.every((r) => r.host === ALLOWED), `${siteRequests.length} request(s)`);
    record("the proxy dialled nothing but the judged public address", dials.length > 0 && dials.every((d) => d === `${PUBLIC_ADDRESS}:80`), dials.join(" "));

    const version = await browser.newPage();
    await version.goto("chrome://version");
    const line = await version.locator("#command_line").innerText();
    record("Chromium's command line names the proxy", line.includes(`--proxy-server=http://127.0.0.1:${proxyPort}`));
    // Windows shows a value with spaces in quotes; Linux shows it bare.
    record(
      "Chromium's resolver can resolve only the proxy",
      /--host-resolver-rules="?MAP \* ~NOTFOUND , EXCLUDE 127\.0\.0\.1"?/.test(line)
    );
    record("loopback is not exempt from the proxy", line.includes("<-loopback>"));
  } finally {
    await browser.close();
    proxy.close();
    site.close();
  }
  finish();
}

if (process.argv.includes("--container")) await containerMode();
else await localMode();
