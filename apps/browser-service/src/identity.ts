// ---------------------------------------------------------------------------
// Phase 19, Stage 19.2 — proving the peer is the provisioned API.
//
// The identity is taken from the TLS socket: the certificate the peer
// presented, validated against the configured CA by the server itself
// (`rejectUnauthorized: true`), never from a header the caller can choose.
//
// There is no exception (Stage 19.2 audit, M2). The forwarded-identity mode a
// TLS terminator could assert through a header was removed: nothing in this
// service could tell the terminator's header from the caller's, so it was a
// caller-supplied identity in all but name. A missing certificate or an
// unauthorized one is `null`, and `verifySignedRequest` refuses a null
// identity before it looks at anything else.
// ---------------------------------------------------------------------------

import type { IncomingMessage } from "node:http";
import { TLSSocket } from "node:tls";

const MAX_IDENTITY_LENGTH = 300;

function firstValue(value: string | string[] | undefined): string | null {
  if (typeof value === "string") {
    const text = value.trim();
    return text.length > 0 ? text : null;
  }
  if (Array.isArray(value) && value.length > 0) return firstValue(value[0]);
  return null;
}

/** The first SAN entry, which is `DNS:…`, `URI:…`, `IP:…` or `email:…`. */
function firstSubjectAlternativeName(raw: string | undefined): string | null {
  if (!raw) return null;
  const first = raw.split(",")[0]?.trim();
  if (!first) return null;
  const separator = first.indexOf(":");
  if (separator < 0) return null;
  const value = first.slice(separator + 1).trim();
  return value.length > 0 ? value : null;
}

function certificateIdentity(request: IncomingMessage): string | null {
  const socket = request.socket;
  if (!(socket instanceof TLSSocket)) return null;
  if (!socket.authorized) return null;
  const certificate = socket.getPeerCertificate();
  if (!certificate || Object.keys(certificate).length === 0) return null;

  const commonName = firstValue(certificate.subject?.CN);
  if (commonName) return commonName.slice(0, MAX_IDENTITY_LENGTH);
  const alternative = firstSubjectAlternativeName(certificate.subjectaltname);
  return alternative ? alternative.slice(0, MAX_IDENTITY_LENGTH) : null;
}

/** The verified client certificate's identity, or null. No header is read. */
export function peerIdentityFromRequest(request: IncomingMessage): string | null {
  return certificateIdentity(request);
}
