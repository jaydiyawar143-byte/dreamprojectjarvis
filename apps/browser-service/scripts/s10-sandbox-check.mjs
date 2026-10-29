// ---------------------------------------------------------------------------
// Phase 19, Stage 19.2 audit (H1) — S10: a real Chromium, launched the way the
// browser service launches it, runs with its sandbox.
//
// Opt-in and offline. Not part of any test suite: it starts a real browser, so
// run it only where that is acceptable, after building the service:
//
//   pnpm --filter @jarvis/browser-service build
//   node apps/browser-service/scripts/s10-sandbox-check.mjs
//
// CHROME_PATH names the executable; without it the service's own lookup is
// used. Inside the browser-service container this is the check that matters,
// because the container's kernel settings decide whether the sandbox can start.
//
// What it does, and nothing else:
//   1. launches headless Chromium with the service's own launch options
//      (`sandboxedChromiumLaunchOptions`), Playwright's throwaway profile, and
//      every connection sent to a closed local port — no site is contacted;
//   2. reads the browser's real command line over CDP and fails if any switch
//      that turns the sandbox off is on it;
//   3. on Linux, reads chrome://sandbox and fails unless it reports a sandbox;
//   4. renders one inline data: page, so a sandboxed renderer really ran;
//   5. as a control, launches once with Playwright's DEFAULT (`chromiumSandbox`
//      unset) and expects `--no-sandbox` on that command line — proof that the
//      check can see the flag it looks for.
//
// If step 1 cannot start Chromium with its sandbox, that is the service's
// fail-closed behaviour on this host, and the check reports it as a failure of
// the host, not a reason to launch without the sandbox. It prints switch names
// and pass/fail only.
// ---------------------------------------------------------------------------

import { resolveChromePath } from "@jarvis/browser";
import { chromium } from "playwright-core";

import { sandboxedChromiumLaunchOptions } from "../dist/engine.js";

const DISABLING = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-namespace-sandbox",
  "--disable-seccomp-filter-sandbox",
  "--disable-gpu-sandbox",
  "--no-zygote-sandbox",
];
// A closed port on loopback: anything the browser tries to fetch fails here.
const OFFLINE = { server: "http://127.0.0.1:9" };

function disablingSwitches(args) {
  return args.filter((arg) => DISABLING.some((name) => arg === name || arg.startsWith(`${name}=`)));
}

/**
 * The browser process's real command line, as chrome://version shows it — the
 * switches Chromium was started with, after Playwright added its own. (CDP's
 * `Browser.getBrowserCommandLine` would need `--enable-automation`, which the
 * service does not pass.)
 */
async function commandLine(browser) {
  const page = await browser.newPage();
  try {
    await page.goto("chrome://version");
    const text = await page.locator("#command_line").innerText();
    return text.split(/\s+/).filter((token) => token.startsWith("--"));
  } finally {
    await page.close();
  }
}

const chromePath = process.env.CHROME_PATH?.trim() || resolveChromePath();
if (!chromePath) {
  console.error("S10: no Chromium executable found; set CHROME_PATH");
  process.exit(2);
}

const results = [];
const record = (name, pass, detail) => results.push({ name, pass, detail });

// The service's own options, with its egress proxy pointed at the closed
// local port: the same flags as production, and still nothing leaves.
const options = sandboxedChromiumLaunchOptions({
  chromePath,
  headless: true,
  egressProxy: { url: OFFLINE.server, host: "127.0.0.1" },
});
record("the service's launch options set chromiumSandbox: true", options.chromiumSandbox === true);

let browser;
try {
  browser = await chromium.launch(options);
} catch (error) {
  const first = error instanceof Error ? error.message.split("\n")[0] : "launch failed";
  record("Chromium starts with its sandbox on this host", false, first);
}

if (browser) {
  try {
    const off = disablingSwitches(await commandLine(browser));
    record("the launched browser's command line has no sandbox-disabling switch", off.length === 0, off.join(" "));

    if (process.platform === "linux") {
      const page = await browser.newPage();
      await page.goto("chrome://sandbox");
      const text = await page.innerText("body");
      record(
        "chrome://sandbox reports a sandbox",
        /Layer 1 Sandbox\s*(Namespace|SUID)/i.test(text) && !/not adequately sandboxed/i.test(text)
      );
      await page.close();
    } else {
      record(`chrome://sandbox (Linux only; this is ${process.platform})`, true, "not applicable");
    }

    const page = await browser.newPage();
    await page.goto("data:text/html,<title>s10</title><p>offline</p>");
    record("a renderer starts and renders an offline page", (await page.title()) === "s10");
  } finally {
    await browser.close();
  }
}

const control = await chromium.launch({ executablePath: chromePath, headless: true, proxy: OFFLINE });
try {
  const off = disablingSwitches(await commandLine(control));
  record("control: Playwright's default adds --no-sandbox, and the check sees it", off.includes("--no-sandbox"), off.join(" "));
} finally {
  await control.close();
}

let failed = 0;
for (const { name, pass, detail } of results) {
  if (!pass) failed += 1;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
}
console.log(`S10: ${results.length - failed} passed, ${failed} failed (platform ${process.platform}, playwright-core ${(await import("playwright-core/package.json", { with: { type: "json" } })).default.version})`);
process.exit(failed === 0 ? 0 : 1);
