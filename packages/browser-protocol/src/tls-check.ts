// ---------------------------------------------------------------------------
// Phase 19, P0 — the API's client TLS material, checked before any browser
// tool is registered.
//
// `readBrowserServiceEndpoint` checks that the three paths are SET. This checks
// that they are USABLE: each names a readable file, the certificate and the CA
// parse, the key parses and is the certificate's own, the certificate is in
// date, and it names the identity the API signs as — the same rule the service
// applies to the certificate it receives (its CN, or failing that its first
// subject alternative name; apps/browser-service/src/identity.ts).
//
// Without this, every one of those mistakes surfaces later and worse: as an
// "unavailable" answer to the first browser request a person makes.
//
// What it never does: print a path's contents, a key, a certificate, an
// identity or a path. Reasons name the environment variable to fix.
// ---------------------------------------------------------------------------

import { X509Certificate, createPrivateKey, type KeyObject } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

import type { BrowserServiceClientTls } from "./config.js";

export type BrowserServiceTlsProblem =
  | "unreadable"
  | "invalid"
  | "mismatched-pair"
  | "expired"
  | "not-yet-valid"
  | "wrong-identity";

export type BrowserServiceTlsCheck =
  | {
      ok: true;
      /** When the client certificate stops being valid (ISO 8601). Not a secret. */
      clientCertificateNotAfter: string;
    }
  | { ok: false; problem: BrowserServiceTlsProblem; reason: string };

export interface BrowserServiceTlsCheckOptions {
  /** Test seam for expiry; production uses the clock. */
  now?: number;
}

const CERT_FIELD = "BROWSER_SERVICE_CLIENT_CERT_PATH";
const KEY_FIELD = "BROWSER_SERVICE_CLIENT_KEY_PATH";
const CA_FIELD = "BROWSER_SERVICE_CA_PATH";

type Read = { ok: true; bytes: Buffer } | { ok: false; problem: BrowserServiceTlsProblem; reason: string };

function readFileField(path: string, field: string): Read {
  try {
    if (!statSync(path).isFile()) {
      return { ok: false, problem: "unreadable", reason: `${field} does not name a readable file` };
    }
    return { ok: true, bytes: readFileSync(path) };
  } catch {
    // The error's own text names the path; it is not repeated.
    return { ok: false, problem: "unreadable", reason: `${field} does not name a readable file` };
  }
}

function parseCertificate(bytes: Buffer): X509Certificate | null {
  try {
    return new X509Certificate(bytes);
  } catch {
    return null;
  }
}

function parsePrivateKey(bytes: Buffer): KeyObject | null {
  try {
    return createPrivateKey(bytes);
  } catch {
    return null;
  }
}

/** The identity the service will read from this certificate: CN, else the first SAN value. */
export function certificatePeerIdentity(certificate: X509Certificate): string | null {
  for (const line of certificate.subject.split("\n")) {
    const match = /^CN=(.+)$/.exec(line.trim());
    if (match && match[1]!.trim().length > 0) return match[1]!.trim();
  }
  const first = certificate.subjectAltName?.split(",")[0]?.trim();
  if (!first) return null;
  const separator = first.indexOf(":");
  if (separator < 0) return null;
  const value = first.slice(separator + 1).trim();
  return value.length > 0 ? value : null;
}

function dateCheck(
  certificate: X509Certificate,
  now: number,
  label: string
): { ok: true } | { ok: false; problem: BrowserServiceTlsProblem; reason: string } {
  const notBefore = Date.parse(certificate.validFrom);
  const notAfter = Date.parse(certificate.validTo);
  if (Number.isFinite(notAfter) && now > notAfter) {
    return { ok: false, problem: "expired", reason: `${label} has expired` };
  }
  if (Number.isFinite(notBefore) && now < notBefore) {
    return { ok: false, problem: "not-yet-valid", reason: `${label} is not valid yet` };
  }
  return { ok: true };
}

/**
 * Check the API's client TLS material against what the browser service will
 * demand of it. `expectedIdentity` is `BROWSER_SERVICE_PEER_IDENTITY`.
 */
export function checkBrowserServiceClientTls(
  tls: BrowserServiceClientTls,
  expectedIdentity: string,
  options: BrowserServiceTlsCheckOptions = {}
): BrowserServiceTlsCheck {
  const now = options.now ?? Date.now();

  const certFile = readFileField(tls.certPath, CERT_FIELD);
  if (!certFile.ok) return certFile;
  const keyFile = readFileField(tls.keyPath, KEY_FIELD);
  if (!keyFile.ok) return keyFile;

  const certificate = parseCertificate(certFile.bytes);
  if (!certificate) {
    return { ok: false, problem: "invalid", reason: `${CERT_FIELD} does not hold a PEM certificate` };
  }
  const key = parsePrivateKey(keyFile.bytes);
  if (!key) {
    return {
      ok: false,
      problem: "invalid",
      reason: `${KEY_FIELD} does not hold an unencrypted PEM private key`,
    };
  }
  if (!certificate.checkPrivateKey(key)) {
    return {
      ok: false,
      problem: "mismatched-pair",
      reason: `${CERT_FIELD} and ${KEY_FIELD} are not a matching certificate and key`,
    };
  }

  const dates = dateCheck(certificate, now, `the client certificate (${CERT_FIELD})`);
  if (!dates.ok) return dates;

  if (certificatePeerIdentity(certificate) !== expectedIdentity) {
    return {
      ok: false,
      problem: "wrong-identity",
      reason:
        `the client certificate (${CERT_FIELD}) does not name BROWSER_SERVICE_PEER_IDENTITY: ` +
        "the service takes the identity from its CN, or else its first subject alternative name",
    };
  }

  if (tls.caPath !== null) {
    const caFile = readFileField(tls.caPath, CA_FIELD);
    if (!caFile.ok) return caFile;
    const ca = parseCertificate(caFile.bytes);
    if (!ca) return { ok: false, problem: "invalid", reason: `${CA_FIELD} does not hold a PEM certificate` };
    const caDates = dateCheck(ca, now, `the CA certificate (${CA_FIELD})`);
    if (!caDates.ok) return caDates;
  }

  const notAfter = Date.parse(certificate.validTo);
  return {
    ok: true,
    clientCertificateNotAfter: Number.isFinite(notAfter) ? new Date(notAfter).toISOString() : "unknown",
  };
}
