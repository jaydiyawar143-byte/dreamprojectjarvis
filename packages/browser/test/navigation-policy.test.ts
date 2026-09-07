// ---------------------------------------------------------------------------
// Sprint 7.5 — Navigation policy tests.
//
// DNS is injected (`resolveHost`) so every case is deterministic and offline.
// Nothing here opens a socket.
//
// The suite is organised by the order the policy checks things, because the
// ORDER is part of the contract: a denial should name the most specific reason,
// and a caller reading "blocked-scheme" must be able to trust that the scheme
// really was the problem.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";

import {
  validateNavigationTarget,
  DEFAULT_MAX_URL_LENGTH,
  type NavigationPolicyConfig,
} from "../src/navigation-policy.js";

/** Resolver that sends every host to one address. */
const resolvesTo = (...addresses: string[]) => ({
  resolveHost: async () => addresses,
});

const PUBLIC: NavigationPolicyConfig = resolvesTo("93.184.216.34");

async function deny(url: unknown, config: NavigationPolicyConfig = PUBLIC) {
  const decision = await validateNavigationTarget(url, config);
  if (decision.allowed) {
    throw new Error(`expected a denial, got allowed for ${String(url)}`);
  }
  return decision;
}

async function allow(url: unknown, config: NavigationPolicyConfig = PUBLIC) {
  const decision = await validateNavigationTarget(url, config);
  if (!decision.allowed) {
    throw new Error(`expected allowed, got ${decision.reason}: ${decision.detail}`);
  }
  return decision;
}

describe("Sprint 7.5 — shape", () => {
  it.each([
    ["a non-string", 42],
    ["undefined", undefined],
    ["null", null],
    ["an empty string", ""],
    ["only whitespace", "   "],
    ["a relative path", "/dashboard"],
    ["a protocol-relative URL", "//example.com/x"],
    ["a bare host", "example.com"],
  ])("DENIES %s", async (_label, value) => {
    const decision = await deny(value);
    expect(decision.reason).toBe("invalid-url");
  });

  it("DENIES a URL longer than the cap", async () => {
    const long = `https://example.com/${"a".repeat(DEFAULT_MAX_URL_LENGTH)}`;
    expect((await deny(long)).reason).toBe("too-long");
  });

  it("DENIES control characters INSIDE the URL", async () => {
    // `new URL()` strips these silently, so the string it parses is not the
    // string that was checked. That divergence is the bypass.
    expect((await deny(`https://exa\tmple.com/`)).reason).toBe("invalid-url");
    expect((await deny(`https://exa\rmple.com/`)).reason).toBe("invalid-url");
    expect((await deny(`https://exa\nmple.com/`)).reason).toBe("invalid-url");
    expect((await deny(`https://example.com/a b`)).reason).toBe("invalid-url");
  });

  it("ALLOWS surrounding whitespace, because trimming cannot cause divergence", async () => {
    // The trimmed string is both what gets parsed and what gets returned, so
    // there is no second reading for an attacker to aim at. Only interior
    // control characters split the two.
    const decision = await allow(`  https://example.com/\n`);
    expect(decision.url).toBe("https://example.com/");
  });
});

describe("Sprint 7.5 — scheme", () => {
  it.each([
    ["javascript", "javascript:alert(1)"],
    ["data", "data:text/html;base64,PHNjcmlwdD4="],
    ["file", "file:///etc/passwd"],
    ["file on Windows", "file:///C:/Windows/win.ini"],
    ["about", "about:blank"],
    ["blob", "blob:https://example.com/uuid"],
    ["ftp", "ftp://example.com/x"],
    ["gopher", "gopher://example.com/x"],
    ["ws", "ws://example.com/socket"],
    ["chrome", "chrome://settings"],
    ["view-source", "view-source:https://example.com"],
  ])("DENIES the %s scheme", async (_label, url) => {
    expect((await deny(url)).reason).toBe("blocked-scheme");
  });

  it("ALLOWS http and https", async () => {
    expect((await allow("http://example.com/")).hostname).toBe("example.com");
    expect((await allow("https://example.com/")).hostname).toBe("example.com");
  });

  it("treats the scheme case-insensitively", async () => {
    await allow("HTTPS://example.com/");
    expect((await deny("JAVASCRIPT:alert(1)")).reason).toBe("blocked-scheme");
  });
});

describe("Sprint 7.5 — embedded credentials", () => {
  it.each([
    ["a username", "https://admin@example.com/"],
    ["a username and password", "https://admin:hunter2@example.com/"],
    ["an empty username with a password", "https://:hunter2@example.com/"],
  ])("DENIES %s", async (_label, url) => {
    expect((await deny(url)).reason).toBe("credentials-in-url");
  });

  it("never echoes the credential back in the reason", async () => {
    const decision = await deny("https://admin:hunter2@example.com/");
    expect(decision.detail).not.toContain("hunter2");
    expect(decision.detail).not.toContain("admin");
  });
});

describe("Sprint 7.5 — port", () => {
  it("ALLOWS the default ports, written explicitly or not", async () => {
    await allow("https://example.com/");
    await allow("https://example.com:443/");
    await allow("http://example.com:80/");
  });

  it.each([
    ["SSH", "https://example.com:22/"],
    ["Postgres", "http://example.com:5432/"],
    ["Redis", "http://example.com:6379/"],
    ["the API's own port", "http://example.com:3001/"],
  ])("DENIES %s", async (_label, url) => {
    expect((await deny(url)).reason).toBe("blocked-port");
  });

  it("honours a widened port list", async () => {
    await allow("http://example.com:8080/", { ...PUBLIC, allowedPorts: [80, 8080] });
  });
});

describe("Sprint 7.5 — addresses (the actual SSRF defence)", () => {
  it.each([
    ["loopback by name", "http://localhost/", "127.0.0.1"],
    ["loopback by literal", "http://127.0.0.1/", "127.0.0.1"],
    ["all-zeros", "http://0.0.0.0/", "0.0.0.0"],
    ["RFC1918 10/8", "http://10.0.0.5/", "10.0.0.5"],
    ["RFC1918 172.16/12", "http://172.16.9.9/", "172.16.9.9"],
    ["RFC1918 192.168/16", "http://192.168.1.1/", "192.168.1.1"],
    ["CGNAT", "http://100.64.0.1/", "100.64.0.1"],
    ["link-local", "http://169.254.1.1/", "169.254.1.1"],
    ["IPv6 loopback", "http://[::1]/", "::1"],
    ["IPv6 unique-local", "http://[fc00::1]/", "fc00::1"],
    ["IPv6 link-local", "http://[fe80::1]/", "fe80::1"],
  ])("DENIES %s", async (_label, url, address) => {
    const decision = await deny(url, resolvesTo(address));
    expect(decision.reason).toBe("blocked-address");
  });

  it("DENIES the cloud metadata endpoint and says so", async () => {
    const decision = await deny("http://169.254.169.254/latest/meta-data/", {
      ...resolvesTo("169.254.169.254"),
      allowedPorts: [80, 443],
    });
    expect(decision.reason).toBe("blocked-address");
    expect(decision.detail).toContain("cloud-metadata");
  });

  it("DENIES a PUBLIC hostname that resolves to a private address", async () => {
    // The whole point of resolving rather than pattern-matching the hostname.
    const decision = await deny("https://totally-normal.example/", resolvesTo("10.1.2.3"));
    expect(decision.reason).toBe("blocked-address");
    expect(decision.detail).toContain("10.1.2.3");
  });

  it("DENIES a host that resolves to a metadata address under a friendly name", async () => {
    const decision = await deny(
      "http://metadata.google.internal/",
      resolvesTo("169.254.169.254")
    );
    expect(decision.detail).toContain("cloud-metadata");
  });

  it("DENIES when ANY resolved address is private, even if another is public", async () => {
    // A split answer is a rebinding attempt, not a partially valid target.
    const decision = await deny(
      "https://split.example/",
      resolvesTo("93.184.216.34", "127.0.0.1")
    );
    expect(decision.reason).toBe("blocked-address");
    expect(decision.detail).toContain("127.0.0.1");
  });

  it("DENIES an IPv4-mapped IPv6 answer", async () => {
    const decision = await deny("https://sneaky.example/", resolvesTo("::ffff:169.254.169.254"));
    expect(decision.detail).toContain("cloud-metadata");
  });

  it("ALLOWS a public host", async () => {
    const decision = await allow("https://example.com/path?q=1");
    expect(decision.hostname).toBe("example.com");
    expect(decision.addresses).toEqual(["93.184.216.34"]);
  });

  it("does not consult DNS for a literal address", async () => {
    let called = false;
    await allow("https://93.184.216.34/", {
      resolveHost: async () => {
        called = true;
        return ["127.0.0.1"];
      },
    });
    expect(called).toBe(false);
  });
});

describe("Sprint 7.5 — DNS failure fails closed", () => {
  it("DENIES when resolution throws", async () => {
    const decision = await deny("https://nx.example/", {
      resolveHost: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(decision.reason).toBe("dns-failure");
  });

  it("DENIES when resolution returns nothing", async () => {
    const decision = await deny("https://empty.example/", { resolveHost: async () => [] });
    expect(decision.reason).toBe("dns-failure");
  });

  it("does not leak the resolver's error text", async () => {
    const decision = await deny("https://nx.example/", {
      resolveHost: async () => {
        throw new Error("connect ECONNREFUSED 10.0.0.53:53 secret-resolver");
      },
    });
    expect(decision.detail).not.toContain("secret-resolver");
    expect(decision.detail).not.toContain("10.0.0.53");
  });
});

describe("Sprint 7.5 — operator allowlist", () => {
  const withAllowlist: NavigationPolicyConfig = {
    ...PUBLIC,
    domainAllowlist: ["example.com", "docs.internal.test"],
  };

  it("ALLOWS an exact match and a subdomain", async () => {
    await allow("https://example.com/", withAllowlist);
    await allow("https://api.example.com/", withAllowlist);
    await allow("https://deep.nested.example.com/", withAllowlist);
  });

  it("DENIES a lookalike suffix", async () => {
    // "notexample.com" must not satisfy an "example.com" entry.
    expect((await deny("https://notexample.com/", withAllowlist)).reason).toBe(
      "not-allowlisted"
    );
    expect((await deny("https://example.com.evil.test/", withAllowlist)).reason).toBe(
      "not-allowlisted"
    );
  });

  it("DENIES an unrelated host", async () => {
    expect((await deny("https://other.test/", withAllowlist)).reason).toBe("not-allowlisted");
  });

  it("still applies the address check to an allowlisted host", async () => {
    // Allowlisting a name never waives where that name points.
    const decision = await deny("https://example.com/", {
      ...withAllowlist,
      resolveHost: async () => ["127.0.0.1"],
    });
    expect(decision.reason).toBe("blocked-address");
  });

  it("treats an empty allowlist as 'any public host'", async () => {
    await allow("https://anything.test/", { ...PUBLIC, domainAllowlist: [] });
  });
});

describe("Sprint 7.5 — the test-only escape hatch", () => {
  it("is off by default", async () => {
    expect((await deny("http://127.0.0.1:80/", resolvesTo("127.0.0.1"))).reason).toBe(
      "blocked-address"
    );
  });

  it("permits loopback ONLY when explicitly set", async () => {
    const decision = await validateNavigationTarget("http://127.0.0.1/", {
      __unsafeAllowPrivateAddresses: true,
    });
    expect(decision.allowed).toBe(true);
  });

  it("does not waive the scheme or port checks", async () => {
    // The hatch is about addresses, and only addresses.
    const scheme = await validateNavigationTarget("file:///etc/passwd", {
      __unsafeAllowPrivateAddresses: true,
    });
    expect(scheme.allowed).toBe(false);

    const port = await validateNavigationTarget("http://127.0.0.1:22/", {
      __unsafeAllowPrivateAddresses: true,
    });
    expect(port.allowed).toBe(false);
  });
});
