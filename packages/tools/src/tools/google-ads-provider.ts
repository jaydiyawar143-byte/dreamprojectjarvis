import type {
  GoogleAdsCustomer,
  GoogleAdsCampaign,
  GoogleAdsMetrics,
  GoogleAdsDateRange,
} from "@jarvis/core";
import type { ProviderCallOptions } from "./meta-ads-provider.js";

// ---------------------------------------------------------------------------
// GoogleAdsProvider — READ-ONLY interface for the Google Ads API (Sprint 5.2)
// ---------------------------------------------------------------------------
// Deliberately shaped like MetaAdsProvider in ./meta-ads-provider.ts, with the
// same two invariants:
//
//   - Implementations must NEVER expose credentials to callers.
//   - The provider is the ONLY boundary to the Google Ads API.
//
// One structural difference from Meta: every method takes `userId` first.
// Meta uses a single server-configured token, so its provider needs no user;
// Google credentials are per-user OAuth grants, so the user is what selects the
// credential. Passing it explicitly makes it impossible to call the API without
// having decided whose connection is being used.
//
// There is no write counterpart to this interface in Sprint 5.2. Adding one
// must also route through ToolApprovalService, as the Meta write tools do.
// ---------------------------------------------------------------------------

export interface GoogleAdsProvider {
  /** Accounts reachable through this user's connection. */
  getAccessibleCustomers(
    userId: string,
    options?: ProviderCallOptions
  ): Promise<GoogleAdsCustomer[]>;

  /** Campaigns for one customer. */
  getCampaigns(
    userId: string,
    customerId: string,
    options?: ProviderCallOptions
  ): Promise<GoogleAdsCampaign[]>;

  /** Performance metrics over a date range; `daily` segments by date. */
  getMetrics(
    userId: string,
    customerId: string,
    dateRange: GoogleAdsDateRange,
    options?: ProviderCallOptions & { daily?: boolean }
  ): Promise<GoogleAdsMetrics[]>;
}

// ---------------------------------------------------------------------------
// GoogleAccountAuthorizer — server-side account access control
// ---------------------------------------------------------------------------
// Mirrors MetaAccountAuthorizer. Determines which Google Ads customers a user
// may access. Never trust client-provided customer IDs.
// ---------------------------------------------------------------------------

export interface GoogleAccountAuthorizer {
  getAuthorizedCustomerIds(userId: string, options?: ProviderCallOptions): Promise<string[]>;
  isAuthorized(
    userId: string,
    customerId: string,
    options?: ProviderCallOptions
  ): Promise<boolean>;
}
