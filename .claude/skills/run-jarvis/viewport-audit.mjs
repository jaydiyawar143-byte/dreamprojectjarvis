#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Dashboard viewport audit.
//
// The pixel half of the /dashboard layout contract. `apps/web/test/
// v4-viewport.test.tsx` asserts the STRUCTURE that produces a viewport fit, but
// it runs in jsdom, which has no layout engine — every box there is 0×0, so the
// assertion that actually matters cannot be made in it:
//
//     documentElement.scrollWidth  <= window.innerWidth
//     documentElement.scrollHeight <= window.innerHeight
//
// This makes it, in a real browser, at every viewport the dashboard is expected
// to support. It exits non-zero on any overflow, so it can gate a change.
//
// It also reports the grid's used width against the space available, because
// "no scrollbar" and "uses the screen" are different failures: a 1152px grid
// centred in a 1844px workspace has no overflow at all, and was the other half
// of the original defect.
//
//   node .claude/skills/run-jarvis/viewport-audit.mjs
//   node .claude/skills/run-jarvis/viewport-audit.mjs 1280x720,3840x2160
//
// Requires the stack to be up (`driver.mjs up`) and uses the same driver
// identity and the same system Chrome.
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_DIR = dirname(fileURLToPath(import.meta.url));
const require = createRequire(`${SKILL_DIR}/driver.mjs`);
const { chromium } = require("playwright-core");

const WEB = process.env.JARVIS_WEB_URL || "http://localhost:3000";
const API = process.env.JARVIS_API_URL || "http://127.0.0.1:3001";
const USER = {
  email: process.env.JARVIS_USER_EMAIL || "driver@jarvis.local",
  name: "Skill Driver",
  password: process.env.JARVIS_USER_PASSWORD || "DriverPass123!",
};

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error("No Chrome/Edge found. Set CHROME_PATH.");
  return found;
}

// The sizes in the brief, smallest first. 1280×720 is the tightest case: it is
// where the row floor is closest to binding.
const SIZES = (process.argv[2] || "1280x720,1366x768,1440x900,1920x1080,2560x1440")
  .split(",")
  .map((s) => {
    const [w, h] = s.trim().split("x").map(Number);
    return { w, h };
  });

// Registering an account that exists answers 400, which is the steady state.
await fetch(`${API}/api/v1/auth/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(USER),
}).catch(() => {});

const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
let failures = 0;

console.log(`\n=== dashboard viewport audit — ${WEB} ===\n`);

for (const { w, h } of SIZES) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();

  await page.goto(`${WEB}/login`, { waitUntil: "networkidle" });
  await page.fill('input[type="email"]', USER.email);
  await page.fill('input[type="password"]', USER.password);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard", { timeout: 60000 });
  // The widgets settle asynchronously; measuring before they do measures an
  // empty grid, which always fits.
  await page.waitForSelector('[data-testid="command-workspace"]', { timeout: 30000 });
  await page.waitForTimeout(4000);

  const m = await page.evaluate(() => {
    const de = document.documentElement;
    const q = (t) => document.querySelector(`[data-testid="${t}"]`);
    const box = (el) => (el ? Math.round(el.getBoundingClientRect().width) : 0);
    const main = q("dashboard-main");
    // V4 — the grid is react-grid-layout's own container on desktop, and the
    // stacked column below the grid's minimum width.
    const grid = document.querySelector('.react-grid-layout, [data-testid="command-stack"]');
    return {
      overflowX: de.scrollWidth - window.innerWidth,
      overflowY: de.scrollHeight - window.innerHeight,
      mode: q("command-workspace")?.getAttribute("data-mode") ?? "?",
      gridW: box(grid),
      availableW: box(main),
      // A widget whose PANEL overflows is the defect one level down: content
      // escaping the card instead of scrolling inside it.
      spilling: [...document.querySelectorAll('[data-testid="command-workspace"] section[aria-label]')]
        .filter((s) => s.scrollHeight > s.clientHeight + 2 || s.scrollWidth > s.clientWidth + 2)
        .map((s) => s.getAttribute("aria-label")),
      // Not a defect — the designed escape hatch. Reported because "which
      // widgets do not fully fit at this size" is a real design question, and
      // the honest answer should be visible rather than inferred.
      scrollingInside: [...document.querySelectorAll('[data-testid="command-workspace"] section[aria-label]')]
        .filter((s) =>
          [...s.children].some((c) => c.scrollHeight > c.clientHeight + 2)
        )
        .map((s) => s.getAttribute("aria-label")),
    };
  });

  // Anything narrower than ~92% of the space available is the "dashboard
  // stranded in the middle of the screen" defect, not a rounding difference.
  const usedPct = m.availableW ? Math.round((m.gridW / m.availableW) * 100) : 0;
  const bad = m.overflowX > 0 || m.overflowY > 0 || usedPct < 92 || m.spilling.length > 0;
  if (bad) failures++;

  console.log(`${bad ? "FAIL" : "ok  "}  ${String(`${w}x${h}`).padEnd(10)}` +
    ` [${m.mode}] scroll x=${String(m.overflowX).padStart(4)} y=${String(m.overflowY).padStart(4)}` +
    `   grid ${String(m.gridW).padStart(5)}/${String(m.availableW).padStart(5)}px (${usedPct}% of workspace)`);
  if (m.spilling.length) console.log(`        FAIL widgets overflowing their panel: ${m.spilling.join(", ")}`);
  if (m.scrollingInside.length) console.log(`        scrolling inside their panel: ${m.scrollingInside.join(", ")}`);

  await ctx.close();
}

await browser.close();

console.log(
  failures === 0
    ? "\nAll viewports fit: no page scroll on either axis, full width used.\n"
    : `\n${failures} viewport(s) FAILED.\n`
);
process.exit(failures === 0 ? 0 : 1);
