// ---------------------------------------------------------------------------
// UI V2 visual QA harness.
//
// The bundled driver's `web:shot` seeds sessionStorage and THEN drives the
// login form, so on a fast machine the app has already authenticated and
// redirected away from /login before `page.fill` runs. That is a race in the
// harness, not the app.
//
// This does the same job the other way round: authenticate over HTTP, seed the
// tokens the app expects, then load each route directly. `api.ts` hydrates its
// in-memory token from sessionStorage at MODULE EVALUATION, so a hard load is
// safe — that hydration is exactly what fixed the old 401-on-refresh race.
//
// Usage:  node .claude/skills/run-jarvis/shots.mjs [--width 1440] route [route…]
// ---------------------------------------------------------------------------
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, "screenshots");
const API = process.env.JARVIS_API_URL || "http://localhost:3001/api/v1";
const WEB = process.env.JARVIS_WEB_URL || "http://localhost:3000";
const CHROME =
  process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const USER = {
  email: process.env.JARVIS_USER_EMAIL || "driver@jarvis.local",
  name: "Driver",
  password: process.env.JARVIS_USER_PASSWORD || "DriverPass123!",
};

const args = process.argv.slice(2);
let width = 1440;
const widthAt = args.indexOf("--width");
if (widthAt !== -1) {
  width = Number(args[widthAt + 1]);
  args.splice(widthAt, 2);
}
const label = args.indexOf("--label") !== -1 ? args[args.indexOf("--label") + 1] : "";
if (label) args.splice(args.indexOf("--label"), 2);

const routes = args.length > 0 ? args : ["/dashboard"];

async function post(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// Registering an existing account returns 400, which is the steady state here.
await post("/auth/register", USER).catch(() => undefined);
const login = await post("/auth/login", { email: USER.email, password: USER.password });
if (!login?.success) {
  console.error("login failed:", JSON.stringify(login?.error ?? login));
  process.exit(1);
}
const { accessToken, refreshToken } = login.data.tokens;

mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width, height: 1000 } });

const errors = [];
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("favicon")) errors.push(m.text());
});
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

// Seed on the app's own origin so sessionStorage is written to the right key.
await page.goto(`${WEB}/login`, { waitUntil: "domcontentloaded" });
await page.evaluate(
  ([a, r]) => {
    sessionStorage.setItem("jarvis_access", a);
    sessionStorage.setItem("jarvis_refresh", r);
  },
  [accessToken, refreshToken]
);

let failures = 0;
for (const route of routes) {
  errors.length = 0;
  const name = `${label ? `${label}-` : ""}${route.replace(/\W+/g, "_").replace(/^_/, "") || "root"}`;
  try {
    await page.goto(`${WEB}${route}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);

    const url = page.url();
    const redirected = new URL(url).pathname !== route;
    const text = (await page.locator("body").innerText()).replace(/\s*\n+\s*/g, " | ");
    const file = join(SHOTS, `${name}.png`);
    await page.screenshot({ path: file, fullPage: true });

    const status = redirected ? `REDIRECTED -> ${new URL(url).pathname}` : "ok";
    console.log(`${route.padEnd(16)} ${status.padEnd(28)} w=${width}`);
    console.log(`   ${text.slice(0, 220)}`);
    if (errors.length) {
      failures += 1;
      for (const e of errors.slice(0, 4)) console.log(`   ERROR: ${e.slice(0, 220)}`);
    }
  } catch (err) {
    failures += 1;
    console.log(`${route.padEnd(16)} FAILED: ${err.message.slice(0, 160)}`);
  }
}

await browser.close();
console.log(failures === 0 ? "\nall routes rendered clean" : `\n${failures} route(s) reported problems`);
process.exit(failures === 0 ? 0 : 1);
