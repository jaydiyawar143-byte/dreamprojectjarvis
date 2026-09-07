// ---------------------------------------------------------------------------
// Sprint 7.4 — Container wiring for the browser tools.
//
// Two halves, following the Sprint 6 precedent:
//
//   CONFIG    — the real `isBrowserConfigured` / `createBrowserConfig`, driven
//               with fabricated environments. These are behaviour tests.
//   DRIFT     — assertions that container.ts still wires what Sprint 7 depends
//               on, read as SOURCE TEXT. The container needs a database, an
//               OpenAI key and a JWT secret to instantiate, so it cannot be
//               constructed here.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isBrowserConfigured,
  describeBrowserConfigStatus,
  createBrowserConfig,
  navigationPolicyFor,
  resolveChromePath,
} from "@jarvis/browser";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const CONTAINER_SOURCE = readFileSync(resolve(here, "../src/services/container.ts"), "utf-8");
const INDEX_SOURCE = readFileSync(resolve(here, "../src/index.ts"), "utf-8");

/** A machine where a browser exists — this test file itself is always present. */
const REAL_FILE = fileURLToPath(import.meta.url);

describe("Sprint 7.4 — browsing is opt-in, never inferred", () => {
  it("is OFF when BROWSER_ENABLED is unset, even with a browser present", () => {
    // The Sprint 8 precedent: voice refused to switch itself on just because an
    // OpenAI key happened to exist. Every machine has a browser; inferring from
    // that would hand an automation surface to deployments that never asked.
    const env = { CHROME_PATH: REAL_FILE } as NodeJS.ProcessEnv;
    expect(isBrowserConfigured(env)).toBe(false);
    expect(describeBrowserConfigStatus(env).reason).toContain("BROWSER_ENABLED");
  });

  it.each([
    ["false", "false"],
    ["1", "1"],
    ["yes", "yes"],
    ["TRUE", "TRUE"],
  ])("is OFF when BROWSER_ENABLED is %s rather than exactly 'true'", (_label, value) => {
    const env = { BROWSER_ENABLED: value, CHROME_PATH: REAL_FILE } as NodeJS.ProcessEnv;
    expect(isBrowserConfigured(env)).toBe(false);
  });

  it("is OFF when enabled but no browser can be found", () => {
    const env = {
      BROWSER_ENABLED: "true",
      CHROME_PATH: "/definitely/not/a/browser",
    } as NodeJS.ProcessEnv;
    expect(isBrowserConfigured(env)).toBe(false);
    expect(describeBrowserConfigStatus(env).reason).toContain("CHROME_PATH");
  });

  it("is ON only when both halves are satisfied", () => {
    const env = { BROWSER_ENABLED: "true", CHROME_PATH: REAL_FILE } as NodeJS.ProcessEnv;
    expect(isBrowserConfigured(env)).toBe(true);
    expect(describeBrowserConfigStatus(env).enabled).toBe(true);
  });

  it("refuses a CHROME_PATH that does not exist rather than trusting the string", () => {
    expect(resolveChromePath({ CHROME_PATH: "/no/such/chrome" } as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveChromePath({ CHROME_PATH: REAL_FILE } as NodeJS.ProcessEnv)).toBe(REAL_FILE);
  });
});

describe("Sprint 7.4 — configuration cannot switch the SSRF defence off", () => {
  const config = () =>
    createBrowserConfig({ chromePath: REAL_FILE }, {} as NodeJS.ProcessEnv);

  it("never enables the private-address escape hatch", () => {
    const policy = navigationPolicyFor(config());
    expect(policy.__unsafeAllowPrivateAddresses).toBeUndefined();
  });

  it("cannot be talked into it through the environment", () => {
    // There is deliberately no env var for this. If one is ever added, this
    // test is where it should be argued for.
    const hostile = {
      BROWSER_ALLOW_PRIVATE: "true",
      BROWSER_ALLOW_PRIVATE_ADDRESSES: "true",
      __unsafeAllowPrivateAddresses: "true",
      BROWSER_DISABLE_SSRF: "true",
    } as unknown as NodeJS.ProcessEnv;

    const policy = navigationPolicyFor(
      createBrowserConfig({ chromePath: REAL_FILE }, hostile)
    );
    expect(policy.__unsafeAllowPrivateAddresses).toBeUndefined();
  });

  it("keeps http/https and the default ports", () => {
    const policy = navigationPolicyFor(config());
    expect(policy.allowedSchemes).toEqual(["http:", "https:"]);
    expect(policy.allowedPorts).toEqual([80, 443]);
  });

  it("carries an operator allowlist through when one is set", () => {
    const env = { BROWSER_DOMAIN_ALLOWLIST: "example.com, docs.example.com" } as NodeJS.ProcessEnv;
    const policy = navigationPolicyFor(createBrowserConfig({ chromePath: REAL_FILE }, env));
    expect(policy.domainAllowlist).toEqual(["example.com", "docs.example.com"]);
  });

  it("keeps the session deadline under the journal lease", () => {
    // DEFAULT_LEASE_MS is 300_000. A session that outlived its own claim would
    // be reported as stale while it was still running.
    expect(config().sessionTimeoutMs).toBeLessThan(300_000);
  });
});

describe("Sprint 7.4 — container wiring has not drifted", () => {
  it("registers the browser tools behind the opt-in guard", () => {
    expect(CONTAINER_SOURCE).toContain("isBrowserConfigured()");
    expect(CONTAINER_SOURCE).toContain("createBrowserTools(runtime, browserJournal, approvalConsumption)");
  });

  it("registers the browser agent only when the tools are present", () => {
    expect(CONTAINER_SOURCE).toContain('hasTool("browser.navigate")');
    expect(CONTAINER_SOURCE).toContain("new BrowserAgent(");
    expect(CONTAINER_SOURCE).toContain("AGENT_POLICIES[AGENT_IDS.browser]!.allowedTools");
  });

  it("passes the approval consumption port to the browser write tools", () => {
    // Without it, an approval id in context cannot be consumed and the tools
    // fail closed — correct, but it would mean submit/upload never run.
    expect(CONTAINER_SOURCE).toContain("approvalConsumption");
  });

  it("does not take the API down when the browser is misconfigured", () => {
    expect(CONTAINER_SOURCE).toContain("browser_registration_skipped");
  });

  it("closes the browser during shutdown", () => {
    expect(INDEX_SOURCE).toContain("releaseExternalResources");
    expect(INDEX_SOURCE).toContain("getBrowserRuntime()?.shutdown()");
  });

  it("never constructs a browser runtime outside the guarded block", () => {
    const constructions = CONTAINER_SOURCE.match(/new BrowserRuntime\(/g) ?? [];
    expect(constructions).toHaveLength(1);
  });
});
