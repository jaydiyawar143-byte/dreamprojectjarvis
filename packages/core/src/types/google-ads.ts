import { z } from "zod";

// ---------------------------------------------------------------------------
// Google Ads domain types (Sprint 5.2)
// ---------------------------------------------------------------------------
// Deliberately mirrors the shape of types/meta-ads.ts so the two marketing
// providers stay symmetrical for the aggregation layers above them. Google
// reports money in "micros" (1/1,000,000 of the account currency); every value
// crossing this boundary is already normalised to a decimal string so no
// downstream consumer has to know that.
// ---------------------------------------------------------------------------

export const GOOGLE_ADS_CUSTOMER_ID_PATTERN = /^\d{10}$/;

export interface GoogleAdsCustomer {
  /** 10-digit customer id, dashes stripped. */
  customerId: string;
  descriptiveName: string;
  currencyCode: string;
  timeZone: string;
  /** True for manager (MCC) accounts, which hold no campaigns of their own. */
  isManager: boolean;
  isTestAccount: boolean;
}

export type GoogleAdsCampaignStatus = "ENABLED" | "PAUSED" | "REMOVED" | "UNKNOWN";

export interface GoogleAdsCampaign {
  campaignId: string;
  name: string;
  status: GoogleAdsCampaignStatus;
  advertisingChannelType: string;
  startDate?: string;
  endDate?: string;
  /** Decimal string in account currency, converted from micros. */
  budgetAmount?: string;
}

export interface GoogleAdsMetrics {
  campaignId?: string;
  campaignName?: string;
  date?: string;
  impressions: number;
  clicks: number;
  /** Decimal string in account currency, converted from micros. */
  cost: string;
  conversions: number;
  /** Decimal string; Google returns conversion value in the account currency. */
  conversionValue: string;
  ctr?: number;
  averageCpc?: string;
}

export interface GoogleAdsDateRange {
  since: string; // YYYY-MM-DD
  until: string; // YYYY-MM-DD
}

export const GoogleAdsDateRangeSchema = z.object({
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

// ---------------------------------------------------------------------------
// Connection record — what the API layer may see
// ---------------------------------------------------------------------------
// NOTE the absence of token fields. Nothing above the repository is ever handed
// an access or refresh token; that is enforced by this type, not by convention.
// ---------------------------------------------------------------------------

export interface GoogleConnectionSummary {
  id: string;
  userId: string;
  googleAccountEmail: string;
  scopes: string[];
  connectedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

/** Decrypted credential material. Repository-internal and provider-internal only. */
export interface GoogleCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scopes: string[];
}

export interface IGoogleConnectionRepository {
  /** Upserts the connection for (userId, googleAccountEmail). Encrypts on write. */
  save(input: {
    userId: string;
    googleAccountEmail: string;
    scopes: string[];
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
  }): Promise<GoogleConnectionSummary>;

  /** Summary only — never carries token material. */
  findByUser(userId: string): Promise<GoogleConnectionSummary | null>;

  /** Decrypted credentials for server-side use. Returns null when revoked/absent. */
  getCredentials(userId: string): Promise<GoogleCredentials | null>;

  /** Replaces the access token after a refresh, preserving the refresh token. */
  updateAccessToken(userId: string, accessToken: string, expiresAt: Date): Promise<void>;

  revoke(userId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// OAuth state — CSRF + PKCE, single use
// ---------------------------------------------------------------------------

export interface OAuthStateRecord {
  state: string;
  userId: string;
  codeVerifier: string;
  redirectUri: string;
  expiresAt: Date;
}

export interface IOAuthStateRepository {
  create(record: OAuthStateRecord): Promise<void>;
  /** Atomically consumes the state; a second call for the same state returns null. */
  consume(state: string): Promise<OAuthStateRecord | null>;
  deleteExpired(now: Date): Promise<number>;
}
