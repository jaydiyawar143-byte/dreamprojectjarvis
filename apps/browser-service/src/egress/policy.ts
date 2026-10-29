// ---------------------------------------------------------------------------
// Phase 19, Stage 19.3 — the egress decision.
//
// Every connection the isolated browser makes goes through the egress proxy,
// and this module is the proxy's one question: "may a connection be opened to
// this host and port, and to WHICH address?". The answer names the address, so
// the proxy connects to exactly what was judged and never resolves again — a
// DNS answer that changes between the check and the connection (rebinding)
// therefore never reaches a socket.
//
// Order, cheapest and most decisive first:
//
//   1. shape      — the target is canonicalised by the WHATWG URL parser, so
//                   `0x7f.1`, `2130706433`, `0177.0.0.1`, `%31%32%37.0.0.1` and
//                   `127.1` are all judged as the `127.0.0.1` they are;
//   2. port       — an explicit allowlist (80 and 443 by default);
//   3. literal    — an IP literal is judged by `ip-rules` (IPv4-mapped, NAT64,
//                   6to4, Teredo and metadata included);
//   4. name       — `host-rules`: single-label, special-use and metadata names
//                   are refused before any resolver is asked;
//   5. allowlist  — optional operator-supplied domain restriction;
//   6. resolution — EVERY answer must be public; one private answer refuses.
//
// Fail closed throughout: a target that cannot be parsed, a resolver that
// errors or times out, or an empty answer is a refusal.
// ---------------------------------------------------------------------------

import { lookup } from "node:dns/promises";

import {
  isBlockedAddress,
  isBlockedHostname,
  parseIpAddress,
  type BlockReason,
  type HostnameBlockReason,
} from "@jarvis/browser";

export type EgressDenyReason =
  | "invalid-target"
  | "blocked-port"
  | "blocked-address"
  | "blocked-hostname"
  | "not-allowlisted"
  | "dns-failure";

export interface EgressPolicy {
  /** Destination ports a connection may use. */
  allowedPorts: readonly number[];
  /** Empty: any public host. Otherwise the host or a subdomain of an entry. */
  domainAllowlist: readonly string[];
  dnsTimeoutMs: number;
}

export interface EgressTarget {
  /** Canonical host: lower-case name, dotted-quad IPv4, or bracketed IPv6. */
  host: string;
  port: number;
}

export type EgressDecision =
  | { allowed: true; host: string; port: number; address: string }
  | {
      allowed: false;
      reason: EgressDenyReason;
      /** A fixed class name (an ip-rules or host-rules reason); never a URL or an answer. */
      detail: string;
    };

export type ResolveHost = (host: string) => Promise<string[]>;

const MAX_TARGET_LENGTH = 2048;

function hasControlOrSpace(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

function canonicalHost(rawHost: string): string | null {
  // The WHATWG parser is the browser's own: it folds every IPv4 spelling into
  // dotted-quad, decodes percent-escapes, applies IDNA and compresses IPv6.
  // Judging its output means judging what Chromium would have dialled.
  try {
    const url = new URL(`http://${rawHost}/`);
    return url.hostname.length > 0 ? url.hostname : null;
  } catch {
    return null;
  }
}

function parsePort(text: string): number | null {
  if (!/^[0-9]{1,5}$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65_535 ? port : null;
}

/**
 * The target of a CONNECT request: authority-form `host:port` or `[v6]:port`.
 * Anything else — a path, credentials, a missing port, whitespace — is refused.
 */
export function parseConnectTarget(input: unknown): EgressTarget | null {
  if (typeof input !== "string" || input.length === 0 || input.length > 300) return null;
  if (hasControlOrSpace(input) || /[@/\\?#]/.test(input)) return null;
  const match = /^(\[[^\]]+\]|[^:[\]]+):([^:]+)$/.exec(input);
  if (!match) return null;
  const port = parsePort(match[2]!);
  const host = canonicalHost(match[1]!);
  if (port === null || host === null) return null;
  return { host, port };
}

export interface HttpTarget extends EgressTarget {
  /** The request target to send upstream: path and query, never the fragment. */
  path: string;
  /** The `Host` header value: host, and the port when it is not 80. */
  hostHeader: string;
}

/**
 * The target of a plain-HTTP proxy request: an absolute `http://` URL. An
 * origin-form request, an `https://` URL (that is CONNECT's job) or a URL with
 * credentials is refused.
 */
export function parseHttpProxyTarget(input: unknown): HttpTarget | null {
  if (typeof input !== "string" || input.length === 0 || input.length > MAX_TARGET_LENGTH) return null;
  if (hasControlOrSpace(input) || !/^http:\/\//i.test(input)) return null;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || url.username || url.password || url.hostname.length === 0) return null;
  const port = url.port ? parsePort(url.port) : 80;
  if (port === null) return null;
  return { host: url.hostname, port, path: `${url.pathname}${url.search}`, hostHeader: url.host };
}

function matchesAllowlist(host: string, allowlist: readonly string[]): boolean {
  return allowlist.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

export type LookupAll = (host: string) => Promise<Array<{ address: string }>>;

const lookupAll: LookupAll = (host) => lookup(host, { all: true, verbatim: true });

/**
 * The resolver the proxy uses: every address, in the order DNS gave them, or a
 * rejection once `timeoutMs` passes. `lookupFn` is a test seam; production
 * uses the system resolver.
 */
export function systemResolver(timeoutMs: number, lookupFn: LookupAll = lookupAll): ResolveHost {
  return async (host) => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("resolution timed out")), timeoutMs);
    });
    try {
      const records = await Promise.race([lookupFn(host), timeout]);
      return records.map((record) => record.address);
    } finally {
      clearTimeout(timer);
    }
  };
}

const deny = (reason: EgressDenyReason, detail: BlockReason | HostnameBlockReason | string): EgressDecision => ({
  allowed: false,
  reason,
  detail,
});

/** Decides one connection. The address it returns is the only one to dial. */
export async function judgeEgressTarget(
  target: EgressTarget,
  policy: EgressPolicy,
  resolveHost: ResolveHost
): Promise<EgressDecision> {
  if (!policy.allowedPorts.includes(target.port)) return deny("blocked-port", "port");

  const literal = parseIpAddress(target.host);
  if (literal) {
    const blocked = isBlockedAddress(target.host);
    if (blocked) return deny("blocked-address", blocked);
    // A domain allowlist names domains; an address literal is never one of them.
    if (policy.domainAllowlist.length > 0) return deny("not-allowlisted", "literal");
    return { allowed: true, host: target.host, port: target.port, address: target.host.replace(/^\[|\]$/g, "") };
  }

  const named = isBlockedHostname(target.host);
  if (named) return deny("blocked-hostname", named);
  const host = target.host.replace(/\.$/, "");
  if (policy.domainAllowlist.length > 0 && !matchesAllowlist(host, policy.domainAllowlist)) {
    return deny("not-allowlisted", "name");
  }

  let addresses: string[];
  try {
    addresses = await resolveHost(host);
  } catch {
    return deny("dns-failure", "unresolved");
  }
  if (!Array.isArray(addresses) || addresses.length === 0) return deny("dns-failure", "empty");

  // EVERY answer must be public. One public and one private answer is a
  // rebinding attempt, not a partly valid destination.
  for (const address of addresses) {
    const blocked = isBlockedAddress(address);
    if (blocked) return deny("blocked-address", blocked);
  }
  return { allowed: true, host, port: target.port, address: addresses[0]! };
}
