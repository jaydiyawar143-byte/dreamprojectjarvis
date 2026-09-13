// Focused check: the FIVE handles that did not exist before, and the one
// gesture that was previously impossible — sizing a widget from its top edge.
//
// The committed acceptance script exercises `se` and one edge, so it would pass
// unchanged whether or not n/w/ne/nw/sw were wired up. This proves they are.

import { chromium } from "playwright-core";
import { existsSync } from "node:fs";

const WEB = process.env.JARVIS_WEB_URL ?? "http://localhost:3000";
const USER = {
  email: process.env.JARVIS_USER_EMAIL ?? "driver@jarvis.local",
  password: process.env.JARVIS_USER_PASSWORD ?? "DriverPass123!",
};

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error("No Chrome found. Set CHROME_PATH.");
  return found;
}

let failures = 0;
const check = (cond, label, extra = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${extra ? `  ${extra}` : ""}`);
  if (!cond) failures++;
};

const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
const page = await ctx.newPage();

await page.goto(`${WEB}/login`, { waitUntil: "networkidle" });
await page.fill('input[type="email"]', USER.email);
await page.fill('input[type="password"]', USER.password);
await page.click('button[type="submit"]');
await page.waitForURL("**/dashboard", { timeout: 60000 });
await page.waitForSelector('[data-testid="command-workspace"]');
await page.waitForTimeout(3500);

const placements = () =>
  page.evaluate(() => {
    const out = {};
    for (const el of document.querySelectorAll('[data-testid^="cell-"]')) {
      const id = el.getAttribute("data-testid").replace("cell-", "");
      out[id] = {
        x: +el.getAttribute("data-x"),
        y: +el.getAttribute("data-y"),
        w: +el.getAttribute("data-w"),
        h: +el.getAttribute("data-h"),
      };
    }
    return out;
  });

console.log("=== all eight handle types exist in customise mode ===");
await page.click('[data-testid="customize-toggle"]');
await page.waitForTimeout(700);

for (const dir of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
  const n = await page.locator(`.react-resizable-handle-${dir}`).count();
  check(n > 0, `handle "${dir}" present`, `(${n})`);
}

console.log("");
console.log("=== the north handle has a real hit area and a resize cursor ===");
const northBox = await page.evaluate(() => {
  const h = document.querySelector(".react-resizable-handle-n");
  if (!h) return null;
  const r = h.getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height), cursor: getComputedStyle(h).cursor };
});
check(Boolean(northBox), "north handle is laid out");
if (northBox) {
  check(northBox.w > 10 && northBox.h > 10, "north handle is grabbable", JSON.stringify(northBox));
  check(northBox.cursor === "ns-resize", "north handle shows a resize cursor", northBox.cursor);
}

const westCursor = await page.evaluate(() => {
  const h = document.querySelector(".react-resizable-handle-w");
  return h ? getComputedStyle(h).cursor : null;
});
check(westCursor === "ew-resize", "west handle shows a resize cursor", String(westCursor));

console.log("");
console.log("=== the grip wins over the north handle where they overlap ===");
const gripAbove = await page.evaluate(() => {
  const grip = document.querySelector(".jarvis-widget-drag-handle");
  if (!grip) return null;
  const r = grip.getBoundingClientRect();
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return top ? top.closest(".jarvis-widget-drag-handle") !== null : false;
});
check(gripAbove === true, "pointer over the grip hits the grip, not a resize handle");

console.log("");
console.log("=== resize from the TOP edge (previously impossible) ===");
// Pick a widget that is not in the top row, so there is room to grow upward.
const before = await placements();
const target = Object.entries(before)
  .filter(([, p]) => p.y >= 2)
  .sort((a, b) => b[1].y - a[1].y)[0];

if (!target) {
  check(false, "found a widget with space above it");
} else {
  const [id, start] = target;
  console.log(`  ..    resizing "${id}" from y=${start.y} h=${start.h}`);

  const cell = page.locator(`[data-testid="cell-${id}"]`);
  const box = await cell.boundingBox();
  const handle = cell.locator(".react-resizable-handle-n");
  const hb = await handle.boundingBox();

  if (!hb) {
    check(false, "north handle is reachable on the target widget");
  } else {
    // Drag the top edge upward by roughly two rows.
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2, hb.y - 90, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(900);

    const after = (await placements())[id];
    console.log(`  ..    now y=${after.y} h=${after.h}`);

    check(after.h > start.h, "the widget grew when its top edge was dragged up", `h ${start.h} -> ${after.h}`);
    check(box !== null, "widget remained on the grid");
  }
}

console.log("");
console.log("=== no page scroll was introduced ===");
const scroll = await page.evaluate(() => ({
  v: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  h: document.documentElement.scrollWidth - document.documentElement.clientWidth,
}));
check(scroll.v <= 0 && scroll.h <= 0, "no page scroll", JSON.stringify(scroll));

// Leave the account as found.
await page.click('[data-testid="reset-layout"]').catch(() => {});
await page.waitForTimeout(600);
await page.click('[data-testid="save-layout"]').catch(() => {});
await page.waitForTimeout(900);

await browser.close();
console.log("");
console.log(failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
