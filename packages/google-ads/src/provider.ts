import type {
  GoogleAdsCustomer,
  GoogleAdsCampaign,
  GoogleAdsMetrics,
  GoogleAdsDateRange,
  IGoogleConnectionRepository,
} from "@jarvis/core";
import type {
  GoogleAdsProvider,
  GoogleAccountAuthorizer,
  ProviderCallOptions,
} from "@jarvis/tools";
import { createGoogleAdsHttpClient, isSuccessResponse, extractError, type GoogleAdsHttpClient } from "./client.js";
import { normalizeCustomerId, type GoogleConfig } from "./config.js";
import { toJarvisError } from "./error-handler.js";
import { refreshAccessToken, type FetchLike } from "./oauth.js";
import { parseCustomer, parseCampaign, parseMetrics, extractRows } from "./response-validator.js";

// ---------------------------------------------------------------------------
// GoogleAdsGraphProvider (Sprint 5.2) — READ-ONLY
// ---------------------------------------------------------------------------
// The only boundary to the Google Ads API, mirroring the contract stated in
// packages/tools/src/tools/meta-ads-provider.ts: implementations must NEVER
// expose credentials to their callers.
//
// This class deliberately implements no mutating operation. Google's `adwords`
// scope is not separable into read and write, so read-only is enforced here in
// our own code: there is no method that writes, and every query is a GAQL
// SELECT. Adding a write later must go through the approval boundary in
// ToolApprovalService, exactly as the Meta write tools do.
//
// Token lifecycle is handled here rather than in each tool: callers pass a
// userId, and the provider resolves credentials, refreshes them when they are
// near expiry, and persists the new access token. A tool never sees a token.
// ---------------------------------------------------------------------------

/** Refresh this long before actual expiry, so a call cannot expire mid-flight. */
const REFRESH_SKEW_MS = 60_000;

export interface GoogleAdsProviderConfig {
  config: GoogleConfig;
  connections: IGoogleConnectionRepository;
  httpClient?: GoogleAdsHttpClient;
  /** Injected in tests so no network call is made. */
  fetchImpl?: FetchLike;
  now?: () => Date;
}

/** GAQL string literals are single-quoted; dates are validated before use. */
function assertSafeDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid ${field}: expected YYYY-MM-DD`);
  }
  return value;
}

export class GoogleAdsGraphProvider implements GoogleAdsProvider, GoogleAccountAuthorizer {
  private readonly config: GoogleConfig;
  private readonly connections: IGoogleConnectionRepository;
  private readonly http: GoogleAdsHttpClient;
  private readonly fetchImpl?: FetchLike;
  private readonly now: () => Date;

  constructor(opts: GoogleAdsProviderConfig) {
    this.config = opts.config;
    this.connections = opts.connections;
    this.http = opts.httpClient ?? createGoogleAdsHttpClient(opts.config);
    this.fetchImpl = opts.fetchImpl;
    this.now = opts.now ?? (() => new Date());
  }

  // -------------------------------------------------------------------------
  // Credential resolution — private, never returns to a caller
  // -------------------------------------------------------------------------

  private async accessTokenFor(userId: string): Promise<string> {
    const creds = await this.connections.getCredentials(userId);
    if (!creds) {
      throw toJarvisError({
        code: "AUTHENTICATION_REQUIRED",
        retryable: false,
        message: "No active Google connection for this user",
      });
    }

    const expiresSoon = creds.expiresAt.getTime() - this.now().getTime() <= REFRESH_SKEW_MS;
    if (!expiresSoon) return creds.accessToken;

    // Expired or nearly so — exchange the refresh token. A failure here is an
    // authentication failure the user must resolve by reconnecting; it is never
    // retried silently against Google.
    const refreshed = await refreshAccessToken(
      this.config,
      creds.refreshToken,
      this.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
    );
    await this.connections.updateAccessToken(userId, refreshed.accessToken, refreshed.expiresAt);
    return refreshed.accessToken;
  }

  private async runQuery(
    userId: string,
    customerId: string,
    query: string,
    options?: ProviderCallOptions
  ): Promise<unknown[]> {
    const accessToken = await this.accessTokenFor(userId);
    const response = await this.http.search({
      customerId,
      query,
      accessToken,
      signal: options?.signal,
    });

    if (!isSuccessResponse(response)) {
      throw toJarvisError(extractError(response));
    }
    return extractRows(response.body);
  }

  // -------------------------------------------------------------------------
  // GoogleAccountAuthorizer — server-side account access control
  // -------------------------------------------------------------------------
  // Never trust a client-provided customer id. The authoritative list is the
  // set of accounts reachable by the user's OWN connection, so one user cannot
  // read another's Google data by guessing a customer id.
  // -------------------------------------------------------------------------

  async getAuthorizedCustomerIds(userId: string, options?: ProviderCallOptions): Promise<string[]> {
    const customers = await this.getAccessibleCustomers(userId, options);
    return customers.map((c) => c.customerId);
  }

  async isAuthorized(
    userId: string,
    customerId: string,
    options?: ProviderCallOptions
  ): Promise<boolean> {
    let normalized: string;
    try {
      normalized = normalizeCustomerId(customerId);
    } catch {
      return false;
    }
    const allowed = await this.getAuthorizedCustomerIds(userId, options);
    return allowed.includes(normalized);
  }

  // -------------------------------------------------------------------------
  // Read operations
  // -------------------------------------------------------------------------

  async getAccessibleCustomers(
    userId: string,
    options?: ProviderCallOptions
  ): Promise<GoogleAdsCustomer[]> {
    const loginCustomerId = this.config.loginCustomerId;
    if (!loginCustomerId) {
      // Without a manager account there is exactly one reachable customer and
      // Google has no endpoint to enumerate it via search; the caller must
      // configure GOOGLE_ADS_LOGIN_CUSTOMER_ID for multi-account access.
      throw toJarvisError({
        code: "INVALID_REQUEST",
        retryable: false,
        message:
          "GOOGLE_ADS_LOGIN_CUSTOMER_ID must be configured to enumerate accessible Google Ads accounts",
      });
    }

    const query = [
      "SELECT customer_client.id, customer_client.descriptive_name,",
      "customer_client.currency_code, customer_client.time_zone,",
      "customer_client.manager, customer_client.test_account",
      "FROM customer_client",
      "WHERE customer_client.status = 'ENABLED'",
    ].join(" ");

    const rows = await this.runQuery(userId, loginCustomerId, query, options);
    return rows.map((row) => {
      const r = row as { customerClient?: unknown };
      return parseCustomer(r.customerClient ?? row);
    });
  }

  async getCampaigns(
    userId: string,
    customerId: string,
    options?: ProviderCallOptions
  ): Promise<GoogleAdsCampaign[]> {
    const normalized = normalizeCustomerId(customerId);
    const query = [
      "SELECT campaign.id, campaign.name, campaign.status,",
      "campaign.advertising_channel_type, campaign.start_date, campaign.end_date,",
      "campaign_budget.amount_micros",
      "FROM campaign",
      "WHERE campaign.status != 'REMOVED'",
      "ORDER BY campaign.id",
    ].join(" ");

    const rows = await this.runQuery(userId, normalized, query, options);
    return rows.map(parseCampaign);
  }

  async getMetrics(
    userId: string,
    customerId: string,
    dateRange: GoogleAdsDateRange,
    options?: ProviderCallOptions & { daily?: boolean }
  ): Promise<GoogleAdsMetrics[]> {
    const normalized = normalizeCustomerId(customerId);
    const since = assertSafeDate(dateRange.since, "since");
    const until = assertSafeDate(dateRange.until, "until");

    const fields = [
      "campaign.id",
      "campaign.name",
      "metrics.impressions",
      "metrics.clicks",
      "metrics.cost_micros",
      "metrics.conversions",
      "metrics.conversions_value",
      "metrics.ctr",
      "metrics.average_cpc",
    ];
    if (options?.daily) fields.push("segments.date");

    const query = [
      `SELECT ${fields.join(", ")}`,
      "FROM campaign",
      `WHERE segments.date BETWEEN '${since}' AND '${until}'`,
      "AND campaign.status != 'REMOVED'",
    ].join(" ");

    const rows = await this.runQuery(userId, normalized, query, options);
    return rows.map(parseMetrics);
  }
}

export function createGoogleAdsProvider(opts: GoogleAdsProviderConfig): GoogleAdsGraphProvider {
  return new GoogleAdsGraphProvider(opts);
}
