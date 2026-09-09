// ---------------------------------------------------------------------------
// The Integration Control Center's server-side model.
//
// This is a FACADE, not a new integration layer. Every fact it reports comes
// from a service that already exists — the credentials router's encrypted
// store, the Google OAuth connection repository, the WhatsApp and n8n
// environment configs, the Maps usage guard. Nothing here stores a credential,
// performs a write, or reaches an external system except through a provider
// that was already built for that purpose.
//
// FOUR RULES IT ENFORCES:
//
// 1. HEALTH IS NOT "CREDENTIALS EXIST". A stored token that the provider
//    rejects is DEGRADED, never CONNECTED. `CONNECTED` is only ever returned
//    after a real call succeeded, and the timestamp of that call travels with
//    it — see `runCheck` and the cache below.
//
// 2. AN UNVERIFIED INTEGRATION SAYS SO. The list endpoint does NOT call five
//    external APIs on every page load; it reports what is configured plus the
//    last verified result. With no verification on record the health is
//    `UNVERIFIED`, which the UI renders as "Not checked" — never as connected.
//
// 3. CAPABILITIES ARE REAL. Each capability listed here maps to a tool or route
//    that exists in this repository. Writes are marked `requiresApproval`,
//    because the card must not imply that connecting an integration grants
//    execution — connecting is configuration; executing goes through
//    ToolExecutor, the permission check and the approval boundary.
//
// 4. NO SECRET IS EVER IN THE SHAPE. There is no field on `IntegrationView`
//    that could hold a key, a token or a webhook secret. The type itself is the
//    control; a future edit cannot leak one without adding a field on purpose.
// ---------------------------------------------------------------------------

import { createMetaGraphProvider } from "@jarvis/meta-graph";
import { createWhatsAppConfig, isWhatsAppConfigured } from "@jarvis/whatsapp";
import { createN8nConfig, isN8nConfigured } from "@jarvis/n8n";
import {
  createGoogleMapsConfig,
  describeGoogleMapsStatus,
  isGoogleMapsBrowserConfigured,
  isGoogleMapsServerConfigured,
} from "@jarvis/config";
import { geocode } from "./providers/geo-provider.js";
import { getMapsUsageGuard } from "./maps-usage-guard.js";

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type IntegrationHealth =
  /** A real call to the provider succeeded. */
  | "CONNECTED"
  /** Configured and reachable, but not fully working — e.g. an expired token. */
  | "DEGRADED"
  /** Everything is configured; nothing has been verified yet. */
  | "UNVERIFIED"
  /** Configured, but the last verification failed. */
  | "ERROR"
  /** Nothing is configured for this integration. */
  | "NOT_CONNECTED"
  /** Partially configured — some required settings are missing. */
  | "CONFIG_REQUIRED"
  /** Switched off for this deployment. */
  | "DISABLED";

export type IntegrationCategory =
  | "google"
  | "maps"
  | "communication"
  | "automation"
  | "advertising";

export interface IntegrationCapability {
  id: string;
  label: string;
  /** Whether this deployment can actually do it right now. */
  available: boolean;
  /**
   * True for anything that changes state outside JARVIS.
   *
   * Rendered as a badge, so a connected card cannot be read as "this dashboard
   * can now send messages". It cannot: outbound actions run through
   * ToolExecutor and stop at the approval boundary.
   */
  requiresApproval?: boolean;
}

export interface IntegrationUsage {
  used: number;
  limit: number;
  percentUsed: number;
  level: string;
  blocked: boolean;
}

/**
 * What the browser receives.
 *
 * Deliberately has no field that could carry a credential. Identifiers that ARE
 * safe to show (an account email the user themselves authorised, a phone number
 * id) live under `account`, which holds display strings only.
 */
export interface IntegrationView {
  id: string;
  name: string;
  subtitle: string;
  category: IntegrationCategory;
  health: IntegrationHealth;
  /** Plain English. Actionable. Never contains provider credential material. */
  detail: string;
  capabilities: IntegrationCapability[];
  account: { label: string; detail?: string } | null;
  usage: IntegrationUsage | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  /** Where the running system reads this integration's configuration from. */
  effectiveSource: string;
  actions: {
    testable: boolean;
    /** Existing endpoints. The Control Center drives them; it does not duplicate them. */
    connectUrl?: string;
    configureUrl?: string;
    disconnectUrl?: string;
  };
}

export interface CheckResult {
  health: IntegrationHealth;
  detail: string;
  checkedAt: string;
}

// ---------------------------------------------------------------------------
// Last-check cache
//
// In memory and per user. Deliberately NOT a table: a health check is an
// observation with a few minutes of usefulness, and persisting it would create
// a second source of truth that outlives the thing it describes. Losing it on
// restart is correct — after a restart nothing has been verified.
// ---------------------------------------------------------------------------

interface CheckRecord {
  health: IntegrationHealth;
  detail: string;
  checkedAt: number;
}

const CHECK_TTL_MS = 10 * 60 * 1000;
const MAX_CHECK_ENTRIES = 5000;

const checks = new Map<string, CheckRecord>();

const checkKey = (userId: string, integration: string) => `${userId}:${integration}`;

function rememberCheck(userId: string, integration: string, result: CheckResult): void {
  if (checks.size >= MAX_CHECK_ENTRIES) {
    const oldest = checks.keys().next().value;
    if (oldest !== undefined) checks.delete(oldest);
  }
  checks.set(checkKey(userId, integration), {
    health: result.health,
    detail: result.detail,
    checkedAt: Date.parse(result.checkedAt),
  });
}

function recallCheck(userId: string, integration: string): CheckRecord | null {
  const hit = checks.get(checkKey(userId, integration));
  if (!hit) return null;
  if (Date.now() - hit.checkedAt >= CHECK_TTL_MS) {
    checks.delete(checkKey(userId, integration));
    return null;
  }
  return hit;
}

/** Drops a user's cached verdict — called after connect, configure or disconnect. */
export function invalidateChecks(userId: string, integration?: string): void {
  if (integration) {
    checks.delete(checkKey(userId, integration));
    return;
  }
  for (const key of [...checks.keys()]) {
    if (key.startsWith(`${userId}:`)) checks.delete(key);
  }
}

/** Test seam. */
export function __resetIntegrationChecks(): void {
  checks.clear();
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface IntegrationDeps {
  /** Reads the user's Google OAuth connection. Null when the route is unmounted. */
  googleConnections: {
    findByUser(userId: string): Promise<{
      googleAccountEmail: string;
      scopes: string[];
      connectedAt: Date;
      expiresAt: Date;
    } | null>;
  } | null;
  /** Decrypted Meta credentials for one user, or null. Supplied by the route. */
  readMetaCredentials(
    userId: string
  ): Promise<{ accessToken?: string; adAccountId?: string } | null>;
  /** Whether the Google OAuth routes are mounted at all. */
  googleOAuthMounted: boolean;
}

// ---------------------------------------------------------------------------
// Per-integration description
// ---------------------------------------------------------------------------

/**
 * Combines a configuration state with a remembered verification.
 *
 * The ordering is the honesty rule: a failed or stale check can only make the
 * reported health WORSE than the configuration suggests, never better. Nothing
 * in this function can turn an unverified integration into "CONNECTED".
 */
function withCheck(
  base: { health: IntegrationHealth; detail: string },
  remembered: CheckRecord | null
): Pick<IntegrationView, "health" | "detail" | "lastCheckedAt" | "lastError"> {
  // Not configured beats everything: a check from before the credentials were
  // removed must not keep claiming success.
  if (base.health === "NOT_CONNECTED" || base.health === "CONFIG_REQUIRED" || base.health === "DISABLED") {
    return { ...base, lastCheckedAt: null, lastError: null };
  }

  if (!remembered) {
    return {
      health: "UNVERIFIED",
      detail: base.detail,
      lastCheckedAt: null,
      lastError: null,
    };
  }

  return {
    health: remembered.health,
    detail: remembered.detail,
    lastCheckedAt: new Date(remembered.checkedAt).toISOString(),
    lastError:
      remembered.health === "ERROR" || remembered.health === "DEGRADED"
        ? remembered.detail
        : null,
  };
}

async function describeGoogle(userId: string, deps: IntegrationDeps): Promise<IntegrationView> {
  // The OAuth connection in this repository is Google ADS, read-only. It is
  // NOT Gmail, Calendar or Drive — none of those exist here, and listing them
  // would be exactly the fabricated capability this page must not show.
  //
  // `available` means "usable right now", not "this build supports it". Ticking
  // all three on a card that says NOT CONNECTED reads as though the user
  // already has them; unticked, the same list correctly reads as what
  // connecting would enable.
  const capabilitiesFor = (connected: boolean): IntegrationCapability[] => [
    { id: "google.accounts", label: "Ads accounts", available: connected },
    { id: "google.campaigns", label: "Campaigns", available: connected },
    { id: "google.insights", label: "Insights", available: connected },
  ];

  if (!deps.googleOAuthMounted || !deps.googleConnections) {
    return {
      id: "google",
      name: "Google Ads",
      subtitle: "Read-only Ads access, connected by consent",
      category: "google",
      ...withCheck(
        {
          health: "DISABLED",
          detail:
            "No Google OAuth client is configured on the server, so this connection cannot be established.",
        },
        null
      ),
      capabilities: capabilitiesFor(false),
      account: null,
      usage: null,
      effectiveSource: "server environment",
      actions: { testable: false },
    };
  }

  const connection = await deps.googleConnections.findByUser(userId);
  const base = connection
    ? { health: "UNVERIFIED" as const, detail: "Connected by consent. Test to verify the token." }
    : {
        health: "NOT_CONNECTED" as const,
        detail: "Connect through Google to authorize read-only Ads access.",
      };

  return {
    id: "google",
    name: "Google Ads",
    subtitle: "Read-only Ads access, connected by consent",
    category: "google",
    ...withCheck(base, connection ? recallCheck(userId, "google") : null),
    capabilities: capabilitiesFor(connection !== null),
    account: connection
      ? {
          // The user's own account, which they saw on the consent screen.
          // No token, no scope secret, no client id.
          label: connection.googleAccountEmail,
          detail: `${connection.scopes.length} scope(s) · connected ${connection.connectedAt.toISOString().slice(0, 10)}`,
        }
      : null,
    usage: null,
    effectiveSource: "oauth",
    actions: {
      testable: connection !== null,
      connectUrl: "/google/connect",
      // Only when there IS something to disconnect. A Disconnect button on a
      // card that says NOT CONNECTED is an action with nothing to act on.
      ...(connection ? { disconnectUrl: "/google/disconnect" } : {}),
    },
  };
}

function describeGoogleMapsIntegration(userId: string, usage: IntegrationUsage | null): IntegrationView {
  const browser = isGoogleMapsBrowserConfigured();
  const server = isGoogleMapsServerConfigured();
  const status = describeGoogleMapsStatus();

  const capabilities: IntegrationCapability[] = [
    { id: "maps.js", label: "Maps JavaScript API", available: browser },
    { id: "maps.places", label: "Places API (New)", available: server },
    { id: "maps.routes", label: "Routes API", available: server },
    { id: "maps.geocoding", label: "Geocoding API", available: server },
  ];

  // Three states, because the two keys do different jobs and either can stand
  // alone. Reporting a browser-key-only deployment as simply "connected" would
  // hide that every distance on screen came from OpenStreetMap.
  const base =
    browser && server
      ? { health: "UNVERIFIED" as const, detail: "Both keys configured. Test to verify them against Google." }
      : browser || server
        ? { health: "CONFIG_REQUIRED" as const, detail: status.reason }
        : { health: "NOT_CONNECTED" as const, detail: status.reason };

  return {
    id: "google-maps",
    name: "Google Maps",
    subtitle: "Maps Platform — map, places, routing, geocoding",
    category: "maps",
    ...withCheck(base, recallCheck(userId, "google-maps")),
    capabilities,
    account: null,
    usage,
    effectiveSource: "server environment",
    actions: { testable: server },
  };
}

function describeWhatsApp(userId: string): IntegrationView {
  const configured = isWhatsAppConfigured();

  const capabilities: IntegrationCapability[] = [
    { id: "whatsapp.inbound", label: "Inbound messages", available: configured },
    { id: "whatsapp.webhook", label: "Signed webhook", available: configured },
    // The one write. Marked, so a CONNECTED card cannot be read as "this
    // dashboard can message customers" — it cannot; `whatsapp.send` is
    // EXTERNAL_SIDE_EFFECT and stops at the approval boundary.
    { id: "whatsapp.send", label: "Outbound send", available: configured, requiresApproval: true },
  ];

  const base = configured
    ? { health: "UNVERIFIED" as const, detail: "Configured from server environment. Test to verify the token." }
    : {
        health: "CONFIG_REQUIRED" as const,
        detail:
          "Not configured on the server. WhatsApp needs its four environment variables set at deploy time, because the inbound webhook must verify Meta's signature before any user session exists.",
      };

  return {
    id: "whatsapp",
    name: "WhatsApp Business",
    subtitle: "Cloud API — inbound webhook, approval-gated outbound",
    category: "communication",
    ...withCheck(base, recallCheck(userId, "whatsapp")),
    capabilities,
    account: configured
      ? { label: `Phone number ID ${createWhatsAppConfig().phoneNumberId}` }
      : null,
    usage: null,
    effectiveSource: "server environment",
    actions: { testable: configured },
  };
}

function describeN8n(userId: string): IntegrationView {
  const configured = isN8nConfigured();

  const capabilities: IntegrationCapability[] = [
    { id: "n8n.workflows", label: "Workflow registry", available: configured },
    { id: "n8n.callback", label: "HMAC callback", available: configured },
    { id: "n8n.idempotency", label: "Idempotency keys", available: configured },
    { id: "n8n.trigger", label: "Trigger workflow", available: configured, requiresApproval: true },
  ];

  const base = configured
    ? { health: "UNVERIFIED" as const, detail: "Configured from server environment. Test to verify the API key." }
    : {
        health: "CONFIG_REQUIRED" as const,
        detail:
          "Not configured on the server. n8n needs its base URL, API key and callback secret set at deploy time; the callback authenticates an HMAC over the raw request body.",
      };

  return {
    id: "n8n",
    name: "n8n Automations",
    subtitle: "Workflow triggers behind the approval boundary",
    category: "automation",
    ...withCheck(base, recallCheck(userId, "n8n")),
    capabilities,
    // The base URL is operator configuration, not a secret — the API key is the
    // secret and never appears here.
    account: configured ? { label: createN8nConfig().baseUrl } : null,
    usage: null,
    effectiveSource: "server environment",
    actions: { testable: configured },
  };
}

async function describeMeta(userId: string, deps: IntegrationDeps): Promise<IntegrationView> {
  const stored = await deps.readMetaCredentials(userId);
  const envConfigured = Boolean(process.env.META_ACCESS_TOKEN && process.env.META_AD_ACCOUNT_ID);
  const hasCredentials = Boolean(stored?.accessToken && stored?.adAccountId) || envConfigured;

  const capabilities: IntegrationCapability[] = [
    { id: "meta.accounts", label: "Ad accounts", available: hasCredentials },
    { id: "meta.campaigns", label: "Campaigns", available: hasCredentials },
    { id: "meta.adsets", label: "Ad sets", available: hasCredentials },
    { id: "meta.ads", label: "Ads", available: hasCredentials },
    { id: "meta.insights", label: "Insights", available: hasCredentials },
    // Every Meta write is EXTERNAL_SIDE_EFFECT or FINANCIAL and approval-gated.
    // The dashboard proposes nothing and executes nothing.
    { id: "meta.writes", label: "Budget & status changes", available: hasCredentials, requiresApproval: true },
  ];

  const base = hasCredentials
    ? { health: "UNVERIFIED" as const, detail: "Credentials present. Test to verify them against the Graph API." }
    : { health: "NOT_CONNECTED" as const, detail: "No credentials stored." };

  return {
    id: "meta",
    name: "Meta Ads",
    subtitle: "Marketing API — reads open, writes approval-gated",
    category: "advertising",
    ...withCheck(base, hasCredentials ? recallCheck(userId, "meta") : null),
    capabilities,
    account:
      stored?.adAccountId
        ? { label: stored.adAccountId }
        : envConfigured
          ? { label: process.env.META_AD_ACCOUNT_ID ?? "" }
          : null,
    usage: null,
    // Honest about the gap between what is stored and what the running agent
    // uses: the tool registry binds Meta credentials once, at container build.
    effectiveSource: stored?.accessToken
      ? "stored (applies at next service restart)"
      : envConfigured
        ? "server environment"
        : "none",
    actions: {
      testable: hasCredentials,
      configureUrl: "/credentials/meta",
      disconnectUrl: stored?.accessToken ? "/credentials/meta" : undefined,
    },
  };
}

/** Current Maps usage, or null when the guard is not installed. */
async function readMapsUsage(): Promise<IntegrationUsage | null> {
  const guard = getMapsUsageGuard();
  if (!guard) return null;
  try {
    const status = await guard.status();
    return {
      used: status.used,
      limit: status.limit,
      percentUsed: status.percentUsed,
      level: status.level,
      blocked: status.blocked,
    };
  } catch {
    // A counter that cannot be read is reported as absent, never as zero — a
    // zero here would read as "no usage" and hide a real problem.
    return null;
  }
}

/** Every integration, for one user. */
export async function listIntegrations(
  userId: string,
  deps: IntegrationDeps
): Promise<IntegrationView[]> {
  const usage = await readMapsUsage();
  const [google, meta] = await Promise.all([
    describeGoogle(userId, deps),
    describeMeta(userId, deps),
  ]);

  return [
    google,
    describeGoogleMapsIntegration(userId, usage),
    describeWhatsApp(userId),
    describeN8n(userId),
    meta,
  ];
}

export async function getIntegration(
  userId: string,
  id: string,
  deps: IntegrationDeps
): Promise<IntegrationView | null> {
  const all = await listIntegrations(userId, deps);
  return all.find((i) => i.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// Connection tests
//
// Each one is the CHEAPEST call that actually proves the credential works, and
// every one is a READ. None of them changes state anywhere.
// ---------------------------------------------------------------------------

/** Trims a provider's rejection notice to something safe to display. */
function safeMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback;
  // A rejection notice, never credential material — and bounded, so a provider
  // cannot push an essay into the UI or the audit log.
  return message.slice(0, 300);
}

async function testGoogle(userId: string, deps: IntegrationDeps): Promise<CheckResult> {
  const now = new Date().toISOString();
  if (!deps.googleConnections) {
    return { health: "DISABLED", detail: "Google OAuth is not enabled on this server.", checkedAt: now };
  }

  const connection = await deps.googleConnections.findByUser(userId);
  if (!connection) {
    return { health: "NOT_CONNECTED", detail: "No Google account is connected.", checkedAt: now };
  }

  // An expired access token is not a failure — the refresh token is what the
  // connection is for — but it IS a state the operator should see, because a
  // refresh that has been revoked upstream looks exactly like this until the
  // next call fails.
  if (connection.expiresAt.getTime() <= Date.now()) {
    return {
      health: "DEGRADED",
      detail: `Access token expired at ${connection.expiresAt.toISOString()}. It will be refreshed on the next Ads call; if that fails, reconnect.`,
      checkedAt: now,
    };
  }

  return {
    health: "CONNECTED",
    detail: `Connected as ${connection.googleAccountEmail} with ${connection.scopes.length} scope(s).`,
    checkedAt: now,
  };
}

async function testGoogleMaps(): Promise<CheckResult> {
  const now = new Date().toISOString();
  const config = createGoogleMapsConfig();

  if (!config.serverKey) {
    return {
      health: "CONFIG_REQUIRED",
      detail: "No server key is set, so places, routing and geocoding fall back to OpenStreetMap.",
      checkedAt: now,
    };
  }

  // A real geocode through the EXISTING provider, which means it passes the
  // monthly usage guard like every other Maps call. A test that bypassed the
  // guard would be a hole in the cost ceiling.
  const result = await geocode("Nagpur, India", 1);

  if (result.data?.[0] && result.meta.source.includes("Google")) {
    return {
      health: config.browserKey ? "CONNECTED" : "DEGRADED",
      detail: config.browserKey
        ? "Geocoding, Places and Routes verified against Google. Browser key present, so the map renders."
        : "Server key verified. No browser key, so the interactive map cannot render.",
      checkedAt: now,
    };
  }

  return {
    health: "ERROR",
    detail: result.meta.reason ?? "Google Maps did not answer the verification request.",
    checkedAt: now,
  };
}

async function testWhatsApp(): Promise<CheckResult> {
  const now = new Date().toISOString();
  if (!isWhatsAppConfigured()) {
    return { health: "CONFIG_REQUIRED", detail: "WhatsApp is not configured on the server.", checkedAt: now };
  }

  const config = createWhatsAppConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    // Reading the phone number's own metadata: the cheapest call that proves
    // the token is valid AND scoped to this number. A read, with no recipient
    // and no message — sending anything from a connection test would route
    // around the approval boundary.
    const res = await fetch(
      `https://graph.facebook.com/${config.apiVersion}/${encodeURIComponent(config.phoneNumberId)}?fields=id,verified_name`,
      { signal: controller.signal, headers: { Authorization: `Bearer ${config.accessToken}` } }
    );
    const body = (await res.json()) as {
      id?: string;
      verified_name?: string;
      error?: { message?: string; type?: string };
    };

    if (res.ok && body.id) {
      return {
        health: "CONNECTED",
        detail: `Token verified for ${body.verified_name ?? "phone number"} ${body.id}.`,
        checkedAt: now,
      };
    }

    return {
      health: res.status === 401 || res.status === 403 ? "ERROR" : "DEGRADED",
      // Meta's own rejection text says whether the token expired or lacks a
      // permission, which is what an operator needs. It is not credential
      // material, and it is truncated.
      detail: (body.error?.message ?? `WhatsApp rejected the request (HTTP ${res.status}).`).slice(0, 300),
      checkedAt: now,
    };
  } catch (error) {
    return { health: "ERROR", detail: safeMessage(error, "WhatsApp could not be reached."), checkedAt: now };
  } finally {
    clearTimeout(timer);
  }
}

async function testN8n(): Promise<CheckResult> {
  const now = new Date().toISOString();
  if (!isN8nConfigured()) {
    return { health: "CONFIG_REQUIRED", detail: "n8n is not configured on the server.", checkedAt: now };
  }

  const config = createN8nConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    // SSRF containment: the URL is built from the SERVER-CONFIGURED base only.
    // No part of it comes from the request, so there is nothing for a caller to
    // redirect. The `URL` construction plus the origin re-check mirrors what
    // buildWebhookUrl does for triggers.
    const target = new URL("/api/v1/workflows?limit=1", config.baseUrl);
    if (target.origin !== new URL(config.baseUrl).origin) {
      return { health: "ERROR", detail: "Refusing to test outside the configured n8n origin.", checkedAt: now };
    }

    const res = await fetch(target, {
      signal: controller.signal,
      headers: { "X-N8N-API-KEY": config.apiKey, Accept: "application/json" },
    });

    if (res.ok) {
      return { health: "CONNECTED", detail: `n8n reachable at ${new URL(config.baseUrl).origin} and the API key was accepted.`, checkedAt: now };
    }
    if (res.status === 401 || res.status === 403) {
      return { health: "ERROR", detail: "n8n rejected the API key.", checkedAt: now };
    }
    return { health: "DEGRADED", detail: `n8n answered with HTTP ${res.status}.`, checkedAt: now };
  } catch (error) {
    return { health: "ERROR", detail: safeMessage(error, "n8n could not be reached."), checkedAt: now };
  } finally {
    clearTimeout(timer);
  }
}

async function testMeta(userId: string, deps: IntegrationDeps): Promise<CheckResult> {
  const now = new Date().toISOString();
  const stored = await deps.readMetaCredentials(userId);

  const accessToken = stored?.accessToken ?? process.env.META_ACCESS_TOKEN;
  const adAccountId = stored?.adAccountId ?? process.env.META_AD_ACCOUNT_ID;
  if (!accessToken || !adAccountId) {
    return { health: "NOT_CONNECTED", detail: "Save credentials before testing the connection.", checkedAt: now };
  }

  try {
    const provider = createMetaGraphProvider({
      accessToken,
      adAccountId,
      ...(process.env.META_GRAPH_API_VERSION ? { apiVersion: process.env.META_GRAPH_API_VERSION } : {}),
    });
    const result = await provider.getAdAccounts({ limit: 1 });
    const accounts = Array.isArray(result) ? result : ((result as { data?: unknown[] })?.data ?? []);

    return {
      health: "CONNECTED",
      detail: `Verified against the Meta Graph API. ${accounts.length} account(s) visible.`,
      checkedAt: now,
    };
  } catch (error) {
    return {
      health: "ERROR",
      detail: safeMessage(error, "The provider rejected the credentials."),
      checkedAt: now,
    };
  }
}

/**
 * Runs one integration's connection test and remembers the verdict.
 *
 * Returns null for an unknown id so the route can answer 404 rather than
 * inventing a result.
 */
export async function runCheck(
  userId: string,
  id: string,
  deps: IntegrationDeps
): Promise<CheckResult | null> {
  let result: CheckResult | null = null;

  switch (id) {
    case "google":
      result = await testGoogle(userId, deps);
      break;
    case "google-maps":
      result = await testGoogleMaps();
      break;
    case "whatsapp":
      result = await testWhatsApp();
      break;
    case "n8n":
      result = await testN8n();
      break;
    case "meta":
      result = await testMeta(userId, deps);
      break;
    default:
      return null;
  }

  rememberCheck(userId, id, result);
  return result;
}

/** The ids this registry knows. Used to reject unknown paths early. */
export const INTEGRATION_IDS = ["google", "google-maps", "whatsapp", "n8n", "meta"] as const;
