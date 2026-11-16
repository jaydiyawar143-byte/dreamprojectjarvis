// ---------------------------------------------------------------------------
// Phase 19, Stage 19.2 audit (H1) — S10: a real Chromium, launched the way the
// browser service launches it, runs with its sandbox.
//
// Opt-in and offline. Not part of any test suite: it starts a real browser, so
// run it only where that is acceptable. The check that matters is inside the
// browser-service container, whose kernel features, seccomp profile and
// filesystem decide whether the sandbox can start:
//
//   docker compose exec browser-service node apps/browser-service/scripts/s10-sandbox-check.mjs
//
// Elsewhere, after building the service:
//
//   pnpm --filter @jarvis/browser-service build
//   node apps/browser-service/scripts/s10-sandbox-check.mjs
//
// CHROME_PATH names the executable; without it the service's own lookup is
// used.
//
// What it does, and nothing else:
//   0. prints the preconditions it can read (user, no_new_privs, seccomp mode,
//      capabilities, read-only root, a writable HOME, user-namespace limit) —
//      for information, never as a pass or a fail;
//   1. launches headless Chromium with the service's own launch options
//      (`sandboxedChromiumLaunchOptions`), Playwright's throwaway profile, and
//      every connection sent to a closed local port — no site is contacted;
//   2. reads the browser's real command line (chrome://version) and fails if
//      any switch that turns the sandbox off is on it;
//   3. reads chrome://sandbox and requires Layer 1 = Namespace (the user-
//      namespace sandbox), PID and network namespaces, and the Seccomp-BPF
//      sandbox, and the page's own verdict that it is adequately sandboxed.
//      SUID is refused: with `no-new-privileges` the setuid helper cannot
//      become root, so a SUID answer means something is not as deployed.
//      None is refused;
//   4. renders one inline data: page, and checks that its renderer runs in a
//      user, PID and network namespace of its own, not the browser's; then
//      waits a few seconds and requires the browser to still be up and to
//      render a second page — a sandboxed helper that keeps being killed makes
//      Chromium exit ("GPU process isn't usable. Goodbye."), and that is not a
//      working sandbox;
//   5. as a control, launches once with Playwright's DEFAULT (`chromiumSandbox`
//      unset) and expects `--no-sandbox` on that command line — proof that the
//      check can see the flag it looks for. Offline; it reads one chrome://
//      page and closes.
//
// Every result is printed the moment it is known, and a launch that fails is a
// FAIL line with Chromium's own reason, never a crash that hides what came
// before. It never retries without the sandbox: a host that cannot give
// Chromium its sandbox is reported as a failure of the host.
//
// Exit codes: 0 every check passed; 1 a check failed; 2 a prerequisite is
// missing (no Chromium, the service not built, or not Linux — the Layer 1
// checks only exist there). It prints switch names, process kinds and
// pass/fail; never a page.
// ---------------------------------------------------------------------------

import { constants, accessSync, readFileSync, readdirSync, readlinkSync } from "node:fs";

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
// How long the sandboxed browser must stay up after rendering (step 4).
const STABILITY_WAIT_MS = 5_000;
// The longest any one step against a launched browser may take.
const STEP_TIMEOUT_MS = 30_000;

const results = [];
let prerequisitesMissing = false;

function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
}
function info(line) {
  console.log(`info  ${line}`);
}
function missing(reason) {
  prerequisitesMissing = true;
  console.log(`MISSING  ${reason}`);
}

function finish() {
  const failed = results.filter((r) => !r.pass).length;
  const code = prerequisitesMissing ? 2 : failed > 0 ? 1 : 0;
  console.log(
    `S10: ${results.length - failed} passed, ${failed} failed${prerequisitesMissing ? ", prerequisites missing" : ""} (platform ${process.platform}) exit ${code}`
  );
  process.exit(code);
}

/**
 * Runs one step against a launched browser, but never waits on it forever: the
 * step fails if the browser exits (Playwright can leave a call pending when
 * Chromium dies, and Node then quits with nothing reported) or takes longer
 * than STEP_TIMEOUT_MS. A failed step is a FAIL line, never a silent exit.
 */
function guardBrowser(browser) {
  let onGone;
  const gone = new Promise((_resolve, reject) => {
    onGone = () => reject(new Error("the browser exited"));
    browser.on("disconnected", onGone);
  });
  gone.catch(() => undefined);
  return (promise) => {
    let timer;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${STEP_TIMEOUT_MS / 1000} s`)), STEP_TIMEOUT_MS);
    });
    return Promise.race([promise, gone, timeout]).finally(() => clearTimeout(timer));
  };
}

function disablingSwitches(args) {
  return args.filter((arg) => DISABLING.some((name) => arg === name || arg.startsWith(`${name}=`)));
}

/** The first line of a launch error, and Chromium's own error lines from it. */
function launchFailure(error) {
  const text = error instanceof Error ? error.message : String(error);
  const lines = text.split("\n");
  const chromium = [...new Set(lines.filter((l) => /\[err\]|signal=|FATAL/.test(l) && !/<launching>/.test(l)).map((l) => l.replace(/^\s*-\s*/, "").trim()))];
  return { first: lines[0]?.slice(0, 160) ?? "launch failed", chromium: chromium.slice(0, 8) };
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

/** The answers chrome://sandbox gives, from its whitespace-normalised text. */
function parseSandboxPage(text) {
  const flat = text.replace(/\s+/g, " ");
  const yesNo = (label) => new RegExp(`${label} (Yes|No)\\b`).exec(flat)?.[1] ?? null;
  return {
    layer1: /Layer 1 Sandbox (\S+)/.exec(flat)?.[1] ?? null,
    pidNamespaces: yesNo("PID namespaces"),
    networkNamespaces: yesNo("Network namespaces"),
    seccompBpf: yesNo("Seccomp-BPF sandbox"),
    adequate: /You are adequately sandboxed/i.test(flat) && !/NOT adequately sandboxed/i.test(flat),
  };
}

// --- 0. Preconditions: printed, never judged --------------------------------

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function preconditions() {
  info(`platform ${process.platform}, node ${process.version}, uid ${process.getuid?.() ?? "n/a"}`);
  const status = readText("/proc/self/status");
  if (status) {
    const field = (name) => new RegExp(`^${name}:\\s*(.+)$`, "m").exec(status)?.[1]?.trim() ?? "?";
    info(`NoNewPrivs ${field("NoNewPrivs")}, Seccomp ${field("Seccomp")} (2 = filter), CapEff ${field("CapEff")}, CapBnd ${field("CapBnd")}`);
  }
  const mountinfo = readText("/proc/self/mountinfo");
  if (mountinfo) {
    const root = mountinfo.split("\n").map((l) => l.split(" ")).find((f) => f[4] === "/");
    info(`root filesystem ${root && root[5]?.split(",").includes("ro") ? "read-only" : "writable"}`);
  }
  const home = process.env.HOME;
  let homeWritable = false;
  try {
    if (home) {
      accessSync(home, constants.W_OK);
      homeWritable = true;
    }
  } catch {
    homeWritable = false;
  }
  info(`HOME ${home ?? "(unset)"} ${homeWritable ? "writable" : "NOT writable — Chromium cannot start without a writable home"}`);
  const maxUserNs = readText("/proc/sys/user/max_user_namespaces");
  if (maxUserNs !== null) info(`max_user_namespaces ${maxUserNs.trim()}`);
}

// --- 4. Renderer namespaces --------------------------------------------------

/**
 * Live Chromium processes and their kind. Chromium rewrites its children's
 * process titles, so a child's command line is one string with `--type=…`
 * inside it rather than a separate argument; and a process that has exited
 * but not been reaped (a zombie) has no command line at all, so it is skipped.
 */
function chromiumProcesses() {
  const found = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const status = readText(`/proc/${entry}/status`);
    if (!status || /^State:\s*Z/m.test(status)) continue;
    const cmdline = readText(`/proc/${entry}/cmdline`);
    if (!cmdline) continue;
    const joined = cmdline.split("\0").filter(Boolean).join(" ");
    if (!/chrom/i.test(joined) || /chrome_crashpad_handler/.test(joined)) continue;
    const type = /(?:^|\s)--type=(\S+)/.exec(joined)?.[1] ?? null;
    found.push({ pid: Number(entry), type, joined });
  }
  return found;
}

function namespaceOf(pid, kind) {
  try {
    return readlinkSync(`/proc/${pid}/ns/${kind}`);
  } catch (error) {
    return `unreadable (${error?.code ?? "error"})`;
  }
}

function checkRendererNamespaces() {
  const processes = chromiumProcesses();
  // The browser process: the one Playwright drives over its pipe, with no --type.
  const browser = processes.find((p) => p.type === null && /--remote-debugging-pipe/.test(p.joined));
  const renderers = processes.filter((p) => p.type === "renderer");
  if (!browser || renderers.length === 0) {
    record(RENDERER_NAMESPACES, false, `browser process ${browser ? "found" : "not found"}, ${renderers.length} live renderer(s)`);
    return;
  }
  const of = (pid) => ({ user: namespaceOf(pid, "user"), pid: namespaceOf(pid, "pid"), net: namespaceOf(pid, "net") });
  const browserNs = of(browser.pid);
  const separated = renderers.every((r) => {
    const ns = of(r.pid);
    return (
      ns.user.startsWith("user:") && ns.pid.startsWith("pid:") && ns.net.startsWith("net:") &&
      ns.user !== browserNs.user && ns.pid !== browserNs.pid && ns.net !== browserNs.net
    );
  });
  const sample = of(renderers[0].pid);
  record(
    RENDERER_NAMESPACES,
    separated,
    `browser ${browserNs.user} ${browserNs.pid} ${browserNs.net}; renderer ${sample.user} ${sample.pid} ${sample.net}; ${renderers.length} live renderer(s)`
  );
}

// --- The run -----------------------------------------------------------------

preconditions();
if (process.platform !== "linux") missing(`chrome://sandbox and renderer namespaces exist on Linux only; this is ${process.platform}`);

let resolveChromePath;
let chromium;
let sandboxedChromiumLaunchOptions;
try {
  ({ resolveChromePath } = await import("@jarvis/browser"));
  ({ chromium } = await import("playwright-core"));
  ({ sandboxedChromiumLaunchOptions } = await import("../dist/engine.js"));
} catch (error) {
  missing(`the service is not built or a dependency is missing: ${String(error?.message ?? error).split("\n")[0]}`);
  finish();
}

const chromePath = process.env.CHROME_PATH?.trim() || resolveChromePath();
if (!chromePath) {
  missing("no Chromium executable found; set CHROME_PATH");
  finish();
}
info(`Chromium ${chromePath}`);

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
  record("Chromium starts with its sandbox on this host", true, browser.version());
} catch (error) {
  const failure = launchFailure(error);
  record("Chromium starts with its sandbox on this host", false, failure.first);
  for (const line of failure.chromium) info(`chromium: ${line.slice(0, 220)}`);
}

const errorText = (error) => String(error?.message ?? error).split("\n")[0].slice(0, 160);

/** One named check: its own FAIL line when it throws, so a failure never hides the rest. */
async function check(name, run) {
  try {
    const [pass, detail] = await run();
    record(name, pass, detail);
  } catch (error) {
    record(name, false, errorText(error));
  }
}

const SANDBOX_CHECKS = [
  ["chrome://sandbox: Layer 1 is the user-namespace sandbox (not SUID, not None)", (s) => [s.layer1 === "Namespace", `Layer 1 ${s.layer1}`]],
  ["chrome://sandbox: PID namespaces", (s) => [s.pidNamespaces === "Yes", s.pidNamespaces ?? "not reported"]],
  ["chrome://sandbox: network namespaces", (s) => [s.networkNamespaces === "Yes", s.networkNamespaces ?? "not reported"]],
  ["chrome://sandbox: Seccomp-BPF sandbox", (s) => [s.seccompBpf === "Yes", s.seccompBpf ?? "not reported"]],
  ["chrome://sandbox: the page says it is adequately sandboxed", (s) => [s.adequate, ""]],
];
const RENDERER_NAMESPACES = "a renderer runs in its own user, PID and network namespace";
const STAYS_UP = `the sandboxed browser stays up: ${STABILITY_WAIT_MS / 1000} s later it still renders a second page`;

if (browser) {
  const step = guardBrowser(browser);
  try {
    await check("the launched browser's command line has no sandbox-disabling switch", async () => {
      const off = disablingSwitches(await step(commandLine(browser)));
      return [off.length === 0, off.join(" ")];
    });

    if (process.platform === "linux") {
      let sandbox = null;
      let unread = "";
      try {
        const page = await step(browser.newPage());
        await step(page.goto("chrome://sandbox"));
        sandbox = parseSandboxPage(await step(page.innerText("body")));
        await step(page.close());
      } catch (error) {
        unread = `chrome://sandbox not read: ${errorText(error)}`;
      }
      if (sandbox) {
        info(`chrome://sandbox: Layer 1 ${sandbox.layer1}, PID namespaces ${sandbox.pidNamespaces}, network namespaces ${sandbox.networkNamespaces}, Seccomp-BPF ${sandbox.seccompBpf}, adequate ${sandbox.adequate}`);
      }
      for (const [name, judge] of SANDBOX_CHECKS) {
        if (sandbox) record(name, ...judge(sandbox));
        else record(name, false, unread);
      }
    }

    let namespacesChecked = false;
    await check("a renderer starts and renders an offline page", async () => {
      const page = await step(browser.newPage());
      await step(page.goto("data:text/html,<title>s10</title><p>offline</p>"));
      const rendered = (await step(page.title())) === "s10";
      if (process.platform === "linux") {
        checkRendererNamespaces();
        namespacesChecked = true;
      }
      await step(page.close());
      return [rendered, ""];
    });
    if (process.platform === "linux" && !namespacesChecked) record(RENDERER_NAMESPACES, false, "not reached: the page did not render");

    // A sandbox that starts but cannot keep the browser alive is not a working
    // sandbox: Chromium exits ("GPU process isn't usable. Goodbye.") when a
    // sandboxed helper keeps being killed. Wait, then load a second page.
    await check(STAYS_UP, async () => {
      await new Promise((resolve) => setTimeout(resolve, STABILITY_WAIT_MS));
      if (!browser.isConnected()) return [false, `the browser exited within ${STABILITY_WAIT_MS / 1000} s`];
      const again = await step(browser.newPage());
      await step(again.goto("data:text/html,<title>s10-again</title>"));
      const ok = (await step(again.title())) === "s10-again";
      await step(again.close());
      return [ok, ""];
    });
  } finally {
    await browser.close().catch(() => undefined);
  }
}

try {
  const control = await chromium.launch({ executablePath: chromePath, headless: true, proxy: OFFLINE });
  const step = guardBrowser(control);
  try {
    await check("control: Playwright's default adds --no-sandbox, and the check sees it", async () => {
      const off = disablingSwitches(await step(commandLine(control)));
      return [off.includes("--no-sandbox"), off.join(" ")];
    });
  } finally {
    await control.close().catch(() => undefined);
  }
} catch (error) {
  const failure = launchFailure(error);
  record("control: Playwright's default launch starts, so the check can see --no-sandbox", false, failure.first);
  for (const line of failure.chromium) info(`chromium (control): ${line.slice(0, 220)}`);
}

finish();
