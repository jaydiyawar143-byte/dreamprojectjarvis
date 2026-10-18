// ---------------------------------------------------------------------------
// Phase 17 multi-business hardening (review finding H2) — who may use the
// deployment's Meta connection, and on which account.
//
//   • `SharedConnectionAccess` answers from the owner record and the caller's
//     membership, read on every call; failures refuse.
//   • The access gate allows every tool that uses no shared connection, and
//     answers outsiders with one sentence that names nobody.
//   • The Organization Meta authorizer allows only the configured account, asks
//     the Organization before the token, and gives a write its scope.
//
// Pure doubles: the tenancy is in memory and the token check is a spy.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import { createSharedConnectionToolGate } from "../src/services/tenancy/shared-connection-access.js";
import { createOrganizationMetaAuthorizer, metaAccountFor, metaAvailability, normalizeMetaAccountId } from "../src/services/tenancy/meta-ads-access.js";
import { accessOver, memoryTenancy } from "./helpers/shared-access.js";

const ORG = "org-a";
const ACCOUNT = "act_111111111";

function tenancy() {
  return memoryTenancy({
    owners: { "meta/ads": ORG },
    members: [
      { userId: "owner-1", tenantId: ORG, role: "owner" },
      { userId: "admin-1", tenantId: ORG, role: "admin" },
      { userId: "member-1", tenantId: ORG, role: "member" },
      { userId: "viewer-1", tenantId: ORG, role: "viewer" },
      { userId: "outsider-1", tenantId: "org-b", role: "owner" },
    ],
  });
}

function authorizer(t = tenancy()) {
  const token = {
    getAuthorizedAccountIds: vi.fn(async () => [ACCOUNT, "act_222222222"]),
    // The token reaches more accounts than the Organization's one.
    isAuthorized: vi.fn(async () => true),
  };
  return { meta: createOrganizationMetaAuthorizer({ provider: token, access: accessOver(t), configuredAccountId: ACCOUNT }), token, t };
}

describe("SharedConnectionAccess — read now, from the owner record and the membership", () => {
  it("allows a member's read and refuses their write; allows an admin's write", async () => {
    const access = accessOver(tenancy());
    const meta = { providerId: "meta", connector: "ads" };
    expect(await access.check("member-1", meta, "read")).toMatchObject({ allowed: true, tenantId: ORG, role: "member" });
    expect(await access.check("member-1", meta, "write")).toMatchObject({ allowed: false, code: "PERMISSION_DENIED", member: true });
    expect(await access.check("admin-1", meta, "write")).toMatchObject({ allowed: true, tenantId: ORG });
  });

  it("refuses an outsider and, while nobody owns it, everyone — as one kind of refusal", async () => {
    const t = tenancy();
    const access = accessOver(t);
    const meta = { providerId: "meta", connector: "ads" };
    expect(await access.check("outsider-1", meta, "read")).toMatchObject({ allowed: false, member: false });
    t.setOwner("meta", "ads", null);
    expect(await access.check("owner-1", meta, "read")).toMatchObject({ allowed: false, code: "RESOURCE_OWNERSHIP_MISSING", member: false });
  });

  it("applies a removed membership to the very next call", async () => {
    const t = tenancy();
    const access = accessOver(t);
    const meta = { providerId: "meta", connector: "ads" };
    expect((await access.check("admin-1", meta, "write")).allowed).toBe(true);
    t.setRole("admin-1", ORG, null);
    expect((await access.check("admin-1", meta, "write")).allowed).toBe(false);
  });

  it("refuses — AUTHORIZATION_UNAVAILABLE — when ownership or membership cannot be read", async () => {
    const t = tenancy();
    t.setFailing(true);
    expect(await accessOver(t).check("owner-1", { providerId: "meta", connector: "ads" }, "read")).toEqual({
      allowed: false,
      code: "AUTHORIZATION_UNAVAILABLE",
      member: false,
    });
  });
});

describe("the access gate", () => {
  it("allows every tool that uses no shared connection, without reading anything", async () => {
    const t = tenancy();
    const gate = createSharedConnectionToolGate(accessOver(t));
    expect(await gate.check({ toolId: "whatsapp.send", userId: "outsider-1" })).toEqual({ allowed: true });
    expect(await gate.check({ toolId: "memory.forget", userId: "outsider-1" })).toEqual({ allowed: true });
    expect(t.reads).toEqual({ owners: 0, memberships: 0 });
  });

  it("answers an outsider with one sentence that names nobody, read or write", async () => {
    const gate = createSharedConnectionToolGate(accessOver(tenancy()));
    for (const toolId of ["meta.insights", "meta.campaign.pause"]) {
      expect(await gate.check({ toolId, userId: "outsider-1" })).toEqual({
        allowed: false,
        reason: "Meta Ads is not available to your account.",
      });
    }
  });

  it("tells a member what their role does not allow", async () => {
    const gate = createSharedConnectionToolGate(accessOver(tenancy()));
    expect(await gate.check({ toolId: "meta.insights", userId: "viewer-1" })).toEqual({ allowed: true });
    const write = await gate.check({ toolId: "meta.campaign.budget.update", userId: "member-1" });
    expect(write.allowed).toBe(false);
    expect(!write.allowed && write.reason).toMatch(/does not allow changes through Meta Ads/);
  });
});

describe("the Organization Meta authorizer", () => {
  it("allows only the configured account — never another the token can also see", async () => {
    const { meta } = authorizer();
    expect(await meta.isAuthorized("member-1", ACCOUNT)).toBe(true);
    expect(await meta.isAuthorized("member-1", "111111111")).toBe(true);
    expect(await meta.isAuthorized("member-1", "act_222222222")).toBe(false);
    expect(await meta.getAuthorizedAccountIds("member-1")).toEqual([ACCOUNT]);
  });

  it("asks the Organization before the token, and does not ask the token for an outsider", async () => {
    const { meta, token } = authorizer();
    expect(await meta.isAuthorized("outsider-1", ACCOUNT)).toBe(false);
    expect(await meta.getAuthorizedAccountIds("outsider-1")).toEqual([]);
    const write = await meta.authorizeWrite("outsider-1", ACCOUNT);
    expect(write).toEqual({ allowed: false, reason: "Meta Ads is not available to your account." });
    expect(token.isAuthorized).not.toHaveBeenCalled();
    expect(token.getAuthorizedAccountIds).not.toHaveBeenCalled();
  });

  it("gives an admin's write the scope the approval store re-checks", async () => {
    const { meta } = authorizer();
    expect(await meta.authorizeWrite("admin-1", ACCOUNT)).toEqual({
      allowed: true,
      tenantScope: { tenantId: ORG, providerId: "meta", connector: "ads", requesterRoles: ["owner", "admin"], approverRoles: ["owner", "admin"] },
    });
  });

  it("refuses a member's or a viewer's write, and a write on another account", async () => {
    const { meta } = authorizer();
    for (const userId of ["member-1", "viewer-1"]) {
      const write = await meta.authorizeWrite(userId, ACCOUNT);
      expect(write.allowed, userId).toBe(false);
    }
    const elsewhere = await meta.authorizeWrite("admin-1", "act_222222222");
    expect(elsewhere).toEqual({ allowed: false, reason: "That ad account is not your organization's Meta Ads account." });
  });

  it("refuses when the token itself cannot reach the account", async () => {
    const { meta, token } = authorizer();
    token.isAuthorized.mockResolvedValue(false);
    expect(await meta.isAuthorized("admin-1", ACCOUNT)).toBe(false);
    expect((await meta.authorizeWrite("admin-1", ACCOUNT)).allowed).toBe(false);
  });

  it("allows nothing when the configured account is not a valid id", async () => {
    const t = tenancy();
    const meta = createOrganizationMetaAuthorizer({
      provider: { getAuthorizedAccountIds: async () => [ACCOUNT], isAuthorized: async () => true },
      access: accessOver(t),
      configuredAccountId: "not-an-account",
    });
    expect(await meta.isAuthorized("owner-1", "not-an-account")).toBe(false);
    expect(await meta.getAuthorizedAccountIds("owner-1")).toEqual([]);
    expect((await meta.authorizeWrite("owner-1", "not-an-account")).allowed).toBe(false);
  });

  it("normalizes ids the way the tools write them", () => {
    expect(normalizeMetaAccountId("111111111")).toBe(ACCOUNT);
    expect(normalizeMetaAccountId(` ${ACCOUNT} `)).toBe(ACCOUNT);
    for (const bad of ["act_", "act_12", "abc", "", 42, null]) expect(normalizeMetaAccountId(bad)).toBeNull();
  });
});

describe("metaAvailability — what the Meta pages may say", () => {
  it("is available to every member, unavailable to outsiders and without an access reader, unverified on failure", async () => {
    const t = tenancy();
    expect(await metaAvailability(accessOver(t), "viewer-1")).toBe("available");
    expect(await metaAvailability(accessOver(t), "outsider-1")).toBe("unavailable");
    expect(await metaAvailability(undefined, "owner-1")).toBe("unavailable");
    t.setFailing(true);
    expect(await metaAvailability(accessOver(t), "owner-1")).toBe("unverified");
  });
});

describe("metaAccountFor — the ad account a marketing report may name", () => {
  it("names it to a member, and to nobody else — as a deployment without Meta would", async () => {
    const t = tenancy();
    expect(await metaAccountFor(accessOver(t), "viewer-1", ACCOUNT)).toBe(ACCOUNT);
    expect(await metaAccountFor(accessOver(t), "outsider-1", ACCOUNT)).toBeNull();
    expect(await metaAccountFor(undefined, "owner-1", ACCOUNT)).toBeNull();
  });

  it("asks nothing when the deployment has no ad account", async () => {
    const t = tenancy();
    expect(await metaAccountFor(accessOver(t), "owner-1", null)).toBeNull();
    expect(await metaAccountFor(accessOver(t), "owner-1", undefined)).toBeNull();
    expect(t.reads).toEqual({ owners: 0, memberships: 0 });
  });

  it("throws, rather than answering 'none', when the Organization cannot be checked", async () => {
    const t = tenancy();
    t.setFailing(true);
    await expect(metaAccountFor(accessOver(t), "owner-1", ACCOUNT)).rejects.toThrow(/could not be verified/);
  });
});
