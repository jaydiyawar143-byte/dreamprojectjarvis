// ---------------------------------------------------------------------------
// Phase 19, Stage 19.2 — how the API chooses and binds a browser session.
//
// Two things are proved here without a database or a browser:
//
//   1. the Organization a remote session belongs to is resolved from the
//      shared-connection reader, never from anything a caller supplied, and a
//      refusal is a refusal (not an empty string, not a default org);
//   2. the container's wiring still makes the remote runtime one of two
//      implementations of the SAME port, behind the SAME opt-in, with the SAME
//      tools — and an unusable browser-service configuration registers nothing
//      rather than quietly falling back to an in-process Chromium.
//
// The second half reads the container as source text, as the Sprint 7 drift
// test does: instantiating the container needs PostgreSQL, an OpenAI key and a
// JWT secret, none of which a unit test should provide.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isBrowserConfigured, isBrowserEnabled } from "@jarvis/browser";
import { SHARED_INTEGRATION_CONNECTORS } from "@jarvis/core";
import { describe, expect, it } from "vitest";

import {
  createBrowserSessionTenantResolver,
  type SharedAccessDecision,
  type SharedConnectionAccessPort,
} from "../src/services/tenancy/shared-connection-access.js";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const CONTAINER_SOURCE = readFileSync(resolve(here, "../src/services/container.ts"), "utf-8");

/** A reader that answers from a table, so no database is involved. */
function fakeAccess(answer: (userId: string) => Promise<SharedAccessDecision>) {
  const asked: Array<{ userId: string; connector: unknown; operation: string }> = [];
  const access: SharedConnectionAccessPort = {
    async check(userId, connector, operation) {
      asked.push({ userId, connector, operation });
      return answer(userId);
    },
  };
  return { access, asked };
}

describe("createBrowserSessionTenantResolver", () => {
  it("answers with the Organization that owns the browser connection", async () => {
    const { access, asked } = fakeAccess(async () => ({
      allowed: true,
      tenantId: "org-7",
      role: "member",
    }));
    const tenant = createBrowserSessionTenantResolver(access);

    await expect(tenant.resolveSessionOrganization("user-1")).resolves.toEqual({
      ok: true,
      organizationId: "org-7",
    });
    expect(asked).toEqual([
      {
        userId: "user-1",
        connector: SHARED_INTEGRATION_CONNECTORS.browser,
        operation: "read",
      },
    ]);
  });

  it("refuses without naming a reason when the caller is outside the Organization", async () => {
    const { access } = fakeAccess(async () => ({
      allowed: false,
      code: "TENANT_MEMBERSHIP_REQUIRED",
      member: false,
    }));
    await expect(createBrowserSessionTenantResolver(access).resolveSessionOrganization("user-1")).resolves.toEqual({
      ok: false,
    });
  });

  it("refuses when the check itself could not be made", async () => {
    const { access } = fakeAccess(async () => {
      throw new Error("database is down");
    });
    await expect(createBrowserSessionTenantResolver(access).resolveSessionOrganization("user-1")).resolves.toEqual({
      ok: false,
    });
  });

  it("asks the browser connection, never a connection named in the call", async () => {
    const { access, asked } = fakeAccess(async () => ({
      allowed: true,
      tenantId: "org-7",
      role: "owner",
    }));
    await createBrowserSessionTenantResolver(access).resolveSessionOrganization("user-1");
    expect(asked[0].connector).toEqual(SHARED_INTEGRATION_CONNECTORS.browser);
    // A viewer may read a shared connection; the session that follows is still
    // bounded by the tools' own write approvals.
    expect(asked[0].operation).toBe("read");
  });
});

describe("browsing switch", () => {
  it("separates 'may browse' from 'has a local Chromium'", () => {
    expect(isBrowserEnabled({ BROWSER_ENABLED: "true" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isBrowserEnabled({ BROWSER_ENABLED: "TRUE" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isBrowserEnabled({} as NodeJS.ProcessEnv)).toBe(false);

    // Phase 19.2: a deployment with a browser service and no local Chrome is
    // enabled but not locally configured. The old predicate still asks both.
    expect(
      isBrowserConfigured({
        BROWSER_ENABLED: "true",
        CHROME_PATH: "/definitely/not/a/browser",
      } as NodeJS.ProcessEnv)
    ).toBe(false);
  });
});

describe("container wiring for the browser service", () => {
  it("selects the remote runtime through the same tools and the same port", () => {
    expect(CONTAINER_SOURCE).toContain("readBrowserServiceEndpoint()");
    expect(CONTAINER_SOURCE).toContain("new RemoteBrowserRuntime(");
    expect(CONTAINER_SOURCE).toContain("createBrowserSessionTenantResolver(sharedAccess)");
    expect(CONTAINER_SOURCE).toContain(
      "createBrowserTools(runtime, browserJournal, approvalConsumption, browserWriteScope)"
    );
    // One local construction, unchanged: the remote branch must not add a
    // second way to build an in-process browser.
    expect(CONTAINER_SOURCE.match(/new BrowserRuntime\(/g) ?? []).toHaveLength(1);
    expect(CONTAINER_SOURCE).toContain("getBrowserRuntime(): BrowserRuntimePort | null");
  });

  it("registers nothing when the browser-service configuration is unusable", () => {
    const start = CONTAINER_SOURCE.indexOf('browserService.state === "invalid"');
    const end = CONTAINER_SOURCE.indexOf('browserService.state === "ready"');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const invalidBranch = CONTAINER_SOURCE.slice(start, end);
    expect(invalidBranch).toContain("browser_registration_skipped");
    // No tool, no runtime, and — the point of the branch — no fallback.
    expect(invalidBranch).not.toContain("registry.register(");
    expect(invalidBranch).not.toContain("new BrowserRuntime(");
    expect(invalidBranch).not.toContain("new RemoteBrowserRuntime(");
  });

  it("keeps the remote runtime behind the same opt-in as the local one", () => {
    const disabled = CONTAINER_SOURCE.indexOf("if (!isBrowserEnabled())");
    const remote = CONTAINER_SOURCE.indexOf('browserService.state === "ready"');
    expect(disabled).toBeGreaterThan(-1);
    expect(remote).toBeGreaterThan(disabled);
  });
});
