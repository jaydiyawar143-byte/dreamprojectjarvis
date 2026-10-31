// Tests for the local QA watcher's pure logic and its environment fence.
//
//   node --test scripts/qa-watch.test.mjs
//
// Node's built-in runner — the watcher itself adds no dependency.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

import { isPidAlive, isQaWatchProcess } from "./qa-watch-process.mjs";
import {
  classifyChange,
  discoverWorkspaces,
  isIgnored,
  parseArgs,
  planFromChanges,
  quoteForCmd,
  sanitizeEnv,
  turboArgs,
  workspaceFor,
} from "./qa-watch.mjs";

const WORKSPACES = [
  { dir: "apps/api", name: "@jarvis/api", group: "apps" },
  { dir: "apps/web", name: "@jarvis/web", group: "apps" },
  { dir: "packages/core", name: "@jarvis/core", group: "packages" },
  { dir: "packages/db", name: "@jarvis/db", group: "packages" },
];

const ws = (dir) => WORKSPACES.find((entry) => entry.dir === dir);

test("sanitizeEnv fences provider credentials and the database URL", () => {
  const inherited = {
    PATH: "/usr/bin",
    OPENAI_API_KEY: "sk-live-should-never-reach-a-test",
    ANTHROPIC_API_KEY: "sk-ant-live",
    ELEVENLABS_API_KEY: "el-live",
    META_ACCESS_TOKEN: "meta-live",
    GOOGLE_CLIENT_SECRET: "google-live",
    N8N_API_KEY: "n8n-live",
    WHATSAPP_ACCESS_TOKEN: "wa-live",
    DATABASE_URL: "postgresql://jarvis:secret@localhost:5432/jarvis",
    JWT_SECRET: "jwt-live",
    N8N_BASE_URL: "https://n8n.example.test",
    OMNIROUTE_BASE_URL: "https://omniroute.example.test",
    JARVIS_ENCRYPTION_KEY: "enc-live",
    BROWSER_ENABLED: "true",
    JARVIS_MCP_ENABLED: "true",
    MARKETING_PUBLISH_ENABLED: "true",
    DESKTOP_AGENT_ENABLED: "true",
    VOICE_ENABLED: "true",
    JARVIS_MEMORY_EVAL_REAL_EMBEDDINGS: "1",
    JARVIS_REQUIRE_POSTGRES: "1",
  };

  const env = sanitizeEnv(inherited, "watch");

  // Nothing secret survives, not even as a prefix.
  const serialized = JSON.stringify(env);
  assert.equal(serialized.includes("sk-live"), false);
  assert.equal(serialized.includes("postgresql://"), false);
  assert.equal(serialized.includes("n8n-live"), false);

  for (const name of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "ELEVENLABS_API_KEY",
    "META_ACCESS_TOKEN",
    "GOOGLE_CLIENT_SECRET",
    "N8N_API_KEY",
    "WHATSAPP_ACCESS_TOKEN",
    "DATABASE_URL",
    "JWT_SECRET",
    "JARVIS_ENCRYPTION_KEY",
    "JARVIS_REQUIRE_POSTGRES",
  ]) {
    assert.equal(env[name], "", `${name} must be blank`);
  }

  // An endpoint is REMOVED, not blanked: `N8N_BASE_URL` is validated with
  // `z.string().url()`, where "" is an invalid URL rather than "not set".
  for (const name of [
    "N8N_BASE_URL",
    "N8N_MCP_ENDPOINT",
    "OMNIROUTE_BASE_URL",
    "MARKET_INDICES_API_URL",
  ]) {
    assert.equal(name in env, false, `${name} must be absent`);
  }

  // Feature switches that reach outside JARVIS are off.
  for (const name of [
    "BROWSER_ENABLED",
    "JARVIS_MCP_ENABLED",
    "MARKETING_PUBLISH_ENABLED",
    "DESKTOP_AGENT_ENABLED",
    "VOICE_ENABLED",
    "JARVIS_MEMORY_EVAL_REAL_EMBEDDINGS",
  ]) {
    assert.equal(env[name], "false", `${name} must be off`);
  }

  // Unrelated variables are preserved, and the marker identifies the run.
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.JARVIS_QA_WATCH, "1");
  assert.equal(env.JARVIS_QA_WATCH_MODE, "watch");
  assert.equal(env.TURBO_TELEMETRY_DISABLED, "1");
  assert.equal(env.NEXT_TELEMETRY_DISABLED, "1");

  // The caller's environment is not mutated.
  assert.equal(inherited.OPENAI_API_KEY, "sk-live-should-never-reach-a-test");
  assert.equal(inherited.DATABASE_URL, "postgresql://jarvis:secret@localhost:5432/jarvis");
});

test("sanitizeEnv leaves no URL-ish variable empty", () => {
  // A pin against a real break: `N8N_BASE_URL` is `z.string().url()`, so an
  // empty string stopped `getServerEnv()` for the whole @jarvis/config suite.
  // A URL-shaped variable is removed, never blanked.
  const env = sanitizeEnv(
    {
      N8N_BASE_URL: "https://n8n.example.test",
      N8N_MCP_ENDPOINT: "https://n8n.example.test/mcp",
      OMNIROUTE_BASE_URL: "https://omniroute.example.test",
      MARKET_INDICES_API_URL: "https://indices.example.test",
    },
    "watch"
  );

  for (const [name, value] of Object.entries(env)) {
    if (value !== "") continue;
    // The SQL connection strings are the deliberate exception: DEFINED and
    // blank, so `dotenv` cannot refill them from the root `.env`. Their schemas
    // accept the blank in every suite that parses them.
    if (/DATABASE_URL$/.test(name) || name === "DIRECT_URL") continue;
    assert.equal(
      /(_URL|_ENDPOINT|_ORIGIN|_URI)$/.test(name),
      false,
      `${name} is URL-shaped and must be removed rather than blanked`
    );
  }
});

test("sanitizeEnv records full mode", () => {
  assert.equal(sanitizeEnv({}, "full").JARVIS_QA_WATCH_MODE, "full");
});

test("isIgnored skips build output, dependencies and the desktop agent", () => {
  for (const path of [
    "node_modules/vitest/index.js",
    "packages/core/node_modules/x.js",
    "packages/core/dist/index.js",
    "apps/web/.next/server/page.js",
    ".turbo/cache/x",
    ".git/HEAD",
    ".qa-watch/qa-watch.log",
    "apps/desktop-agent/src/Program.cs",
    "coverage/lcov.info",
    "",
  ]) {
    assert.equal(isIgnored(path), true, `${path} should be ignored`);
  }

  for (const path of [
    "packages/core/src/index.ts",
    "apps/api/test/chat.test.ts",
    "packages/db/prisma/schema.prisma",
  ]) {
    assert.equal(isIgnored(path), false, `${path} should be watched`);
  }
});

test("workspaceFor resolves the two-segment workspace directory", () => {
  assert.equal(workspaceFor("apps/api/src/index.ts", WORKSPACES), ws("apps/api"));
  assert.equal(workspaceFor("packages/core/test/x.test.ts", WORKSPACES), ws("packages/core"));
  assert.equal(workspaceFor("docs/DEVELOPMENT.md", WORKSPACES), null);
  assert.equal(workspaceFor("apps/desktop-agent/x", WORKSPACES), null);
});

test("classifyChange distinguishes tests, source, config and other files", () => {
  assert.equal(
    classifyChange("apps/api/test/chat.test.ts", WORKSPACES).kind,
    "test"
  );
  assert.equal(
    classifyChange("apps/web/test/page.test.tsx", WORKSPACES).kind,
    "test"
  );
  assert.equal(
    classifyChange("packages/core/src/automation-library.ts", WORKSPACES).kind,
    "source"
  );
  assert.equal(
    classifyChange("packages/core/vitest.config.ts", WORKSPACES).kind,
    "config"
  );
  assert.equal(classifyChange("apps/api/package.json", WORKSPACES).kind, "config");
  assert.equal(classifyChange("apps/api/tsconfig.test.json", WORKSPACES).kind, "config");
  assert.equal(
    classifyChange("packages/db/prisma/schema.prisma", WORKSPACES).kind,
    "other"
  );
  assert.equal(classifyChange("docs/DEVELOPMENT.md", WORKSPACES).kind, "root");
  assert.equal(
    classifyChange("packages/core/dist/index.js", WORKSPACES).kind,
    "ignored"
  );

  const testChange = classifyChange("packages/core/test/params-hash.test.ts", WORKSPACES);
  assert.equal(testChange.ws.name, "@jarvis/core");
  assert.equal(testChange.file, "test/params-hash.test.ts");
});

test("planFromChanges upgrades a library change to build + suite", () => {
  const jobs = planFromChanges([
    { kind: "source", ws: ws("packages/core"), file: "src/index.ts" },
  ]);

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].mode, "suite");
  assert.equal(jobs[0].ws.name, "@jarvis/core");
  assert.equal(jobs[0].buildSelf, true);
});

test("planFromChanges runs an app change as a suite without building the app", () => {
  const jobs = planFromChanges([
    { kind: "source", ws: ws("apps/api"), file: "src/index.ts" },
  ]);

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].mode, "suite");
  assert.equal(jobs[0].buildSelf, false);
});

test("planFromChanges targets changed test files and drops PostgreSQL suites", () => {
  const jobs = planFromChanges([
    { kind: "test", ws: ws("apps/api"), file: "test/chat.test.ts" },
    { kind: "test", ws: ws("apps/api"), file: "test/marketing-e2e-pg.integration.test.ts" },
  ]);

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].mode, "files");
  assert.deepEqual(jobs[0].files, ["test/chat.test.ts"]);
});

test("planFromChanges skips a change that is only a PostgreSQL suite", () => {
  const jobs = planFromChanges([
    {
      kind: "test",
      ws: ws("packages/db"),
      file: "test/desktop-agent-p19-pg.integration.test.ts",
    },
  ]);

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].mode, "files");
  assert.deepEqual(jobs[0].files, []);
});

test("planFromChanges lets a source change absorb changed test files", () => {
  const jobs = planFromChanges([
    { kind: "test", ws: ws("packages/core"), file: "test/a.test.ts" },
    { kind: "source", ws: ws("packages/core"), file: "src/a.ts" },
  ]);

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].mode, "suite");
});

test("planFromChanges keeps one job per workspace", () => {
  const jobs = planFromChanges([
    { kind: "test", ws: ws("apps/api"), file: "test/a.test.ts" },
    { kind: "test", ws: ws("apps/web"), file: "test/b.test.tsx" },
    { kind: "test", ws: ws("apps/api"), file: "test/c.test.ts" },
  ]);

  assert.equal(jobs.length, 2);
  const api = jobs.find((job) => job.ws.name === "@jarvis/api");
  assert.deepEqual(api.files.sort(), ["test/a.test.ts", "test/c.test.ts"]);
});

test("quoteForCmd quotes only when needed", () => {
  assert.equal(quoteForCmd("pnpm.cmd"), "pnpm.cmd");
  assert.equal(quoteForCmd("@jarvis/core"), "@jarvis/core");
  assert.equal(quoteForCmd("--filter=@jarvis/core"), "--filter=@jarvis/core");
  assert.equal(quoteForCmd("a b"), '"a b"');
  assert.equal(quoteForCmd(""), '""');
});

test("turboArgs always asks for loose env mode", () => {
  // Turbo 2's default strict mode hands a task ONLY the variables named in
  // turbo.json, so a blanked DATABASE_URL would arrive ABSENT — and a test's
  // `dotenv` call would refill it from the root `.env`. This is the pin: every
  // Turbo run must carry `--env-mode=loose`, before the `--` separator.
  for (const args of [
    turboArgs("build", { filter: "@jarvis/core" }),
    turboArgs("test", { filter: "@jarvis/core" }),
    turboArgs("typecheck"),
    turboArgs("lint"),
    turboArgs("test", { concurrency: 1 }),
  ]) {
    assert.ok(args.includes("--env-mode=loose"), `${args.join(" ")} must be loose`);
    assert.ok(args.indexOf("--env-mode=loose") > args.indexOf("run"));
  }

  assert.deepEqual(turboArgs("test", { filter: "@jarvis/core" }).slice(1), [
    "exec",
    "turbo",
    "run",
    "test",
    "--filter",
    "@jarvis/core",
    "--env-mode=loose",
  ]);
  assert.ok(turboArgs("test", { concurrency: 1 }).includes("--concurrency=1"));
});

test("classifyChange ignores a directory event, not a file change", () => {
  // `fs.watch` on Windows can report the watched directory itself (its own
  // root after a buffer overflow), as `packages/core/src`. Treating that as a
  // workspace change ran every package's suite at once.
  for (const relPath of [
    "packages/core/src",
    "packages/core/test",
    "apps/api/src",
    "apps/web/test",
    "packages/core/dist",
    "packages/core/node_modules",
  ]) {
    assert.equal(classifyChange(relPath, WORKSPACES).kind, "ignored", relPath);
  }
});

test("planFromChanges records what triggered a run", () => {
  const jobs = planFromChanges([
    { kind: "source", ws: ws("packages/core"), file: "src/a.ts" },
    { kind: "test", ws: ws("packages/core"), file: "test/a.test.ts" },
  ]);

  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].triggers.sort(), ["src/a.ts", "test/a.test.ts"]);
});

test("full mode asks Turbo to keep going after a failing workspace", () => {
  // A one-off check must report EVERY failure, not stop at the first workspace
  // and hide the rest. `dependencies-successful` still protects a task from a
  // broken build its dependency failed to produce.
  const args = turboArgs("test", { concurrency: 1, continueOnError: true });
  assert.ok(args.includes("--continue=dependencies-successful"));
  assert.ok(args.indexOf("--env-mode=loose") > args.indexOf("--continue=dependencies-successful"));

  // A watch-mode run covers one workspace; there is nothing to continue past.
  assert.equal(
    turboArgs("test", { filter: "@jarvis/core" }).includes("--continue=dependencies-successful"),
    false
  );
});

test("parseArgs rejects unknown flags", () => {
  assert.deepEqual(parseArgs(["--full"]), { full: true, help: false, verbose: false });
  assert.deepEqual(parseArgs(["--verbose"]), { full: false, help: false, verbose: true });
  assert.throws(() => parseArgs(["--nope"]), /Unknown argument/);
});

test("discoverWorkspaces finds the pnpm workspaces and not the .NET agent", () => {
  const workspaces = discoverWorkspaces();
  const dirs = workspaces.map((entry) => entry.dir);

  assert.ok(dirs.includes("apps/api"), "apps/api is a workspace");
  assert.ok(dirs.includes("apps/web"), "apps/web is a workspace");
  assert.ok(dirs.includes("packages/core"), "packages/core is a workspace");
  assert.equal(dirs.includes("apps/desktop-agent"), false, "the .NET agent is not");
  assert.ok(workspaces.every((entry) => entry.group === "apps" || entry.group === "packages"));
});

test("isPidAlive rejects impossible pids and accepts this process", () => {
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(-1), false);
  assert.equal(isPidAlive(1.5), false);
  assert.equal(isPidAlive("123"), false);
  assert.equal(isPidAlive(process.pid), true);
});

test("isQaWatchProcess never claims an unrelated process", () => {
  // This runner's command line names qa-watch.test.mjs, not qa-watch.mjs, so a
  // stale pid pointing here must not be treated as a watcher.
  assert.equal(isQaWatchProcess(process.pid), false);
  assert.equal(isQaWatchProcess(0), false);
});

test("isQaWatchProcess recognises a process running qa-watch.mjs", async () => {
  // `-e` keeps the process alive without starting a real watcher; the trailing
  // argument is only there to put the script name on the command line.
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)", "qa-watch.mjs"], {
    stdio: "ignore",
    windowsHide: true,
  });
  try {
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    assert.equal(isQaWatchProcess(child.pid), true);
  } finally {
    child.kill();
  }
});
