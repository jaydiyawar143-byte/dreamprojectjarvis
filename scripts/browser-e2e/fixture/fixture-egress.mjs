// ---------------------------------------------------------------------------
// Phase 19, P0 — the real-Chromium E2E's egress container. TEST ONLY.
//
// Runs in place of the egress proxy's entry point, in the isolated E2E compose
// project and nowhere else (scripts/browser-e2e/docker-compose.e2e.yml). It is
// mounted read-only; it is not in any image and no environment variable makes
// the production proxy behave like this.
//
// What is REAL here: the proxy itself (`createEgressProxy`, built from the
// image's own dist), its policy (`loadEgressConfig` reads the same
// BROWSER_EGRESS_* variables production does: allowed ports, domain
// allowlist, timeouts, connection ceiling), its judgment of every address, and
// its health listener. What is substituted — exactly as S11's local mode does
// — is name resolution and the final dial: the fixture's name resolves to a
// public address the policy judges, and a dial to THAT judged address is wired
// to the fixture site in this process. A privately resolving name and every
// other address are judged and refused as in production; nothing here can
// reach the internet.
//
// The fixture site records what reached it and serves it back at /state, so a
// test reads the site's side of every action through the real browser.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { Socket, connect } from "node:net";

import { loadEgressConfig } from "/workspace/apps/browser-service/dist/egress/config.js";
import { createEgressHealthServer, createEgressProxy } from "/workspace/apps/browser-service/dist/egress/proxy.js";

const FIXTURE_HOST = (process.env.JARVIS_E2E_FIXTURE_HOST ?? "").trim();
if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(FIXTURE_HOST)) {
  console.error(JSON.stringify({ service: "browser-e2e-egress", event: "fixture_host_invalid" }));
  process.exit(1);
}
const PRIVATE_HOST = `private.${FIXTURE_HOST}`;
// A public address the policy judges like any other. It is never dialled on
// the network: the dial below is wired to the fixture site.
const PUBLIC_ADDRESS = "8.8.8.8";

/** The download's bytes. The E2E test knows their SHA-256. */
const REPORT_CSV = "id,name,amount\n1,alpha,10\n2,beta,20\n3,gamma,30\n";
/** Text that must never appear in an error, a log line or an audit row. */
const CONFIDENTIAL = "CONFIDENTIAL-FIXTURE-CONTENT-5c2e91";

const state = {
  requests: 0,
  submits: [],
  slowSubmits: 0,
  downloads: 0,
  uploads: [],
};

const page = (title, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", () => resolve(Buffer.concat(chunks)));
  });
}

/** The first file part of a multipart body: its bytes, by hand, for one test form. */
function firstFilePart(body, contentType) {
  const boundary = /boundary=([^;]+)/.exec(contentType ?? "")?.[1];
  if (!boundary) return null;
  const marker = Buffer.from(`--${boundary}`);
  const start = body.indexOf(marker);
  if (start < 0) return null;
  const headerEnd = body.indexOf("\r\n\r\n", start);
  const next = body.indexOf(marker, headerEnd);
  if (headerEnd < 0 || next < 0) return null;
  return body.subarray(headerEnd + 4, next - 2);
}

const site = createServer(async (request, response) => {
  state.requests += 1;
  const url = new URL(request.url ?? "/", `http://${FIXTURE_HOST}`);
  const html = (status, title, body) => {
    response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(page(title, body));
  };

  if (request.method === "GET" && url.pathname === "/") {
    html(
      200,
      "JARVIS E2E Fixture",
      `<h1>JARVIS E2E Fixture</h1>
       <p id="marker">fixture-marker-7c1d</p>
       <p id="js">no script ran</p>
       <script>document.getElementById("js").textContent = "rendered-by-chromium-" + (6 * 7);</script>
       <a id="dl" href="/files/report.csv" download="report.csv">Download the report</a>
       <form id="contact" method="post" action="/submit">
         <label for="email">Email</label><input id="email" name="email" type="text">
         <button id="send" type="submit">Send</button>
       </form>`
    );
    return;
  }

  if (request.method === "GET" && url.pathname === "/confidential") {
    html(200, "Confidential", `<p id="secret">${CONFIDENTIAL}</p>`);
    return;
  }

  if (request.method === "GET" && url.pathname === "/files/report.csv") {
    state.downloads += 1;
    response.writeHead(200, {
      "content-type": "text/csv",
      "content-disposition": 'attachment; filename="report.csv"',
      "content-length": String(Buffer.byteLength(REPORT_CSV)),
    });
    response.end(REPORT_CSV);
    return;
  }

  if (request.method === "POST" && url.pathname === "/submit") {
    const body = new URLSearchParams((await readBody(request)).toString("utf8"));
    state.submits.push({ email: body.get("email") ?? "" });
    html(200, `Submitted ${state.submits.length}`, `<p id="result">received ${state.submits.length}</p>`);
    return;
  }

  if (request.method === "GET" && url.pathname === "/slow-form") {
    // The submit control appears four seconds after load. The browser's click
    // waits for it — longer than the E2E's short API deadline — so the API
    // gives up while the write is still in progress and cannot know whether
    // it reached the site: an unknown outcome, made deterministically.
    html(
      200,
      "Slow form",
      `<form id="slow" method="post" action="/slow-submit">
         <input id="slow-email" name="email" type="text">
         <button id="slow-send" type="submit" style="display:none">Send slowly</button>
       </form>
       <script>setTimeout(() => { document.getElementById("slow-send").style.display = "inline"; }, 4000);</script>`
    );
    return;
  }

  if (request.method === "POST" && url.pathname === "/slow-submit") {
    await readBody(request);
    state.slowSubmits += 1;
    html(200, "Slow submitted", "<p>done</p>");
    return;
  }

  if (request.method === "GET" && url.pathname === "/upload-form") {
    // A plain file input. The upload tool sets the file and returns; whether
    // the file could be set at all is decided by the artifact store's scope.
    html(
      200,
      "Upload form",
      `<form id="upload" method="post" action="/upload" enctype="multipart/form-data">
         <input id="file" name="file" type="file">
         <button id="upload-send" type="submit">Upload</button>
       </form>`
    );
    return;
  }

  if (request.method === "POST" && url.pathname === "/upload") {
    const body = await readBody(request);
    const file = firstFilePart(body, request.headers["content-type"]);
    state.uploads.push(file ? { bytes: file.length, sha256: createHash("sha256").update(file).digest("hex") } : { bytes: 0 });
    html(200, `Uploaded ${state.uploads.length}`, "<p>upload received</p>");
    return;
  }

  if (request.method === "GET" && url.pathname === "/slow") {
    // Never answers: the browser's own navigation deadline must end it.
    return;
  }

  if (request.method === "GET" && url.pathname === "/state") {
    html(200, "Fixture state", `<pre id="state">${JSON.stringify(state)}</pre>`);
    return;
  }

  html(404, "Not found", "<p>not found</p>");
});

await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
const sitePort = site.address().port;

let config;
try {
  config = loadEgressConfig();
} catch (error) {
  console.error(JSON.stringify({ service: "browser-e2e-egress", event: "config_invalid", message: String(error?.message ?? error) }));
  process.exit(1);
}

const log = (event, fields = {}) => console.log(JSON.stringify({ service: "browser-e2e-egress", event, ...fields }));

const proxy = createEgressProxy({
  policy: config.policy,
  connectTimeoutMs: config.connectTimeoutMs,
  idleTimeoutMs: config.idleTimeoutMs,
  maxConnections: config.maxConnections,
  resolveHost: async (host) => {
    if (host === FIXTURE_HOST) return [PUBLIC_ADDRESS];
    if (host === PRIVATE_HOST) return ["10.0.0.5"];
    throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  },
  openSocket: (address, port) => {
    log("e2e_dial", { address, port });
    if (address === PUBLIC_ADDRESS && port === 80) return connect({ host: "127.0.0.1", port: sitePort });
    const refused = new Socket();
    setImmediate(() => refused.destroy(Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" })));
    return refused;
  },
  log,
});
const health = createEgressHealthServer();

proxy.listen(config.port, config.host, () =>
  log("browser_e2e_egress_started", {
    port: config.port,
    allowedPorts: config.policy.allowedPorts.join(","),
    domainAllowlist: config.policy.domainAllowlist.length,
  })
);
health.listen(config.healthPort, "127.0.0.1");

const stop = () => {
  health.close();
  site.close();
  proxy.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3_000).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
