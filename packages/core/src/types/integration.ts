// ---------------------------------------------------------------------------
// The universal integration contract.
//
// ONE RULE GIVES THIS FILE ITS SHAPE: every integration operation must be
// reachable two ways — a JARVIS sentence and a button — and both must land on
// the SAME backend service. That is only enforceable if both callers speak one
// vocabulary, so the verbs, the argument shapes and the result envelope are
// declared here, in the package both sides already depend on.
//
// What lives here is CONTRACT ONLY: types, the verb set, and the static
// catalogue in `integration-catalog.ts`. No HTTP, no database, no provider SDK,
// no secret. `@jarvis/core` is imported by the browser-facing types, the tool
// package and the API alike; anything executable would drag a provider into all
// three.
//
// THE ENVELOPE IS THE PARITY GUARANTEE. `IntegrationCommandResult` is what the
// REST route serialises and what the JARVIS tool hands its model. Because there
// is one type, a field that exists for the UI cannot quietly go missing for the
// agent, and a field that would leak a secret cannot be added "just for the
// frontend" — there is no frontend-only shape to add it to.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * The closed set of integration ids.
 *
 * Closed on purpose: an id is the key to a user's stored credentials, so a
 * request naming an unknown one must be rejected before any lookup happens
 * rather than passed through to a store that might do something helpful with
 * it. Adding an integration is a code change that goes through review.
 */
export const INTEGRATION_IDS = [
  "google",
  "google-maps",
  "whatsapp",
  "n8n",
  "meta",
] as const;

export type IntegrationId = (typeof INTEGRATION_IDS)[number];

export function isIntegrationId(value: unknown): value is IntegrationId {
  return typeof value === "string" && (INTEGRATION_IDS as readonly string[]).includes(value);
}

export type IntegrationCategory =
  | "google"
  | "maps"
  | "communication"
  | "automation"
  | "advertising";

/**
 * How an integration is configured. This decides which verbs are even
 * meaningful for it, so the UI and the agent both stop asking for an OAuth
 * connect on something configured by environment variables.
 *
 *   oauth          — established by a consent redirect. `configure` is not how
 *                    you connect it; `connect` is.
 *   form           — user-supplied secrets, stored encrypted server-side.
 *   server-managed — set by environment variables at deploy time. Neither
 *                    `connect` nor `configure` can change it at runtime, and
 *                    saying so is more honest than rendering a dead form.
 */
export type IntegrationConfigKind = "oauth" | "form" | "server-managed";

// ---------------------------------------------------------------------------
// Health and connection state
//
// Deliberately TWO axes, not one.
//
// `IntegrationConnectionState` answers "is it set up?" — a fact about stored
// configuration, knowable without touching the network.
// `IntegrationHealth` answers "does it actually work?" — knowable only after a
// real call to the provider.
//
// Collapsing them is the bug this whole feature exists to prevent: credentials
// being present is not a working connection, and a card that says CONNECTED
// because three form fields are non-empty is lying to its operator.
// ---------------------------------------------------------------------------

export type IntegrationConnectionState =
  /** Credentials/consent are on record for this user. */
  | "CONNECTED"
  /** Nothing is on record. */
  | "NOT_CONNECTED"
  /** Some required configuration is present, some is missing. */
  | "PARTIAL"
  /** Connected, but the provider has rejected the credential — user must re-consent. */
  | "NEEDS_REAUTH"
  /** Turned off by the user, without discarding the credential. */
  | "DISABLED";

export type IntegrationHealth =
  /** A real call to the provider succeeded. */
  | "CONNECTED"
  /** Reachable but not fully working — e.g. an expired access token. */
  | "DEGRADED"
  /** Everything needed is configured; nothing has been verified yet. */
  | "UNVERIFIED"
  /** The last verification failed. */
  | "ERROR"
  /** Nothing is configured. */
  | "NOT_CONNECTED"
  /** Partially configured — some required settings are missing. */
  | "CONFIG_REQUIRED"
  /** The provider rejected the stored authorization; re-consent required. */
  | "NEEDS_REAUTH"
  /** Switched off for this deployment or by this user. */
  | "DISABLED";

/** Health values an operator should act on. Used by the UI filter and by JARVIS. */
export const ATTENTION_HEALTH: readonly IntegrationHealth[] = [
  "ERROR",
  "DEGRADED",
  "CONFIG_REQUIRED",
  "NEEDS_REAUTH",
];

// ---------------------------------------------------------------------------
// Configuration schema
//
// Declared as data rather than as a Zod schema so it can cross the wire: the
// frontend renders a form from the same description the server validates
// against, which is what stops the two drifting into disagreement about what
// "valid" means.
// ---------------------------------------------------------------------------

export type IntegrationFieldKind = "secret" | "text" | "url" | "number" | "boolean";

export interface IntegrationFieldSpec {
  name: string;
  label: string;
  kind: IntegrationFieldKind;
  required: boolean;
  /** Shown to the user. Never an example of a REAL credential. */
  placeholder?: string;
  help?: string;
  /** Server-side format check. Source of truth for both sides' validation. */
  pattern?: string;
  /** Human description of `pattern`, used in the error message. */
  patternHint?: string;
  /**
   * True when this field is set by an environment variable and cannot be
   * changed through the API. Rendered read-only; rejected by `configure`.
   */
  serverManaged?: boolean;
}

/**
 * The state of ONE configuration field as reported back to a caller.
 *
 * `value` is populated only for non-secret fields. A secret reports
 * `hasValue` + `masked` and nothing else — there is no code path, and no type,
 * that can return a stored secret to a client. That is the point of splitting
 * this from `IntegrationFieldSpec`: the spec describes the input, this
 * describes what may be read back, and they are not the same set of facts.
 */
export interface IntegrationFieldState {
  name: string;
  label: string;
  kind: IntegrationFieldKind;
  required: boolean;
  hasValue: boolean;
  /** `••••••••` for a stored secret, null when empty. Never a real prefix. */
  masked: string | null;
  /** Non-secret values only. Always null when `kind === "secret"`. */
  value: string | null;
  serverManaged: boolean;
  help?: string;
}

// ---------------------------------------------------------------------------
// Permissions / scopes
// ---------------------------------------------------------------------------

export interface IntegrationPermission {
  /** The provider's own identifier — an OAuth scope URL, a Meta permission. */
  id: string;
  /** Plain English. What this actually lets JARVIS do. */
  label: string;
  /** Whether the provider has actually granted it. */
  granted: boolean;
  /** Reads cannot change anything; writes are approval-gated regardless. */
  access: "read" | "write";
  /** Which service inside the provider it belongs to, e.g. "gmail". */
  service?: string;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * A provider operation JARVIS can perform once connected — distinct from the
 * MANAGEMENT verbs below, which operate on the integration itself.
 */
export interface IntegrationActionSpec {
  id: string;
  label: string;
  /** Whether this deployment can run it right now. */
  available: boolean;
  /**
   * True for anything that changes state outside JARVIS. Everything marked here
   * stops at the approval boundary — the flag is documentation of a guarantee
   * enforced elsewhere (ToolApprovalService), never the enforcement itself.
   */
  writesExternally: boolean;
  /** Registry tool id that implements it, when one exists. */
  toolId?: string;
}

// ---------------------------------------------------------------------------
// The management verb set — the heart of the contract
// ---------------------------------------------------------------------------

/**
 * Every operation an integration supports, named identically on both paths.
 *
 * A button and a sentence produce the same member of this union, which is what
 * makes "the frontend and JARVIS do the same thing" a type-level fact rather
 * than a convention someone has to remember.
 */
export const INTEGRATION_COMMANDS = [
  "list",
  "status",
  "connect",
  "configure",
  "validateConfig",
  "testConnection",
  "getPermissions",
  "reconnect",
  "enable",
  "disable",
  "disconnect",
  "getHealth",
  "getAudit",
  "executeAction",
] as const;

export type IntegrationCommand = (typeof INTEGRATION_COMMANDS)[number];

/** Verbs that change stored state and must therefore be audited and rate-limited. */
export const MUTATING_COMMANDS: readonly IntegrationCommand[] = [
  "connect",
  "configure",
  "reconnect",
  "enable",
  "disable",
  "disconnect",
  "executeAction",
];

/** Verbs that reach an external provider and must therefore be rate-limited. */
export const PROVIDER_COMMANDS: readonly IntegrationCommand[] = [
  "connect",
  "testConnection",
  "reconnect",
  "disconnect",
  "executeAction",
];

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface IntegrationUsage {
  used: number;
  limit: number;
  percentUsed: number;
  level: string;
  blocked: boolean;
}

/** A non-secret description of the connected account. */
export interface IntegrationAccount {
  label: string;
  detail?: string;
}

/**
 * One integration's complete state, as handed to BOTH the browser and the model.
 *
 * There is no field on this type that could carry a credential, and that is a
 * deliberate structural control rather than a discipline: a future edit cannot
 * leak a token without adding a field on purpose, in a file whose header says
 * not to.
 */
export interface IntegrationView {
  id: IntegrationId;
  name: string;
  subtitle: string;
  category: IntegrationCategory;
  configKind: IntegrationConfigKind;

  connection: IntegrationConnectionState;
  health: IntegrationHealth;
  /** Plain English, actionable, never containing credential material. */
  detail: string;

  /** Non-secret account identity — an email the user consented with, an account id. */
  account: IntegrationAccount | null;

  /** Field-by-field configuration state. Secrets appear masked or not at all. */
  config: IntegrationFieldState[];
  /** True when every required field has a value. */
  configComplete: boolean;
  /** Names of required fields still empty. Names only — never values. */
  missingConfig: string[];

  permissions: IntegrationPermission[];
  actions: IntegrationActionSpec[];
  /** Sub-services the user has switched on, e.g. ["gmail", "drive"]. */
  enabledServices: string[];

  usage: IntegrationUsage | null;

  lastTestedAt: string | null;
  lastSuccessfulSyncAt: string | null;
  lastError: string | null;

  /** Where the running system actually reads this integration's config from. */
  effectiveSource: string;

  /** Which management verbs are meaningful for this integration right now. */
  supportedCommands: IntegrationCommand[];
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export interface IntegrationAuditEntry {
  id: string;
  integration: IntegrationId;
  command: IntegrationCommand | string;
  result: "success" | "failure";
  at: string;
  /** Non-secret context: which service, which health verdict. Never a value. */
  detail?: string;
}

// ---------------------------------------------------------------------------
// Result envelope
// ---------------------------------------------------------------------------

/**
 * What every command returns, on both paths.
 *
 * A discriminated union on `ok`, so a caller cannot read `.data` without having
 * established success. The failure arm carries a STABLE `code` for the UI to
 * branch on and a message already made safe for display — provider internals
 * are classified into a code upstream, never forwarded raw.
 */
export type IntegrationCommandResult<T = unknown> =
  | {
      ok: true;
      command: IntegrationCommand;
      integration: IntegrationId | null;
      data: T;
      /** Present when the verb changed state and produced a fresh view. */
      view?: IntegrationView;
      /** One sentence suitable for JARVIS to speak verbatim. */
      message: string;
      at: string;
    }
  | {
      ok: false;
      command: IntegrationCommand;
      integration: IntegrationId | null;
      code: IntegrationErrorCode;
      message: string;
      /**
       * Set when the caller must confirm before this will run. The UI renders a
       * dialog; JARVIS asks the question out loud. Neither may auto-confirm.
       */
      confirmationRequired?: IntegrationConfirmation;
      at: string;
    };

export type IntegrationErrorCode =
  | "UNKNOWN_INTEGRATION"
  | "NOT_CONFIGURED"
  | "NOT_CONNECTED"
  | "INVALID_CONFIG"
  | "NEEDS_REAUTH"
  | "PERMISSION_DENIED"
  | "CONFIRMATION_REQUIRED"
  | "RATE_LIMITED"
  | "PROVIDER_ERROR"
  | "TIMEOUT"
  | "UNSUPPORTED_COMMAND"
  | "INTERNAL_ERROR";

/**
 * A pending external write, described so a human can decide.
 *
 * `token` is what the confirmed call must echo back. It is bound server-side to
 * the user, the integration, the action and a hash of the parameters, so a
 * confirmation obtained for "pause campaign A" cannot be replayed to pause
 * campaign B — and a voice session cannot confirm something it never described.
 */
export interface IntegrationConfirmation {
  token: string;
  /** What will happen, in plain English, including the specific target. */
  summary: string;
  integration: IntegrationId;
  actionId: string;
  /** When the token stops being accepted. */
  expiresAt: string;
  /** True for anything irreversible — deletion, spend, an outbound message. */
  irreversible: boolean;
}

// ---------------------------------------------------------------------------
// Command arguments
// ---------------------------------------------------------------------------

export interface IntegrationCommandInput {
  command: IntegrationCommand;
  /** Null only for `list`. Every other verb names exactly one integration. */
  integration: IntegrationId | null;
  /**
   * Field values for `configure` / `validateConfig`. Secrets travel INBOUND
   * here and are never echoed back out.
   */
  config?: Record<string, string | number | boolean | null>;
  /** Sub-services to request scopes for on `connect` / `reconnect`. */
  services?: string[];
  /**
   * Which access level to request. Defaults to `read`.
   *
   * `write` is the ONLY way a write scope is ever requested, and it exists as a
   * separate explicit value rather than as extra entries in `services` so that
   * asking for write access is a distinct decision in the code as well as on
   * the consent screen. A caller that does not name it cannot obtain one.
   */
  accessLevel?: "read" | "write";
  /** For `executeAction`. */
  actionId?: string;
  actionParams?: Record<string, unknown>;
  /** Echoed from a prior `CONFIRMATION_REQUIRED` failure. */
  confirmationToken?: string;
  /** For `getAudit`. */
  limit?: number;
}

/**
 * Where a command came from.
 *
 * Recorded on every audit row. It does NOT change authorization — a voice
 * command and a click get identical checks, which is the whole point — but
 * "who did this and through what" is the first question asked after an
 * incident, and a system that cannot answer it is not auditable.
 */
export type IntegrationCommandSource = "frontend" | "jarvis" | "system";

export interface IntegrationCommandContext {
  userId: string;
  /**
   * The caller's role, threaded through to the execution authority.
   *
   * Never widened here: it is whatever the authenticated session says, and
   * ToolExecutor re-checks it against the tool's own required permissions. It
   * defaults to the LOWEST role when absent, so a caller that forgets to pass
   * one is under-privileged rather than over-privileged.
   */
  role?: "owner" | "admin" | "member" | "viewer";
  source: IntegrationCommandSource;
  /** Correlates this command with the HTTP request or tool execution. */
  traceId?: string;
  /**
   * True when the caller cannot render a confirmation dialog — a voice session.
   * Write actions are refused outright rather than confirmed by speech alone.
   */
  voice?: boolean;
}
