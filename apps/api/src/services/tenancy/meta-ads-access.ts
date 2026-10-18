// ---------------------------------------------------------------------------
// Phase 17 multi-business hardening (review finding H2) — who may use the
// deployment's Meta Ads connection, and on which account.
//
// WHAT CHANGED. The Meta tools used to be given the provider as their account
// authorizer, and the provider ignored the user: anyone signed in could read
// and change any ad account the shared token could see. This authorizer sits
// in front of the provider and answers for the PERSON:
//
//   1. The account must be THE account this deployment gives its Organization
//      — META_AD_ACCOUNT_ID. Another account the token can also see is not
//      the Organization's, so it is refused, whatever the request says.
//   2. The caller must be a member of the Organization that owns the Meta
//      connection, with a role that allows the read or the write
//      (`SharedConnectionAccess`, read from the database on every call).
//   3. Only then is the provider asked whether the token really reaches the
//      account — its own check, unchanged.
//
// A WRITE NAMES ITS SCOPE. `authorizeWrite` returns who may take part in the
// write — the Organization, the roles a requester and an approver must hold —
// and the write tool hands that to the approval store, which re-checks all of
// it in the transaction that consumes the approval. Asked as the write runs,
// after the approval: never only when it was proposed.
//
// Every refusal is a fixed sentence. An outsider is told only that Meta Ads is
// not available to them — never whether it is configured, or for whom.
// ---------------------------------------------------------------------------

import { SHARED_INTEGRATION_CONNECTORS } from "@jarvis/core";
import { sharedWriteScope } from "@jarvis/security";
import type { MetaAccountAuthorizer, ProviderCallOptions } from "@jarvis/tools";
import { sharedRefusalMessage, type SharedConnectionAccessPort } from "./shared-connection-access.js";

const META = SHARED_INTEGRATION_CONNECTORS.meta;
const NAME = "Meta Ads";

/**
 * Phase 17 (review finding L11) — whether the deployment's Meta Ads is
 * available to this caller at all, for the pages that read it (the dashboard,
 * analysis, the opportunity queue). `unavailable` must be answered EXACTLY as
 * a deployment without Meta is answered, so a page never tells an outsider
 * that the operator has a Meta account. Absent access port: unavailable.
 */
export async function metaAvailability(
  access: SharedConnectionAccessPort | undefined,
  userId: string
): Promise<"available" | "unavailable" | "unverified"> {
  if (!access) return "unavailable";
  const decision = await access.check(userId, META, "read");
  if (decision.allowed) return "available";
  return decision.code === "AUTHORIZATION_UNAVAILABLE" ? "unverified" : "unavailable";
}

/**
 * Phase 17 (review finding L11) — the deployment's ad account as THIS caller's
 * marketing report may name it: the configured account for a member of the
 * Organization that owns Meta Ads, and null — what a deployment without Meta
 * answers — for anyone else. Throws when that cannot be checked: "unknown" is
 * never answered as "no", and the report then reads nothing from it.
 */
export async function metaAccountFor(
  access: SharedConnectionAccessPort | undefined,
  userId: string,
  configuredAccountId: string | null | undefined
): Promise<string | null> {
  if (!configuredAccountId) return null;
  const availability = await metaAvailability(access, userId);
  if (availability === "unverified") throw new Error("organization access could not be verified");
  return availability === "available" ? configuredAccountId : null;
}

/** An ad account id as the tools and the provider write it, or null. */
export function normalizeMetaAccountId(accountId: unknown): string | null {
  if (typeof accountId !== "string") return null;
  const trimmed = accountId.trim();
  if (/^act_\d{5,}$/.test(trimmed)) return trimmed;
  if (/^\d{5,}$/.test(trimmed)) return `act_${trimmed}`;
  return null;
}

export function createOrganizationMetaAuthorizer(deps: {
  /** The provider's own check: does the token reach this account? */
  provider: MetaAccountAuthorizer;
  access: SharedConnectionAccessPort;
  /** META_AD_ACCOUNT_ID — the one account the owning Organization may use. */
  configuredAccountId: string;
}): Required<MetaAccountAuthorizer> {
  const configured = normalizeMetaAccountId(deps.configuredAccountId);
  const isTheAccount = (accountId: string) => configured !== null && normalizeMetaAccountId(accountId) === configured;

  return {
    async getAuthorizedAccountIds(userId: string, options?: ProviderCallOptions): Promise<string[]> {
      if (!configured) return [];
      const decision = await deps.access.check(userId, META, "read");
      if (!decision.allowed) return [];
      return (await deps.provider.isAuthorized(userId, configured, options)) ? [configured] : [];
    },

    async isAuthorized(userId: string, accountId: string, options?: ProviderCallOptions): Promise<boolean> {
      if (!isTheAccount(accountId)) return false;
      const decision = await deps.access.check(userId, META, "read");
      if (!decision.allowed) return false;
      return deps.provider.isAuthorized(userId, configured!, options);
    },

    async authorizeWrite(userId: string, accountId: string, options?: ProviderCallOptions) {
      const decision = await deps.access.check(userId, META, "write");
      if (!decision.allowed) return { allowed: false as const, reason: sharedRefusalMessage(NAME, "write", decision) };
      // Checked after the role so that an outsider learns nothing about which
      // account the Organization uses.
      if (!isTheAccount(accountId)) {
        return { allowed: false as const, reason: "That ad account is not your organization's Meta Ads account." };
      }
      if (!(await deps.provider.isAuthorized(userId, configured!, options))) {
        return { allowed: false as const, reason: "Not authorized to access this Meta account" };
      }
      return { allowed: true as const, tenantScope: sharedWriteScope(decision.tenantId, META) };
    },
  };
}
