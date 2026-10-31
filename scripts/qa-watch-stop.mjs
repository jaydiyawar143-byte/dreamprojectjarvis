#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Stop the JARVIS local QA watcher started by `pnpm qa:watch`.
//
// A stop request is a file, not a signal: the watcher polls for it and shuts
// down in order — closing its file watchers, ending the running test process
// tree, removing its PID file — before exiting. If it does not answer within
// the timeout (a wedged child process), this script ends the tree itself.
//
// Node built-ins only.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isPidAlive, isQaWatchProcess } from "./qa-watch-process.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_DIR = join(ROOT, ".qa-watch");
const PID_FILE = join(STATE_DIR, "qa-watch.pid");
const STOP_FILE = join(STATE_DIR, "stop.request");

const STOP_TIMEOUT_MS = Number(process.env.QA_WATCH_STOP_TIMEOUT_MS || 10000);
const POLL_MS = 250;

function readPidRecord() {
  try {
    return JSON.parse(readFileSync(PID_FILE, "utf8"));
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function forceKillTree(pid) {
  return new Promise((resolveKill) => {
    if (process.platform === "win32") {
      try {
        const child = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        child.once("exit", () => resolveKill());
        child.once("error", () => resolveKill());
      } catch {
        resolveKill();
      }
      return;
    }

    try {
      process.kill(pid, "SIGTERM");
      setTimeout(() => {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
        resolveKill();
      }, 2000).unref?.();
    } catch {
      resolveKill();
    }
  });
}

async function main() {
  const record = readPidRecord();

  if (!record || !Number.isInteger(record.pid)) {
    process.stdout.write("qa-watch: not running (no valid .qa-watch/qa-watch.pid)\n");
    rmSync(PID_FILE, { force: true });
    rmSync(STOP_FILE, { force: true });
    return 0;
  }

  if (record.root !== ROOT) {
    process.stdout.write(
      `qa-watch: refusing to stop pid ${record.pid} — it belongs to ${record.root}, not this repository\n`
    );
    return 1;
  }

  if (!isPidAlive(record.pid)) {
    process.stdout.write(
      `qa-watch: not running (stale pid ${record.pid}); removing the pid file\n`
    );
    rmSync(PID_FILE, { force: true });
    rmSync(STOP_FILE, { force: true });
    return 0;
  }

  // A pid is not an identity: Windows reuses pids, so an old record can point
  // at a completely unrelated process. Only a process still running
  // `qa-watch.mjs` may be asked to stop or force-killed.
  const identity = isQaWatchProcess(record.pid);
  if (identity === false) {
    process.stdout.write(
      `qa-watch: not running (stale pid ${record.pid} belongs to another process); removing the pid file\n`
    );
    rmSync(PID_FILE, { force: true });
    rmSync(STOP_FILE, { force: true });
    return 0;
  }
  if (identity === null) {
    process.stdout.write(
      `qa-watch: cannot verify pid ${record.pid}; asking it to stop without force-killing\n`
    );
  }

  process.stdout.write(`qa-watch: stopping pid ${record.pid}…\n`);
  writeFileSync(STOP_FILE, new Date().toISOString());

  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isPidAlive(record.pid)) {
      rmSync(PID_FILE, { force: true });
      rmSync(STOP_FILE, { force: true });
      process.stdout.write("qa-watch: stopped\n");
      return 0;
    }
    await sleep(POLL_MS);
  }

  // Re-check immediately before killing: the watcher may have exited during
  // the wait and the pid been reused by something else.
  if (isQaWatchProcess(record.pid) !== true) {
    process.stdout.write(
      `qa-watch: pid ${record.pid} is no longer a verified QA watcher; not killing it\n`
    );
    rmSync(PID_FILE, { force: true });
    rmSync(STOP_FILE, { force: true });
    return 1;
  }

  process.stdout.write(
    `qa-watch: no answer after ${Math.round(STOP_TIMEOUT_MS / 1000)}s; ending the process tree\n`
  );
  await forceKillTree(record.pid);
  await sleep(500);
  rmSync(PID_FILE, { force: true });
  rmSync(STOP_FILE, { force: true });

  if (isPidAlive(record.pid)) {
    process.stdout.write(`qa-watch: pid ${record.pid} is still alive; check it by hand\n`);
    return 1;
  }

  process.stdout.write("qa-watch: stopped\n");
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(
      `qa-watch:stop: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  });
