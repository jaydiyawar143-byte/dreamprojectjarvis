// ---------------------------------------------------------------------------
// Sprint 7.5 — Navigation policy (SSRF containment).
//
// ONE place decides whether a URL may be opened. Every browser tool, every
// redirect hop and every subresource request funnels through
// `validateNavigationTarget`; nothing is allowed to hand a URL straight to the
// browser. Duplicating this logic per tool is how the second copy ends up
// missing the metadata range.
//
// The shape is borrowed from packages/n8n/src/config.ts, which is the repo's
// existing SSRF control: check the RAW string first, then re-check the parsed
// result. The raw pass matters because `new URL()` is lenient — it will happily
// strip whitespace and accept schemes we never intend to dial — so a filter
// that only inspects the parsed object is judging a different string from the
// one the caller supplied.
//
// Order is cheapest-and-most-decisive first, so a denial always names the most
// specific reason:
//
//   1. shape     — type, length, control characters
//   2. scheme    — http/https only, checked on the raw text AND the parse
//   3. identity  — no credentials embedded in the URL
//   4. port      — default ports only, unless configured otherwise
//   5. allowlist — optional operator-supplied domain restriction
//   6. address   — resolve the host and judge EVERY address it answers with
//
// Step 6 is the one that actually stops SSRF, and it fails closed: a host that
// cannot be resolved, or that resolves to nothing, is denied.
//
// RESIDUAL RISK — DNS rebinding. We resolve the host and judge the answers,
// then Chrome resolves it again independently, and a hostile authoritative
// server can answer differently the second time. Fully closing this needs the
// resolved address pinned into the browser (Chromium's
// `--host-resolver-rules=MAP host ip`), which is a browser-launch flag and so
// cannot vary per navigation with a shared browser. It is documented as a known
// limitation rather than silently assumed away.
// ---------------------------------------------------------------------------

import { lookup } from "node:dns/promises";

import { isBlockedAddress, parseIpAddress, type BlockReason } from "./ip-rules.js";

export const DEFAULT_MAX_URL_LENGTH = 2048;
export const DEFAULT_ALLOWED_SCHEMES = ["http:", "https:"] as const;
export const DEFAULT_ALLOWED_PORTS = [80, 443] as const;

export type NavigationDenyReason =
  | "invalid-url"
  | "too-long"
  | "blocked-scheme"
  | "credentials-in-url"
  | "blocked-port"
  | "not-allowlisted"
  | "dns-failure"
  | "blocked-address";

export type NavigationDecision =
  | { allowed: true; url: string; hostname: string; addresses: string[] }
  | { allowed: false; reason: NavigationDenyReason; detail: string };

export interface NavigationPolicyConfig {
  allowedSchemes?: readonly string[];
  allowedPorts?: readonly number[];
  /**
   * Operator-supplied domain restriction. Empty means "any public host".
   * An entry matches the host itself and its subdomains, so `example.com`
   * covers `docs.example.com` but never `notexample.com`.
   */
  domainAllowlist?: readonly string[];
  maxUrlLength?: number;
  /**
   * DNS seam. Present so the test suite can resolve deterministically without
   * a network; production never sets it and gets `node:dns`.
   */
  resolveHost?: (hostname: string) => Promise<string[]>;
  /**
   * TEST-ONLY escape hatch, so the suite can drive a loopback mock server.
   *
   * Deliberately ugly, deliberately never read from the environment, and
   * asserted absent by `createBrowserConfig`. If this is ever true in a
   * deployed process, the SSRF defence is off.
   */
  __unsafeAllowPrivateAddresses?: boolean;
}

/**
 * True when the text carries a C0 control, a space, or DEL.
 *
 * Written as a code-point scan rather than a regex literal so this source file
 * never has to contain the control characters it is looking for.
 *
 * It matters because `new URL()` silently strips tab, LF and CR: a string
 * containing them parses into a DIFFERENT url than the one that was checked,
 * which is exactly how a filter gets walked past.
 */
function hasControlOrSpace(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

const SCHEME_PREFIX = /^([A-Za-z][A-Za-z0-9+.-]*):/;

function defaultPortFor(protocol: string): number | null {
  if (protocol === "http:") return 80;
  if (protocol === "https:") return 443;
  return null;
}

/** `example.com` matches `example.com` and `a.example.com`, never `badexample.com`. */
function matchesAllowlist(hostname: string, allowlist: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return allowlist.some((raw) => {
    const entry = raw.trim().toLowerCase().replace(/^\.+/, "");
    if (entry.length === 0) return false;
    return host === entry || host.endsWith(`.${entry}`);
  });
}

async function resolveWithDns(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

function addressDenial(
  hostname: string,
  address: string,
  blocked: BlockReason
): NavigationDecision {
  return {
    allowed: false,
    reason: "blocked-address",
    detail: `host "${hostname}" resolves to ${address}, which is ${blocked}`,
  };
}

/**
 * Decides whether a URL may be opened.
 *
 * Call this for the initial target, for every redirect hop, and for every
 * subresource the page requests. A decision is only valid for the exact URL it
 * was made about.
 */
export async function validateNavigationTarget(
  rawUrl: unknown,
  config: NavigationPolicyConfig = {}
): Promise<NavigationDecision> {
  const schemes = config.allowedSchemes ?? DEFAULT_ALLOWED_SCHEMES;
  const ports = config.allowedPorts ?? DEFAULT_ALLOWED_PORTS;
  const allowlist = config.domainAllowlist ?? [];
  const maxLength = config.maxUrlLength ?? DEFAULT_MAX_URL_LENGTH;
  const resolveHost = config.resolveHost ?? resolveWithDns;

  // --- 1. shape ------------------------------------------------------------
  if (typeof rawUrl !== "string") {
    return { allowed: false, reason: "invalid-url", detail: "URL must be a string" };
  }
  const text = rawUrl.trim();
  if (text.length === 0) {
    return { allowed: false, reason: "invalid-url", detail: "URL is empty" };
  }
  if (text.length > maxLength) {
    return {
      allowed: false,
      reason: "too-long",
      detail: `URL exceeds ${maxLength} characters`,
    };
  }
  if (hasControlOrSpace(text)) {
    return {
      allowed: false,
      reason: "invalid-url",
      detail: "URL contains control characters",
    };
  }

  // --- 2. scheme, on the RAW text ------------------------------------------
  const rawScheme = SCHEME_PREFIX.exec(text);
  if (!rawScheme) {
    return {
      allowed: false,
      reason: "invalid-url",
      detail: "URL must be absolute and carry a scheme",
    };
  }
  if (!schemes.includes(`${rawScheme[1]!.toLowerCase()}:`)) {
    return {
      allowed: false,
      reason: "blocked-scheme",
      detail: `scheme "${rawScheme[1]!.toLowerCase()}:" is not allowed`,
    };
  }

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { allowed: false, reason: "invalid-url", detail: "URL could not be parsed" };
  }

  // Re-checked after parsing: the raw check and the parse must agree.
  if (!schemes.includes(url.protocol.toLowerCase())) {
    return {
      allowed: false,
      reason: "blocked-scheme",
      detail: `scheme "${url.protocol.toLowerCase()}" is not allowed`,
    };
  }

  // --- 3. embedded credentials ---------------------------------------------
  if (url.username.length > 0 || url.password.length > 0) {
    // The value is a credential, so it is never echoed back in the reason.
    return {
      allowed: false,
      reason: "credentials-in-url",
      detail: "URL must not embed a username or password",
    };
  }

  // --- 4. port -------------------------------------------------------------
  const effectivePort =
    url.port.length > 0 ? Number(url.port) : defaultPortFor(url.protocol);
  if (effectivePort === null || !Number.isInteger(effectivePort)) {
    return { allowed: false, reason: "blocked-port", detail: "URL has no usable port" };
  }
  if (!ports.includes(effectivePort)) {
    return {
      allowed: false,
      reason: "blocked-port",
      detail: `port ${effectivePort} is not allowed`,
    };
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (hostname.length === 0) {
    return { allowed: false, reason: "invalid-url", detail: "URL has no host" };
  }

  // --- 5. operator allowlist ------------------------------------------------
  if (allowlist.length > 0 && !matchesAllowlist(hostname, allowlist)) {
    return {
      allowed: false,
      reason: "not-allowlisted",
      detail: `host "${hostname}" is not in the configured allowlist`,
    };
  }

  const permitPrivate = config.__unsafeAllowPrivateAddresses === true;

  // --- 6. address ----------------------------------------------------------
  // A literal address is judged as-is; there is nothing to resolve, and asking
  // DNS about it would only add a way to get a different answer.
  const literal = parseIpAddress(hostname);
  if (literal) {
    const blocked = permitPrivate ? null : isBlockedAddress(hostname);
    if (blocked) return addressDenial(hostname, hostname, blocked);
    return { allowed: true, url: url.toString(), hostname, addresses: [hostname] };
  }

  let addresses: string[];
  try {
    addresses = await resolveHost(hostname);
  } catch {
    // Fail closed. "I could not find out where this goes" is not permission.
    return {
      allowed: false,
      reason: "dns-failure",
      detail: `host "${hostname}" could not be resolved`,
    };
  }

  if (!Array.isArray(addresses) || addresses.length === 0) {
    return {
      allowed: false,
      reason: "dns-failure",
      detail: `host "${hostname}" resolved to no addresses`,
    };
  }

  if (!permitPrivate) {
    // EVERY answer must be acceptable. A host that returns one public and one
    // private address is a rebinding attempt, not a partially valid target.
    for (const address of addresses) {
      const blocked = isBlockedAddress(address);
      if (blocked) return addressDenial(hostname, address, blocked);
    }
  }

  return { allowed: true, url: url.toString(), hostname, addresses };
}
