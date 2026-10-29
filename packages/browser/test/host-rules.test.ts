// ---------------------------------------------------------------------------
// Phase 19.3 — host NAME classification tests.
//
// Pure function calls: no DNS, no network. The egress proxy refuses these
// names before any resolver is asked.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { isBlockedHostname, type HostnameBlockReason } from "../src/host-rules.js";

describe("Phase 19.3 — names no public site can hold are refused", () => {
  const cases: Array<[string, unknown, HostnameBlockReason]> = [
    ["GCP metadata", "metadata.google.internal", "cloud-metadata-name"],
    ["GCP metadata, fully qualified", "metadata.google.internal.", "cloud-metadata-name"],
    ["GCP metadata alias", "metadata.goog", "cloud-metadata-name"],
    ["AWS instance-data", "instance-data.ec2.internal", "cloud-metadata-name"],
    ["a bare container name", "postgres", "single-label"],
    ["the API's service name", "api", "single-label"],
    ["a bare metadata name", "metadata", "single-label"],
    ["localhost", "localhost", "single-label"],
    ["localhost, fully qualified", "localhost.", "single-label"],
    ["a localhost subdomain", "app.localhost", "special-use-name"],
    ["mDNS", "printer.local", "special-use-name"],
    ["ICANN private use", "svc.corp.internal", "special-use-name"],
    ["home network", "router.home.arpa", "special-use-name"],
    ["Tor", "abc.onion", "special-use-name"],
    ["test", "site.test", "special-use-name"],
    ["invalid", "x.invalid", "special-use-name"],
    ["the example TLD", "shop.example", "special-use-name"],
    ["localdomain", "box.localdomain", "special-use-name"],
    ["empty", "", "invalid-hostname"],
    ["upper case (not canonical)", "Example.COM", "invalid-hostname"],
    ["an empty label", "a..example.com", "invalid-hostname"],
    ["a label over 63 characters", `${"a".repeat(64)}.com`, "invalid-hostname"],
    ["a name over 253 characters", `${"a.".repeat(127)}com`, "invalid-hostname"],
    ["a space", "ex ample.com", "invalid-hostname"],
    ["a percent sign", "ex%61mple.com", "invalid-hostname"],
    ["not a string", 42, "invalid-hostname"],
  ];

  it.each(cases)("REFUSES %s", (_label, name, reason) => {
    expect(isBlockedHostname(name)).toBe(reason);
  });
});

describe("Phase 19.3 — public names are allowed", () => {
  it.each([["example.com"], ["www.example.com."], ["xn--bcher-kva.ch"], ["docs.github.com"], ["my_host.example.org"]])(
    "ALLOWS %s",
    (name) => {
      expect(isBlockedHostname(name)).toBeNull();
    }
  );

  it("the TLD `example` is special-use, the public domain example.com is not", () => {
    expect(isBlockedHostname("example.com")).toBeNull();
    expect(isBlockedHostname("example")).toBe("single-label");
  });
});
