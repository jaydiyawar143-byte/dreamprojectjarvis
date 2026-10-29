// ---------------------------------------------------------------------------
// Phase 19, Stage 19.2 — browser-service configuration.
//
// The service refuses to START without the material its authentication needs.
// That is the difference between "closed" and "closed and loud": a service
// that boots without a key would answer every request with a refusal, and an
// operator would see a healthy container with a feature that silently never
// works. Failing at start names the missing field.
//
// Chromium is a separate switch and is OFF by default. Starting this process
// does not start a browser; `BROWSER_SERVICE_CHROMIUM_ENABLED=true` does, and
// nothing else does.
// ---------------------------------------------------------------------------

import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BROWSER_PROTOCOL_DEFAULT_CLOCK_SKEW_MS,
  BROWSER_PROTOCOL_DEFAULT_TIMEOUT_MS,
  BROWSER_PROTOCOL_MAX_BODY_BYTES,
  BROWSER_PROTOCOL_MAX_SESSIONS,
  BROWSER_PROTOCOL_MAX_SESSION_TTL_MS,
  BROWSER_PROTOCOL_MIN_SECRET_LENGTH,
  BROWSER_PROTOCOL_MIN_SESSION_TTL_MS,
} from "@jarvis/browser-protocol";

export interface BrowserServiceChromiumConfig {
  headless: boolean;
  maxConcurrentSessions: number;
  navigationTimeoutMs: number;
  downloadDir: string;
  domainAllowlist: string[];
}

export interface BrowserServiceTlsConfig {
  certPath: string;
  keyPath: string;
  caPath: string;
}

export interface BrowserServiceConfig {
  host: string;
  port: number;
  /**
   * The loopback-only liveness listener's port (Stage 19.2 audit, M1). It
   * serves `/healthz` and nothing else, on 127.0.0.1 only, so the container's
   * own health check can reach it without a client certificate while no other
   * container — and no browser operation — can.
   */
  healthPort: number;
  /** The key id the API signs with; this service accepts exactly this one. */
  keyId: string;
  secret: string;
  /** The certificate identity the API must present. */
  peerIdentity: string;
  /** Always present: the service accepts mutual TLS only (Stage 19.2 audit, M2). */
  tls: BrowserServiceTlsConfig;
  healthToken: string | null;
  clockSkewMs: number;
  sessionTtlMs: number;
  maxSessions: number;
  maxSessionsPerOrganization: number;
  requestTimeoutMs: number;
  maxBodyBytes: number;
  chromiumEnabled: boolean;
  chromium: BrowserServiceChromiumConfig;
  /**
   * The egress proxy every Chromium connection goes through (Phase 19.3).
   * Required whenever Chromium is enabled: there is no unproxied mode.
   */
  egressProxy: BrowserServiceEgressProxy | null;
}

export interface BrowserServiceEgressProxy {
  /** `http://<host>:<port>`, exactly as Chromium is given it. */
  url: string;
  /** The one name Chromium's resolver is still allowed to resolve. */
  host: string;
  port: number;
}

const MIN_CLOCK_SKEW_MS = 1_000;
const MAX_CLOCK_SKEW_MS = 300_000;
const MAX_REQUEST_TIMEOUT_MS = 120_000;

export function trimmed(value: string | undefined): string | null {
  const text = value?.trim();
  return text && text.length > 0 ? text : null;
}

export function requestedInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  options: { fallback: number; min: number; max: number }
): number {
  const raw = trimmed(env[name]);
  if (!raw) return options.fallback;
  if (!/^[0-9]{1,9}$/.test(raw)) {
    throw new Error(`browser service configuration error: ${name} must be a whole number`);
  }
  const value = Number(raw);
  if (value < options.min || value > options.max) {
    throw new Error(
      `browser service configuration error: ${name} must be between ${options.min} and ${options.max}`
    );
  }
  return value;
}

/**
 * `http://<host>:<port>` and nothing else: no credentials, path, query or
 * fragment, and a host Chromium's resolver rule can name — a DNS name or an
 * IPv4 literal. Unset is `null`; set but unusable refuses to start.
 */
function parseEgressProxyUrl(raw: string | null): BrowserServiceEgressProxy | null {
  if (raw === null) return null;
  const refuse = (): never => {
    throw new Error(
      "browser service configuration error: BROWSER_SERVICE_EGRESS_PROXY_URL must be http://<host>:<port> with no credentials, path or query"
    );
  };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse();
  }
  if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash) refuse();
  if (url.pathname !== "/" && url.pathname !== "") refuse();
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(url.hostname)) refuse();
  const port = url.port ? Number(url.port) : 80;
  return { url: `http://${url.hostname}:${port}`, host: url.hostname, port };
}

function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function defaultDownloadDir(env: NodeJS.ProcessEnv): string {
  const base = trimmed(env.BROWSER_SERVICE_DOWNLOAD_DIR);
  return base ?? join(tmpdir(), "jarvis-browser-artifacts");
}

export function loadBrowserServiceConfig(
  env: NodeJS.ProcessEnv = process.env
): BrowserServiceConfig {
  const keyId = trimmed(env.BROWSER_SERVICE_KEY_ID);
  if (!keyId) throw new Error("browser service configuration error: BROWSER_SERVICE_KEY_ID is not set");

  const secret = trimmed(env.BROWSER_SERVICE_SHARED_SECRET);
  if (!secret) {
    throw new Error("browser service configuration error: BROWSER_SERVICE_SHARED_SECRET is not set");
  }
  if (secret.length < BROWSER_PROTOCOL_MIN_SECRET_LENGTH) {
    throw new Error(
      `browser service configuration error: BROWSER_SERVICE_SHARED_SECRET is shorter than ${BROWSER_PROTOCOL_MIN_SECRET_LENGTH} characters`
    );
  }

  const peerIdentity = trimmed(env.BROWSER_SERVICE_PEER_IDENTITY);
  if (!peerIdentity) {
    throw new Error(
      "browser service configuration error: BROWSER_SERVICE_PEER_IDENTITY is not set"
    );
  }

  // Stage 19.2 audit (M2). Mutual TLS is the only mode. The two switches that
  // used to turn it off are refused rather than ignored: an operator who set
  // one asked for a deployment this service will not be, and should learn so
  // at start-up — not from a service that quietly runs differently.
  //
  //   BROWSER_SERVICE_REQUIRE_MTLS=false  would have served plain HTTP;
  //   BROWSER_SERVICE_TRUST_FORWARDED_PEER_IDENTITY=true  would have taken the
  //     caller's identity from a request header — a value the caller writes,
  //     which is never transport authentication.
  const requireMtls = trimmed(env.BROWSER_SERVICE_REQUIRE_MTLS);
  if (requireMtls !== null && requireMtls !== "true") {
    throw new Error(
      "browser service configuration error: BROWSER_SERVICE_REQUIRE_MTLS can only be true; the browser service accepts mutual TLS only"
    );
  }
  const trustForwarded = trimmed(env.BROWSER_SERVICE_TRUST_FORWARDED_PEER_IDENTITY);
  if (trustForwarded !== null && trustForwarded !== "false") {
    throw new Error(
      "browser service configuration error: BROWSER_SERVICE_TRUST_FORWARDED_PEER_IDENTITY is not supported; a caller's identity is taken only from its verified client certificate"
    );
  }

  const certPath = trimmed(env.BROWSER_SERVICE_TLS_CERT_PATH);
  const keyPath = trimmed(env.BROWSER_SERVICE_TLS_KEY_PATH);
  const caPath = trimmed(env.BROWSER_SERVICE_TLS_CA_PATH);
  if (!certPath || !keyPath || !caPath) {
    throw new Error(
      "browser service configuration error: BROWSER_SERVICE_TLS_CERT_PATH, BROWSER_SERVICE_TLS_KEY_PATH and BROWSER_SERVICE_TLS_CA_PATH are required"
    );
  }

  const sessionTtlMs = requestedInteger(env, "BROWSER_SERVICE_SESSION_TTL_MS", {
    fallback: 60_000,
    min: BROWSER_PROTOCOL_MIN_SESSION_TTL_MS,
    max: BROWSER_PROTOCOL_MAX_SESSION_TTL_MS,
  });
  const maxSessions = requestedInteger(env, "BROWSER_SERVICE_MAX_SESSIONS", {
    fallback: 2,
    min: 1,
    max: BROWSER_PROTOCOL_MAX_SESSIONS,
  });
  const maxSessionsPerOrganization = requestedInteger(
    env,
    "BROWSER_SERVICE_MAX_SESSIONS_PER_ORGANIZATION",
    { fallback: maxSessions, min: 1, max: maxSessions }
  );

  const port = requestedInteger(env, "BROWSER_SERVICE_PORT", {
    fallback: 3200,
    min: 1,
    max: 65_535,
  });
  const healthPort = requestedInteger(env, "BROWSER_SERVICE_HEALTH_PORT", {
    fallback: 3201,
    min: 1,
    max: 65_535,
  });
  if (healthPort === port) {
    throw new Error(
      "browser service configuration error: BROWSER_SERVICE_HEALTH_PORT must differ from BROWSER_SERVICE_PORT"
    );
  }

  // Phase 19.3: Chromium has no route out except the egress proxy. With
  // Chromium on and no proxy, the service refuses to start rather than run a
  // browser whose traffic nothing judges.
  const chromiumEnabled = env.BROWSER_SERVICE_CHROMIUM_ENABLED === "true";
  const egressProxy = parseEgressProxyUrl(trimmed(env.BROWSER_SERVICE_EGRESS_PROXY_URL));
  if (chromiumEnabled && egressProxy === null) {
    throw new Error(
      "browser service configuration error: BROWSER_SERVICE_EGRESS_PROXY_URL is required when BROWSER_SERVICE_CHROMIUM_ENABLED=true; the browser has no route except through the egress proxy"
    );
  }

  return {
    // Loopback by default. A deployment that must be reachable from another
    // container sets BROWSER_SERVICE_HOST=0.0.0.0 explicitly (compose does). A
    // bare `node dist/index.js` on a host must not end up listening on every
    // interface because nobody thought about it.
    host: trimmed(env.BROWSER_SERVICE_HOST) ?? "127.0.0.1",
    port,
    healthPort,
    keyId,
    secret,
    peerIdentity,
    tls: { certPath, keyPath, caPath },
    healthToken: trimmed(env.BROWSER_SERVICE_HEALTH_TOKEN),
    clockSkewMs: requestedInteger(env, "BROWSER_SERVICE_CLOCK_SKEW_MS", {
      fallback: BROWSER_PROTOCOL_DEFAULT_CLOCK_SKEW_MS,
      min: MIN_CLOCK_SKEW_MS,
      max: MAX_CLOCK_SKEW_MS,
    }),
    sessionTtlMs,
    maxSessions,
    maxSessionsPerOrganization,
    requestTimeoutMs: requestedInteger(env, "BROWSER_SERVICE_REQUEST_TIMEOUT_MS", {
      fallback: BROWSER_PROTOCOL_DEFAULT_TIMEOUT_MS,
      min: 1_000,
      max: MAX_REQUEST_TIMEOUT_MS,
    }),
    maxBodyBytes: requestedInteger(env, "BROWSER_SERVICE_MAX_BODY_BYTES", {
      fallback: BROWSER_PROTOCOL_MAX_BODY_BYTES,
      min: 1_024,
      max: BROWSER_PROTOCOL_MAX_BODY_BYTES,
    }),
    chromiumEnabled,
    egressProxy,
    chromium: {
      headless: env.BROWSER_HEADLESS !== "false",
      maxConcurrentSessions: maxSessions,
      navigationTimeoutMs: requestedInteger(env, "BROWSER_NAVIGATION_TIMEOUT_MS", {
        fallback: 20_000,
        min: 1_000,
        max: 120_000,
      }),
      downloadDir: defaultDownloadDir(env),
      domainAllowlist: parseAllowlist(env.BROWSER_DOMAIN_ALLOWLIST),
    },
  };
}
