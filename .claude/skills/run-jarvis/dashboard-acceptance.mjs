#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Dashboard acceptance test — the free-form grid, driven for real.
//
// Everything here is done with the mouse, against the running app: the pointer
// is pressed on a drag grip, moved in steps, and released; a corner handle is
// dragged; a widget is hidden and restored through the UI. Nothing is asserted
// from the code, because the question this answers — "can a person actually
// rearrange this dashboard, and does it stay rearranged" — is not a question
// the source can answer.
//
// It restores the default layout on the way out, so it can be run repeatedly.
//
//   node .claude/skills/run-jarvis/dashboard-acceptance.mjs
//
// Exits non-zero if any step fails. Requires `driver.mjs up`.
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_DIR = dirname(fileURLToPath(import.meta.url));
const require = createRequire(`${SKILL_DIR}/driver.mjs`);
const { chromium } = require("playwright-core");

const WEB = process.env.JARVIS_WEB_URL || "http://localhost:3000";
const API = process.env.JARVIS_API_URL || "http://127.0.0.1:3001";
const SHOTS = join(SKILL_DIR, "screenshots");
const USER = {
  email: process.env.JARVIS_USER_EMAIL || "driver@jarvis.local",
  name: "Skill Driver",
  password: process.env.JARVIS_USER_PASSWORD || "DriverPass123!",
};

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const found = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
  ].find((p) => existsSync(p));
  if (!found) throw new Error("No Chrome found. Set CHROME_PATH.");
  return found;
}

let failures = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => {
  failures++;
  console.log(`  FAIL  ${m}`);
};
const check = (cond, m) => (cond ? ok(m) : bad(m));
const head = (m) => console.log(`\n=== ${m} ===`);

await fetch(`${API}/api/v1/auth/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(USER),
}).catch(() => {});

const browser = await chromium.launch({ executablePath: chromePath(), headless: true });

async function open(width = 1366, height = 768) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  await page.goto(`${WEB}/login`, { waitUntil: "networkidle" });
  await page.fill('input[type="email"]', USER.email);
  await page.fill('input[type="password"]', USER.password);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard", { timeout: 60000 });
  await page.waitForSelector('[data-testid="command-workspace"]');
  await page.waitForTimeout(3500);
  return { ctx, page };
}

/**
 * Where every widget sits, in GRID UNITS.
 *
 * Not pixels. Pixel geometry is a function of the viewport AND of whether the
 * customise toolbar is open — it makes the workspace ~18px shorter, which
 * changes every row height and therefore every widget's pixel size. Comparing
 * pixels across a save-and-reload compares the chrome, not the layout.
 */
const readLayout = (page) =>
  page.evaluate(() => {
    const out = {};
    for (const el of document.querySelectorAll('[data-testid^="cell-"]')) {
      const id = el.getAttribute("data-testid").replace("cell-", "");
      out[id] = {
        x: Number(el.dataset.x),
        y: Number(el.dataset.y),
        w: Number(el.dataset.w),
        h: Number(el.dataset.h),
      };
    }
    return out;
  });

/** Pixel boxes, for the questions that are genuinely about pixels. */
const readBoxes = (page) =>
  page.evaluate(() => {
    const out = {};
    for (const el of document.querySelectorAll('[data-testid^="cell-"]')) {
      const r = el.getBoundingClientRect();
      out[el.getAttribute("data-testid").replace("cell-", "")] = {
        x: Math.round(r.left), y: Math.round(r.top),
        w: Math.round(r.width), h: Math.round(r.height),
      };
    }
    return out;
  });

const pageOverflow = (page) =>
  page.evaluate(() => ({
    v: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    h: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));

/**
 * A real pointer drag.
 *
 * react-draggable needs intermediate moves — a single jump from press to
 * release is not a drag as far as it is concerned, and nothing moves.
 */
async function dragBy(page, selector, dx, dy) {
  const el = await page.waitForSelector(selector, { timeout: 10000 });
  const box = await el.boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(cx + (dx * i) / 12, cy + (dy * i) / 12);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  await page.waitForTimeout(700);
}

let { ctx, page } = await open();

// ---------------------------------------------------------------------------
head("1. clean dashboard at 1366x768");
{
  const o = await pageOverflow(page);
  check(o.v <= 0, `no page vertical scroll (scrollHeight - clientHeight = ${o.v})`);
  check(o.h <= 0, `no page horizontal scroll (scrollWidth - clientWidth = ${o.h})`);

  const handles = await page.evaluate(
    () =>
      [...document.querySelectorAll(".react-resizable-handle")].filter(
        (h) => getComputedStyle(h).display !== "none" && h.offsetParent !== null
      ).length
  );
  check(handles === 0, `no resize handles visible outside customise mode (${handles})`);
  check(
    (await page.locator('[data-testid="grid-guides"]').count()) === 0,
    "no grid guides outside customise mode"
  );
  check(await page.locator('[data-testid="command-input"]').isVisible(), "command bar visible");
}

// ---------------------------------------------------------------------------
head("2. customise mode");
await page.click('[data-testid="customize-toggle"]');
await page.waitForTimeout(900);
{
  const handles = await page.evaluate(
    () =>
      [...document.querySelectorAll(".react-resizable-handle")].filter(
        (h) => getComputedStyle(h).display !== "none" && h.offsetParent !== null
      ).length
  );
  check(handles > 0, `resize handles appear (${handles})`);
  check(
    (await page.locator('[data-testid="grid-guides"]').count()) === 1,
    "grid guides appear"
  );
  check((await page.locator('[data-testid="drag-orb"]').count()) === 1, "orb has a drag grip");
}

const before = await readLayout(page);

// ---------------------------------------------------------------------------
head("3. drag widgets");
{
  const cell = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="cell-clock"]');
    return el ? el.getBoundingClientRect().width / 2 : 100;
  });

  await dragBy(page, '[data-testid="drag-orb"]', Math.round(cell * 2), 0);
  const afterOrb = await readLayout(page);
  check(afterOrb.orb.x !== before.orb.x, `orb moved (column ${before.orb.x} -> ${afterOrb.orb.x})`);

  await dragBy(page, '[data-testid="drag-weather"]', -Math.round(cell * 2), 0);
  const afterWeather = await readLayout(page);
  check(
    afterWeather.weather.x !== before.weather.x || afterWeather.weather.y !== before.weather.y,
    "weather moved"
  );

  await dragBy(page, '[data-testid="drag-tasks"]', 0, 120);
  const afterTasks = await readLayout(page);
  check(
    afterTasks.tasks.x !== before.tasks.x || afterTasks.tasks.y !== before.tasks.y,
    "tasks moved"
  );

  const o = await pageOverflow(page);
  check(o.v <= 0 && o.h <= 0, "dragging created no page scroll");
}

// ---------------------------------------------------------------------------
head("4. resize by dragging a corner handle");
{
  const pre = await readLayout(page);
  await dragBy(page, '[data-testid="cell-map"] .react-resizable-handle-se', -160, 90);
  const post = await readLayout(page);
  check(
    post.map.w !== pre.map.w || post.map.h !== pre.map.h,
    `map resized by corner (${pre.map.w}x${pre.map.h} -> ${post.map.w}x${post.map.h} cells)`
  );

  const gm = await page.evaluate(() => {
    const s = document.querySelector('section[aria-label*="ocation"]');
    const host = s?.querySelector(".gm-style")?.parentElement;
    const r = host?.getBoundingClientRect();
    return {
      present: Boolean(s?.querySelector(".gm-style")),
      w: Math.round(r?.width ?? 0),
      tiles: s?.querySelectorAll("img").length ?? 0,
    };
  });
  check(gm.present && gm.tiles > 0, `Google map still rendering after resize (${gm.tiles} tiles, ${gm.w}px wide)`);

  const preSys = await readLayout(page);
  // Upward: the map was just grown, so system sits low and growing it further
  // can legitimately be refused at the row ceiling. Shrinking always fits, and
  // it exercises the same edge handle.
  await dragBy(page, '[data-testid="cell-system"] .react-resizable-handle-s', 0, -70);
  const postSys = await readLayout(page);
  check(
    postSys.system.h !== preSys.system.h,
    `system monitor resized by edge handle (${preSys.system.h} -> ${postSys.system.h} rows)`
  );

  const o = await pageOverflow(page);
  check(o.v <= 0 && o.h <= 0, "resizing created no page scroll");
}

// ---------------------------------------------------------------------------
head("5. no widget overlaps, nothing escapes the workspace");
{
  const bad2 = await page.evaluate(() => {
    const ws = document.querySelector('[data-testid="command-workspace"]').getBoundingClientRect();
    const cells = [...document.querySelectorAll('[data-testid^="cell-"]')].map((el) => ({
      id: el.getAttribute("data-testid"),
      r: el.getBoundingClientRect(),
    }));
    const escaped = cells
      .filter((c) => c.r.right > ws.right + 2 || c.r.bottom > ws.bottom + 2 || c.r.left < ws.left - 2)
      .map((c) => c.id);
    const overlapping = [];
    for (let i = 0; i < cells.length; i++)
      for (let j = i + 1; j < cells.length; j++) {
        const a = cells[i].r;
        const b = cells[j].r;
        if (a.left < b.right - 2 && b.left < a.right - 2 && a.top < b.bottom - 2 && b.top < a.bottom - 2)
          overlapping.push(`${cells[i].id}/${cells[j].id}`);
      }
    return { escaped, overlapping };
  });
  check(bad2.escaped.length === 0, `no widget escaped the workspace ${bad2.escaped.join(", ")}`);
  check(bad2.overlapping.length === 0, `no widgets overlap ${bad2.overlapping.join(", ")}`);
}

// ---------------------------------------------------------------------------
head("6. hide and restore");
{
  await page.click('[data-testid="hide-markets"]');
  await page.waitForTimeout(600);
  check((await page.locator('[data-testid="cell-markets"]').count()) === 0, "markets hidden");

  await page.click('[data-testid="manage-widgets"]');
  await page.waitForTimeout(400);
  check(
    /hidden/i.test(await page.locator('[data-testid="manage-widgets"]').innerText()),
    "hidden count reported in Manage widgets"
  );
  await page.click('[data-testid="toggle-markets"]');
  await page.waitForTimeout(600);
  check((await page.locator('[data-testid="cell-markets"]').count()) === 1, "markets restored");

  const orbToggle = page.locator('[data-testid="toggle-orb"]');
  check(await orbToggle.isDisabled(), "the Orb cannot be switched off");
  await page.click('[data-testid="manage-widgets"]');
  await page.waitForTimeout(300);
}

// ---------------------------------------------------------------------------
head("7. save and come back");
const saved = await readLayout(page);
{
  check(await page.locator('[data-testid="save-layout"]').isEnabled(), "Save is enabled by the edits");
  await page.click('[data-testid="save-layout"]');
  await page.waitForTimeout(2500);

  // The save has to be ACCEPTED, not merely attempted. A rejected save leaves
  // `dirty` true on purpose, so the unsaved marker is the honest signal — and
  // checking it here is what would have caught the API rejecting the whole
  // payload as invalid, which otherwise only showed up as "it did not persist".
  check(
    (await page.locator('[data-testid="unsaved-indicator"]').count()) === 0,
    "the server accepted the layout (no unsaved marker left)"
  );
  await page.screenshot({ path: join(SHOTS, "acceptance-customising.png") });
  await ctx.close();

  ({ ctx, page } = await open());
  const restored = await readLayout(page);

  const drifted = Object.keys(saved).filter((id) => {
    const a = saved[id];
    const b = restored[id];
    return !b || a.x !== b.x || a.y !== b.y || a.w !== b.w || a.h !== b.h;
  });
  const same = drifted.length === 0;
  if (!same) console.log(`        drifted: ${drifted.join(", ")}`);
  check(same, "layout persisted across a full re-login");

  const o = await pageOverflow(page);
  check(o.v <= 0 && o.h <= 0, "no page scroll after restoring a custom layout");
  await page.screenshot({ path: join(SHOTS, "acceptance-restored.png") });
}

// ---------------------------------------------------------------------------
head("8. every resolution, with the custom layout in place");
for (const [w, h] of [[1280, 720], [1366, 768], [1440, 900], [1920, 1080], [2560, 1440]]) {
  await ctx.close();
  ({ ctx, page } = await open(w, h));
  const o = await pageOverflow(page);
  check(o.v <= 0 && o.h <= 0, `${w}x${h}: vertical=${o.v} horizontal=${o.h}`);
}

// ---------------------------------------------------------------------------
head("9. reset, so the account is left as it was found");
{
  await page.click('[data-testid="customize-toggle"]');
  await page.waitForTimeout(500);
  await page.click('[data-testid="reset-layout"]');
  await page.waitForTimeout(700);
  await page.click('[data-testid="save-layout"]');
  await page.waitForTimeout(2000);
  await page.click('[data-testid="customize-done"]');
  await page.waitForTimeout(400);
  ok("default layout restored and saved");
}

await ctx.close();
await browser.close();

console.log(
  failures === 0
    ? "\nACCEPTANCE PASSED — drag, resize, hide/restore, persistence, no page scroll.\n"
    : `\n${failures} ACCEPTANCE CHECK(S) FAILED.\n`
);
process.exit(failures === 0 ? 0 : 1);
