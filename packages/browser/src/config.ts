// ---------------------------------------------------------------------------
// Sprint 7.1 — Browser configuration.
//
// Mirrors packages/n8n/src/config.ts and packages/whatsapp/src/config.ts:
// `is<X>Configured()` for the container's mount guard, `create<X>Config()` for
// the validated object, and error messages that name FIELDS and never VALUES.
//
// Browsing is OPT-IN. It is never inferred from "a Chrome happens to be
// installed", for the same reason Sprint 8 refused to infer voice from the
// presence of an OpenAI key: every developer machine has a browser, and
// inferring would hand a live automation surface to deployments that never
// asked for one. An operator must set BROWSER_ENABLED=true.
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import { z } from "zod";

import type { NavigationPolicyConfig } from "./navigation-policy.js";
import {
  DEFAULT_ALLOWED_PORTS,
  DEFAULT_ALLOWED_SCHEMES,
  DEFAULT_MAX_URL_LENGTH,
} from "./navigation-policy.js";

/** Chrome/Edge locations checked when CHROME_PATH is not set. */
const KNOWN_BROWSER_PATHS: readonly string[] = [
  // Windows
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  // macOS
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  // Linux
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
];

/**
 * Finds a Chromium-family executable, or returns null.
 *
 * `CHROME_PATH` wins so an operator can pin an exact build; the fallback list
 * exists so a developer machine needs no configuration at all. Same approach as
 * `.claude/skills/run-jarvis/driver.mjs`, which already drives this repo's UI
 * through an installed Chrome.
 */
export function resolveChromePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.CHROME_PATH?.trim();
  if (configured && configured.length > 0) {
    return existsSync(configured) ? configured : null;
  }
  for (const candidate of KNOWN_BROWSER_PATHS) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export const BROWSER_DEFAULT_NAVIGATION_TIMEOUT_MS = 20_000;
export const BROWSER_DEFAULT_SESSION_TIMEOUT_MS = 60_000;
export const BROWSER_DEFAULT_MAX_SESSIONS = 2;
export const BROWSER_DEFAULT_MAX_EXTRACT_CHARS = 20_000;
export const BROWSER_DEFAULT_MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;

const browserConfigSchema = z.object({
  chromePath: z.string().min(1, "no Chrome or Edge executable found; set CHROME_PATH"),
  headless: z.boolean().default(true),
  /**
   * Each session is a whole browser context. The ceiling is deliberately small:
   * this runs inside the API process, and an unbounded pool turns a browsing
   * request into a memory-exhaustion vector.
   */
  maxConcurrentSessions: z.coerce.number().int().positive().max(16).default(
    BROWSER_DEFAULT_MAX_SESSIONS
  ),
  /** Per-navigation ceiling. */
  navigationTimeoutMs: z.coerce.number().int().positive().max(120_000).default(
    BROWSER_DEFAULT_NAVIGATION_TIMEOUT_MS
  ),
  /**
   * Whole-session ceiling. Must stay under the journal lease
   * (`DEFAULT_LEASE_MS`, 300s) or a long session could outlive its own claim.
   */
  sessionTimeoutMs: z.coerce.number().int().positive().max(240_000).default(
    BROWSER_DEFAULT_SESSION_TIMEOUT_MS
  ),
  maxExtractChars: z.coerce.number().int().positive().max(200_000).default(
    BROWSER_DEFAULT_MAX_EXTRACT_CHARS
  ),
  maxDownloadBytes: z.coerce.number().int().positive().max(100 * 1024 * 1024).default(
    BROWSER_DEFAULT_MAX_DOWNLOAD_BYTES
  ),
  downloadDir: z.string().min(1).default("storage/browser"),
  domainAllowlist: z.array(z.string().min(1)).default([]),
});

export type BrowserConfig = z.infer<typeof browserConfigSchema>;

export interface BrowserConfigInput {
  chromePath?: string;
  headless?: boolean;
  maxConcurrentSessions?: number;
  navigationTimeoutMs?: number;
  sessionTimeoutMs?: number;
  maxExtractChars?: number;
  maxDownloadBytes?: number;
  downloadDir?: string;
  domainAllowlist?: string[];
}

function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function createBrowserConfig(
  input: BrowserConfigInput = {},
  env: NodeJS.ProcessEnv = process.env
): BrowserConfig {
  const raw = {
    chromePath: input.chromePath ?? resolveChromePath(env) ?? "",
    headless: input.headless ?? env.BROWSER_HEADLESS !== "false",
    maxConcurrentSessions: input.maxConcurrentSessions ?? env.BROWSER_MAX_SESSIONS,
    navigationTimeoutMs: input.navigationTimeoutMs ?? env.BROWSER_NAVIGATION_TIMEOUT_MS,
    sessionTimeoutMs: input.sessionTimeoutMs ?? env.BROWSER_SESSION_TIMEOUT_MS,
    maxExtractChars: input.maxExtractChars ?? env.BROWSER_MAX_EXTRACT_CHARS,
    maxDownloadBytes: input.maxDownloadBytes ?? env.BROWSER_MAX_DOWNLOAD_BYTES,
    downloadDir: input.downloadDir ?? env.BROWSER_DOWNLOAD_DIR,
    domainAllowlist: input.domainAllowlist ?? parseAllowlist(env.BROWSER_DOMAIN_ALLOWLIST),
  };

  // `undefined` must reach zod for `.default()` to fire; an env var that is
  // simply unset would otherwise arrive as the string "undefined".
  for (const key of Object.keys(raw) as Array<keyof typeof raw>) {
    if (raw[key] === undefined) delete raw[key];
  }

  const result = browserConfigSchema.safeParse(raw);
  if (!result.success) {
    const errors = result.error.flatten().fieldErrors;
    const messages = Object.entries(errors)
      .map(([field, problems]) => `${field}: ${problems?.join(", ")}`)
      .join("; ");
    // Field NAMES only. A path is not a secret, but the habit is worth keeping
    // uniform across every config module in the repo.
    throw new Error(`browser configuration error: ${messages}`);
  }
  return result.data;
}

/**
 * Whether the container should mount the browser tools at all.
 *
 * Both halves are required: an operator has switched browsing on AND a browser
 * exists to drive. Either alone is a misconfiguration, not a capability.
 */
export function isBrowserConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.BROWSER_ENABLED !== "true") return false;
  return resolveChromePath(env) !== null;
}

/** Explains why browsing is off, for the container's startup log. */
export function describeBrowserConfigStatus(env: NodeJS.ProcessEnv = process.env): {
  enabled: boolean;
  reason: string;
} {
  if (env.BROWSER_ENABLED !== "true") {
    return { enabled: false, reason: "BROWSER_ENABLED is not set to true" };
  }
  if (resolveChromePath(env) === null) {
    return { enabled: false, reason: "no Chrome or Edge executable found; set CHROME_PATH" };
  }
  return { enabled: true, reason: "browser tools enabled" };
}

/**
 * The navigation policy implied by a config.
 *
 * Note what is NOT here: `__unsafeAllowPrivateAddresses` is never set, and
 * there is no environment variable that can set it. The only way to reach a
 * private address is to construct a policy config by hand, which is exactly
 * what the test suite does and what production never does.
 */
export function navigationPolicyFor(config: BrowserConfig): NavigationPolicyConfig {
  return {
    allowedSchemes: DEFAULT_ALLOWED_SCHEMES,
    allowedPorts: DEFAULT_ALLOWED_PORTS,
    maxUrlLength: DEFAULT_MAX_URL_LENGTH,
    domainAllowlist: config.domainAllowlist,
  };
}
