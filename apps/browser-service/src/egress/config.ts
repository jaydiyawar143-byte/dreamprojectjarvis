// ---------------------------------------------------------------------------
// Phase 19, Stage 19.3 — egress proxy configuration.
//
// Read once at start-up, and refused at start-up when unusable: a proxy that
// boots with a policy it could not parse would be judging traffic by a rule
// nobody wrote. Error messages name the field, never the value.
//
// The defaults are the safe ones: ports 80 and 443 only, any PUBLIC host, a
// five-second resolver deadline. An operator narrows them; there is no switch
// that widens the address rules — private, loopback, link-local, reserved and
// metadata destinations are refused whatever is configured here.
// ---------------------------------------------------------------------------

import { isBlockedHostname, parseIpAddress } from "@jarvis/browser";

import { requestedInteger, trimmed } from "../config.js";
import type { EgressPolicy } from "./policy.js";

export interface EgressConfig {
  host: string;
  port: number;
  /** The loopback-only liveness listener's port. */
  healthPort: number;
  policy: EgressPolicy;
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  maxConnections: number;
}

const MAX_ALLOWED_PORTS = 16;

function configError(message: string): Error {
  return new Error(`browser egress configuration error: ${message}`);
}

function parseAllowedPorts(raw: string | null): number[] {
  if (raw === null) return [80, 443];
  const entries = raw.split(",").map((entry) => entry.trim());
  if (entries.length === 0 || entries.length > MAX_ALLOWED_PORTS) {
    throw configError(`BROWSER_EGRESS_ALLOWED_PORTS must list 1 to ${MAX_ALLOWED_PORTS} ports`);
  }
  const ports = entries.map((entry) => {
    const port = /^[0-9]{1,5}$/.test(entry) ? Number(entry) : NaN;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw configError("BROWSER_EGRESS_ALLOWED_PORTS must be whole port numbers between 1 and 65535");
    }
    return port;
  });
  return [...new Set(ports)];
}

/**
 * Domain names, lower-cased, with a leading dot dropped. An address literal or
 * a name no public site can hold is refused: the allowlist can only narrow the
 * public internet, never open something the address rules close.
 */
function parseDomainAllowlist(raw: string | null): string[] {
  if (raw === null) return [];
  const entries = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase().replace(/^\.+/, ""))
    .filter((entry) => entry.length > 0);
  for (const entry of entries) {
    if (parseIpAddress(entry) || isBlockedHostname(entry) !== null) {
      throw configError(
        "BROWSER_EGRESS_DOMAIN_ALLOWLIST may list public domain names only (no addresses, single-label, special-use or metadata names)"
      );
    }
  }
  return [...new Set(entries)];
}

export function loadEgressConfig(env: NodeJS.ProcessEnv = process.env): EgressConfig {
  const port = requestedInteger(env, "BROWSER_EGRESS_PORT", { fallback: 3128, min: 1, max: 65_535 });
  const healthPort = requestedInteger(env, "BROWSER_EGRESS_HEALTH_PORT", { fallback: 3129, min: 1, max: 65_535 });
  if (healthPort === port) {
    throw configError("BROWSER_EGRESS_HEALTH_PORT must differ from BROWSER_EGRESS_PORT");
  }

  return {
    // Loopback unless the deployment says otherwise; compose sets 0.0.0.0 on
    // the internal browser network, where only the browser and the API are.
    host: trimmed(env.BROWSER_EGRESS_HOST) ?? "127.0.0.1",
    port,
    healthPort,
    policy: {
      allowedPorts: parseAllowedPorts(trimmed(env.BROWSER_EGRESS_ALLOWED_PORTS)),
      domainAllowlist: parseDomainAllowlist(trimmed(env.BROWSER_EGRESS_DOMAIN_ALLOWLIST)),
      dnsTimeoutMs: requestedInteger(env, "BROWSER_EGRESS_DNS_TIMEOUT_MS", { fallback: 5_000, min: 100, max: 30_000 }),
    },
    connectTimeoutMs: requestedInteger(env, "BROWSER_EGRESS_CONNECT_TIMEOUT_MS", {
      fallback: 10_000,
      min: 100,
      max: 60_000,
    }),
    idleTimeoutMs: requestedInteger(env, "BROWSER_EGRESS_IDLE_TIMEOUT_MS", {
      fallback: 120_000,
      min: 1_000,
      max: 600_000,
    }),
    maxConnections: requestedInteger(env, "BROWSER_EGRESS_MAX_CONNECTIONS", { fallback: 256, min: 1, max: 4_096 }),
  };
}
