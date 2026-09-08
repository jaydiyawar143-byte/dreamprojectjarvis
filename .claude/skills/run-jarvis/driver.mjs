#!/usr/bin/env node
// ---------------------------------------------------------------------------
// JARVIS run-skill driver.
//
// One handle on the running stack for agents: preflight the environment,
// start/stop the servers, hit the REST API as a real authenticated user, and
// drive the Next.js UI in a real Chrome via playwright-core.
//
// Deliberately dependency-light: playwright-core only, resolved from this
// directory's own node_modules (this dir is NOT a pnpm workspace member, so
// `pnpm install` at the repo root will not provision it -- see SKILL.md).
//
// Usage:  node .claude/skills/run-jarvis/driver.mjs <command> [args]
// ---------------------------------------------------------------------------

import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const SKILL_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(SKILL_DIR, "../../..");
const SHOTS = join(SKILL_DIR, "screenshots");
const LOGS = join(SKILL_DIR, "logs");
const STATE_FILE = join(SKILL_DIR, ".driver-state.json");

const API = process.env.JARVIS_API_URL || "http://127.0.0.1:3001";
// MUST be "localhost", not "127.0.0.1". The API answers a fixed
// Access-Control-Allow-Origin of http://localhost:3000 (CORS_ORIGIN default),
// so a page served from http://127.0.0.1:3000 has every XHR blocked by CORS --
// the login form just silently never navigates.
const WEB = process.env.JARVIS_WEB_URL || "http://localhost:3000";
const PG_CONTAINER = process.env.JARVIS_PG_CONTAINER || "jarvis-postgres";

// Default driver identity. Registered on first use, reused thereafter.
const USER = {
  email: process.env.JARVIS_USER_EMAIL || "driver@jarvis.local",
  name: "Skill Driver",
  password: process.env.JARVIS_USER_PASSWORD || "DriverPass123!",
};

for (const d of [SHOTS, LOGS]) if (!existsSync(d)) mkdirSync(d, { recursive: true });

// --- tiny output helpers ---------------------------------------------------
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => console.log(`  FAIL  ${m}`);
const info = (m) => console.log(`  ..    ${m}`);
const head = (m) => console.log(`\n=== ${m} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveState(patch) {
  const s = { ...loadState(), ...patch };
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  return s;
}

// --- process / port --------------------------------------------------------
function portOpen(port, host = "127.0.0.1", timeout = 1000) {
  return new Promise((res) => {
    const sock = new net.Socket();
    const done = (v) => {
      sock.destroy();
      res(v);
    };
    sock.setTimeout(timeout);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
    sock.connect(port, host);
  });
}

async function waitFor(label, fn, { tries = 60, delay = 1000 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      if (await fn()) return true;
    } catch {
      /* keep waiting */
    }
    await sleep(delay);
  }
  throw new Error(`timed out waiting for ${label} (${(tries * delay) / 1000}s)`);
}

// Git Bash (MSYS) rewrites any argument that looks like a POSIX path before
// node ever sees it: `/api/v1/health` arrives as
// `C:/Program Files/Git/api/v1/health`. Undo that here so the same command
// works from Git Bash, PowerShell and cmd without MSYS_NO_PATHCONV=1.
function normalizePath(p) {
  if (!p) return p;
  if (/^https?:\/\//i.test(p)) return p;
  const mangled = p.match(/^[A-Za-z]:[\\/].*?[\\/]Git[\\/](.*)$/);
  if (mangled) return "/" + mangled[1].replace(/\\/g, "/");
  return p.startsWith("/") ? p : "/" + p;
}

// --- HTTP ------------------------------------------------------------------
async function req(method, path, { body, token, base = API } = {}) {
  const url = path.startsWith("http") ? path : `${base}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { _raw: text.slice(0, 400) };
  }
  return { status: res.status, json };
}

// Register-or-login. On reruns the account already exists and the API answers
// 400 INVALID_REQUEST ("An account with this email already exists") -- NOT 409.
// That 400 is the expected steady state, not an error.
async function auth({ quiet = false } = {}) {
  const reg = await req("POST", "/api/v1/auth/register", { body: USER });
  if (reg.status === 201) {
    if (!quiet) ok(`registered ${USER.email}`);
  } else if (!quiet) {
    info(`account exists (${reg.status}), logging in`);
  }
  const login = await req("POST", "/api/v1/auth/login", {
    body: { email: USER.email, password: USER.password },
  });
  if (login.status !== 200) {
    throw new Error(
      `login failed ${login.status}: ${JSON.stringify(login.json).slice(0, 300)}`
    );
  }
  const t = login.json.data.tokens;
  saveState({
    accessToken: t.accessToken,
    refreshToken: t.refreshToken,
    userId: login.json.data.user.id,
  });
  if (!quiet) ok(`token acquired (expires in ${t.expiresIn ?? "?"}s)`);
  return t.accessToken;
}

// Access tokens live ~15 min, so anything that matters re-auths rather than
// trusting the cached one.
async function freshToken() {
  return auth({ quiet: true });
}

// --- browser ---------------------------------------------------------------
function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env["ProgramFiles(x86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env["ProgramFiles(x86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];
  const found = candidates.find((p) => p && existsSync(p));
  if (!found) throw new Error("No Chrome/Edge found. Set CHROME_PATH to a browser executable.");
  return found;
}

async function browser({ headed = false } = {}) {
  const { chromium } = await import("playwright-core");
  const b = await chromium.launch({ executablePath: chromePath(), headless: !headed });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  return { b, ctx, page, errors };
}

// Seeding sessionStorage is NOT enough to reach a protected page. api.ts holds
// the token in a module-level `_accessToken` and only ever populates it from
// setTokens() (login) or loadTokens() (AuthProvider's mount effect). React runs
// child effects before parent ones, so on a hard load of /approvals the page's
// own fetch fires while `_accessToken` is still null -> 401 "Authentication
// required", and the 401-retry path can't save it either because `_refreshToken`
// is null for the same reason. Storage is seeded anyway so a later in-app
// refresh has something to read, but the reliable route is loginViaForm +
// client-side navigation below.
// UI V2 — deliberately a no-op.
//
// Seeding sessionStorage no longer establishes anything: the session is an
// HttpOnly refresh cookie the API sets at login, and the access token is held
// in a module variable that nothing outside the app can write. Kept as a stub
// so the call site reads honestly rather than looking like it still helps.
// loginViaForm is now the ONLY way to obtain a browser session.
async function seedAuth(_page, _tok) {
  /* no-op: see comment above */
}

// Real login through the actual form. This is what puts the token in the
// module-level closure, so every subsequent client-side navigation is authed.
async function loginViaForm(page) {
  await auth({ quiet: true }); // ensure the account exists
  await page.goto(`${WEB}/login`, { waitUntil: "networkidle" });
  await page.fill('input[type="email"]', USER.email);
  await page.fill('input[type="password"]', USER.password);
  await page.click('button[type="submit"]');
  // UI V2 — login lands on /dashboard, not /chat.
  await page.waitForURL("**/dashboard", { timeout: 30000 });
}

// Navigate to a protected route WITHOUT a page reload, so the in-memory token
// survives. next/link anchors are intercepted by the app router; a plain
// page.goto would be a hard load and re-open the 401 race described above.
async function gotoAuthed(page, route) {
  // UI V2 — /dashboard is where login lands, so it needs no navigation.
  if (route === "/dashboard") return;
  const link = page.locator(`a[href="${route}"]`).first();
  if ((await link.count()) > 0) {
    await link.click();
    await page.waitForURL(`**${route}`, { timeout: 30000 });
    return;
  }
  info(`no in-app link to ${route}; hard-loading (page data may 401)`);
  await page.goto(`${WEB}${route}`, { waitUntil: "networkidle" });
}

async function shoot(page, name) {
  const file = join(SHOTS, name.endsWith(".png") ? name : `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  ok(`screenshot -> ${file}`);
  return file;
}

function dumpErrors(errors) {
  if (errors.length) {
    console.log("  console errors:\n" + errors.map((e) => "    " + e).join("\n"));
  }
}

// --- commands --------------------------------------------------------------
const cmds = {};

cmds.doctor = async () => {
  head("doctor");
  let fail = 0;

  try {
    execSync("docker info", { stdio: "pipe" });
    ok("docker daemon reachable");
  } catch {
    bad("docker daemon NOT reachable -- start Docker Desktop, wait ~60s");
    fail++;
  }

  try {
    const st = execSync(`docker inspect -f "{{.State.Status}}" ${PG_CONTAINER}`, { stdio: "pipe" })
      .toString()
      .trim();
    if (st === "running") ok(`container ${PG_CONTAINER} running`);
    else {
      bad(`container ${PG_CONTAINER} is '${st}' -- docker start ${PG_CONTAINER}`);
      fail++;
    }
  } catch {
    bad(`container ${PG_CONTAINER} missing -- see SKILL.md Prerequisites`);
    fail++;
  }

  // The published port lags the container by a few seconds after Docker Desktop
  // boots; a running container with a closed 5432 is that window.
  if (await portOpen(5432)) ok("postgres reachable on 127.0.0.1:5432");
  else {
    bad("port 5432 closed (container up but proxy not wired yet? wait, retry)");
    fail++;
  }

  for (const [name, port] of [
    ["api", 3001],
    ["web", 3000],
  ]) {
    if (await portOpen(port)) ok(`${name} listening on ${port}`);
    else info(`${name} not listening on ${port} (start it: driver.mjs up)`);
  }

  try {
    ok(`chrome: ${chromePath()}`);
  } catch (e) {
    bad(e.message);
    fail++;
  }

  if (existsSync(join(SKILL_DIR, "node_modules/playwright-core"))) ok("playwright-core installed");
  else {
    bad("playwright-core missing -- npm install in .claude/skills/run-jarvis");
    fail++;
  }

  console.log(fail ? `\n${fail} blocking problem(s).` : "\nAll preflight checks passed.");
  if (fail) process.exitCode = 1;
};

function launch(name, cwd, args, port) {
  const log = join(LOGS, `${name}.log`);
  writeFileSync(log, `--- ${name} started ${new Date().toISOString()} ---\n`);
  // Log via raw file descriptors, NOT stdio:"pipe". Piping would attach
  // readable streams to this process, and those keep the event loop alive --
  // `up` would hang forever after the servers are already healthy, even with
  // child.unref(). With fds the parent holds nothing and exits cleanly.
  const fd = openSync(log, "a");
  // One command STRING, not (cmd, argsArray) -- node 22+ emits DEP0190 for an
  // args array combined with shell:true. shell is required on Windows to run
  // npx.cmd at all. These args are fixed literals, so concatenation is safe.
  const child = spawn(`npx ${args.join(" ")}`, {
    cwd,
    detached: true,
    stdio: ["ignore", fd, fd],
    shell: true,
  });
  child.unref();
  closeSync(fd);
  info(`${name} pid=${child.pid} log=${log}`);
  return { pid: child.pid, port, log };
}

cmds.up = async () => {
  head("up");
  try {
    execSync(`docker start ${PG_CONTAINER}`, { stdio: "pipe" });
    ok("postgres started");
  } catch {
    info("postgres already running (or docker down -- run doctor)");
  }
  await waitFor("postgres:5432", () => portOpen(5432), { tries: 40 });
  ok("postgres accepting connections");

  if (await portOpen(3001)) {
    ok("api already up on 3001");
  } else {
    // cwd MUST be apps/api: its env loader resolves the root .env as ../../.env
    const api = launch("api", join(REPO, "apps/api"), ["tsx", "src/index.ts"], 3001);
    saveState({ api });
    await waitFor("api /health", async () => (await req("GET", "/api/v1/health")).status === 200, {
      tries: 90,
    });
    ok("api healthy on 3001");
  }

  if (await portOpen(3000)) {
    ok("web already up on 3000");
  } else {
    const web = launch("web", join(REPO, "apps/web"), ["next", "dev", "--port", "3000"], 3000);
    saveState({ web });
    await waitFor(
      "web /login",
      async () => {
        const r = await fetch(`${WEB}/login`).catch(() => null);
        return r && r.status === 200;
      },
      { tries: 90 }
    );
    ok("web serving on 3000");
  }
};

// Whatever is actually LISTENING on a port. Killing by recorded pid alone is
// not enough on Windows: spawn(shell:true) records the cmd.exe wrapper, and the
// real node process can re-parent and outlive `taskkill /T` on that wrapper --
// leaving a stale API on 3001 that a later `up` happily reports as "already up".
function pidsOnPort(port) {
  try {
    if (process.platform === "win32") {
      const out = execSync(`netstat -ano -p TCP`, { stdio: "pipe" }).toString();
      return [
        ...new Set(
          out
            .split(/\r?\n/)
            .filter((l) => /LISTENING/.test(l) && new RegExp(`[:.]${port}\\s`).test(l))
            .map((l) => l.trim().split(/\s+/).pop())
            .filter((p) => p && p !== "0")
        ),
      ];
    }
    return execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { stdio: "pipe" })
      .toString()
      .split(/\s+/)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function killPid(pid) {
  try {
    if (process.platform === "win32") execSync(`taskkill /PID ${pid} /T /F`, { stdio: "pipe" });
    else process.kill(Number(pid), "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

cmds.down = async () => {
  head("down");
  const s = loadState();
  for (const [key, port] of [
    ["api", 3001],
    ["web", 3000],
  ]) {
    const pid = s[key]?.pid;
    if (pid && killPid(pid)) ok(`${key} pid ${pid} stopped`);

    // Then sweep the port itself, which catches orphans and anything started
    // by hand outside the driver.
    for (const stray of pidsOnPort(port)) {
      if (killPid(stray)) ok(`${key} orphan pid ${stray} on ${port} stopped`);
    }
    if (!(await portOpen(port))) ok(`port ${port} free`);
    else bad(`port ${port} STILL listening`);
  }
  saveState({ api: null, web: null });
  info("postgres left running on purpose (docker stop jarvis-postgres to stop it)");
};

cmds["api:health"] = async () => {
  head("api:health");
  const r = await req("GET", "/api/v1/health");
  console.log(JSON.stringify(r.json, null, 2));
  if (r.status !== 200) process.exitCode = 1;
};

cmds["api:auth"] = async () => {
  head("api:auth");
  console.log(await auth());
};

cmds["api:chat"] = async (msg, convId) => {
  head("api:chat");
  if (!msg) throw new Error('usage: api:chat "<message>" [conversationId]');
  const t = await freshToken();
  const body = { message: msg, ...(convId ? { conversationId: convId } : {}) };
  const started = Date.now();
  const r = await req("POST", "/api/v1/chat", { body, token: t });
  info(`${r.status} in ${Date.now() - started}ms`);
  console.log(JSON.stringify(r.json, null, 2));
  if (r.json?.data?.conversationId) saveState({ conversationId: r.json.data.conversationId });
  if (r.status !== 200) process.exitCode = 1;
};

cmds["api:get"] = async (rawPath) => {
  if (!rawPath) throw new Error("usage: api:get /api/v1/<path>");
  const path = normalizePath(rawPath);
  head(`api:get ${path}`);
  const r = await req("GET", path, { token: await freshToken() });
  info(`status ${r.status}`);
  console.log(JSON.stringify(r.json, null, 2));
  if (r.status >= 400) process.exitCode = 1;
};

cmds["api:post"] = async (rawPath, json) => {
  if (!rawPath) throw new Error("usage: api:post /api/v1/<path> '<json>'");
  const path = normalizePath(rawPath);
  head(`api:post ${path}`);
  const r = await req("POST", path, {
    token: await freshToken(),
    body: json ? JSON.parse(json) : {},
  });
  info(`status ${r.status}`);
  console.log(JSON.stringify(r.json, null, 2));
  if (r.status >= 400) process.exitCode = 1;
};

cmds["web:shot"] = async (rawRoute = "/login", name) => {
  const route = normalizePath(rawRoute);
  head(`web:shot ${route}`);
  const { b, page, errors } = await browser();
  try {
    if (route === "/login" || route === "/register") {
      await page.goto(`${WEB}${route}`, { waitUntil: "networkidle" });
    } else {
      await seedAuth(page, await freshToken());
      await loginViaForm(page);
      await gotoAuthed(page, route);
    }
    await page.waitForTimeout(1500);
    await shoot(page, name || `shot${route.replace(/\W+/g, "_")}`);
    info(`title: ${await page.title()}`);
    dumpErrors(errors);
  } finally {
    await b.close();
  }
};

cmds["web:login"] = async () => {
  head("web:login");
  const { b, page, errors } = await browser();
  try {
    await auth({ quiet: true });
    await page.goto(`${WEB}/login`, { waitUntil: "networkidle" });
    await shoot(page, "01-login-page");
    await loginViaForm(page);
    await page.waitForTimeout(1500);
    await shoot(page, "02-after-login");
    ok(`landed on ${page.url()}`);
    dumpErrors(errors);
  } finally {
    await b.close();
  }
};

cmds["web:chat"] = async (msg = "Hello JARVIS, reply with exactly: UI OK") => {
  head("web:chat");
  const { b, page, errors } = await browser();
  try {
    await loginViaForm(page);
    // UI V2 — login lands on /dashboard now, so reach the assistant through
    // the sidebar link (a client-side navigation, which preserves the
    // in-memory access token).
    await gotoAuthed(page, "/chat");

    const box = page.locator('textarea[placeholder="Message JARVIS..."]');
    await box.waitFor({ timeout: 20000 });
    await box.fill(msg);
    await box.press("Enter");
    info("message sent, waiting for the assistant turn (model call, ~5-20s)");

    // Waiting on body text is a trap here: the user's own bubble renders
    // instantly and carries a timestamp, so "text appeared after my message"
    // is satisfied while the model is still thinking. The real signals are the
    // three .animate-bounce dots (typing indicator, present only while
    // sending) and .justify-start rows (assistant bubbles; user is
    // .justify-end). Wait for dots gone AND at least one assistant bubble.
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".animate-bounce").length === 0 &&
        [...document.querySelectorAll("div.flex.justify-start")].some(
          (n) => n.innerText.trim().length > 0
        ),
      undefined,
      { timeout: 120000, polling: 500 }
    );
    await page.waitForTimeout(1500);
    await shoot(page, "03-chat-reply");
    dumpErrors(errors);
  } finally {
    await b.close();
  }
};

cmds.smoke = async () => {
  head("smoke: full stack");
  await cmds.doctor();
  if (process.exitCode === 1) throw new Error("doctor failed -- fix the above before smoking");

  head("smoke: api");
  const h = await req("GET", "/api/v1/health");
  h.status === 200 ? ok(`health ${h.json.status}`) : bad(`health ${h.status}`);
  const t = await auth();

  const chat = await req("POST", "/api/v1/chat", {
    body: { message: "Hello JARVIS, reply with exactly: SMOKE OK" },
    token: t,
  });
  let convId;
  if (chat.status === 200) {
    convId = chat.json.data.conversationId;
    ok(`chat -> "${chat.json.data.message}" (${chat.json.data.metadata?.model})`);
  } else {
    bad(`chat ${chat.status}: ${JSON.stringify(chat.json).slice(0, 200)}`);
    process.exitCode = 1;
  }

  const probes = [
    "/api/v1/conversations",
    "/api/v1/approvals",
    "/api/v1/recommendations",
    "/api/v1/opportunities",
    // pending-actions is conversation-scoped: a bare GET is a 400 by design,
    // not a failure. It needs the conversationId the chat turn just created.
    ...(convId ? [`/api/v1/pending-actions?conversationId=${convId}`] : []),
  ];
  for (const p of probes) {
    const r = await req("GET", p, { token: t });
    if (r.status === 200) ok(`GET ${p.split("?")[0]} 200`);
    else {
      bad(`GET ${p} ${r.status}`);
      process.exitCode = 1;
    }
  }

  head("smoke: web");
  await cmds["web:chat"]();
  console.log("\nSmoke complete. Screenshots in .claude/skills/run-jarvis/screenshots/");
};

cmds.help = async () => {
  console.log(`
JARVIS driver -- node .claude/skills/run-jarvis/driver.mjs <command>

  doctor                    preflight: docker, postgres, ports, chrome, deps
  up                        start postgres + api + web, wait until ready
  down                      stop api + web (postgres stays up)

  api:health                GET /api/v1/health
  api:auth                  register-or-login, print + cache access token
  api:chat "<msg>" [convId] one chat turn through the agent stack
  api:get  <path>           authenticated GET  (e.g. /api/v1/conversations)
  api:post <path> '<json>'  authenticated POST

  web:shot <route> [name]   screenshot any route (auto-authenticates)
  web:login                 drive the real login form -> /chat + screenshots
  web:chat "<msg>"          full UI chat turn -> screenshot of the reply

  smoke                     everything above, end to end

Env overrides: JARVIS_API_URL JARVIS_WEB_URL JARVIS_USER_EMAIL
               JARVIS_USER_PASSWORD JARVIS_PG_CONTAINER CHROME_PATH
`);
};

// --- dispatch --------------------------------------------------------------
const [cmd, ...args] = process.argv.slice(2);
const fn = cmds[cmd || "help"];
if (!fn) {
  console.error(`Unknown command: ${cmd}\n`);
  await cmds.help();
  process.exit(1);
}
try {
  await fn(...args);
} catch (e) {
  console.error(`\nDRIVER ERROR: ${e.message}`);
  process.exit(1);
}
