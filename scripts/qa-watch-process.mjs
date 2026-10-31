// ---------------------------------------------------------------------------
// Process identity for the local QA watcher.
//
// A pid file outlives a crashed watcher, and Windows reuses pids. "The pid is
// alive" therefore does NOT mean "the watcher is alive": it can be a completely
// unrelated process that happened to receive the same number. Killing that
// process — or refusing to start because of it — would be a real bug, so the
// pid is only trusted when its command line still runs `qa-watch.mjs`.
//
// Node built-ins only.
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** True when a process with this pid exists. */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return error?.code === "EPERM";
  }
}

/** The command line of a live pid, or null when it cannot be read. */
function commandLineOf(pid) {
  if (process.platform === "win32") {
    // Windows PowerShell is present on every supported Windows; pwsh is the
    // fallback. CIM is used instead of wmic, which is being removed.
    for (const shell of ["powershell.exe", "pwsh.exe"]) {
      const result = spawnSync(
        shell,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($p) { $p.CommandLine }`,
        ],
        { encoding: "utf8", windowsHide: true, timeout: 5000 }
      );
      if (result.status === 0 && typeof result.stdout === "string") {
        const text = result.stdout.trim();
        if (text) return text;
      }
    }
    return null;
  }

  // Linux keeps the command line in procfs. On other POSIX systems, ps is the
  // portable answer.
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    const text = raw.split("\0").filter(Boolean).join(" ").trim();
    if (text) return text;
  } catch {
    // Not Linux, or the process went away.
  }

  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (result.status === 0 && typeof result.stdout === "string") {
    return result.stdout.trim() || null;
  }
  return null;
}

/**
 * Whether a live pid is this repository's QA watcher.
 *
 *   true  — the command line runs `qa-watch.mjs`
 *   false — no such process, or it is something else
 *   null  — the process exists but its command line cannot be read; callers
 *           must fail safe and never force-kill it
 */
export function isQaWatchProcess(pid) {
  if (!isPidAlive(pid)) return false;
  const commandLine = commandLineOf(pid);
  if (!commandLine) return null;
  // `qa-watch-stop.mjs` and `qa-watch.test.mjs` do not contain this substring.
  return /\bqa-watch\.mjs\b/.test(commandLine);
}
