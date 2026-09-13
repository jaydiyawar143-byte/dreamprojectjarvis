// End-to-end check of Auto Optimize: analyse → preview → apply → undo.
//
// The property that matters is that NOTHING moves until Apply is pressed, and
// that Undo restores exactly what was there. Both are asserted against the grid
// units actually rendered, not against what the engine thinks it did.

import { chromium } from "playwright-core";
import { existsSync } from "node:fs";

const WEB = process.env.JARVIS_WEB_URL ?? "http://localhost:3000";
const USER = {
  email: process.env.JARVIS_USER_EMAIL || "driver@jarvis.local",
  password: process.env.JARVIS_USER_PASSWORD || "DriverPass123!",
};

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const c = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].find((p) => existsSync(p));
  if (!c) throw new Error("No Chrome found. Set CHROME_PATH.");
  return c;
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
      out[el.getAttribute("data-testid").replace("cell-", "")] = {
        x: +el.getAttribute("data-x"),
        y: +el.getAttribute("data-y"),
        w: +el.getAttribute("data-w"),
        h: +el.getAttribute("data-h"),
      };
    }
    return out;
  });

console.log("=== 1. the control exists only in customise mode ===");
check(
  (await page.locator('[data-testid="auto-optimize"]').count()) === 0,
  "no Auto optimize button in normal mode"
);
await page.click('[data-testid="customize-toggle"]');
await page.waitForTimeout(600);
check(await page.locator('[data-testid="auto-optimize"]').isVisible(), "Auto optimize appears in customise mode");

console.log("");
console.log("=== 2. make room, so there is something to find ===");
// Hiding the two widgets under the orb is what actually frees its column.
//
// Shrinking the orb does NOT: `compactType="vertical"` immediately pulls
// clock and worldclock up into the space, so there is no gap left to find.
// That is the compaction trade-off working as designed, and the optimizer is
// right to report nothing in that case.
const before = await placements();
await page.click('[data-testid="manage-widgets"]');
await page.waitForTimeout(400);
for (const id of ["clock", "worldclock"]) {
  await page.click(`[data-testid="toggle-${id}"]`).catch(() => {});
  await page.waitForTimeout(300);
}
await page.click('[data-testid="manage-widgets"]').catch(() => {});
await page.waitForTimeout(600);

const shrunk = await placements();
check(
  shrunk.clock === undefined && shrunk.worldclock === undefined,
  "clock and worldclock hidden, freeing the orb's column",
  `orb h=${shrunk.orb?.h}`
);

console.log("");
console.log("=== 3. analyse — and change nothing ===");
await page.click('[data-testid="auto-optimize"]');
await page.waitForTimeout(700);

check(await page.locator('[data-testid="optimize-panel"]').isVisible(), "preview panel opened");
const issues = await page.locator('[data-testid="optimize-issues"] li').count();
check(issues > 0, "issues were reported", `(${issues})`);

const afterAnalyse = await placements();
check(
  JSON.stringify(afterAnalyse) === JSON.stringify(shrunk),
  "NOTHING moved during analysis — preview only"
);

console.log("");
console.log("=== 4. apply ===");
const hasApply = (await page.locator('[data-testid="optimize-apply"]').count()) > 0;
if (!hasApply) {
  const conf = await page.locator('[data-testid="optimize-panel"]').getAttribute("data-confidence");
  check(conf === "low", "no Apply offered, and confidence is reported low", String(conf));
} else {
  await page.click('[data-testid="optimize-apply"]');
  await page.waitForTimeout(900);

  const applied = await placements();
  check(applied.orb.h > shrunk.orb.h, "the orb grew when the optimization was applied", `h ${shrunk.orb.h} -> ${applied.orb.h}`);
  check(
    Object.keys(applied).length === Object.keys(shrunk).length,
    "no widget was added or removed"
  );

  console.log("");
  console.log("=== 5. undo restores exactly ===");
  await page.click('[data-testid="auto-optimize"]');
  await page.waitForTimeout(600);
  const undoVisible = (await page.locator('[data-testid="optimize-undo"]').count()) > 0;
  check(undoVisible, "Undo is offered after an apply");

  if (undoVisible) {
    await page.click('[data-testid="optimize-undo"]');
    await page.waitForTimeout(900);
    const undone = await placements();
    check(
      JSON.stringify(undone) === JSON.stringify(shrunk),
      "undo restored the exact previous layout"
    );
  }
}

console.log("");
console.log("=== 6. no page scroll introduced ===");
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
