// ---------------------------------------------------------------------------
// Phase 19, Stage 19.3 — host NAME classification for browser egress.
//
// `ip-rules.ts` answers "may a connection be opened to this address?". This
// answers the question that comes before it: "is this a name the public
// internet could own?". A name that cannot be public is refused before any
// resolver is asked, so a lookup for `metadata.google.internal` or for a
// Docker service name such as `postgres` never leaves the egress proxy.
//
// It is deliberately NOT applied by `validateNavigationTarget`. The navigation
// policy is shared with page research, whose tests and deployments use
// `.example` and `.test` names with their own resolvers; the egress proxy —
// the one place that resolves for the isolated browser — applies it instead.
//
// Pure: no DNS, no network, no configuration.
// ---------------------------------------------------------------------------

/** Why a host name may not be reached. `null` from the checker means allowed. */
export type HostnameBlockReason =
  | "invalid-hostname"
  | "single-label"
  | "special-use-name"
  | "cloud-metadata-name";

/** Names that answer with instance credentials. All resolve to link-local. */
const METADATA_NAMES: ReadonlySet<string> = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "instance-data.ec2.internal",
]);

/**
 * Suffixes no public site can hold: RFC 6761 (localhost, test, invalid,
 * example), RFC 6762 (local), RFC 8375 (home.arpa), RFC 7686 (onion), ICANN's
 * private-use `internal`, and the common `localdomain`. `example` here is the
 * TLD, not `example.com`, which is an ordinary public name.
 */
const SPECIAL_USE_SUFFIXES: readonly string[] = [
  "localhost",
  "local",
  "internal",
  "home.arpa",
  "onion",
  "test",
  "invalid",
  "example",
  "localdomain",
];

const LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;

/**
 * Judges a host NAME (not an IP literal), as the WHATWG URL parser produced it:
 * lower-case ASCII, punycode for anything else. One trailing dot — the
 * fully-qualified spelling — is treated as the same name.
 */
export function isBlockedHostname(input: unknown): HostnameBlockReason | null {
  if (typeof input !== "string") return "invalid-hostname";
  const name = input.endsWith(".") ? input.slice(0, -1) : input;
  if (name.length === 0 || name.length > 253 || name !== name.toLowerCase()) return "invalid-hostname";

  const labels = name.split(".");
  if (labels.some((label) => !LABEL.test(label))) return "invalid-hostname";

  if (METADATA_NAMES.has(name)) return "cloud-metadata-name";
  // A name with no dot is a search-domain or container name — `postgres`,
  // `api`, `metadata` — and never a public site.
  if (labels.length === 1) return "single-label";
  for (const suffix of SPECIAL_USE_SUFFIXES) {
    if (name === suffix || name.endsWith(`.${suffix}`)) return "special-use-name";
  }
  return null;
}
