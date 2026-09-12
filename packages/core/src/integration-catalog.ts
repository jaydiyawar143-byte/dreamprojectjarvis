// ---------------------------------------------------------------------------
// The integration catalogue — static, compiled-in description of what exists.
//
// This is DATA, not behaviour. It says what an integration is called, which
// fields configure it, which scopes each Google service needs and which actions
// it offers. It performs no call and holds no secret, which is why it can be
// shared by the API, the tool package and the browser without dragging a
// provider SDK into any of them.
//
// IT IS ALSO THE AUTHORIZATION VOCABULARY. Scope sets are read from here when
// building a consent URL and when deciding whether a granted token covers a
// requested service. Because the table is compiled in, no request body and no
// model output can widen a scope request — the worst a caller can do is name a
// service that is already in the table.
//
// HONESTY RULE: nothing is listed here that the repository cannot actually do.
// A service whose tools do not exist yet is marked `implemented: false`, so the
// UI can render it as "available to connect" without implying JARVIS can
// already read your mail.
// ---------------------------------------------------------------------------

import type {
  IntegrationActionSpec,
  IntegrationCategory,
  IntegrationCommand,
  IntegrationConfigKind,
  IntegrationFieldSpec,
  IntegrationId,
} from "./types/integration.js";

// ---------------------------------------------------------------------------
// Google services
// ---------------------------------------------------------------------------

export type GoogleServiceId =
  | "ads"
  | "gmail"
  | "drive"
  | "calendar"
  | "youtube"
  | "sheets"
  | "docs";

/**
 * One Google service and the scopes it needs.
 *
 * Read and write scopes are listed SEPARATELY and requested separately. That
 * split is the progressive-permission model in data form: connecting grants
 * `readScopes` for the services the user picked, and a write scope is only ever
 * added by an explicit later request. There is no code path that sends
 * `writeScopes` during the initial connect.
 */
export interface GoogleServiceSpec {
  id: GoogleServiceId;
  label: string;
  description: string;
  /** Minimum scopes to read this service. Requested on connect when selected. */
  readScopes: readonly string[];
  /**
   * Scopes needed to change anything. NEVER requested at initial connect, and
   * only ever added through an explicit re-consent the user initiates.
   */
  writeScopes: readonly string[];
  /**
   * Whether this repository has tools that actually use the service. False
   * means "you may connect it, but JARVIS has no action for it yet" — which the
   * UI states rather than hides.
   */
  implemented: boolean;
  /** Extra configuration beyond OAuth, e.g. the Ads developer token. */
  extraConfig?: readonly string[];
}

/**
 * Identity scopes. Requested always: they are what names the connected account
 * so it can be displayed and revoked. They grant no data access.
 */
export const GOOGLE_IDENTITY_SCOPES: readonly string[] = ["openid", "email", "profile"];

export const GOOGLE_SERVICES: readonly GoogleServiceSpec[] = [
  {
    id: "ads",
    label: "Google Ads",
    description: "Campaign, account and performance reads.",
    // Google publishes exactly one Ads scope and it is not separable into read
    // and write. Read-only is therefore enforced on OUR side — the provider
    // exposes no mutating method and every Ads tool is RiskLevel READ_ONLY —
    // and it is listed as a read scope because that is how this system uses it.
    readScopes: ["https://www.googleapis.com/auth/adwords"],
    writeScopes: [],
    implemented: true,
    // Ads needs more than OAuth: a developer token issued to the manager
    // account, and a customer id to address. Gmail consent alone is not enough,
    // and pretending otherwise produces a connection that 401s on first use.
    extraConfig: ["adsDeveloperToken", "adsCustomerId", "adsLoginCustomerId"],
  },
  {
    id: "gmail",
    label: "Gmail",
    description: "Read message metadata and content; sending is a separate grant.",
    readScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    // `gmail.compose`, not `gmail.send`.
    //
    // `gmail.send` permits sending and NOTHING else — it cannot create or
    // update a draft, so Phase 13's draft actions would fail on it with a 403
    // that looks like a bug. `gmail.compose` is the narrowest scope that covers
    // exactly this phase's surface: create, update and send drafts.
    //
    // It is still meaningfully narrower than the alternatives: it does not
    // grant reading the mailbox (that is `gmail.readonly`, requested
    // separately) and it cannot delete mail at all.
    writeScopes: ["https://www.googleapis.com/auth/gmail.compose"],
    implemented: true,
  },
  {
    id: "drive",
    label: "Google Drive",
    description: "List and read files JARVIS has been given access to.",
    // drive.readonly, not drive: the narrow scope still lists and reads, and the
    // broad one additionally permits deletion. Asking for the broad scope to do
    // a read is how consent screens become meaningless.
    readScopes: ["https://www.googleapis.com/auth/drive.readonly"],
    writeScopes: ["https://www.googleapis.com/auth/drive.file"],
    implemented: true,
  },
  {
    id: "calendar",
    label: "Google Calendar",
    description: "Read events and availability.",
    readScopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    writeScopes: ["https://www.googleapis.com/auth/calendar.events"],
    implemented: true,
  },
  {
    id: "youtube",
    label: "YouTube",
    description: "Channel and video reads, analytics.",
    readScopes: [
      "https://www.googleapis.com/auth/youtube.readonly",
      "https://www.googleapis.com/auth/yt-analytics.readonly",
    ],
    // Upload is the write, and it is irreversible in practice — a published
    // video is public the moment it exists.
    writeScopes: ["https://www.googleapis.com/auth/youtube.upload"],
    implemented: false,
  },
  {
    id: "sheets",
    label: "Google Sheets",
    description: "Read spreadsheet values and structure.",
    readScopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    writeScopes: ["https://www.googleapis.com/auth/spreadsheets"],
    implemented: false,
  },
  {
    id: "docs",
    label: "Google Docs",
    description: "Read document content.",
    readScopes: ["https://www.googleapis.com/auth/documents.readonly"],
    writeScopes: ["https://www.googleapis.com/auth/documents"],
    implemented: false,
  },
] as const;

export function getGoogleService(id: string): GoogleServiceSpec | undefined {
  return GOOGLE_SERVICES.find((s) => s.id === id);
}

export function isGoogleServiceId(value: unknown): value is GoogleServiceId {
  return typeof value === "string" && GOOGLE_SERVICES.some((s) => s.id === value);
}

/**
 * The scope set for an initial connection.
 *
 * READ SCOPES ONLY, plus identity. A caller that asks for write access at
 * connect time does not get it — there is no parameter here that could request
 * one, which is stronger than remembering not to pass it.
 *
 * An unknown service id is dropped rather than throwing: the catalogue is the
 * allowlist, so filtering against it is the containment.
 */
export function scopesForConnect(services: readonly string[]): string[] {
  const scopes = new Set<string>(GOOGLE_IDENTITY_SCOPES);
  for (const id of services) {
    const spec = getGoogleService(id);
    if (!spec) continue;
    for (const scope of spec.readScopes) scopes.add(scope);
  }
  return [...scopes];
}

/**
 * The scope set for an explicit write-access upgrade.
 *
 * Separate function, separate call site, so granting write is always a distinct
 * decision in the code as well as in the consent screen.
 */
export function scopesForWriteUpgrade(services: readonly string[]): string[] {
  const scopes = new Set<string>();
  for (const id of services) {
    const spec = getGoogleService(id);
    if (!spec) continue;
    for (const scope of spec.readScopes) scopes.add(scope);
    for (const scope of spec.writeScopes) scopes.add(scope);
  }
  return [...scopes];
}

/**
 * Which services a granted scope list actually covers.
 *
 * Authorization decisions read THIS, never the list of services that were
 * requested: Google may grant fewer scopes than asked for, and a system that
 * trusts the request will call an API it has no permission for and surface the
 * resulting 403 as a mystery.
 */
export function servicesFromGrantedScopes(granted: readonly string[]): GoogleServiceId[] {
  const set = new Set(granted);
  return GOOGLE_SERVICES.filter((spec) =>
    spec.readScopes.length > 0 && spec.readScopes.every((scope) => set.has(scope))
  ).map((spec) => spec.id);
}

/** Whether the granted scopes include write access for a service. */
export function hasWriteAccess(service: GoogleServiceId, granted: readonly string[]): boolean {
  const spec = getGoogleService(service);
  if (!spec || spec.writeScopes.length === 0) return false;
  const set = new Set(granted);
  return spec.writeScopes.every((scope) => set.has(scope));
}

/** Plain-English label for a raw scope URL, for the permissions view. */
export function describeScope(scope: string): { label: string; access: "read" | "write"; service?: string } {
  if (scope === "openid" || scope === "email" || scope === "profile") {
    return { label: "Identify the connected Google account", access: "read" };
  }
  for (const spec of GOOGLE_SERVICES) {
    if (spec.readScopes.includes(scope)) {
      return { label: `Read ${spec.label}`, access: "read", service: spec.id };
    }
    if (spec.writeScopes.includes(scope)) {
      return { label: `Modify ${spec.label}`, access: "write", service: spec.id };
    }
  }
  // An unrecognised scope is shown as-is rather than hidden: a token carrying a
  // permission this build does not know about is exactly what an operator needs
  // to see, and silently dropping it from the list would conceal it.
  return { label: scope, access: scope.includes(".readonly") ? "read" : "write" };
}

// ---------------------------------------------------------------------------
// Integration descriptors
// ---------------------------------------------------------------------------

export interface IntegrationDescriptor {
  id: IntegrationId;
  name: string;
  subtitle: string;
  category: IntegrationCategory;
  configKind: IntegrationConfigKind;
  /** Configuration fields. Empty for a pure-OAuth integration. */
  fields: readonly IntegrationFieldSpec[];
  /** Provider operations, as opposed to management verbs. */
  actions: readonly Omit<IntegrationActionSpec, "available">[];
  /** Management verbs this integration supports at all. */
  commands: readonly IntegrationCommand[];
  /** Environment variables that configure it, for the docs and the UI hint. */
  envVars: readonly string[];
}

/** Verbs every integration supports, whatever its configuration kind. */
const UNIVERSAL_COMMANDS: readonly IntegrationCommand[] = [
  "status",
  "validateConfig",
  "testConnection",
  "getPermissions",
  "getHealth",
  "getAudit",
  "enable",
  "disable",
];

export const INTEGRATION_CATALOG: readonly IntegrationDescriptor[] = [
  {
    id: "google",
    name: "Google",
    subtitle: "One consent, per-service scopes — Ads, Gmail, Drive, Calendar, YouTube, Sheets, Docs",
    category: "google",
    configKind: "oauth",
    fields: [
      {
        name: "adsDeveloperToken",
        label: "Google Ads developer token",
        kind: "secret",
        required: false,
        help: "Issued to your Google Ads manager account. Required for Ads API calls — OAuth consent alone is not sufficient.",
      },
      {
        name: "adsCustomerId",
        label: "Google Ads customer ID",
        kind: "text",
        required: false,
        placeholder: "1234567890",
        pattern: "^\\d{10}$",
        patternHint: "ten digits, no dashes",
        help: "The account to query. Dashes are stripped automatically.",
      },
      {
        name: "adsLoginCustomerId",
        label: "Google Ads manager (MCC) ID",
        kind: "text",
        required: false,
        placeholder: "1234567890",
        pattern: "^\\d{10}$",
        patternHint: "ten digits, no dashes",
        help: "Only needed when accessing a client account through a manager account.",
      },
    ],
    actions: [
      { id: "google.ads.accounts", label: "List Ads accounts", writesExternally: false, toolId: "google.accounts" },
      { id: "google.ads.campaigns", label: "List campaigns", writesExternally: false, toolId: "google.campaigns" },
      { id: "google.ads.insights", label: "Read performance insights", writesExternally: false, toolId: "google.insights" },
    ],
    commands: [...UNIVERSAL_COMMANDS, "connect", "configure", "reconnect", "disconnect", "executeAction"],
    envVars: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "GOOGLE_ADS_DEVELOPER_TOKEN"],
  },
  {
    id: "google-maps",
    name: "Google Maps",
    subtitle: "Maps Platform — map rendering, places, routing, geocoding",
    category: "maps",
    configKind: "server-managed",
    fields: [
      {
        name: "browserKey",
        label: "Browser API key",
        kind: "secret",
        required: false,
        serverManaged: true,
        help: "Referrer-restricted key used by the browser to render the map. This one is PUBLIC by design — restrict it by HTTP referrer in the Google Cloud console.",
      },
      {
        name: "serverKey",
        label: "Server API key",
        kind: "secret",
        required: false,
        serverManaged: true,
        help: "IP-restricted key used server-side for Places, Routes and Geocoding. Never sent to the browser.",
      },
      {
        name: "monthlyLimit",
        label: "Monthly request ceiling",
        kind: "number",
        required: false,
        serverManaged: true,
        help: "Requests are refused past this number, so a loop cannot run up a bill.",
      },
    ],
    actions: [
      { id: "maps.geocode", label: "Geocode an address", writesExternally: false, toolId: "maps.geocode" },
      { id: "maps.search", label: "Search places", writesExternally: false, toolId: "maps.search" },
      { id: "maps.route", label: "Compute a route", writesExternally: false, toolId: "maps.route" },
      { id: "maps.distance", label: "Distance and travel time", writesExternally: false, toolId: "maps.distance" },
    ],
    commands: [...UNIVERSAL_COMMANDS, "executeAction"],
    envVars: ["GOOGLE_MAPS_BROWSER_KEY", "GOOGLE_MAPS_SERVER_KEY", "GOOGLE_MAPS_MONTHLY_LIMIT"],
  },
  {
    id: "meta",
    name: "Meta Ads",
    subtitle: "Marketing API — reads open, writes approval-gated",
    category: "advertising",
    configKind: "form",
    fields: [
      {
        name: "accessToken",
        label: "Access token",
        kind: "secret",
        required: true,
        help: "A Marketing API user or system-user token with ads_read.",
      },
      {
        name: "adAccountId",
        label: "Ad account ID",
        kind: "text",
        required: true,
        placeholder: "act_1234567890",
        pattern: "^act_\\d+$",
        patternHint: "act_ followed by digits",
      },
      {
        name: "pixelId",
        label: "Pixel ID",
        kind: "text",
        required: false,
        help: "Optional. Recorded for attribution context.",
      },
    ],
    actions: [
      { id: "meta.accounts", label: "List ad accounts", writesExternally: false, toolId: "meta.accounts" },
      { id: "meta.campaigns", label: "List campaigns", writesExternally: false, toolId: "meta.campaigns" },
      { id: "meta.insights", label: "Read insights", writesExternally: false, toolId: "meta.insights" },
      { id: "meta.campaign.pause", label: "Pause a campaign", writesExternally: true, toolId: "meta.campaign.pause" },
      { id: "meta.campaign.budget.update", label: "Change a campaign budget", writesExternally: true, toolId: "meta.campaign.budget.update" },
    ],
    commands: [...UNIVERSAL_COMMANDS, "configure", "reconnect", "disconnect", "executeAction"],
    envVars: ["META_ACCESS_TOKEN", "META_AD_ACCOUNT_ID", "META_GRAPH_API_VERSION"],
  },
  {
    id: "whatsapp",
    name: "WhatsApp Business",
    subtitle: "Cloud API — inbound webhook, approval-gated outbound",
    category: "communication",
    configKind: "server-managed",
    fields: [
      { name: "phoneNumberId", label: "Phone number ID", kind: "text", required: true, serverManaged: true },
      { name: "accessToken", label: "Access token", kind: "secret", required: true, serverManaged: true },
      { name: "verifyToken", label: "Webhook verify token", kind: "secret", required: true, serverManaged: true },
      { name: "appSecret", label: "App secret", kind: "secret", required: true, serverManaged: true },
    ],
    actions: [
      { id: "whatsapp.send", label: "Send a message", writesExternally: true, toolId: "whatsapp.send" },
    ],
    commands: [...UNIVERSAL_COMMANDS, "executeAction"],
    envVars: [
      "WHATSAPP_PHONE_NUMBER_ID",
      "WHATSAPP_ACCESS_TOKEN",
      "WHATSAPP_VERIFY_TOKEN",
      "WHATSAPP_APP_SECRET",
    ],
  },
  {
    id: "n8n",
    name: "n8n Automations",
    subtitle: "Workflow triggers behind the approval boundary",
    category: "automation",
    configKind: "server-managed",
    fields: [
      { name: "baseUrl", label: "Base URL", kind: "url", required: true, serverManaged: true },
      { name: "apiKey", label: "API key", kind: "secret", required: true, serverManaged: true },
      { name: "callbackSecret", label: "Callback HMAC secret", kind: "secret", required: true, serverManaged: true },
    ],
    actions: [
      { id: "n8n.trigger", label: "Trigger a workflow", writesExternally: true, toolId: "n8n.trigger" },
    ],
    commands: [...UNIVERSAL_COMMANDS, "executeAction"],
    envVars: ["N8N_BASE_URL", "N8N_API_KEY", "N8N_CALLBACK_SECRET"],
  },
] as const;

export function getIntegrationDescriptor(id: string): IntegrationDescriptor | undefined {
  return INTEGRATION_CATALOG.find((d) => d.id === id);
}

/**
 * Resolves a user's phrasing to an integration id.
 *
 * Used by the JARVIS tools so "Gmail ka status batao" and "Drive test karo"
 * reach the Google integration rather than failing on an unknown id. It matches
 * only on names this system actually has; an unrecognised word returns null so
 * the tool can ask which integration was meant instead of guessing one.
 */
export function resolveIntegrationAlias(input: string): IntegrationId | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;

  // Exact id first, so a caller that already knows the id is never reinterpreted.
  if (INTEGRATION_CATALOG.some((d) => d.id === text)) return text as IntegrationId;

  // Maps before the bare "google" checks: "google maps" contains "google", and
  // the more specific match has to win or every Maps request becomes an Ads one.
  if (/\b(map|maps|naksha|nakshe)\b/.test(text)) return "google-maps";
  if (/\b(whatsapp|whats app|wa)\b/.test(text)) return "whatsapp";
  if (/\bn8n\b|\b(workflow|automation)s?\b/.test(text)) return "n8n";
  if (/\b(meta|facebook|fb|instagram|ig)\b/.test(text)) return "meta";
  if (/\b(google|gmail|drive|calendar|youtube|sheets?|docs?|adwords)\b/.test(text)) return "google";

  return null;
}

/**
 * Resolves a phrase to a Google sub-service, when one is named.
 *
 * Returns null for a bare "google", which is correct: the caller then operates
 * on the whole Google integration rather than silently picking a service.
 */
export function resolveGoogleServiceAlias(input: string): GoogleServiceId | null {
  const text = input.trim().toLowerCase();
  if (/\bgmail\b|\bmail\b|\bemail\b/.test(text)) return "gmail";
  if (/\bdrive\b/.test(text)) return "drive";
  if (/\bcalendar\b|\bcal\b/.test(text)) return "calendar";
  if (/\byoutube\b|\byt\b/.test(text)) return "youtube";
  if (/\bsheets?\b|\bspreadsheets?\b/.test(text)) return "sheets";
  if (/\bdocs?\b|\bdocuments?\b/.test(text)) return "docs";
  if (/\bads?\b|\badwords\b|\bcampaigns?\b/.test(text)) return "ads";
  return null;
}
