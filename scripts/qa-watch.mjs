#!/usr/bin/env node
// ---------------------------------------------------------------------------
// The JARVIS local QA watcher — zero tokens, zero paid providers, zero
// database.
//
//   pnpm qa:watch        watch workspaces and run the tests a change touches
//   pnpm qa:watch:full   typecheck, lint and the full suite, once
//   pnpm qa:watch:stop   stop the watcher started by `pnpm qa:watch`
//
// WHY THIS EXISTS. `pnpm test` is the gate, but running all ~440 test files
// after every save is slow. This script watches each workspace's `src/` and
// `test/` trees and re-runs only what a change can affect.
//
// SAFETY, and it is the point of the script:
//
//   * NO PAID AI. Every provider credential inherited from the shell — or
//     loaded from the repository's `.env` by a test's own `dotenv` call — is
//     replaced with the empty string, the repository's own "not set"
//     convention. Blank wins over `.env` because dotenv never overrides a
//     variable that is already defined. `JARVIS_MEMORY_EVAL_REAL_EMBEDDINGS`
//     is emptied too, so the opt-in real-embedding evaluation cannot run.
//
//   * NO DATABASE. `DATABASE_URL` is fenced to the empty string for the same
//     reason: deleting it would let a test's `dotenv` call load the developer's
//     own `.env` and hand a live database to Prisma. Empty means every
//     PostgreSQL suite that looks at it sees "not configured", and every
//     `*.pg.integration.test.ts` is excluded from the runner by glob as well.
//     `JARVIS_REQUIRE_POSTGRES` is emptied, so a suite can never turn a skip
//     into a connection attempt.
//
//   * NO EXTERNAL INTEGRATIONS. Feature switches that reach outside JARVIS
//     (browser, MCP, publishing, desktop agent, voice) are forced off, and the
//     tokens of n8n, OmniRoute, Meta, Google, WhatsApp and ElevenLabs are
//     blanked. An integration's base URL is REMOVED instead, because an empty
//     string is an invalid URL to a schema that validates one — with the token
//     blank and the switch off, an endpoint on its own reaches nothing.
//
//   * THE FENCE SURVIVES TURBO. Turbo 2's default env mode is strict, and a
//     strict task receives only the variables named in `turbo.json`. That would
//     turn a blanked variable into an ABSENT one, and `dotenv` fills an absent
//     variable from the root `.env`. Every Turbo run therefore passes
//     `--env-mode=loose` (`turboArgs`), so a task receives exactly the
//     environment built here.
//
//   * NO STALE COMPILED PACKAGES. Workspaces resolve each other through
//     `dist/`, not `src/`. A change in a `packages/*` workspace therefore
//     builds that package first (Turbo builds its dependencies too), and every
//     suite runs through `turbo run test`, whose `^build` dependency keeps the
//     package graph fresh. See `docs/QA_WATCHER.md`.
//
// Node built-ins only. No dependency is added by this file.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { isPidAlive, isQaWatchProcess } from "./qa-watch-process.mjs";

export { isPidAlive };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_DIR = join(ROOT, ".qa-watch");
const LOG_FILE = join(STATE_DIR, "qa-watch.log");
const PID_FILE = join(STATE_DIR, "qa-watch.pid");
const STOP_FILE = join(STATE_DIR, "stop.request");

const IS_WINDOWS = process.platform === "win32";
const PNPM = IS_WINDOWS ? "pnpm.cmd" : "pnpm";

// Excluded from every run. PostgreSQL integration suites are never started by
// the watcher; they need an explicit, separate database and are CI's job.
const PG_EXCLUDE = "**/*pg.integration*";

// Turbo 2 defaults to STRICT env mode: a task process receives only the
// variables named in `turbo.json`'s `env`/`globalEnv`. That would silently undo
// the fence below — a blanked variable is not blanked, it is ABSENT, and
// `dotenv` fills an absent variable from the root `.env`. Loose mode passes
// the environment this process built. Undeclared variables never enter a
// cache hash, so it changes no caching behaviour.
const ENV_LOOSE = "--env-mode=loose";

// The debounce window: a burst of editor writes (save-all, formatter, git
// checkout) becomes one run.
const DEBOUNCE_MS = Number(process.env.QA_WATCH_DEBOUNCE_MS || 500);
const FILE_TIMEOUT_MS = Number(process.env.QA_WATCH_FILE_TIMEOUT_MS || 300000);
const SUITE_TIMEOUT_MS = Number(process.env.QA_WATCH_SUITE_TIMEOUT_MS || 900000);

// Directories and files the watcher never looks at.
const IGNORED_SEGMENTS = new Set([
  "node_modules",
  "dist",
  ".next",
  ".turbo",
  ".git",
  "coverage",
  ".qa-watch",
  "artifacts",
  "bin",
  "obj",
]);
const IGNORED_PREFIXES = [
  "apps/desktop-agent/", // .NET, outside the pnpm workspaces
  ".claude/",
  "omniroute-claude-plugin/",
];

// A credential or connection string a child process must never inherit.
// `sanitizeEnv` sets each of these to "" — defined, so `dotenv` (which only
// fills variables that are undefined) cannot load a value from `.env`.
const SECRET_VARS = [
  "DATABASE_URL",
  "DIRECT_URL",
  "SHADOW_DATABASE_URL",
  "JWT_SECRET",
  "JARVIS_ENCRYPTION_KEY",
  "JARVIS_ENCRYPTION_KEY_RETIRED",
  "DESKTOP_AGENT_COMMAND_SIGNING_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ELEVENLABS_API_KEY",
  "META_ACCESS_TOKEN",
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_MAPS_BROWSER_KEY",
  "GOOGLE_MAPS_SERVER_KEY",
  "N8N_API_KEY",
  "N8N_CALLBACK_SECRET",
  "N8N_MCP_TOKEN",
  "OMNIROUTE_API_KEY",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_VERIFY_TOKEN",
  "MARKET_INDICES_API_KEY",
  "BROWSER_SERVICE_SHARED_SECRET",
  "BROWSER_SERVICE_HEALTH_TOKEN",
];

// Endpoints of live integrations. These are REMOVED rather than blanked:
// `N8N_BASE_URL` and `N8N_MCP_ENDPOINT` are `z.string().url()` in
// `@jarvis/config`, and an empty string is not "not set" to that schema — it is
// an invalid URL that stops `getServerEnv()` for every suite in the run.
// Removing them is safe because every credential that could authenticate to
// one of these endpoints is blanked above, and the switches below are off: an
// endpoint on its own reaches nothing. (Removal is only used for endpoints;
// `DATABASE_URL` above must stay DEFINED and blank, or `dotenv` refills it.)
const REMOVED_ENDPOINT_VARS = [
  "N8N_BASE_URL",
  "N8N_MCP_ENDPOINT",
  "OMNIROUTE_BASE_URL",
  "MARKET_INDICES_API_URL",
];

// Switches that reach outside JARVIS, forced off. A test that needs one turns
// it on for itself with `vi.stubEnv`, which runs after this environment.
const FORCED_OFF_VARS = [
  "BROWSER_ENABLED",
  "BROWSER_SERVICE_CHROMIUM_ENABLED",
  "JARVIS_MCP_ENABLED",
  "N8N_MCP_ENABLED",
  "N8N_ENABLED",
  "MARKETING_PUBLISH_ENABLED",
  "DESKTOP_AGENT_ENABLED",
  "VOICE_ENABLED",
  "JARVIS_MEMORY_EVAL_REAL_EMBEDDINGS",
];

// ---------------------------------------------------------------------------
// Pure helpers (exported for `scripts/qa-watch.test.mjs`)
// ---------------------------------------------------------------------------

/**
 * Build the environment every child process receives: the caller's, with
 * every credential and database URL fenced.
 */
export function sanitizeEnv(source = process.env, mode = "watch") {
  const env = { ...source };

  for (const name of SECRET_VARS) env[name] = "";
  for (const name of REMOVED_ENDPOINT_VARS) delete env[name];
  for (const name of FORCED_OFF_VARS) env[name] = "false";

  // Never let a suite decide to require a database.
  env.JARVIS_REQUIRE_POSTGRES = "";

  // Offline, quiet, and identifiable from inside a test.
  env.TURBO_TELEMETRY_DISABLED = "1";
  env.NEXT_TELEMETRY_DISABLED = "1";
  env.DO_NOT_TRACK = "1";
  env.JARVIS_QA_WATCH = "1";
  env.JARVIS_QA_WATCH_MODE = mode;

  return env;
}

/** True when a relative POSIX path is outside the watcher's interest. */
export function isIgnored(relPath) {
  if (!relPath || relPath.startsWith("..") || relPath === "") return true;
  const parts = relPath.split("/");
  if (parts.some((part) => IGNORED_SEGMENTS.has(part))) return true;
  if (IGNORED_PREFIXES.some((prefix) => relPath.startsWith(prefix))) return true;
  const base = parts[parts.length - 1];
  return (
    base.endsWith(".log") ||
    base.endsWith(".tmp") ||
    base.endsWith("~") ||
    base.startsWith(".#")
  );
}

/** The workspace a relative path belongs to, or null. */
export function workspaceFor(relPath, workspaces) {
  const parts = relPath.split("/");
  if (parts.length < 3) return null;
  const dir = `${parts[0]}/${parts[1]}`;
  return workspaces.find((ws) => ws.dir === dir) ?? null;
}

/**
 * What a changed file means:
 *   test   — a test file: run just it
 *   source — production source: build (if a library) and run the workspace
 *   config — vitest/tsconfig/package.json: run the workspace
 *   other  — e.g. a Prisma schema: run the workspace
 *   root   — repository-level file the watcher does not act on
 *   ignored — not a file change at all (a directory event, build output, …)
 */
export function classifyChange(relPath, workspaces) {
  if (isIgnored(relPath)) return { kind: "ignored" };
  const ws = workspaceFor(relPath, workspaces);
  if (!ws) return { kind: "root" };

  const inner = relPath.slice(ws.dir.length + 1);
  const base = inner.split("/").pop() ?? inner;

  // `fs.watch` can report a DIRECTORY, not a file — on Windows a recursive
  // watcher reports its own root after a buffer overflow, as `packages/x/src`.
  // Acting on that would run every workspace's suite once per burst. A real
  // file this watcher acts on always has an extension; a bare `src` or `test`
  // is the directory itself.
  if (inner === "src" || inner === "test" || !base.includes(".")) {
    return { kind: "ignored" };
  }

  if (
    /(^|\/)(__tests__|test)\//.test(inner) ||
    /\.(test|spec)\.(m|c)?[jt]sx?$/.test(base)
  ) {
    return { kind: "test", ws, file: inner };
  }

  if (
    /^(vitest\.config\.[cm]?[jt]s|tsconfig[^/]*\.json|package\.json)$/.test(base) ||
    /\.config\.[cm]?[jt]s$/.test(base)
  ) {
    return { kind: "config", ws, file: base };
  }

  if (inner.startsWith("src/")) return { kind: "source", ws, file: inner };
  return { kind: "other", ws, file: inner };
}

/**
 * Turn a set of classified changes into jobs, one per workspace:
 *   { mode: "suite", ws, buildSelf }
 *   { mode: "files", ws, files: [...] }
 * Any non-test change in a workspace upgrades it to a suite run.
 */
export function planFromChanges(changes) {
  const byWorkspace = new Map();

  for (const change of changes) {
    if (!change.ws || change.kind === "ignored" || change.kind === "root") continue;
    let entry = byWorkspace.get(change.ws.name);
    if (!entry) {
      entry = { ws: change.ws, suite: false, files: new Set(), triggers: new Set() };
      byWorkspace.set(change.ws.name, entry);
    }
    if (change.file) entry.triggers.add(change.file);
    if (change.kind === "test") entry.files.add(change.file);
    else entry.suite = true;
  }

  return [...byWorkspace.values()].map((entry) => {
    // What caused the run, for the log. Capped so a save-all cannot flood it.
    const triggers = [...entry.triggers].slice(0, 4);
    if (entry.triggers.size > triggers.length) triggers.push(`+${entry.triggers.size - triggers.length}`);
    if (entry.suite) {
      return {
        mode: "suite",
        ws: entry.ws,
        buildSelf: entry.ws.group === "packages",
        triggers,
      };
    }
    return {
      mode: "files",
      ws: entry.ws,
      // A PostgreSQL suite is never run, even when it is the changed file.
      files: [...entry.files].filter((file) => !/pg\.integration/.test(file)),
      triggers,
    };
  });
}

/**
 * The argument list for a Turbo task. EVERY Turbo run the watcher makes goes
 * through here, because `--env-mode=loose` is what keeps the sanitised
 * environment intact (see `ENV_LOOSE`). A call site that builds its own
 * argument list would hand the task a stripped environment and re-open the
 * database hole this watcher exists to close.
 */
export function turboArgs(task, options = {}) {
  const args = [PNPM, "exec", "turbo", "run", task];
  if (options.filter) args.push("--filter", options.filter);
  if (options.concurrency) args.push(`--concurrency=${options.concurrency}`);
  // A one-off check reports every failure it can, instead of hiding the rest
  // behind the first one. "dependencies-successful" keeps Turbo's own safety:
  // a task whose dependency failed is not run against a broken build.
  if (options.continueOnError) args.push("--continue=dependencies-successful");
  args.push(ENV_LOOSE);
  return args;
}

/** Quote one argument for `cmd.exe /d /s /c`. */
export function quoteForCmd(value) {
  const text = String(value);
  if (text === "") return '""';
  if (!/[\s"&|<>^()]/.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

export function parseArgs(argv) {
  const options = { full: false, help: false, verbose: false };
  for (const arg of argv) {
    if (arg === "--full") options.full = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--verbose" || arg === "-v") options.verbose = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

/** Discover pnpm workspaces from package.json files, without reading pnpm config. */
export function discoverWorkspaces(root = ROOT) {
  const workspaces = [];
  for (const group of ["apps", "packages"]) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = `${group}/${entry.name}`;
      const manifest = join(root, dir, "package.json");
      if (!existsSync(manifest)) continue;
      let name = dir;
      try {
        name = JSON.parse(readFileSync(manifest, "utf8")).name ?? dir;
      } catch {
        // A malformed manifest still gets a watcher; the test run will say why.
      }
      workspaces.push({ dir, abs: join(root, dir), name, group });
    }
  }
  return workspaces.sort((a, b) => a.dir.localeCompare(b.dir));
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

function createLogger() {
  mkdirSync(STATE_DIR, { recursive: true });

  const configuredLimit = Number(process.env.QA_WATCH_LOG_MAX_BYTES || 5 * 1024 * 1024);
  const maxBytes =
    Number.isFinite(configuredLimit) && configuredLimit > 0 ? configuredLimit : 5 * 1024 * 1024;

  let stream = null;
  let size = 0;
  let rotating = false;
  const pendingLines = [];
  const closeWaiters = [];

  const open = () => {
    try {
      stream = createWriteStream(LOG_FILE, { flags: "a" });
      // A disk-full or removed-volume error must never crash the watcher.
      stream.on("error", () => {
        stream = null;
      });
    } catch {
      stream = null;
    }
  };

  const reopenAfterRotation = () => {
    try {
      rmSync(`${LOG_FILE}.1`, { force: true });
      renameSync(LOG_FILE, `${LOG_FILE}.1`);
    } catch {
      // If the rename fails, keep appending; the bound is best-effort.
    }
    size = 0;
    open();
    for (const line of pendingLines.splice(0)) {
      try {
        stream?.write(line);
        size += Buffer.byteLength(line);
      } catch {
        // Logging must never stop the watcher.
      }
    }
    rotating = false;
    for (const resolve of closeWaiters.splice(0)) resolve();
  };

  const rotate = () => {
    if (rotating) return;
    rotating = true;
    const old = stream;
    stream = null;
    if (!old) {
      reopenAfterRotation();
      return;
    }
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      reopenAfterRotation();
    };
    try {
      old.end(done);
    } catch {
      done();
    }
    // A destroyed stream may never call back; do not wedge the logger.
    setTimeout(done, 2000).unref?.();
  };

  const account = (text) => {
    size += Buffer.byteLength(text);
    if (size > maxBytes) rotate();
  };

  try {
    size = existsSync(LOG_FILE) ? statSync(LOG_FILE).size : 0;
  } catch {
    size = 0;
  }
  // Keep the previous run's tail for diagnosis instead of deleting it.
  if (size > maxBytes) {
    try {
      rmSync(`${LOG_FILE}.1`, { force: true });
      renameSync(LOG_FILE, `${LOG_FILE}.1`);
    } catch {
      // Best effort: appending is better than losing the log entirely.
    }
    size = 0;
  }
  open();

  const write = (line) => {
    const text = `[${new Date().toISOString()}] ${line}\n`;
    process.stdout.write(text);
    if (rotating) {
      pendingLines.push(text);
      return;
    }
    try {
      stream?.write(text);
      account(text);
    } catch {
      // Logging must never stop the watcher.
    }
  };

  return {
    info: write,
    raw: (chunk) => {
      process.stdout.write(chunk);
      // Rotation lasts milliseconds; dropping that sliver of test output keeps
      // memory bounded. The log's own lines are buffered, not dropped.
      if (rotating) return;
      try {
        stream?.write(chunk);
        account(chunk);
      } catch {
        // As above.
      }
    },
    close: async () => {
      if (rotating) {
        await Promise.race([
          new Promise((resolve) => closeWaiters.push(resolve)),
          new Promise((resolve) => setTimeout(resolve, 2500).unref?.()),
        ]);
      }
      if (!stream) return;
      await Promise.race([
        new Promise((resolveClose) => {
          try {
            stream.end(resolveClose);
          } catch {
            resolveClose();
          }
        }),
        new Promise((resolve) => setTimeout(resolve, 2000).unref?.()),
      ]);
    },
  };
}

/**
 * Spawn a step and expose the child while it runs, so a timeout or a stop can
 * end the whole process tree.
 */
function runStep(label, args, env, log, timeoutMs, controller) {
  const command = args.map(quoteForCmd).join(" ");
  log.info(`▶ ${label}: ${command}`);

  return new Promise((resolveRun) => {
    let child;
    try {
      if (IS_WINDOWS) {
        child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command], {
          cwd: ROOT,
          env,
          windowsHide: true,
        });
      } else {
        child = spawn(args[0], args.slice(1), { cwd: ROOT, env, windowsHide: true });
      }
    } catch (error) {
      log.info(`✗ ${label}: could not start (${error.message})`);
      return resolveRun(1);
    }

    controller.child = child;
    let settled = false;
    let timer = null;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      controller.child = null;
      resolveRun(code);
    };

    child.stdout?.on("data", (chunk) => log.raw(chunk.toString()));
    child.stderr?.on("data", (chunk) => log.raw(chunk.toString()));
    child.once("error", (error) => {
      log.info(`✗ ${label}: ${error.message}`);
      finish(1);
    });
    child.once("exit", (code, signal) => {
      if (signal) log.info(`■ ${label}: stopped by ${signal}`);
      finish(code ?? 1);
    });

    timer = setTimeout(() => {
      log.info(`✗ ${label}: timed out after ${Math.round(timeoutMs / 1000)}s`);
      // `terminateTree` gives up after a few seconds; `finish` then settles the
      // step even if the kill was refused, so a wedged child cannot wedge the
      // watcher. Both calls are idempotent.
      void terminateTree(child).then(() => finish(1));
    }, timeoutMs);
    timer.unref?.();
  });
}

/** End a child and everything it started. */
export function terminateTree(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolveDone) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolveDone();
    };
    child.once("exit", finish);

    if (IS_WINDOWS) {
      try {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
      } catch {
        try {
          child.kill();
        } catch {
          // Already gone.
        }
      }
    } else {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }, 4000).unref?.();
    }

    setTimeout(finish, 6000).unref?.();
  });
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

async function runJob(job, env, log, controller) {
  if (job.mode === "files") {
    if (job.files.length === 0) {
      log.info(`• ${job.ws.name}: only a PostgreSQL integration file changed — skipped`);
      return true;
    }
    const code = await runStep(
      `${job.ws.name} (${job.files.length} file${job.files.length === 1 ? "" : "s"})`,
      [PNPM, "--filter", job.ws.name, "exec", "vitest", "run", ...job.files, "--exclude", PG_EXCLUDE],
      env,
      log,
      FILE_TIMEOUT_MS,
      controller
    );
    return code === 0;
  }

  // A library is consumed through `dist/`, so build it before its own suite.
  // Turbo builds its dependencies as part of `^build` either way.
  if (job.buildSelf) {
    const built = await runStep(
      `build ${job.ws.name}`,
      turboArgs("build", { filter: job.ws.name }),
      env,
      log,
      SUITE_TIMEOUT_MS,
      controller
    );
    if (built !== 0) return false;
  }

  const code = await runStep(
    `suite ${job.ws.name}`,
    [...turboArgs("test", { filter: job.ws.name }), "--", "--exclude", PG_EXCLUDE],
    env,
    log,
    SUITE_TIMEOUT_MS,
    controller
  );
  return code === 0;
}

// ---------------------------------------------------------------------------
// Full (one-off) mode
// ---------------------------------------------------------------------------

async function runFull(env, log, controller) {
  const steps = [
    { label: "typecheck", args: turboArgs("typecheck", { continueOnError: true }) },
    { label: "lint", args: turboArgs("lint", { continueOnError: true }) },
    {
      label: "test (all workspaces, no database)",
      args: [
        ...turboArgs("test", { concurrency: 1, continueOnError: true }),
        "--",
        "--exclude",
        PG_EXCLUDE,
      ],
    },
  ];

  log.info("QA full check — typecheck → lint → test (PostgreSQL suites excluded)");
  for (const step of steps) {
    const code = await runStep(
      step.label,
      step.args,
      env,
      log,
      SUITE_TIMEOUT_MS * 2,
      controller
    );
    if (code !== 0) {
      // A stop requested by the operator ends the running step; that is not a
      // test failure and must not be reported as one.
      log.info(
        controller.stopping
          ? `stopped during: ${step.label}`
          : `✗ full check failed at: ${step.label}`
      );
      return 1;
    }
  }
  log.info("✓ full check passed");
  return 0;
}

// ---------------------------------------------------------------------------
// Watching
// ---------------------------------------------------------------------------

function readPidRecord() {
  try {
    return JSON.parse(readFileSync(PID_FILE, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Refuse to start over a live watcher, or clear a stale record.
 *
 * Runs BEFORE the logger is created: rotating the log of a watcher that is
 * still running would move the file its stream is writing to. Returns the
 * stale pid that was removed, if any, for the caller to log.
 */
async function assertNoOtherWatcher() {
  const record = readPidRecord();
  if (!record || record.root !== ROOT || !isPidAlive(record.pid)) return null;

  const identity = isQaWatchProcess(record.pid);
  if (identity === true) {
    throw new Error(
      `a QA watcher is already running (pid ${record.pid}). Stop it with: pnpm qa:watch:stop`
    );
  }
  if (identity === false) {
    // Windows reuses pids. The recorded pid now belongs to another process, so
    // the record is stale: drop it and start. Never refuse to start because of
    // an unrelated program.
    try {
      rmSync(PID_FILE, { force: true });
    } catch {
      // Nothing to remove.
    }
    return record.pid;
  }

  // Alive, but the command line cannot be read. Fail safe: do not start a
  // second watcher over a record that might still be one.
  throw new Error(
    `cannot verify the process in .qa-watch/qa-watch.pid (pid ${record.pid}); ` +
      "remove the file if no QA watcher is running"
  );
}

const watchers = [];

function watchTree(dir, onChange, log = null, attempt = 0) {
  if (!existsSync(dir)) return;
  try {
    const watcher = watch(dir, { recursive: true }, (event, filename) => {
      if (!filename) return;
      onChange(join(dir, filename.toString()));
    });
    watcher.on("error", () => {
      // Windows ends a recursive watcher when its change buffer overflows, and
      // a directory can disappear mid-session. Either way: reopen it, or the
      // watcher keeps running while silently watching nothing.
      try {
        watcher.close();
      } catch {
        // Already closed.
      }
      const index = watchers.indexOf(watcher);
      if (index >= 0) watchers.splice(index, 1);
      if (attempt < 5) {
        setTimeout(() => watchTree(dir, onChange, log, attempt + 1), 1000).unref?.();
      }
      if (log) log.info(`re-watching ${dir} after a watcher error`);
    });
    watchers.push(watcher);
  } catch {
    // Older Node or a platform without recursive watch: watch what we can.
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) watchTree(join(dir, entry.name), onChange, log, attempt);
      }
    } catch {
      // Nothing to watch.
    }
  }
}

export function watchWorkspaces(workspaces, onChange, verbose = false, log = null) {
  for (const ws of workspaces) {
    for (const sub of ["src", "test"]) {
      watchTree(join(ws.abs, sub), onChange, log);
    }
    // Workspace-root config: vitest.config.ts, tsconfig*.json, package.json.
    try {
      const watcher = watch(ws.abs, { recursive: false }, (event, filename) => {
        if (!filename) return;
        const base = filename.toString();
        if (
          /^(vitest\.config\.[cm]?[jt]s|tsconfig[^/]*\.json|package\.json|.*\.config\.[cm]?[jt]s)$/.test(
            base
          )
        ) {
          onChange(join(ws.abs, base));
        }
      });
      watcher.on("error", () => {
        // Ignore: the workspace remains covered by its src/test watchers.
      });
      watchers.push(watcher);
    } catch {
      if (verbose) log?.info(`could not watch ${ws.dir} root config`);
    }
  }
}

function closeWatchers() {
  for (const watcher of watchers.splice(0)) {
    try {
      watcher.close();
    } catch {
      // Already closed.
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function printHelp() {
  process.stdout.write(
    [
      "JARVIS local QA watcher (zero tokens, no database)",
      "",
      "  pnpm qa:watch          watch changes and run the affected tests",
      "  pnpm qa:watch --full   typecheck, lint and the full suite, once",
      "  pnpm qa:watch:stop     stop a running watcher",
      "",
      "Options:",
      "  --full      run the one-off full check instead of watching",
      "  --verbose   log ignored events",
      "  --help      this message",
      "",
      "Environment:",
      "  QA_WATCH_DEBOUNCE_MS       debounce window (default 500)",
      "  QA_WATCH_FILE_TIMEOUT_MS   single-file timeout (default 300000)",
      "  QA_WATCH_SUITE_TIMEOUT_MS  suite/build timeout (default 900000)",
      "",
      "Logs and state live in .qa-watch/ (gitignored).",
      "",
    ].join("\n")
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return 0;
  }

  // Before the logger: a second start must not rotate a running watcher's log.
  const stalePid = await assertNoOtherWatcher();

  const log = createLogger();
  if (stalePid !== null) {
    log.info(`removed a stale pid file (pid ${stalePid} is another process)`);
  }
  const env = sanitizeEnv(process.env, options.full ? "full" : "watch");
  const controller = { child: null, stopping: false };
  let shuttingDown = false;
  let exitCode = 0;
  // Declared before `shutdown` closes over them: full mode returns before the
  // watch-mode section would otherwise initialise them.
  let debounceTimer = null;
  let stopPoll = null;

  const shutdown = async (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    controller.stopping = true;
    log.info(`stopping (${reason})`);
    closeWatchers();
    if (stopPoll) clearInterval(stopPoll);
    if (debounceTimer) clearTimeout(debounceTimer);
    if (controller.child) {
      log.info("ending the running test process tree");
      await terminateTree(controller.child);
    }
    try {
      rmSync(STOP_FILE, { force: true });
      rmSync(PID_FILE, { force: true });
    } catch {
      // Nothing left to remove.
    }
    log.info("stopped");
    await log.close();
  };

  // Both modes register themselves the same way, so `pnpm qa:watch:stop` can
  // stop a one-off full check too, and so a second watcher is refused while one
  // is running.
  mkdirSync(STATE_DIR, { recursive: true });
  rmSync(STOP_FILE, { force: true });
  writeFileSync(
    PID_FILE,
    JSON.stringify({ pid: process.pid, root: ROOT, startedAt: new Date().toISOString() }, null, 2)
  );

  stopPoll = setInterval(() => {
    if (existsSync(STOP_FILE)) {
      void shutdown("stop requested").then(() => process.exit(0));
    }
  }, 300);

  const onSignal = () => {
    void shutdown("signal").then(() => process.exit(0));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  if (options.full) {
    log.info(`QA full check started (pid ${process.pid}); log: .qa-watch/qa-watch.log`);
    log.info(
      "safety: provider keys blanked, DATABASE_URL fenced empty, PostgreSQL suites excluded"
    );
    log.info("turbo env mode: loose (the fence above is what a task receives)");
    try {
      exitCode = await runFull(env, log, controller);
    } finally {
      await shutdown("full check finished");
    }
    process.exitCode = exitCode;
    return exitCode;
  }

  // --- watch mode -----------------------------------------------------------
  const workspaces = discoverWorkspaces();
  log.info(`QA watcher started (pid ${process.pid})`);
  log.info(`watching ${workspaces.length} workspaces; log: .qa-watch/qa-watch.log`);
  log.info(
    "safety: provider keys blanked, DATABASE_URL fenced empty, PostgreSQL suites excluded"
  );
  log.info("turbo env mode: loose (the fence above is what a task receives)");
  log.info("press Ctrl+C, or run `pnpm qa:watch:stop`, to stop");

  /** @type {Map<string, {kind: string, ws: object, file?: string}>} */
  const pending = new Map();
  let running = false;
  const queue = [];

  const keyFor = (change) =>
    `${change.kind}:${change.ws?.name ?? "root"}:${change.file ?? ""}`;

  const flushPending = () => {
    if (pending.size === 0) return;
    const changes = [...pending.values()];
    pending.clear();
    const live = changes.filter((change) => {
      if (change.kind !== "test" || !change.file) return true;
      const onDisk = existsSync(join(change.ws.abs, change.file));
      if (!onDisk) {
        log.info(`• ${change.ws.name}: ${change.file} was deleted — nothing to run`);
      }
      return onDisk;
    });
    const jobs = planFromChanges(live);
    if (jobs.length === 0) {
      if (options.verbose) log.info("no workspace test run for that change");
      return;
    }
    for (const job of jobs) {
      queue.push(job);
      const trigger = job.triggers?.length ? ` — ${job.triggers.join(", ")}` : "";
      log.info(
        `queued ${job.ws.name}: ${job.mode === "suite" ? "workspace suite" : `${job.files.length} file(s)`}${trigger}`
      );
    }
    void drain();
  };

  // Last modification time seen per file. Windows delivers duplicate events for
  // one save, and a watcher can report an entry that did not change at all. A
  // file whose mtime is unchanged since it was last acted on has nothing new
  // to test, and one whose mtime predates this watcher cannot be a new change
  // — only noise from the watcher's own start-up.
  const lastSeen = new Map();
  const startedAtMs = Date.now() - 1000;

  const onChange = (absPath) => {
    const relPath = relative(ROOT, absPath).split(sep).join("/");
    const change = classifyChange(relPath, workspaces);
    if (change.kind === "ignored") {
      if (options.verbose) log.info(`ignored ${relPath}`);
      return;
    }
    if (change.kind === "root") {
      if (options.verbose) log.info(`repository file changed: ${relPath}`);
      log.info(
        "repository-level file changed — run `pnpm qa:watch:full` when convenient"
      );
      return;
    }
    if (change.file) {
      const abs = join(change.ws.abs, change.file);
      let stamp = null;
      try {
        stamp = statSync(abs).mtimeMs;
      } catch {
        // A deleted file: queued so its workspace re-runs, and a deleted test
        // is dropped at flush time (nothing left to run).
      }
      if (stamp !== null) {
        if (stamp < startedAtMs) {
          if (options.verbose) log.info(`unchanged since start: ${relPath}`);
          return;
        }
        if (lastSeen.get(abs) === stamp) {
          if (options.verbose) log.info(`unchanged (already seen): ${relPath}`);
          return;
        }
        lastSeen.set(abs, stamp);
      }
    }
    pending.set(keyFor(change), change);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flushPending, DEBOUNCE_MS);
  };

  const drain = async () => {
    if (running || shuttingDown) return;
    const job = queue.shift();
    if (!job) return;
    running = true;
    const started = Date.now();
    try {
      const ok = await runJob(job, env, log, controller);
      // A job ended by a stop request is not a failing suite.
      if (!shuttingDown) {
        log.info(
          `${ok ? "✓" : "✗"} ${job.ws.name} ${job.mode} ${ok ? "passed" : "failed"} in ${Math.round(
            (Date.now() - started) / 1000
          )}s`
        );
      }
    } catch (error) {
      log.info(`✗ ${job.ws.name}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
      if (!shuttingDown) void drain();
    }
  };

  watchWorkspaces(workspaces, onChange, options.verbose, log);

  // Keep the process alive until a signal or a stop request arrives.
  while (!shuttingDown) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  return 0;
}

const isMain =
  process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  main().catch((error) => {
    process.stderr.write(`qa-watch: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
