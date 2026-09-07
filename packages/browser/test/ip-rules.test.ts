// ---------------------------------------------------------------------------
// Sprint 7.5 — Address classification tests.
//
// Table-driven on purpose. The value of this module is entirely in its
// coverage of ranges, so every range in the deny table gets at least one
// address that is inside it and the boundaries get their own cases.
//
// No network, no DNS, no fixtures. These are pure function calls.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";

import {
  isBlockedAddress,
  isPublicAddress,
  parseIpAddress,
  parseIpv4,
  parseIpv6,
  type BlockReason,
} from "../src/ip-rules.js";

describe("Sprint 7.5 — IPv4 parsing", () => {
  it("parses a canonical dotted quad", () => {
    expect(parseIpv4("192.168.1.10")).toEqual([192, 168, 1, 10]);
    expect(parseIpv4("0.0.0.0")).toEqual([0, 0, 0, 0]);
    expect(parseIpv4("255.255.255.255")).toEqual([255, 255, 255, 255]);
  });

  it.each([
    ["too few parts", "1.2.3"],
    ["too many parts", "1.2.3.4.5"],
    ["octet out of range", "256.0.0.1"],
    ["negative", "-1.0.0.1"],
    ["hex octet", "0x7f.0.0.1"],
    ["empty octet", "1..2.3"],
    ["trailing dot", "1.2.3.4."],
    ["not an address", "example.com"],
  ])("REJECTS %s", (_label, value) => {
    expect(parseIpv4(value)).toBeNull();
  });

  it("REJECTS leading zeros rather than guessing octal or decimal", () => {
    // A filter that reads 010 as decimal while the connecting library reads it
    // as octal has failed. Refusing the ambiguous spelling removes the class.
    expect(parseIpv4("010.0.0.1")).toBeNull();
    expect(parseIpv4("127.000.000.001")).toBeNull();
  });
});

describe("Sprint 7.5 — IPv6 parsing", () => {
  it("parses a full address", () => {
    expect(parseIpv6("2001:0db8:0000:0000:0000:0000:0000:0001")).toEqual([
      0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
    ]);
  });

  it("expands :: compression", () => {
    expect(parseIpv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6("fe80::1")![0]).toBe(0xfe);
    expect(parseIpv6("::")).toEqual(new Array(16).fill(0));
  });

  it("parses an embedded IPv4 tail", () => {
    expect(parseIpv6("::ffff:127.0.0.1")).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 127, 0, 0, 1,
    ]);
  });

  it("ignores a zone index", () => {
    expect(parseIpv6("fe80::1%eth0")).toEqual(parseIpv6("fe80::1"));
  });

  it.each([
    ["two :: runs", "1::2::3"],
    ["group too long", "12345::1"],
    ["non-hex group", "zzzz::1"],
    ["too many groups", "1:2:3:4:5:6:7:8:9"],
    ["bad embedded IPv4", "::ffff:999.0.0.1"],
  ])("REJECTS %s", (_label, value) => {
    expect(parseIpv6(value)).toBeNull();
  });
});

describe("Sprint 7.5 — parseIpAddress", () => {
  it("strips URL bracketing from IPv6 literals", () => {
    expect(parseIpAddress("[::1]")).toEqual({ family: 6, bytes: parseIpv6("::1") });
  });

  it("reports the family", () => {
    expect(parseIpAddress("8.8.8.8")?.family).toBe(4);
    expect(parseIpAddress("2606:4700::1111")?.family).toBe(6);
  });

  it("returns null for non-strings and blanks", () => {
    expect(parseIpAddress(undefined)).toBeNull();
    expect(parseIpAddress(42)).toBeNull();
    expect(parseIpAddress("")).toBeNull();
    expect(parseIpAddress("   ")).toBeNull();
  });
});

describe("Sprint 7.5 — IPv4 addresses that must be BLOCKED", () => {
  const cases: Array<[string, string, BlockReason]> = [
    ["all-zeros", "0.0.0.0", "unspecified"],
    ["this-network", "0.1.2.3", "unspecified"],
    ["loopback", "127.0.0.1", "loopback"],
    ["loopback, far end of the /8", "127.255.255.254", "loopback"],
    ["RFC1918 10/8", "10.0.0.1", "private"],
    ["RFC1918 172.16/12 low", "172.16.0.1", "private"],
    ["RFC1918 172.16/12 high", "172.31.255.254", "private"],
    ["RFC1918 192.168/16", "192.168.1.1", "private"],
    ["CGNAT", "100.64.0.1", "cgnat"],
    ["link-local", "169.254.1.1", "link-local"],
    ["AWS/GCP/Azure metadata", "169.254.169.254", "cloud-metadata"],
    ["AWS ECS task metadata", "169.254.170.2", "cloud-metadata"],
    ["Alibaba metadata", "100.100.100.200", "cloud-metadata"],
    ["IETF protocol assignments", "192.0.0.1", "reserved"],
    ["TEST-NET-1", "192.0.2.5", "documentation"],
    ["TEST-NET-2", "198.51.100.5", "documentation"],
    ["TEST-NET-3", "203.0.113.5", "documentation"],
    ["benchmarking", "198.18.0.1", "benchmarking"],
    ["multicast", "224.0.0.1", "multicast"],
    ["future use", "240.0.0.1", "reserved"],
    ["broadcast", "255.255.255.255", "reserved"],
  ];

  it.each(cases)("BLOCKS %s (%s)", (_label, address, reason) => {
    expect(isBlockedAddress(address)).toBe(reason);
    expect(isPublicAddress(address)).toBe(false);
  });
});

describe("Sprint 7.5 — IPv6 addresses that must be BLOCKED", () => {
  const cases: Array<[string, string, BlockReason]> = [
    ["unspecified", "::", "unspecified"],
    ["loopback", "::1", "loopback"],
    ["unique local fc00::/7", "fc00::1", "private"],
    ["unique local fd00::/8", "fd12:3456::1", "private"],
    ["link-local", "fe80::1", "link-local"],
    ["multicast", "ff02::1", "multicast"],
    ["documentation", "2001:db8::1", "documentation"],
    ["discard prefix", "0100::1", "reserved"],
    ["AWS IPv6 IMDS", "fd00:ec2::254", "cloud-metadata"],
  ];

  it.each(cases)("BLOCKS %s (%s)", (_label, address, reason) => {
    expect(isBlockedAddress(address)).toBe(reason);
  });
});

describe("Sprint 7.5 — IPv6 wrappers around IPv4 are judged as IPv4", () => {
  // The whole point: ::ffff:169.254.169.254 reaches the metadata service just
  // as surely as 169.254.169.254 does. Checking only the IPv6 table would miss
  // every one of these.
  const cases: Array<[string, string, BlockReason]> = [
    ["IPv4-mapped loopback", "::ffff:127.0.0.1", "loopback"],
    ["IPv4-mapped private", "::ffff:10.0.0.1", "private"],
    ["IPv4-mapped metadata", "::ffff:169.254.169.254", "cloud-metadata"],
    ["IPv4-compatible private", "::192.168.0.1", "private"],
    ["NAT64 loopback", "64:ff9b::127.0.0.1", "loopback"],
    ["NAT64 metadata", "64:ff9b::169.254.169.254", "cloud-metadata"],
  ];

  it.each(cases)("BLOCKS %s (%s)", (_label, address, reason) => {
    expect(isBlockedAddress(address)).toBe(reason);
  });

  it("still allows an IPv4-mapped PUBLIC address", () => {
    expect(isBlockedAddress("::ffff:8.8.8.8")).toBeNull();
  });
});

describe("Sprint 7.5 — public addresses are allowed", () => {
  it.each([
    ["Google DNS", "8.8.8.8"],
    ["Cloudflare DNS", "1.1.1.1"],
    ["a routable /8 neighbour of a blocked range", "11.0.0.1"],
    ["just above CGNAT", "100.128.0.1"],
    ["just below link-local", "169.253.255.255"],
    ["just above 172.16/12", "172.32.0.1"],
    ["just below multicast", "223.255.255.255"],
    ["public IPv6", "2606:4700:4700::1111"],
    ["public IPv6 just below fc00::/7", "fbff::1"],
  ])("ALLOWS %s (%s)", (_label, address) => {
    expect(isBlockedAddress(address)).toBeNull();
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe("Sprint 7.5 — fails closed", () => {
  it.each([
    ["a hostname", "example.com"],
    ["an empty string", ""],
    ["undefined", undefined],
    ["a number", 3232235777],
    ["an object", { address: "8.8.8.8" }],
    ["garbage", "not-an-ip"],
  ])("BLOCKS %s as unparsable", (_label, value) => {
    expect(isBlockedAddress(value)).toBe("unparsable");
    expect(isPublicAddress(value)).toBe(false);
  });
});
