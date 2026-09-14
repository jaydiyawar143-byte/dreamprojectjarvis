// ---------------------------------------------------------------------------
// Request access log, with credential-bearing query values removed.
//
// morgan's stock "combined" format writes the full request URL. Some requests
// carry a live credential in the query string: both Google OAuth callbacks
// receive `code` and `state`, and the WhatsApp webhook handshake receives
// `hub.verify_token`. The stock format wrote those values to stdout on every
// sign-in. This keeps the combined layout operators already parse and swaps
// only the URL and the referrer for redacted versions.
// ---------------------------------------------------------------------------

import type { IncomingMessage } from "node:http";
import morgan from "morgan";

const SENSITIVE_QUERY_KEYS = new Set([
  "code",
  "state",
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "client_secret",
  "key",
  "api_key",
  "apikey",
  "password",
  "hub.verify_token",
]);

const REDACTED = "REDACTED";

/** Replaces the value of every sensitive query parameter; keeps everything else. */
export function redactUrlForLog(raw: string | undefined): string {
  if (!raw) return "-";
  const queryStart = raw.indexOf("?");
  if (queryStart === -1) return raw;

  const pairs = raw
    .slice(queryStart + 1)
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq === -1) return pair;
      const rawKey = pair.slice(0, eq);
      let key: string;
      try {
        key = decodeURIComponent(rawKey.replace(/\+/g, " ")).toLowerCase();
      } catch {
        // An undecodable key cannot be classified, so its value is not logged.
        return `${rawKey}=${REDACTED}`;
      }
      return SENSITIVE_QUERY_KEYS.has(key) ? `${rawKey}=${REDACTED}` : pair;
    });

  return `${raw.slice(0, queryStart)}?${pairs.join("&")}`;
}

/** morgan's "combined" layout, with the URL and referrer passed through redaction. */
const REDACTED_COMBINED_FORMAT =
  ':remote-addr - :remote-user [:date[clf]] ":method :redacted-url HTTP/:http-version" :status :res[content-length] ":redacted-referrer" ":user-agent"';

export function accessLog() {
  morgan.token("redacted-url", (req: IncomingMessage) =>
    redactUrlForLog((req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url)
  );
  morgan.token("redacted-referrer", (req: IncomingMessage) => {
    const header = req.headers.referer ?? req.headers.referrer;
    return redactUrlForLog(Array.isArray(header) ? header[0] : header);
  });
  return morgan(REDACTED_COMBINED_FORMAT);
}
