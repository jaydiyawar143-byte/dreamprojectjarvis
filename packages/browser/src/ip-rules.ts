// ---------------------------------------------------------------------------
// Sprint 7.5 — Address classification.
//
// This module answers one question: "is it safe to open a connection to this
// IP address?" It is deliberately pure — no DNS, no network, no config — so it
// can be exhaustively table-tested, and so the navigation policy above it has
// exactly one place to consult rather than a rule scattered across tools.
//
// The list is a DENY list of address ranges, not an allow list of public ones.
// That direction is chosen on purpose: the IANA special-purpose registries are
// finite and slow-moving, whereas "the public internet" is not enumerable. A
// range we have not heard of therefore reads as public, and the compensating
// control is that the caller resolves a hostname to EVERY address and blocks if
// ANY of them is denied.
//
// Cloud metadata endpoints are separated from the link-local range that
// contains them. 169.254.169.254 is technically just link-local, but it is the
// single most valuable SSRF target in existence — it hands out credentials —
// so it earns its own reason code and its own test.
// ---------------------------------------------------------------------------

/** Why an address may not be reached. `null` from the checker means allowed. */
export type BlockReason =
  | "unparsable"
  | "unspecified"
  | "loopback"
  | "private"
  | "cgnat"
  | "link-local"
  | "cloud-metadata"
  | "multicast"
  | "reserved"
  | "documentation"
  | "benchmarking";

export interface ParsedIp {
  family: 4 | 6;
  /** 4 bytes for IPv4, 16 for IPv6. */
  bytes: number[];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Strict dotted-quad parser.
 *
 * Leading zeros are REJECTED rather than interpreted. `010.0.0.1` is octal in
 * some resolvers and decimal in others, and an SSRF filter that disagrees with
 * the connecting library about which one it is has failed. Refusing the
 * ambiguous spelling outright removes the disagreement. Callers pass hostnames
 * taken from the WHATWG `URL` parser, which has already normalised legitimate
 * IPv4 literals into canonical decimal form, so nothing valid is lost.
 */
export function parseIpv4(input: string): number[] | null {
  const parts = input.split(".");
  if (parts.length !== 4) return null;

  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith("0")) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}

/**
 * IPv6 parser covering `::` compression and a trailing embedded IPv4 literal.
 *
 * Returns the full 16 bytes; unwrapping IPv4-mapped forms is the classifier's
 * job, not the parser's, so that `::ffff:127.0.0.1` and `127.0.0.1` cannot
 * diverge in how they are judged.
 */
export function parseIpv6(input: string): number[] | null {
  let text = input;

  // A zone index ("fe80::1%eth0") never changes which range an address is in.
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  if (text.length === 0) return null;

  // A trailing dotted-quad is rewritten into the two hex groups it stands for,
  // so everything below only ever sees uniform 16-bit groups. Slicing the tail
  // off instead would have to preserve the "::" token by hand, and getting that
  // one character wrong silently turns "64:ff9b::169.254.169.254" into an
  // unparsable string rather than a recognised metadata address.
  const lastColon = text.lastIndexOf(":");
  if (lastColon !== -1 && text.slice(lastColon + 1).includes(".")) {
    const embedded = parseIpv4(text.slice(lastColon + 1));
    if (!embedded) return null;
    const high = ((embedded[0]! << 8) | embedded[1]!).toString(16);
    const low = ((embedded[2]! << 8) | embedded[3]!).toString(16);
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const doubleColon = text.indexOf("::");
  if (doubleColon !== text.lastIndexOf("::")) return null; // at most one "::"

  const toGroups = (segment: string): number[] | null => {
    if (segment.length === 0) return [];
    const out: number[] = [];
    for (const piece of segment.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
      out.push(parseInt(piece, 16));
    }
    return out;
  };

  let groups: number[];
  if (doubleColon === -1) {
    const parsed = toGroups(text);
    if (!parsed || parsed.length !== 8) return null;
    groups = parsed;
  } else {
    const head = toGroups(text.slice(0, doubleColon));
    const tail = toGroups(text.slice(doubleColon + 2));
    if (!head || !tail) return null;
    // "::" must stand for at least one omitted group, otherwise the address
    // already has its full eight and the token is meaningless.
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...tail];
  }

  const bytes: number[] = [];
  for (const group of groups) {
    bytes.push((group >> 8) & 0xff, group & 0xff);
  }
  return bytes.length === 16 ? bytes : null;
}

/** Parses either family. Accepts the `[...]` bracketing that URLs use for IPv6. */
export function parseIpAddress(input: unknown): ParsedIp | null {
  if (typeof input !== "string") return null;
  let text = input.trim();
  if (text.length === 0) return null;

  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);

  if (text.includes(":")) {
    const bytes = parseIpv6(text);
    return bytes ? { family: 6, bytes } : null;
  }
  const bytes = parseIpv4(text);
  return bytes ? { family: 4, bytes } : null;
}

// ---------------------------------------------------------------------------
// Deny tables
// ---------------------------------------------------------------------------

interface Range {
  reason: BlockReason;
  bytes: number[];
  prefixBits: number;
}

const v4 = (a: number, b: number, c: number, d: number) => [a, b, c, d];

/** IANA IPv4 Special-Purpose Address Registry, plus RFC 1918. */
const IPV4_DENY: Range[] = [
  { reason: "unspecified", bytes: v4(0, 0, 0, 0), prefixBits: 8 },
  { reason: "private", bytes: v4(10, 0, 0, 0), prefixBits: 8 },
  { reason: "cgnat", bytes: v4(100, 64, 0, 0), prefixBits: 10 },
  { reason: "loopback", bytes: v4(127, 0, 0, 0), prefixBits: 8 },
  { reason: "link-local", bytes: v4(169, 254, 0, 0), prefixBits: 16 },
  { reason: "private", bytes: v4(172, 16, 0, 0), prefixBits: 12 },
  { reason: "reserved", bytes: v4(192, 0, 0, 0), prefixBits: 24 },
  { reason: "documentation", bytes: v4(192, 0, 2, 0), prefixBits: 24 },
  { reason: "private", bytes: v4(192, 168, 0, 0), prefixBits: 16 },
  { reason: "benchmarking", bytes: v4(198, 18, 0, 0), prefixBits: 15 },
  { reason: "documentation", bytes: v4(198, 51, 100, 0), prefixBits: 24 },
  { reason: "documentation", bytes: v4(203, 0, 113, 0), prefixBits: 24 },
  { reason: "multicast", bytes: v4(224, 0, 0, 0), prefixBits: 4 },
  // 240/4 is "reserved for future use" and includes 255.255.255.255.
  { reason: "reserved", bytes: v4(240, 0, 0, 0), prefixBits: 4 },
];

/**
 * Addresses that serve instance credentials.
 *
 * Checked before the range table purely so the denial says *why* it matters.
 * Every one of these is already inside a denied range.
 */
const METADATA_V4: number[][] = [
  v4(169, 254, 169, 254), // AWS IMDS, GCP, Azure, DigitalOcean, Oracle, Alibaba
  v4(169, 254, 170, 2), // AWS ECS task metadata
  v4(100, 100, 100, 200), // Alibaba Cloud
];

const g = (...groups: number[]): number[] => {
  const bytes: number[] = [];
  for (const group of groups) bytes.push((group >> 8) & 0xff, group & 0xff);
  while (bytes.length < 16) bytes.push(0);
  return bytes;
};

const IPV6_DENY: Range[] = [
  { reason: "unspecified", bytes: g(0), prefixBits: 128 },
  // 100::/64 — the discard-only prefix.
  { reason: "reserved", bytes: g(0x100), prefixBits: 64 },
  { reason: "documentation", bytes: g(0x2001, 0x0db8), prefixBits: 32 },
  { reason: "private", bytes: g(0xfc00), prefixBits: 7 },
  { reason: "link-local", bytes: g(0xfe80), prefixBits: 10 },
  { reason: "multicast", bytes: g(0xff00), prefixBits: 8 },
];

/** AWS's IPv6 instance-metadata address. Inside fc00::/7, called out anyway. */
const METADATA_V6: number[][] = [
  [0xfd, 0x00, 0x0e, 0xc2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x02, 0x54],
];

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function withinPrefix(address: number[], range: number[], prefixBits: number): boolean {
  const wholeBytes = prefixBits >> 3;
  for (let i = 0; i < wholeBytes; i++) {
    if (address[i] !== range[i]) return false;
  }
  const remainingBits = prefixBits & 7;
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (address[wholeBytes]! & mask) === (range[wholeBytes]! & mask);
}

const sameBytes = (a: number[], b: number[]): boolean =>
  a.length === b.length && a.every((value, i) => value === b[i]);

/**
 * True when the 16 bytes are an IPv6 wrapper around an IPv4 address.
 *
 * Covers `::ffff:a.b.c.d` (IPv4-mapped), the deprecated `::a.b.c.d`
 * (IPv4-compatible) and `64:ff9b::/96` (NAT64). All three reach an IPv4
 * destination, so all three must be judged by the IPv4 table — checking only
 * the IPv6 table would let `::ffff:169.254.169.254` through.
 */
function unwrapEmbeddedIpv4(bytes: number[]): number[] | null {
  const tail = bytes.slice(12);

  const leadingZeros = bytes.slice(0, 10).every((b) => b === 0);
  if (leadingZeros && bytes[10] === 0xff && bytes[11] === 0xff) return tail;
  // ::a.b.c.d — but "::" and "::1" are the unspecified and loopback addresses,
  // not IPv4 wrappers, so they are left for the IPv6 table to judge.
  //
  // Compared byte-wise rather than folded into one number: `tail[0] << 24` is
  // signed 32-bit in JS, so any first octet above 127 comes out negative and a
  // "> 1" test on it silently fails open.
  if (leadingZeros && bytes[10] === 0 && bytes[11] === 0) {
    const unspecifiedOrLoopback =
      tail[0] === 0 && tail[1] === 0 && tail[2] === 0 && tail[3]! <= 1;
    return unspecifiedOrLoopback ? null : tail;
  }
  // 64:ff9b::/96
  if (
    bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((b) => b === 0)
  ) {
    return tail;
  }
  return null;
}

function classifyIpv4(bytes: number[]): BlockReason | null {
  for (const metadata of METADATA_V4) {
    if (sameBytes(bytes, metadata)) return "cloud-metadata";
  }
  for (const range of IPV4_DENY) {
    if (withinPrefix(bytes, range.bytes, range.prefixBits)) return range.reason;
  }
  return null;
}

/**
 * Decides whether one address may be connected to.
 *
 * Returns the reason it is denied, or `null` when it is allowed. An address
 * that cannot be parsed is denied as `"unparsable"` — the module fails closed,
 * because "I do not understand this address" is never a reason to dial it.
 */
export function isBlockedAddress(input: unknown): BlockReason | null {
  const parsed = parseIpAddress(input);
  if (!parsed) return "unparsable";

  if (parsed.family === 4) return classifyIpv4(parsed.bytes);

  const { bytes } = parsed;

  // ::1 is loopback and must be reported as such, before any unwrapping.
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return "loopback";

  for (const metadata of METADATA_V6) {
    if (sameBytes(bytes, metadata)) return "cloud-metadata";
  }

  const embedded = unwrapEmbeddedIpv4(bytes);
  if (embedded) return classifyIpv4(embedded);

  for (const range of IPV6_DENY) {
    if (withinPrefix(bytes, range.bytes, range.prefixBits)) return range.reason;
  }
  return null;
}

/** Convenience for call sites that only need the boolean. */
export function isPublicAddress(input: unknown): boolean {
  return isBlockedAddress(input) === null;
}
