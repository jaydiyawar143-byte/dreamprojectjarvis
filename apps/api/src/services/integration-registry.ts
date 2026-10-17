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

import { mcpFailure, type McpConnectResult, type McpDriftKind, type McpFailureCode } from "@jarvis/core";
import { createMetaGraphProvider } from "@jarvis/meta-graph";
import { createWhatsAppConfig, isWhatsAppConfigured } from "@jarvis/whatsapp";
import { createN8nConfig, createN8nProvider, isN8nConfigured, type N8nConfig } from "@jarvis/n8n";
import {
  checkOmniRouteConnection,
  createOmniRouteConfig,
  isOmniRouteConfigured,
  omniRouteModelsUrl,
  type OmniRouteConfig,
} from "@jarvis/omniroute";
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
  /**
   * The provider REJECTED the stored authorization — a revoked grant, a refresh
   * token Google will no longer honour. Distinct from ERROR because the remedy
   * is different and only the user can apply it: no amount of retrying fixes a
   * grant that no longer exists, so the UI must offer re-consent rather than a
   * Test button.
   */
  | "NEEDS_REAUTH"
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
  | "advertising"
  | "ai";

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
      /** Set once the grant is gone at Google's end. A retry cannot clear it. */
      revokedAt?: Date | null;
    } | null>;
  } | null;
  /** Decrypted Meta credentials for one user, or null. Supplied by the route. */
  readMetaCredentials(
    userId: string
  ): Promise<{ accessToken?: string; adAccountId?: string } | null>;
  /** Whether the Google OAuth routes are mounted at all. */
  googleOAuthMounted: boolean;
  /** S8.5 — MCP as the container built it. Absent: reported as switched off. */
  mcp?: McpIntegrationRuntime;
}

/**
 * S8.5 — what the MCP health check may touch: the deployment switch, and the
 * managed connection of every registered server — the same objects tool calls
 * use, read late because the tools register after this layer is built. A
 * server offers its reviewed id and S8.2's own verification; never a client,
 * a transport, a listing or the manifest.
 */
export interface McpIntegrationRuntime {
  enabled(): boolean;
  servers(): readonly { readonly serverId: string; verify(): Promise<McpConnectResult> }[];
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

/**
 * The configured n8n origin, or null when it is unset OR does not validate.
 *
 * `isN8nConfigured()` answers "are the variables present"; this answers "can
 * the values actually be used". A base URL with no scheme is present but
 * unparseable, and `createN8nConfig()` throws on it — which must not take down
 * the integrations page. Never throws, never returns a credential.
 */
function readN8nBaseUrl(): string | null {
  if (!isN8nConfigured()) return null;
  try {
    return createN8nConfig().baseUrl;
  } catch {
    return null;
  }
}

function describeN8n(userId: string): IntegrationView {
  const baseUrl = readN8nBaseUrl();
  const configured = baseUrl !== null;

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
    account: baseUrl ? { label: baseUrl } : null,
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

const MCP_SWITCHED_OFF =
  "Switched off for this deployment. Set JARVIS_MCP_ENABLED=true and restart to use the reviewed MCP servers.";
const MCP_NONE_REGISTERED =
  "No reviewed MCP server is registered on this deployment. A server is added by code review, never at runtime.";

/** The registered servers, or null when MCP is switched off. */
const mcpServers = (deps: IntegrationDeps) => (deps.mcp?.enabled() ? deps.mcp.servers() : null);

/**
 * S8.5 — MCP from configuration alone: switched off, nothing registered, or
 * the servers there are. Starts nothing; only a check (`testMcp`) does.
 */
function describeMcp(userId: string, deps: IntegrationDeps): IntegrationView {
  const servers = mcpServers(deps);
  const base =
    servers === null
      ? { health: "DISABLED" as const, detail: MCP_SWITCHED_OFF }
      : servers.length === 0
        ? { health: "NOT_CONNECTED" as const, detail: MCP_NONE_REGISTERED }
        : {
            health: "UNVERIFIED" as const,
            detail: `Reviewed MCP servers: ${servers.map((s) => s.serverId).join(", ")}. Test to start them and verify them against their review.`,
          };

  return {
    id: "mcp",
    name: "MCP Servers",
    subtitle: "Reviewed local tool servers — read-only tools for owners and admins",
    category: "automation",
    ...withCheck(base, servers?.length ? recallCheck(userId, "mcp") : null),
    capabilities: [],
    account: null,
    usage: null,
    effectiveSource: "reviewed manifest",
    actions: { testable: Boolean(servers?.length) },
  };
}

/**
 * The OmniRoute configuration as the environment states it: absent, present
 * and usable, or present and unusable — three states with three different
 * fixes. Never throws; an unusable value is described by its field names and
 * rules only, never by the value.
 */
function readOmniRoute(): { config: OmniRouteConfig } | { invalid: string } | null {
  if (!isOmniRouteConfigured()) return null;
  try {
    return { config: createOmniRouteConfig() };
  } catch (error) {
    return { invalid: error instanceof Error ? error.message : "OmniRoute configuration error" };
  }
}

function describeOmniRoute(userId: string): IntegrationView {
  const read = readOmniRoute();
  const config = read && "config" in read ? read.config : null;
  const invalid = read && "invalid" in read ? read.invalid : null;

  const base = config
    ? { health: "UNVERIFIED" as const, detail: "Configured from server environment. Test to verify the gateway and its API key." }
    : invalid
      ? { health: "CONFIG_REQUIRED" as const, detail: `${invalid}. Fix it and restart.` }
      : {
          health: "CONFIG_REQUIRED" as const,
          detail: "Not configured on the server. OmniRoute needs OMNIROUTE_BASE_URL and OMNIROUTE_API_KEY set at deploy time.",
        };

  return {
    id: "omniroute",
    name: "OmniRoute",
    subtitle: "AI gateway — one OpenAI-compatible endpoint in front of many model providers",
    category: "ai",
    ...withCheck(base, recallCheck(userId, "omniroute")),
    capabilities: [{ id: "omniroute.models", label: "Model catalogue", available: config !== null }],
    // The base URL is operator configuration, not a secret, and the config
    // refuses one that embeds a credential — so it is safe to display.
    account: config ? { label: config.baseUrl } : null,
    usage: null,
    effectiveSource: "server environment",
    actions: { testable: config !== null },
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
    describeMcp(userId, deps),
    describeOmniRoute(userId),
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

  // A grant the user revoked at Google's end still has a local row until
  // something tries to use it. `revokedAt` is set by the disconnect path and by
  // a refused refresh, and it is the one state a retry cannot clear.
  if (connection.revokedAt != null) {
    return {
      health: "NEEDS_REAUTH",
      detail: "The Google grant has been revoked. Reconnect to authorize again.",
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

  let config: N8nConfig;
  try {
    config = createN8nConfig();
  } catch (error) {
    // Present but unusable — most often a base URL with no scheme. The thrown
    // message names FIELDS only, never values, so it is safe to surface. This
    // is the difference between "not configured" and "configured wrongly",
    // which are different fixes.
    return {
      health: "ERROR",
      detail: `n8n configuration is invalid: ${error instanceof Error ? error.message : "unknown"}`,
      checkedAt: now,
    };
  }

  // One read through the SAME provider the trigger tool uses. The URL is built
  // from the server-configured origin only (no caller input can redirect it),
  // the key travels in the X-N8N-API-KEY header, and nothing is written.
  const result = await createN8nProvider({ config }).checkConnection();

  if (result.ok) {
    return {
      health: "CONNECTED",
      detail: `n8n reachable at ${new URL(config.baseUrl).origin} and the API key was accepted.`,
      checkedAt: now,
    };
  }

  const { error } = result;
  if (error.httpStatus === 401 || error.httpStatus === 403) {
    return { health: "ERROR", detail: "n8n rejected the API key.", checkedAt: now };
  }
  if (error.code === "TOOL_TIMEOUT") {
    return { health: "ERROR", detail: "n8n did not respond in time.", checkedAt: now };
  }
  if (error.httpStatus !== undefined) {
    return { health: "DEGRADED", detail: `n8n answered with HTTP ${error.httpStatus}.`, checkedAt: now };
  }
  // No HTTP status means the request never produced a response, or n8n answered
  // with a shape this integration cannot read. Neither is a working connection.
  return {
    health: "ERROR",
    detail: "n8n could not be reached or answered with an unexpected response.",
    checkedAt: now,
  };
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
 * OmniRoute: the model list, read with the key, and once more without it.
 *
 * A gateway that answers the keyless request too is DEGRADED, never CONNECTED:
 * it works, but "the key was accepted" would be a claim about a key nothing
 * checked, and the providers behind it are open to anyone who can reach it.
 * "Key accepted" is said only when the keyless request was refused. Every
 * detail is fixed wording plus the configured origin and a status code;
 * nothing the gateway says is repeated.
 */
async function testOmniRoute(): Promise<CheckResult> {
  const now = new Date().toISOString();
  const read = readOmniRoute();
  if (!read) {
    return { health: "CONFIG_REQUIRED", detail: "OmniRoute is not configured on the server.", checkedAt: now };
  }
  if ("invalid" in read) {
    return { health: "ERROR", detail: `${read.invalid}.`, checkedAt: now };
  }

  const { config } = read;
  const at = new URL(config.baseUrl).origin;
  const result = await checkOmniRouteConnection(config);

  if (!result.ok) {
    switch (result.reason) {
      case "UNAUTHORIZED":
        return { health: "ERROR", detail: "OmniRoute rejected the API key.", checkedAt: now };
      case "NOT_FOUND":
        return {
          health: "ERROR",
          detail: `OmniRoute has no model list at ${omniRouteModelsUrl(config)}. Check that OMNIROUTE_BASE_URL is the gateway's /v1 base.`,
          checkedAt: now,
        };
      case "REDIRECTED":
        return {
          health: "ERROR",
          detail: `OmniRoute answered with a redirect (HTTP ${result.httpStatus}), which JARVIS does not follow with the API key. Point OMNIROUTE_BASE_URL at the final address.`,
          checkedAt: now,
        };
      case "HTTP_ERROR":
        return { health: "DEGRADED", detail: `OmniRoute answered with HTTP ${result.httpStatus}.`, checkedAt: now };
      case "TIMEOUT":
        return { health: "ERROR", detail: "OmniRoute did not respond in time.", checkedAt: now };
      case "UNREACHABLE":
        return {
          health: "ERROR",
          detail: `OmniRoute could not be reached at ${at}. From inside Docker, the host's gateway is host.docker.internal, not localhost.`,
          checkedAt: now,
        };
      case "UNEXPECTED_RESPONSE":
        return {
          health: "ERROR",
          detail: "OmniRoute answered with something that is not an OpenAI-compatible model list.",
          checkedAt: now,
        };
    }
  }

  const models = `${result.modelCount} model${result.modelCount === 1 ? "" : "s"}`;

  if (result.keyRequired === false) {
    return {
      health: "DEGRADED",
      detail: `OmniRoute at ${at} offers ${models}, but it answers without an API key too, so the key was not checked and anyone who can reach the gateway can use the providers behind it. Set REQUIRE_API_KEY=true on OmniRoute.`,
      checkedAt: now,
    };
  }
  if (result.modelCount === 0) {
    return {
      health: "DEGRADED",
      detail: `OmniRoute at ${at} accepted the API key but offers no models. Connect a provider in the OmniRoute dashboard.`,
      checkedAt: now,
    };
  }
  return {
    health: "CONNECTED",
    detail:
      result.keyRequired === true
        ? `OmniRoute reachable at ${at}; the API key was accepted and ${models} are offered.`
        : `OmniRoute reachable at ${at} with ${models}. Whether it requires an API key could not be confirmed.`,
    checkedAt: now,
  };
}

/** S8.5 — what went wrong with one server, in fixed words. Never the server's own text. */
const MCP_FAILURE: Readonly<Record<McpFailureCode, string>> = {
  SERVER_UNAVAILABLE: "is unavailable",
  INITIALIZATION_FAILED: "did not finish starting",
  SCHEMA_INVALID: "no longer matches its review",
  TIMEOUT: "timed out",
  AUTH_FAILURE: "refused JARVIS's credentials — the operator must update them",
  RATE_LIMITED: "is rate-limiting JARVIS",
  RESPONSE_TOO_LARGE: "sent more output than allowed",
  TOOL_NOT_FOUND: "failed its check",
  INVALID_ARGUMENTS: "failed its check",
  CANCELLED: "failed its check",
  REMOTE_ERROR: "failed its check",
  UNKNOWN: "failed its check",
};

/** What drifted from the review. Never a tool name: a live one is the server's own text. */
const MCP_DRIFT: Readonly<Record<McpDriftKind, string>> = {
  SERVER_INFO_MISMATCH: "another server name or version",
  MISSING_TOOL: "a reviewed tool is missing",
  UNEXPECTED_TOOL: "an unreviewed tool is offered",
  DUPLICATE_TOOL: "a tool is listed twice",
  FINGERPRINT_MISMATCH: "a reviewed tool has changed",
  INVALID_TOOL: "an unreadable tool listing",
};

function mcpOutcome(serverId: string, result: McpConnectResult): string {
  if (result.ok) return `${serverId} verified`;
  const drift = [...new Set((result.failure.drift ?? []).map((d) => MCP_DRIFT[d.kind]))];
  return `${serverId} ${MCP_FAILURE[result.failure.code]}${drift.length > 0 ? ` (${drift.join(", ")})` : ""}`;
}

/**
 * S8.5 — every registered MCP server through S8.2's own verification: an idle
 * server is started and verified, a running one is listed again and compared
 * with its review. Nothing is registered, granted or remembered here except
 * the verdict, and nothing retries — an open breaker answers for itself.
 *
 * One verdict, deterministically: every server verified → CONNECTED; none →
 * ERROR; some → DEGRADED. Each server is named with its own outcome, in
 * manifest order, so one cannot hide another — and a check that throws counts
 * against its own server alone.
 */
async function testMcp(deps: IntegrationDeps): Promise<CheckResult> {
  const now = new Date().toISOString();
  const servers = mcpServers(deps);
  if (servers === null) return { health: "DISABLED", detail: MCP_SWITCHED_OFF, checkedAt: now };
  if (servers.length === 0) return { health: "NOT_CONNECTED", detail: MCP_NONE_REGISTERED, checkedAt: now };

  const results = await Promise.all(
    servers.map((server) =>
      server.verify().catch((): McpConnectResult => ({ ok: false, failure: mcpFailure("UNKNOWN") }))
    )
  );
  const verified = results.filter((result) => result.ok).length;
  const outcomes = servers.map((server, i) => mcpOutcome(server.serverId, results[i]!)).join("; ");

  if (verified === servers.length) {
    return { health: "CONNECTED", detail: `Verified against the review: ${outcomes}.`, checkedAt: now };
  }
  if (verified === 0) {
    return { health: "ERROR", detail: `No reviewed MCP server is working: ${outcomes}.`, checkedAt: now };
  }
  return {
    health: "DEGRADED",
    detail: `${verified} of ${servers.length} reviewed MCP servers verified: ${outcomes}.`,
    checkedAt: now,
  };
}

/** S8.7 — how a failed server's tools are presented. Fixed: never the server's own text. */
const MCP_TOOL_UNAVAILABLE = Object.freeze({
  reason: "This reviewed MCP server failed its last start or check, so its tools are refused until it passes again.",
  requiredAction: "Run Test Connection on MCP Servers in the Integration Center to check it again.",
});

/**
 * S8.7 — whether a reviewed MCP tool should be presented as unavailable: its
 * server's managed connection failed its last start or check, or was closed.
 * Read-only — it looks at the state S8.2 already keeps and never starts,
 * lists or verifies anything. A server not yet started, starting or verified
 * keeps its presentation; anything not a registered server's tool gets null.
 */
export function mcpToolUnavailable(
  servers: readonly { readonly serverId: string; getState(): string }[],
  toolId: string
): { reason: string; requiredAction: string } | null {
  const [namespace, serverId] = toolId.split(".");
  if (namespace !== "mcp") return null;
  const state = servers.find((server) => server.serverId === serverId)?.getState();
  return state === "failed" || state === "closed" ? MCP_TOOL_UNAVAILABLE : null;
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
    case "mcp":
      result = await testMcp(deps);
      break;
    case "omniroute":
      result = await testOmniRoute();
      break;
    default:
      return null;
  }

  rememberCheck(userId, id, result);
  return result;
}

/** The ids this registry knows. Used to reject unknown paths early. */
export const INTEGRATION_IDS = ["google", "google-maps", "whatsapp", "n8n", "meta", "mcp", "omniroute"] as const;
