// ---------------------------------------------------------------------------
// Build metadata — the ONLY place that reads the environment for self-knowledge.
//
// SelfKnowledgeService takes values, not an environment. That split is the
// whole safety design: this file names the three variables it wants, one at a
// time, and nothing downstream can enumerate `process.env` even by accident.
// There is no loop over env keys here and there must never be one — an
// allowlist that is a loop is an allowlist one edit away from being a dump.
//
// Nothing here reads a file or runs a command. A commit is whatever the build
// stamped into the environment; if the build stamped nothing, the answer is
// null and JARVIS says it does not know, which is the honest answer and the
// only one that cannot be wrong.
// ---------------------------------------------------------------------------

import type { BuildMetadata } from "./self-knowledge-service.js";

/** Trimmed, or null. Empty and whitespace-only are treated as "not set". */
function named(key: string): string | null {
  const raw = process.env[key];
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value.length > 0 ? value : null;
}

/**
 * A commit is a hex sha and nothing else.
 *
 * Validated rather than trusted because this value is rendered back to the
 * user: a deploy script that exported the wrong variable could otherwise put
 * arbitrary text — including something sensitive — into an answer. Anything
 * that is not a sha is treated as unstamped.
 */
function commitFrom(value: string | null): string | null {
  if (!value) return null;
  return /^[0-9a-f]{7,40}$/i.test(value) ? value.toLowerCase() : null;
}

/**
 * What this build is, from build-time environment only.
 *
 * `JARVIS_GIT_COMMIT` is the project's own variable; `GITHUB_SHA` is what
 * Actions sets, so a CI-built image is stamped without extra wiring.
 */
export function readBuildMetadata(): BuildMetadata {
  return {
    name: "JARVIS",
    version: named("JARVIS_VERSION") ?? "0.1.0",
    gitCommit: commitFrom(named("JARVIS_GIT_COMMIT") ?? named("GITHUB_SHA")),
    environment: named("NODE_ENV") ?? "development",
  };
}
