// PHASE 10.5 — Meta campaign reconciliation matcher.
// Mocked provider only (NO real Meta calls). Proves the correlation rules:
// single-candidate FOUND, authoritative NOT_FOUND, and every ambiguity path
// degrading to UNCERTAIN / PROVIDER_ERROR — a timeout or 5xx must NEVER be
// interpreted as NOT_FOUND, and name collisions must never produce FOUND.
import { describe, it, expect } from "vitest";
import { MetaCampaignReconciler } from "../src/reconciler.js";
import { MetaRequestAbortedError } from "../src/client.js";
import { JarvisError } from "@jarvis/core";
import type { ReconciliationEvidence } from "@jarvis/core";

interface CampaignRow {
  campaignId: string;
  name: string;
  status: string;
  objective?: string;
  dailyBudget?: string;
  lifetimeBudget?: string;
  buyingType?: string;
  createdAt?: string;
}

type Page = { data: CampaignRow[]; nextPage?: string };

function makeProvider(
  handler: (
    accountId: string,
    pagination: { limit?: number; after?: string }
  ) => Promise<Page>
) {
  const calls: Array<{ accountId: string; pagination: { limit?: number; after?: string } }> = [];
  return {
    calls,
    provider: {
      async getCampaigns(
        accountId: string,
        pagination: { limit?: number; after?: string }
      ): Promise<Page> {
        calls.push({ accountId, pagination });
        return handler(accountId, pagination);
      },
    },
  };
}

function campaign(overrides: Partial<CampaignRow> = {}): CampaignRow {
  return {
    campaignId: "cmp_match_1",
    name: "Summer Sale",
    status: "PAUSED",
    objective: "OUTCOME_SALES",
    createdAt: "2026-08-22T10:02:30Z",
    ...overrides,
  };
}

const BASE_EVIDENCE: ReconciliationEvidence = {
  executionId: "exec-1",
  userId: "user-1",
  toolId: "meta.campaign.create",
  provider: "meta-ads",
  idempotencyKey: "meta.campaign.create:act_111:proposal:Summer Sale:OUTCOME_SALES",
  paramsHash: "hash-123",
  accountId: "act_111",
  resource: { kind: "campaign", name: "Summer Sale", objective: "OUTCOME_SALES" },
  createdAfter: new Date("2026-08-22T10:00:00Z"),
  createdBefore: new Date("2026-08-22T10:05:00Z"),
};

function makeReconciler(
  provider: unknown,
  configuredAccountId = "act_111"
): MetaCampaignReconciler {
  return new MetaCampaignReconciler(
    { provider: provider as never },
    { configuredAccountId, timeSkewMs: 30_000 }
  );
}

describe("Phase 10.5 — Meta campaign reconciliation", () => {
  it("FOUND: exactly one candidate matching all criteria is authoritative", async () => {
    const { provider } = makeProvider(async () => ({ data: [campaign()] }));
    const result = await makeReconciler(provider).reconcile(BASE_EVIDENCE);
    expect(result.outcome).toBe("FOUND");
    expect(result.authoritative).toBe(true);
    expect(result.externalResourceId).toBe("cmp_match_1");
    expect(result.reasonCode).toBe("MATCHED_SINGLE_CANDIDATE");
  });

  it("queries ONLY the configured account derived from durable evidence", async () => {
    const { provider, calls } = makeProvider(async () => ({
      data: [campaign()],
    }));
    await makeReconciler(provider).reconcile(BASE_EVIDENCE);
    expect(calls.length).toBe(1);
    expect(calls[0]!.accountId).toBe("act_111");
  });

  it("NOT_FOUND: complete scan with zero candidates is authoritative absence", async () => {
    const { provider } = makeProvider(async () => ({
      data: [campaign({ name: "Other Campaign", campaignId: "cmp_x" })],
    }));
    const result = await makeReconciler(provider).reconcile(BASE_EVIDENCE);
    expect(result.outcome).toBe("NOT_FOUND");
    expect(result.authoritative).toBe(true);
    expect(result.reasonCode).toBe("NO_CANDIDATES");
  });

  it("UNCERTAIN: two same-name candidates in window refuse to guess (collision)", async () => {
    const { provider } = makeProvider(async () => ({
      data: [
        campaign({ campaignId: "cmp_a" }),
        campaign({ campaignId: "cmp_b", createdAt: "2026-08-22T10:03:30Z" }),
      ],
    }));
    const result = await makeReconciler(provider).reconcile(BASE_EVIDENCE);
    expect(result.outcome).toBe("UNCERTAIN");
    expect(result.reasonCode).toBe("MULTIPLE_CANDIDATES");
    expect(result.externalResourceId).toBeUndefined();
  });

  it("same-name campaign OUTSIDE the correlation window does not match", async () => {
    const { provider } = makeProvider(async () => ({
      data: [campaign({ createdAt: "2025-01-01T00:00:00Z", campaignId: "cmp_old" })],
    }));
    const result = await makeReconciler(provider).reconcile(BASE_EVIDENCE);
    expect(result.outcome).toBe("NOT_FOUND");
    expect(result.externalResourceId).toBeUndefined();
  });

  it("same-name campaign with different objective does not match", async () => {
    const { provider } = makeProvider(async () => ({
      data: [campaign({ objective: "OUTCOME_TRAFFIC" })],
    }));
    const result = await makeReconciler(provider).reconcile(BASE_EVIDENCE);
    expect(result.outcome).toBe("NOT_FOUND");
  });

  it("same-name campaign with different daily budget does not match", async () => {
    const evidence = {
      ...BASE_EVIDENCE,
      resource: { ...BASE_EVIDENCE.resource, dailyBudgetCents: "5000" },
    };
    const { provider } = makeProvider(async () => ({
      data: [campaign({ dailyBudget: "9900" })],
    }));
    const result = await makeReconciler(provider).reconcile(evidence);
    expect(result.outcome).toBe("NOT_FOUND");
  });

  it("candidate without verifiable creation timestamp degrades to UNCERTAIN (never NOT_FOUND)", async () => {
    const { provider } = makeProvider(async () => ({
      data: [campaign({ createdAt: undefined })],
    }));
    const result = await makeReconciler(provider).reconcile(BASE_EVIDENCE);
    expect(result.outcome).toBe("UNCERTAIN");
    expect(result.reasonCode).toBe("MALFORMED_RESPONSE");
  });

  it("pagination exhausted before full scan -> UNCERTAIN PARTIAL_PAGE", async () => {
    const reconciler = new MetaCampaignReconciler(
      {
        provider: {
          getCampaigns: async (_a: string, p: { after?: string }) => ({
            data: [campaign({ name: "Unrelated", campaignId: `cmp_${p.after ?? "0"}` })],
            nextPage: `cursor-${Math.random()}`,
          }),
        },
      },
      { configuredAccountId: "act_111", maxPages: 3 }
    );
    const result = await reconciler.reconcile(BASE_EVIDENCE);
    expect(result.outcome).toBe("UNCERTAIN");
    expect(result.reasonCode).toBe("PARTIAL_PAGE");
  });

  it("multi-page scans follow cursors and find the match on page 2", async () => {
    let callCount = 0;
    const reconciler = new MetaCampaignReconciler(
      {
        provider: {
          getCampaigns: async () => {
            callCount++;
            if (callCount === 1) {
              return {
                data: [campaign({ name: "Filler", campaignId: "cmp_f" })],
                nextPage: "cursor-2",
              };
            }
            return { data: [campaign()], nextPage: undefined };
          },
        },
      },
      { configuredAccountId: "act_111" }
    );
    const result = await reconciler.reconcile(BASE_EVIDENCE);
    expect(callCount).toBe(2);
    expect(result.outcome).toBe("FOUND");
    expect(result.externalResourceId).toBe("cmp_match_1");
  });

  it("missing campaign name in evidence refuses before any provider query", async () => {
    const { provider, calls } = makeProvider(async () => ({ data: [] }));
    const result = await makeReconciler(provider).reconcile({
      ...BASE_EVIDENCE,
      resource: { kind: "campaign" },
    });
    expect(result.outcome).toBe("UNCERTAIN");
    expect(result.reasonCode).toBe("INSUFFICIENT_EVIDENCE");
    expect(calls.length).toBe(0);
  });

  it("account mismatch between evidence and configured account is refused pre-query", async () => {
    const { provider, calls } = makeProvider(async () => ({ data: [campaign()] }));
    const result = await makeReconciler(provider, "act_999").reconcile(BASE_EVIDENCE);
    expect(result.outcome).toBe("PROVIDER_ERROR");
    expect(result.reasonCode).toBe("ACCOUNT_MISMATCH");
    expect(calls.length).toBe(0);
  });

  it("rate limit is UNCERTAIN — never NOT_FOUND", async () => {
    const { provider } = makeProvider(async () => {
      throw new JarvisError("RATE_LIMITED", "application rate limit exceeded");
    });
    const result = await makeReconciler(provider).reconcile(BASE_EVIDENCE);
    expect(result.outcome).toBe("UNCERTAIN");
    expect(result.reasonCode).toBe("RATE_LIMITED");
    expect(result.authoritative).toBe(false);
  });

  it("timeout is UNCERTAIN — never NOT_FOUND", async () => {
    const { provider } = makeProvider(async () => {
      throw new JarvisError("TOOL_TIMEOUT", "request timed out");
    });
    const result = await makeReconciler(provider).reconcile(BASE_EVIDENCE);
    expect(result.outcome).toBe("UNCERTAIN");
    expect(result.reasonCode).toBe("TIMEOUT");
  });

  it("Meta 5xx is PROVIDER_ERROR — never NOT_FOUND", async () => {
    const { provider } = makeProvider(async () => {
      throw new JarvisError("INTERNAL_ERROR", "internal server error");
    });
    const result = await makeReconciler(provider).reconcile(BASE_EVIDENCE);
    expect(result.outcome).toBe("PROVIDER_ERROR");
    expect(result.reasonCode).toBe("PROVIDER_INTERNAL_ERROR");
  });

  it("authentication failure is PROVIDER_ERROR — never NOT_FOUND", async () => {
    const { provider } = makeProvider(async () => {
      throw new JarvisError("AUTHENTICATION_REQUIRED", "access token expired access_token=EAASECRETVALUE");
    });
    const result = await makeReconciler(provider).reconcile(BASE_EVIDENCE);
    expect(result.outcome).toBe("PROVIDER_ERROR");
    expect(result.reasonCode).toBe("AUTHENTICATION_FAILED");
    expect(result.detail).not.toContain("EAASECRETVALUE");
  });

  it("authorization failure is PROVIDER_ERROR — never NOT_FOUND", async () => {
    const { provider } = makeProvider(async () => {
      throw new JarvisError("AUTHORIZATION_FAILED", "not authorized for account");
    });
    const result = await makeReconciler(provider).reconcile(BASE_EVIDENCE);
    expect(result.outcome).toBe("PROVIDER_ERROR");
    expect(result.reasonCode).toBe("AUTHORIZATION_FAILED");
  });

  it("malformed/invalid request response is UNCERTAIN", async () => {
    const { provider } = makeProvider(async () => {
      throw new JarvisError("INVALID_REQUEST", "malformed response body");
    });
    const result = await makeReconciler(provider).reconcile(BASE_EVIDENCE);
    expect(result.outcome).toBe("UNCERTAIN");
    expect(result.reasonCode).toBe("MALFORMED_RESPONSE");
  });

  it("transport abort is UNCERTAIN NETWORK_FAILURE — never NOT_FOUND", async () => {
    const { provider } = makeProvider(async () => {
      throw new MetaRequestAbortedError("in-flight", "GET");
    });
    const result = await makeReconciler(provider).reconcile(BASE_EVIDENCE);
    expect(result.outcome).toBe("UNCERTAIN");
    expect(result.reasonCode).toBe("NETWORK_FAILURE");
  });

  it("raw network failure is UNCERTAIN — never NOT_FOUND", async () => {
    const { provider } = makeProvider(async () => {
      throw new Error("fetch failed");
    });
    const result = await makeReconciler(provider).reconcile(BASE_EVIDENCE);
    expect(result.outcome).toBe("UNCERTAIN");
    expect(result.reasonCode).toBe("NETWORK_FAILURE");
  });
});
