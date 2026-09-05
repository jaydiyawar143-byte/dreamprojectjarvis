import type {
  GoogleAdsCustomer,
  GoogleAdsCampaign,
  GoogleAdsMetrics,
  GoogleAdsDateRange,
} from "@jarvis/core";
import type { ProviderCallOptions } from "./meta-ads-provider.js";
import type { GoogleAdsProvider, GoogleAccountAuthorizer } from "./google-ads-provider.js";

// ---------------------------------------------------------------------------
// MockGoogleAdsProvider (Sprint 5.2)
// ---------------------------------------------------------------------------
// Mirrors meta-ads-mock.ts so Google tests never need real credentials, a
// developer token, or a network. `throwOnCall` reproduces provider failures
// (auth, rate limit, outage) and `delayMs` exercises timeout/cancellation.
//
// Authorization is modelled per user via `authorizedCustomers`, so cross-user
// access can be tested honestly rather than assumed.
// ---------------------------------------------------------------------------

export interface MockGoogleProviderConfig {
  customers?: GoogleAdsCustomer[];
  campaigns?: GoogleAdsCampaign[];
  metrics?: GoogleAdsMetrics[];
  /** userId -> customer ids that user may reach. Absent user = no access. */
  authorizedCustomers?: Record<string, string[]>;
  /** Method name that should reject, e.g. "getCampaigns". */
  throwOnCall?: string;
  /** Error thrown when throwOnCall matches. Defaults to a generic Error. */
  error?: Error;
  delayMs?: number;
}

export const DEFAULT_MOCK_CUSTOMERS: GoogleAdsCustomer[] = [
  {
    customerId: "1234567890",
    descriptiveName: "Test Google Ads Account",
    currencyCode: "USD",
    timeZone: "America/New_York",
    isManager: false,
    isTestAccount: true,
  },
];

export const DEFAULT_MOCK_CAMPAIGNS: GoogleAdsCampaign[] = [
  {
    campaignId: "111",
    name: "Search — Brand",
    status: "ENABLED",
    advertisingChannelType: "SEARCH",
    startDate: "2026-08-01",
    budgetAmount: "50.00",
  },
  {
    campaignId: "222",
    name: "Display — Retargeting",
    status: "PAUSED",
    advertisingChannelType: "DISPLAY",
    startDate: "2026-08-01",
    budgetAmount: "25.00",
  },
];

export const DEFAULT_MOCK_METRICS: GoogleAdsMetrics[] = [
  {
    campaignId: "111",
    campaignName: "Search — Brand",
    impressions: 12000,
    clicks: 480,
    cost: "240.00",
    conversions: 24,
    conversionValue: "1200.00",
    ctr: 0.04,
    averageCpc: "0.50",
  },
  {
    campaignId: "222",
    campaignName: "Display — Retargeting",
    impressions: 50000,
    clicks: 250,
    cost: "125.00",
    conversions: 5,
    conversionValue: "250.00",
    ctr: 0.005,
    averageCpc: "0.50",
  },
];

export class MockGoogleAdsProvider implements GoogleAdsProvider, GoogleAccountAuthorizer {
  readonly calls: { method: string; args: unknown[] }[] = [];

  constructor(private config: MockGoogleProviderConfig = {}) {}

  private async guard(method: string, args: unknown[], options?: ProviderCallOptions) {
    this.calls.push({ method, args });

    if (this.config.delayMs) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, this.config.delayMs);
        options?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("Aborted"));
        });
      });
    }
    if (options?.signal?.aborted) throw new Error("Aborted");
    if (this.config.throwOnCall === method) {
      throw this.config.error ?? new Error(`Mock Google provider failure in ${method}`);
    }
  }

  async getAccessibleCustomers(
    userId: string,
    options?: ProviderCallOptions
  ): Promise<GoogleAdsCustomer[]> {
    await this.guard("getAccessibleCustomers", [userId], options);
    const allowed = this.config.authorizedCustomers?.[userId];
    const all = this.config.customers ?? DEFAULT_MOCK_CUSTOMERS;
    // With no explicit map the mock stays permissive so simple read tests are
    // not obliged to configure authorization; tests that care set the map.
    if (!allowed) return all;
    return all.filter((c) => allowed.includes(c.customerId));
  }

  async getCampaigns(
    userId: string,
    customerId: string,
    options?: ProviderCallOptions
  ): Promise<GoogleAdsCampaign[]> {
    await this.guard("getCampaigns", [userId, customerId], options);
    return this.config.campaigns ?? DEFAULT_MOCK_CAMPAIGNS;
  }

  async getMetrics(
    userId: string,
    customerId: string,
    dateRange: GoogleAdsDateRange,
    options?: ProviderCallOptions & { daily?: boolean }
  ): Promise<GoogleAdsMetrics[]> {
    await this.guard("getMetrics", [userId, customerId, dateRange], options);
    return this.config.metrics ?? DEFAULT_MOCK_METRICS;
  }

  async getAuthorizedCustomerIds(
    userId: string,
    options?: ProviderCallOptions
  ): Promise<string[]> {
    const map = this.config.authorizedCustomers;
    if (map) return map[userId] ?? [];
    const customers = await this.getAccessibleCustomers(userId, options);
    return customers.map((c) => c.customerId);
  }

  async isAuthorized(
    userId: string,
    customerId: string,
    options?: ProviderCallOptions
  ): Promise<boolean> {
    const ids = await this.getAuthorizedCustomerIds(userId, options);
    return ids.includes(customerId.replace(/-/g, ""));
  }
}
