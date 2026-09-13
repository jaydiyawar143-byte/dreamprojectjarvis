// ---------------------------------------------------------------------------
// IntegrationCommandService — THE single path.
//
// Both ways of operating an integration end here:
//
//     Frontend button  ──┐
//                        ├──► IntegrationCommandService.execute() ──► provider
//     JARVIS command  ───┘
//
// There is no second implementation. The REST router is a thin translation of
// HTTP into `IntegrationCommandInput`; the JARVIS tools are a thin translation
// of a sentence into the same shape. Neither holds business logic, neither
// talks to a provider, and neither can skip a check the other performs —
// because the checks live in one method that both of them call.
//
// WHY THAT MATTERS BEYOND TIDINESS. Permission checks, rate limits, audit rows
// and write confirmations are all enforced here. A second path — a "quick"
// endpoint for the dashboard, a tool that calls a provider directly — would be
// a path on which those are absent, and it would be absent quietly. The parity
// test in this repository asserts that both arms reach this same instance.
//
// WHAT THIS SERVICE DOES NOT DO.
//
// 1. It does not RE-IMPLEMENT health checks. `integration-registry.ts` already
//    owns the cheapest real call that proves each credential works, and those
//    are already pinned by tests. This composes it; it does not fork it.
//
// 2. It does not EXECUTE provider writes itself. Execution runs
//    USER → ToolExecutor → permission → approval → journal → audit, and that
//    boundary is the reason a compromised model cannot spend money. This
//    service GATES an action — resolves it, checks the connection, demands a
//    confirmation — and then hands it to the executor. A write path that
//    bypassed ToolExecutor would be the one hole worth none of this work.
//
// 3. It never returns a secret. Not in a view, not in an error, not in an audit
//    row. Provider errors are classified into a code and a bounded message
//    before they leave.
// ---------------------------------------------------------------------------

import {
  ATTENTION_HEALTH,
  getIntegrationDescriptor,
  INTEGRATION_CATALOG,
  describeScope,
  GOOGLE_IDENTITY_SCOPES,
  scopesForConnect,
  scopesForWriteUpgrade,
  GOOGLE_SERVICES,
  servicesFromGrantedScopes,
  isIntegrationId,
  type IntegrationAuditEntry,
  type IntegrationCommand,
  type IntegrationCommandContext,
  type IntegrationCommandInput,
  type IntegrationCommandResult,
  type IntegrationConnectionState,
  type IntegrationDescriptor,
  type IntegrationErrorCode,
  type IntegrationHealth,
  type IntegrationId,
  type IntegrationPermission,
  type IntegrationUsage,
  type IntegrationView,
  type IGoogleConnectionRepository,
  type IOAuthStateRepository,
  type IToolExecutor,
} from "@jarvis/core";
import type { AuditLogger } from "@jarvis/security";
import {
  buildAuthUrl,
  createPkcePair,
  createState,
  refreshAccessToken,
  revokeToken,
  GoogleOAuthError,
  type GoogleConfig,
} from "@jarvis/google-ads";
import {
  googleMapsMonthlyLimit,
  isGoogleMapsBrowserConfigured,
  isGoogleMapsServerConfigured,
  isWhatsAppConfigured,
} from "./environment.js";
import { maskConfig, validateConfig, type ValidationIssue } from "./config-validation.js";
import { consumeConfirmation, issueConfirmation } from "./confirmations.js";
import {
  getIntegration as describeIntegration,
  invalidateChecks,
  runCheck,
  type CheckResult,
  type IntegrationDeps,
} from "../integration-registry.js";

/** Consent must be completed promptly; a stale state is not honoured. */
const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Per-user ceilings for the verbs that reach a provider.
 *
 * Sized for a person operating a settings page, not for a loop: a human tests a
 * connection a handful of times while fixing a key, then stops. A tighter
 * bucket for connect/reconnect because each one starts an OAuth round trip.
 */
export const INTEGRATION_RATE_LIMITS = {
  test: { limit: 20, windowMs: 60_000 },
  connect: { limit: 10, windowMs: 60_000 },
  configure: { limit: 30, windowMs: 60_000 },
  action: { limit: 30, windowMs: 60_000 },
} as const;

export interface RateLimitPort {
  check(
    userId: string,
    bucket: string,
    limit: number,
    windowMs: number
  ): Promise<{ allowed: boolean; currentCount: number; limit: number }>;
}

export interface CredentialPort {
  /** Decrypted values, or null when nothing is stored. */
  read(userId: string, provider: string): Promise<Record<string, string> | null>;
  /** Encrypts and stores. Callers pass the MERGED set, never a partial. */
  write(userId: string, provider: string, values: Record<string, string>): Promise<void>;
  remove(userId: string, provider: string): Promise<void>;
}

export interface IntegrationStatePort {
  get(
    userId: string,
    integration: string
  ): Promise<{ enabled: boolean; enabledServices: string[]; lastSuccessfulSyncAt: string | null }>;
  patch(
    userId: string,
    integration: string,
    changes: Partial<{ enabled: boolean; enabledServices: string[]; lastSuccessfulSyncAt: string | null }>
  ): Promise<{ enabled: boolean; enabledServices: string[]; lastSuccessfulSyncAt: string | null }>;
  clear(userId: string, integration: string): Promise<void>;
}

export interface IntegrationCommandDeps {
  credentials: CredentialPort;
  state: IntegrationStatePort;
  audit: AuditLogger;
  rateLimiter: RateLimitPort;
  /** Null when the Google OAuth routes are not mounted. */
  googleConnections: IGoogleConnectionRepository | null;
  oauthStates: IOAuthStateRepository | null;
  /** Resolves server OAuth configuration, or null when unconfigured. */
  googleConfig: () => GoogleConfig | null;
  /** Current Maps usage, or null when the guard is not installed. */
  mapsUsage: () => Promise<IntegrationUsage | null>;
  /**
   * The ONE execution authority. Bound after construction by `setExecutor`,
   * because the tool registry it is built from must contain the integration
   * tools that call back into this service. Absent means `executeAction` is
   * unavailable and says so.
   */
  executor?: IToolExecutor;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function ok<T>(
  command: IntegrationCommand,
  integration: IntegrationId | null,
  data: T,
  message: string,
  view?: IntegrationView
): IntegrationCommandResult<T> {
  return {
    ok: true,
    command,
    integration,
    data,
    message,
    at: new Date().toISOString(),
    ...(view ? { view } : {}),
  };
}

function fail(
  command: IntegrationCommand,
  integration: IntegrationId | null,
  code: IntegrationErrorCode,
  message: string,
  extra?: Partial<Extract<IntegrationCommandResult, { ok: false }>>
): IntegrationCommandResult<never> {
  return {
    ok: false,
    command,
    integration,
    code,
    message,
    at: new Date().toISOString(),
    ...extra,
  };
}

/**
 * Bounds and strips a provider's rejection notice.
 *
 * A provider message says whether a token expired or a permission is missing,
 * which is exactly what an operator needs. It is truncated so a provider cannot
 * push an essay into the UI or an audit row, and `redactSecrets` upstream in
 * the audit logger catches anything token-shaped that slips through.
 */
function safeMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : fallback;
  return raw.slice(0, 300);
}

// ---------------------------------------------------------------------------

export class IntegrationCommandService {
  private readonly now: () => Date;

  constructor(private readonly deps: IntegrationCommandDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Binds the execution authority after construction.
   *
   * Needed because the object graph is genuinely circular: the JARVIS
   * integration tools must exist before the tool registry is frozen into the
   * agents' function definitions, the ToolExecutor is built FROM that registry,
   * and this service needs the executor to run an action. Something has to be
   * late-bound, and an executor injected once at startup is the smallest and
   * most visible choice.
   *
   * Not a general setter: it refuses to replace an executor that is already
   * bound, so nothing at request time can swap the authority that enforces
   * approvals.
   */
  setExecutor(executor: IToolExecutor): void {
    if (this.deps.executor) {
      throw new Error("IntegrationCommandService already has an executor bound");
    }
    this.deps.executor = executor;
  }

  /** The `IntegrationDeps` the existing health registry expects. */
  private registryDeps(): IntegrationDeps {
    return {
      googleConnections: this.deps.googleConnections,
      readMetaCredentials: async (userId) => {
        const stored = await this.deps.credentials.read(userId, "meta");
        if (!stored) return null;
        return {
          ...(stored.accessToken ? { accessToken: stored.accessToken } : {}),
          ...(stored.adAccountId ? { adAccountId: stored.adAccountId } : {}),
        };
      },
      googleOAuthMounted: this.deps.googleConfig() !== null,
    };
  }

  // -------------------------------------------------------------------------
  // The single entry point
  // -------------------------------------------------------------------------

  /**
   * Runs one command.
   *
   * Every caller — router or tool — arrives here. The order below is the
   * security order and is deliberate: identify the integration, refuse unknown
   * or unsupported verbs, THEN rate-limit, THEN act, THEN audit. Auditing last
   * would miss a throttled attempt, which is precisely the pattern worth having
   * a record of.
   */
  async execute(
    input: IntegrationCommandInput,
    context: IntegrationCommandContext
  ): Promise<IntegrationCommandResult> {
    const { command } = input;

    if (command === "list") {
      return this.handleList(context);
    }

    const id = input.integration;
    if (!id || !isIntegrationId(id)) {
      return fail(
        command,
        null,
        "UNKNOWN_INTEGRATION",
        `"${String(id ?? "")}" is not an integration this system manages. Known: ${INTEGRATION_CATALOG.map((d) => d.id).join(", ")}.`
      );
    }

    const descriptor = getIntegrationDescriptor(id);
    if (!descriptor) {
      return fail(command, id, "UNKNOWN_INTEGRATION", "Unknown integration.");
    }

    // A REFUSED attempt is audited too. "Who tried to disconnect the n8n
    // integration and when" is an audit question even though the answer is
    // "they could not" — recording only what succeeded would leave probing
    // invisible, which is precisely the pattern worth seeing.
    if (!descriptor.commands.includes(command)) {
      const refusal = fail(
        command,
        id,
        "UNSUPPORTED_COMMAND",
        this.explainUnsupported(descriptor, command)
      );
      await this.audit(command, id, context, refusal);
      return refusal;
    }

    const throttled = await this.checkRateLimit(command, id, context);
    if (throttled) {
      await this.audit(command, id, context, throttled);
      return throttled;
    }

    try {
      const result = await this.dispatch(command, id, descriptor, input, context);
      await this.audit(command, id, context, result);
      return result;
    } catch (error) {
      // An exception here is a bug or an unreachable provider. Neither message
      // is safe to forward verbatim — a thrown fetch error can carry a URL with
      // a key in its query string.
      const result = fail(
        command,
        id,
        "INTERNAL_ERROR",
        "The command could not be completed. The server log has the detail."
      );
      await this.audit(command, id, context, result, safeMessage(error, "unknown"));
      return result;
    }
  }

  /** Says WHY a verb is unavailable, which is more useful than "unsupported". */
  private explainUnsupported(
    descriptor: IntegrationDescriptor,
    command: IntegrationCommand
  ): string {
    if (descriptor.configKind === "server-managed" && (command === "connect" || command === "configure" || command === "disconnect")) {
      return `${descriptor.name} is configured by server environment variables (${descriptor.envVars.join(", ")}) and cannot be ${command === "disconnect" ? "disconnected" : "changed"} at runtime. Change the environment and restart.`;
    }
    if (descriptor.configKind === "form" && command === "connect") {
      return `${descriptor.name} is connected by saving credentials, not by a consent redirect. Use configure.`;
    }
    if (descriptor.configKind === "oauth" && command === "connect") {
      return `${descriptor.name} does not support that.`;
    }
    return `${descriptor.name} does not support "${command}".`;
  }

  private async checkRateLimit(
    command: IntegrationCommand,
    id: IntegrationId,
    context: IntegrationCommandContext
  ): Promise<IntegrationCommandResult | null> {
    const bucket =
      command === "testConnection"
        ? INTEGRATION_RATE_LIMITS.test
        : command === "connect" || command === "reconnect"
          ? INTEGRATION_RATE_LIMITS.connect
          : command === "configure"
            ? INTEGRATION_RATE_LIMITS.configure
            : command === "executeAction"
              ? INTEGRATION_RATE_LIMITS.action
              : null;

    if (!bucket) return null;

    const decision = await this.deps.rateLimiter.check(
      context.userId,
      command,
      bucket.limit,
      bucket.windowMs
    );
    if (decision.allowed) return null;

    return fail(
      command,
      id,
      "RATE_LIMITED",
      `Too many ${command} requests. The limit is ${decision.limit} per minute; try again shortly.`
    );
  }

  private async dispatch(
    command: IntegrationCommand,
    id: IntegrationId,
    descriptor: IntegrationDescriptor,
    input: IntegrationCommandInput,
    context: IntegrationCommandContext
  ): Promise<IntegrationCommandResult> {
    switch (command) {
      case "status":
        return ok(command, id, await this.buildView(id, context.userId), `${descriptor.name} status read.`);
      case "getHealth":
        return this.handleHealth(id, descriptor, context);
      case "connect":
        return this.handleConnect(id, descriptor, input, context);
      case "configure":
        return this.handleConfigure(id, descriptor, input, context, true);
      case "validateConfig":
        return this.handleConfigure(id, descriptor, input, context, false);
      case "testConnection":
        return this.handleTest(id, descriptor, context);
      case "getPermissions":
        return this.handlePermissions(id, descriptor, context);
      case "reconnect":
        return this.handleReconnect(id, descriptor, input, context);
      case "enable":
        return this.handleToggle(id, descriptor, context, true);
      case "disable":
        return this.handleToggle(id, descriptor, context, false);
      case "disconnect":
        return this.handleDisconnect(id, descriptor, context);
      case "getAudit":
        return this.handleAudit(id, descriptor, input, context);
      case "executeAction":
        return this.handleExecuteAction(id, descriptor, input, context);
      default:
        return fail(command, id, "UNSUPPORTED_COMMAND", `"${command}" is not a known command.`);
    }
  }

  // -------------------------------------------------------------------------
  // View construction
  // -------------------------------------------------------------------------

  private async handleList(
    context: IntegrationCommandContext
  ): Promise<IntegrationCommandResult<{ integrations: IntegrationView[] }>> {
    const views = await Promise.all(
      INTEGRATION_CATALOG.map((d) => this.buildView(d.id, context.userId))
    );
    const attention = views.filter((v) => ATTENTION_HEALTH.includes(v.health)).length;
    const connected = views.filter((v) => v.connection === "CONNECTED").length;

    return ok(
      "list",
      null,
      { integrations: views },
      `${views.length} integrations: ${connected} connected${attention > 0 ? `, ${attention} needing attention` : ""}.`
    );
  }

  /**
   * Builds one integration's complete state.
   *
   * Health comes from `integration-registry.ts` — the existing engine, which
   * already refuses to report CONNECTED without a verified call. This adds the
   * configuration, permission and service-selection facts around it rather than
   * recomputing any of them.
   */
  async buildView(id: IntegrationId, userId: string): Promise<IntegrationView> {
    const descriptor = getIntegrationDescriptor(id)!;
    const [legacy, state, stored, usage] = await Promise.all([
      describeIntegration(userId, id, this.registryDeps()),
      this.deps.state.get(userId, id),
      descriptor.configKind === "server-managed"
        ? Promise.resolve(null)
        : this.deps.credentials.read(userId, id),
      id === "google-maps" ? this.deps.mapsUsage() : Promise.resolve(null),
    ]);

    const serverPresence = this.serverManagedPresence(id);
    const config = maskConfig(descriptor.fields, stored, serverPresence);
    const missingConfig = descriptor.fields
      .filter((f) => f.required)
      .filter((f) => !config.find((c) => c.name === f.name)?.hasValue)
      .map((f) => f.name);

    const connection = await this.connectionState(id, userId, stored, state.enabled);
    const permissions = await this.permissionsFor(id, userId, stored);

    // A disabled integration reports DISABLED regardless of what the health
    // engine says. The credential may be perfectly good; the user asked for it
    // not to be used, and a green "connected" dot on something switched off is
    // a lie about what the system will actually do.
    const health: IntegrationHealth = !state.enabled
      ? "DISABLED"
      : connection === "NEEDS_REAUTH"
        ? "NEEDS_REAUTH"
        : (legacy?.health as IntegrationHealth) ?? "NOT_CONNECTED";

    const enabledServices =
      id === "google"
        ? state.enabledServices.length > 0
          ? state.enabledServices
          : servicesFromGrantedScopes(
              (await this.deps.googleConnections?.findByUser(userId))?.scopes ?? []
            )
        : state.enabled
          ? descriptor.actions.map((a) => a.id)
          : [];

    return {
      id,
      name: descriptor.name,
      subtitle: descriptor.subtitle,
      category: descriptor.category,
      configKind: descriptor.configKind,
      connection,
      health,
      detail: !state.enabled
        ? "Switched off. Credentials are kept, so enabling needs no reconnection."
        : (legacy?.detail ?? "No configuration on record."),
      account: legacy?.account ?? null,
      config,
      configComplete: missingConfig.length === 0,
      missingConfig,
      permissions,
      actions: descriptor.actions.map((a) => ({
        ...a,
        available: state.enabled && connection === "CONNECTED",
      })),
      enabledServices,
      usage: usage ?? legacy?.usage ?? null,
      lastTestedAt: legacy?.lastCheckedAt ?? null,
      lastSuccessfulSyncAt: state.lastSuccessfulSyncAt,
      lastError: legacy?.lastError ?? null,
      effectiveSource: legacy?.effectiveSource ?? "none",
      supportedCommands: [...descriptor.commands],
    };
  }

  /** Whether each server-managed field actually has a value in the environment. */
  private serverManagedPresence(id: IntegrationId): Record<string, boolean> {
    if (id === "google-maps") {
      return {
        browserKey: isGoogleMapsBrowserConfigured(),
        serverKey: isGoogleMapsServerConfigured(),
        monthlyLimit: googleMapsMonthlyLimit() !== null,
      };
    }
    if (id === "whatsapp") {
      const on = isWhatsAppConfigured();
      return { phoneNumberId: on, accessToken: on, verifyToken: on, appSecret: on };
    }
    if (id === "n8n") {
      const on = Boolean(process.env.N8N_BASE_URL && process.env.N8N_API_KEY);
      return { baseUrl: on, apiKey: on, callbackSecret: Boolean(process.env.N8N_CALLBACK_SECRET) };
    }
    return {};
  }

  /**
   * Whether this integration is set up, as a fact about STORED configuration.
   *
   * Deliberately does not call a provider. "Is it set up" and "does it work"
   * are different questions with different costs, and collapsing them would
   * make a status page fire five external requests on every load.
   */
  private async connectionState(
    id: IntegrationId,
    userId: string,
    stored: Record<string, string> | null,
    enabled: boolean
  ): Promise<IntegrationConnectionState> {
    if (!enabled) return "DISABLED";

    if (id === "google") {
      if (!this.deps.googleConnections || !this.deps.googleConfig()) return "NOT_CONNECTED";
      const connection = await this.deps.googleConnections.findByUser(userId);
      if (!connection) return "NOT_CONNECTED";
      // An expired ACCESS token is normal — the refresh token exists for that.
      // It only becomes NEEDS_REAUTH once a refresh has actually been refused,
      // which `reconnect` records. Reporting re-auth on every expiry would send
      // users through consent hourly for no reason.
      return "CONNECTED";
    }

    if (id === "google-maps") {
      const browser = isGoogleMapsBrowserConfigured();
      const server = isGoogleMapsServerConfigured();
      if (browser && server) return "CONNECTED";
      if (browser || server) return "PARTIAL";
      return "NOT_CONNECTED";
    }

    if (id === "whatsapp") return isWhatsAppConfigured() ? "CONNECTED" : "NOT_CONNECTED";

    if (id === "n8n") {
      const on = Boolean(process.env.N8N_BASE_URL && process.env.N8N_API_KEY && process.env.N8N_CALLBACK_SECRET);
      const partial = Boolean(process.env.N8N_BASE_URL || process.env.N8N_API_KEY);
      return on ? "CONNECTED" : partial ? "PARTIAL" : "NOT_CONNECTED";
    }

    // meta
    const hasStored = Boolean(stored?.accessToken && stored?.adAccountId);
    const hasEnv = Boolean(process.env.META_ACCESS_TOKEN && process.env.META_AD_ACCOUNT_ID);
    if (hasStored || hasEnv) return "CONNECTED";
    if (stored && Object.keys(stored).length > 0) return "PARTIAL";
    return "NOT_CONNECTED";
  }

  // -------------------------------------------------------------------------
  // Verbs
  // -------------------------------------------------------------------------

  private async handleHealth(
    id: IntegrationId,
    descriptor: IntegrationDescriptor,
    context: IntegrationCommandContext
  ): Promise<IntegrationCommandResult> {
    const view = await this.buildView(id, context.userId);
    return ok(
      "getHealth",
      id,
      {
        health: view.health,
        connection: view.connection,
        detail: view.detail,
        lastTestedAt: view.lastTestedAt,
        lastSuccessfulSyncAt: view.lastSuccessfulSyncAt,
        lastError: view.lastError,
        usage: view.usage,
      },
      `${descriptor.name} is ${view.health}. ${view.detail}`,
      view
    );
  }

  /**
   * Begins an OAuth connection.
   *
   * Returns a URL rather than performing a redirect, because the two callers
   * consume it differently: the browser navigates to it, JARVIS reads it out or
   * renders it as a link. Returning a 302 would work for one and be useless to
   * the other.
   *
   * SCOPES ARE READ-ONLY HERE. `scopesForConnect` cannot produce a write scope,
   * so there is no argument to this method that could request one.
   */
  private async handleConnect(
    id: IntegrationId,
    descriptor: IntegrationDescriptor,
    input: IntegrationCommandInput,
    context: IntegrationCommandContext
  ): Promise<IntegrationCommandResult> {
    if (id !== "google") {
      return fail("connect", id, "UNSUPPORTED_COMMAND", this.explainUnsupported(descriptor, "connect"));
    }

    const config = this.deps.googleConfig();
    if (!config || !this.deps.oauthStates) {
      return fail(
        "connect",
        id,
        "NOT_CONFIGURED",
        "Google OAuth is not configured on this server. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI and restart."
      );
    }

    const writeUpgrade = input.accessLevel === "write";

    // Default to Ads only — the service this repository actually implements.
    // Connecting everything "just in case" is how consent screens become
    // meaningless, and the user can add a service later without re-typing
    // anything.
    //
    // A WRITE UPGRADE HAS NO DEFAULT. Asking for write access to a service the
    // user did not name is exactly the over-reach the progressive model exists
    // to prevent, so an unnamed service is refused rather than guessed.
    if (writeUpgrade && !input.services?.length) {
      return fail(
        "connect",
        id,
        "INVALID_CONFIG",
        "A write upgrade must name the services it is for — there is no default. Known services: gmail, drive, calendar."
      );
    }

    const requested = input.services?.length ? input.services : ["ads"];
    const unknown = requested.filter((s) => !scopesForConnect([s]).some((x) => !["openid", "email", "profile"].includes(x)));
    if (unknown.length > 0) {
      return fail(
        "connect",
        id,
        "INVALID_CONFIG",
        `Unknown Google service(s): ${unknown.join(", ")}. Known services: ads, gmail, drive, calendar, youtube, sheets, docs.`
      );
    }

    const { codeVerifier, codeChallenge } = createPkcePair();
    const state = createState();
    // The ONLY place a write scope is ever requested.
    //
    // `scopesForWriteUpgrade` returns read AND write scopes for each named
    // service, so an upgrade never silently drops read access the user already
    // had. `buildAuthUrl` sends `include_granted_scopes=true`, which is what
    // makes this incremental rather than a replacement: previously granted
    // scopes for other services survive the upgrade.
    const scopes = writeUpgrade
      ? [...GOOGLE_IDENTITY_SCOPES, ...scopesForWriteUpgrade(requested)]
      : scopesForConnect(requested);

    await this.deps.oauthStates.create({
      state,
      userId: context.userId,
      codeVerifier,
      redirectUri: config.redirectUri,
      expiresAt: new Date(this.now().getTime() + STATE_TTL_MS),
    });

    // Remember what was asked for, so the callback can report which services
    // Google actually granted versus which were requested.
    await this.deps.state.patch(context.userId, id, { enabledServices: requested });

    // The URL carries client_id and the PKCE CHALLENGE (a hash) — never the
    // verifier, never the client secret.
    const authUrl = buildAuthUrl({ config, state, codeChallenge, scopes });

    return ok(
      "connect",
      id,
      { authUrl, services: requested, scopes, accessLevel: writeUpgrade ? "write" : "read" },
      writeUpgrade
        ? `Open this link to grant JARVIS permission to CHANGE ${requested.join(", ")}. Every change will still ask for your approval first: ${authUrl}`
        : `Open this link to grant JARVIS read access to ${requested.join(", ")}: ${authUrl}`
    );
  }

  /**
   * Validates and (when `persist`) stores configuration.
   *
   * One function for both `configure` and `validateConfig` so the two can never
   * disagree about what "valid" means — a validator that differs from the saver
   * is a validator that passes things the saver rejects.
   */
  private async handleConfigure(
    id: IntegrationId,
    descriptor: IntegrationDescriptor,
    input: IntegrationCommandInput,
    context: IntegrationCommandContext,
    persist: boolean
  ): Promise<IntegrationCommandResult> {
    const command: IntegrationCommand = persist ? "configure" : "validateConfig";

    // Server-managed integrations have no writable configuration; validating
    // them means checking the ENVIRONMENT, which is a real and useful answer.
    if (descriptor.configKind === "server-managed") {
      return this.validateServerManaged(id, descriptor, command);
    }

    const submitted = (input.config ?? {}) as Record<string, unknown>;
    const stored = (await this.deps.credentials.read(context.userId, id)) ?? {};
    const existing = new Set(Object.keys(stored).filter((k) => stored[k]));

    const outcome = validateConfig(descriptor.fields, submitted, existing);

    if (!outcome.valid) {
      return fail(command, id, "INVALID_CONFIG", this.describeIssues(outcome.issues), {});
    }

    if (!persist) {
      return ok(
        "validateConfig",
        id,
        { valid: true, missing: outcome.missing, complete: outcome.missing.length === 0 },
        outcome.missing.length === 0
          ? `${descriptor.name} configuration is valid and complete. Run a connection test to verify it against the provider.`
          : `${descriptor.name} configuration is valid so far, but still missing: ${outcome.missing.join(", ")}.`
      );
    }

    // Merge, never replace: a partial update must not erase a stored secret the
    // caller did not resubmit.
    const merged: Record<string, string> = { ...stored };
    for (const [key, value] of Object.entries(outcome.normalized)) {
      if (value === "") delete merged[key];
      else merged[key] = value;
    }

    await this.deps.credentials.write(context.userId, id, merged);

    // A configuration change invalidates any remembered verdict — a card must
    // not keep showing a green tick earned by the previous key.
    invalidateChecks(context.userId, id);

    const view = await this.buildView(id, context.userId);
    return ok(
      "configure",
      id,
      { saved: Object.keys(outcome.normalized), missing: outcome.missing },
      outcome.missing.length === 0
        ? `${descriptor.name} configuration saved. Run a connection test to verify it.`
        : `${descriptor.name} configuration saved, but still missing: ${outcome.missing.join(", ")}.`,
      view
    );
  }

  /** Field names and format rules only — never a submitted value. */
  private describeIssues(issues: ValidationIssue[]): string {
    return issues.map((i) => i.message).join(" ");
  }

  private validateServerManaged(
    id: IntegrationId,
    descriptor: IntegrationDescriptor,
    command: IntegrationCommand
  ): IntegrationCommandResult {
    const presence = this.serverManagedPresence(id);
    const missing = descriptor.fields
      .filter((f) => f.required && !presence[f.name])
      .map((f) => f.name);

    if (id === "google-maps") {
      const browser = isGoogleMapsBrowserConfigured();
      const server = isGoogleMapsServerConfigured();

      // Maps is the one integration whose two keys have genuinely different
      // jobs, so "configured" is three states rather than two. Saying
      // "configured" for a browser-key-only deployment would hide that every
      // distance on screen came from OpenStreetMap.
      const detail = browser && server
        ? "Both keys are set. The browser key renders the map; the server key serves places, routing and geocoding."
        : browser
          ? "GOOGLE_MAPS_BROWSER_KEY is set, so the map renders. GOOGLE_MAPS_SERVER_KEY is not, so places, routing and geocoding fall back to OpenStreetMap."
          : server
            ? "GOOGLE_MAPS_SERVER_KEY is set, so places, routing and geocoding use Google. GOOGLE_MAPS_BROWSER_KEY is not, so the interactive map cannot render."
            : "Neither key is set. Set GOOGLE_MAPS_BROWSER_KEY for the map and GOOGLE_MAPS_SERVER_KEY for places, routing and geocoding.";

      return ok(
        command,
        id,
        {
          valid: browser || server,
          browserKeyConfigured: browser,
          serverKeyConfigured: server,
          // Stated rather than assumed: these are the restrictions Google
          // enforces, and a browser key without a referrer restriction is a
          // key anyone who views source can spend.
          restrictions: {
            browserKey: "Restrict by HTTP referrer in the Google Cloud console. This key is public by design.",
            serverKey: "Restrict by IP address. Never expose it to the browser.",
          },
          missing,
        },
        detail
      );
    }

    return ok(
      command,
      id,
      { valid: missing.length === 0, missing, envVars: descriptor.envVars },
      missing.length === 0
        ? `${descriptor.name} is fully configured from the server environment.`
        : `${descriptor.name} is missing server configuration: ${descriptor.envVars.join(", ")}. Set them and restart.`
    );
  }

  /**
   * Runs a REAL connection test.
   *
   * Delegates to `integration-registry.runCheck`, which performs the cheapest
   * call per provider that actually proves the credential works. Every one is a
   * READ: no message is sent, no workflow triggered, no campaign touched, so
   * testing a connection can never have a side effect the user did not ask for.
   */
  private async handleTest(
    id: IntegrationId,
    descriptor: IntegrationDescriptor,
    context: IntegrationCommandContext
  ): Promise<IntegrationCommandResult> {
    const state = await this.deps.state.get(context.userId, id);
    if (!state.enabled) {
      return fail(
        "testConnection",
        id,
        "NOT_CONNECTED",
        `${descriptor.name} is switched off. Enable it before testing.`
      );
    }

    let result: CheckResult | null;
    try {
      result = await runCheck(context.userId, id, this.registryDeps());
    } catch (error) {
      return fail("testConnection", id, "PROVIDER_ERROR", safeMessage(error, "The provider could not be reached."));
    }

    if (!result) {
      return fail("testConnection", id, "UNKNOWN_INTEGRATION", "No connection test exists for that integration.");
    }

    // A successful test is evidence data is flowing, so it advances the sync
    // marker. A failed one deliberately does not: the previous successful sync
    // is still the last time this actually worked, and overwriting it would
    // erase the one timestamp that tells an operator how long it has been down.
    if (result.health === "CONNECTED") {
      await this.deps.state.patch(context.userId, id, { lastSuccessfulSyncAt: result.checkedAt });
    }

    const view = await this.buildView(id, context.userId);

    if (result.health === "CONNECTED" || result.health === "DEGRADED") {
      return ok("testConnection", id, result, `${descriptor.name}: ${result.detail}`, view);
    }

    return fail(
      "testConnection",
      id,
      result.health === "NEEDS_REAUTH"
        ? "NEEDS_REAUTH"
        : result.health === "CONFIG_REQUIRED" || result.health === "NOT_CONNECTED"
          ? "NOT_CONNECTED"
          : "PROVIDER_ERROR",
      `${descriptor.name}: ${result.detail}`
    );
  }

  private async handlePermissions(
    id: IntegrationId,
    descriptor: IntegrationDescriptor,
    context: IntegrationCommandContext
  ): Promise<IntegrationCommandResult> {
    const stored = descriptor.configKind === "server-managed"
      ? null
      : await this.deps.credentials.read(context.userId, id);
    const permissions = await this.permissionsFor(id, context.userId, stored);

    const granted = permissions.filter((p) => p.granted);
    const writes = granted.filter((p) => p.access === "write");

    return ok(
      "getPermissions",
      id,
      { permissions, grantedCount: granted.length, writeCount: writes.length },
      granted.length === 0
        ? `${descriptor.name} has no active permissions — nothing is connected.`
        : `${descriptor.name} has ${granted.length} active permission(s): ${granted.map((p) => p.label).join(", ")}.${writes.length === 0 ? " All read-only." : ` ${writes.length} of them allow changes, and every change is approval-gated.`}`
    );
  }

  /**
   * The permissions actually in force.
   *
   * For Google this reads the GRANTED scopes on the stored connection, never
   * the scopes that were requested: Google may grant fewer, and a system that
   * reports the request will claim access it does not have and then fail with a
   * 403 nobody can explain.
   */
  private async permissionsFor(
    id: IntegrationId,
    userId: string,
    stored: Record<string, string> | null
  ): Promise<IntegrationPermission[]> {
    if (id === "google") {
      const connection = await this.deps.googleConnections?.findByUser(userId);
      if (!connection) return [];

      const granted: IntegrationPermission[] = connection.scopes.map((scope) => {
        const described = describeScope(scope);
        return {
          id: scope,
          label: described.label,
          granted: true,
          access: described.access,
          ...(described.service ? { service: described.service } : {}),
        };
      });

      // WHAT IS NOT GRANTED IS ALSO A PERMISSION FACT.
      //
      // This used to return only the granted scopes, which reads as "this is
      // everything" and hides the one thing a user with an Ads-only connection
      // needs to see: that Gmail, Drive and Calendar writes are POSSIBLE and
      // simply not authorized yet. The UI had nothing to render an upgrade
      // control from, so "Gmail write permission is missing" was a dead end.
      //
      // Only services this build can actually write to are listed — an
      // unimplemented one would be an offer that leads nowhere.
      const held = new Set(connection.scopes);
      const pending: IntegrationPermission[] = GOOGLE_SERVICES.filter(
        (spec) =>
          spec.implemented &&
          spec.writeScopes.length > 0 &&
          !spec.writeScopes.every((scope) => held.has(scope))
      ).map((spec) => ({
        id: spec.writeScopes[0]!,
        label: `Modify ${spec.label} (approval-gated)`,
        granted: false,
        access: "write" as const,
        service: spec.id,
      }));

      return [...granted, ...pending];
    }

    if (id === "meta") {
      const has = Boolean(stored?.accessToken) || Boolean(process.env.META_ACCESS_TOKEN);
      return [
        { id: "ads_read", label: "Read ad accounts, campaigns and insights", granted: has, access: "read" },
        { id: "ads_management", label: "Change campaign status and budgets (approval-gated)", granted: has, access: "write" },
      ];
    }

    if (id === "whatsapp") {
      const on = isWhatsAppConfigured();
      return [
        { id: "whatsapp_business_messaging", label: "Receive inbound messages", granted: on, access: "read" },
        { id: "whatsapp_business_send", label: "Send messages (approval-gated)", granted: on, access: "write" },
      ];
    }

    if (id === "n8n") {
      const on = Boolean(process.env.N8N_BASE_URL && process.env.N8N_API_KEY);
      return [
        { id: "workflow_read", label: "List registered workflows", granted: on, access: "read" },
        { id: "workflow_execute", label: "Trigger workflows (approval-gated)", granted: on, access: "write" },
      ];
    }

    // google-maps — API keys carry no scope model; the enabled APIs are the
    // permission, and which are enabled is a Cloud console fact this server
    // cannot read without spending a request per API. Reported as capability.
    const server = isGoogleMapsServerConfigured();
    return [
      { id: "maps_js", label: "Render the interactive map", granted: isGoogleMapsBrowserConfigured(), access: "read" },
      { id: "places", label: "Search places", granted: server, access: "read" },
      { id: "routes", label: "Compute routes and travel time", granted: server, access: "read" },
      { id: "geocoding", label: "Resolve addresses to coordinates", granted: server, access: "read" },
    ];
  }

  /**
   * Re-establishes authorization without discarding the connection.
   *
   * For Google this tries a token REFRESH first. That is the cheap, silent path
   * and it fixes the common case — an expired access token — without dragging
   * the user through a consent screen. Only when the refresh is actually
   * REFUSED does this escalate to re-consent, and then it says so plainly and
   * returns a URL rather than pretending to have fixed it.
   */
  private async handleReconnect(
    id: IntegrationId,
    descriptor: IntegrationDescriptor,
    input: IntegrationCommandInput,
    context: IntegrationCommandContext
  ): Promise<IntegrationCommandResult> {
    if (id === "meta") {
      // Nothing to refresh: a Meta token is long-lived and user-supplied, so
      // "reconnect" means "verify it again".
      return this.handleTest(id, descriptor, context);
    }

    if (id !== "google") {
      return fail("reconnect", id, "UNSUPPORTED_COMMAND", this.explainUnsupported(descriptor, "reconnect"));
    }

    const config = this.deps.googleConfig();
    if (!config || !this.deps.googleConnections) {
      return fail("reconnect", id, "NOT_CONFIGURED", "Google OAuth is not configured on this server.");
    }

    const credentials = await this.deps.googleConnections.getCredentials(context.userId);
    if (!credentials) {
      // Nothing to refresh, so this is really a first connection. Answering
      // with the consent link rather than a bare "not connected" is the
      // difference between an error and an instruction — but the command is
      // still reported as `reconnect`, because that is what was asked for.
      const connect = await this.handleConnect(id, descriptor, input, context);
      return fail(
        "reconnect",
        id,
        "NOT_CONNECTED",
        connect.ok
          ? `There is no Google connection to refresh. ${connect.message}`
          : `There is no Google connection to refresh, and a new one cannot be started: ${connect.message}`
      );
    }

    try {
      const refreshed = await refreshAccessToken(
        config,
        credentials.refreshToken,
        this.deps.fetchImpl as never
      );
      await this.deps.googleConnections.updateAccessToken(
        context.userId,
        refreshed.accessToken,
        refreshed.expiresAt
      );
      invalidateChecks(context.userId, id);

      const view = await this.buildView(id, context.userId);
      return ok(
        "reconnect",
        id,
        { refreshed: true, expiresAt: refreshed.expiresAt.toISOString() },
        "Google access token refreshed. No re-consent was needed.",
        view
      );
    } catch (error) {
      // A refused refresh means the grant is gone at Google's end — revoked by
      // the user, or expired. Re-consent is the only fix, and saying so with a
      // link is more useful than an error code.
      const needsConsent =
        error instanceof GoogleOAuthError &&
        error.classified.code === "AUTHENTICATION_REQUIRED";

      const connect = await this.handleConnect(id, descriptor, input, context);
      const authUrl = connect.ok ? (connect.data as { authUrl: string }).authUrl : null;

      return fail(
        "reconnect",
        id,
        "NEEDS_REAUTH",
        needsConsent
          ? `Google refused the refresh token, so the grant no longer exists. Re-authorize here: ${authUrl ?? "(OAuth is not configured)"}`
          : `Could not refresh the Google token: ${safeMessage(error, "the provider did not respond")}. Re-authorize here: ${authUrl ?? "(OAuth is not configured)"}`
      );
    }
  }

  private async handleToggle(
    id: IntegrationId,
    descriptor: IntegrationDescriptor,
    context: IntegrationCommandContext,
    enabled: boolean
  ): Promise<IntegrationCommandResult> {
    await this.deps.state.patch(context.userId, id, { enabled });
    // A toggle changes what the system will DO, so any remembered verdict is
    // stale regardless of which direction it went.
    invalidateChecks(context.userId, id);

    const view = await this.buildView(id, context.userId);
    return ok(
      enabled ? "enable" : "disable",
      id,
      { enabled },
      enabled
        ? `${descriptor.name} enabled. Credentials were kept, so no reconnection is needed.`
        : `${descriptor.name} disabled. Its credentials are kept; JARVIS will not use it until it is enabled again.`,
      view
    );
  }

  /**
   * Removes the connection.
   *
   * For Google: revoke at Google FIRST (best effort), then locally. Local
   * revocation happens even if Google is unreachable — a network blip must not
   * leave a user unable to stop JARVIS holding a credential they have asked it
   * to forget. That ordering is a deliberate choice to fail toward less access.
   */
  private async handleDisconnect(
    id: IntegrationId,
    descriptor: IntegrationDescriptor,
    context: IntegrationCommandContext
  ): Promise<IntegrationCommandResult> {
    if (id === "google") {
      if (!this.deps.googleConnections) {
        return fail("disconnect", id, "NOT_CONFIGURED", "Google OAuth is not configured on this server.");
      }
      const credentials = await this.deps.googleConnections.getCredentials(context.userId);
      if (!credentials) {
        return ok("disconnect", id, { disconnected: false }, "There was no active Google connection to disconnect.");
      }

      const config = this.deps.googleConfig();
      let revokedAtGoogle = false;
      if (config) {
        revokedAtGoogle = await revokeToken(config, credentials.refreshToken, this.deps.fetchImpl as never);
      }
      await this.deps.googleConnections.revoke(context.userId);
      await this.deps.credentials.remove(context.userId, id);
      await this.deps.state.clear(context.userId, id);
      invalidateChecks(context.userId, id);

      const view = await this.buildView(id, context.userId);
      return ok(
        "disconnect",
        id,
        { disconnected: true, revokedAtGoogle },
        revokedAtGoogle
          ? "Google disconnected and the token revoked at Google."
          : "Google disconnected locally. Google could not be reached to revoke the token — revoke it manually at myaccount.google.com if that matters to you.",
        view
      );
    }

    if (descriptor.configKind === "form") {
      await this.deps.credentials.remove(context.userId, id);
      await this.deps.state.clear(context.userId, id);
      invalidateChecks(context.userId, id);

      const view = await this.buildView(id, context.userId);
      return ok(
        "disconnect",
        id,
        { disconnected: true },
        `${descriptor.name} credentials removed.`,
        view
      );
    }

    return fail("disconnect", id, "UNSUPPORTED_COMMAND", this.explainUnsupported(descriptor, "disconnect"));
  }

  /**
   * This integration's recent activity, from the SAME audit table everything
   * else writes to — not a separate feed that could disagree with it.
   */
  private async handleAudit(
    id: IntegrationId,
    descriptor: IntegrationDescriptor,
    input: IntegrationCommandInput,
    context: IntegrationCommandContext
  ): Promise<IntegrationCommandResult> {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);

    const rows = await this.deps.audit.query({
      userId: context.userId,
      // A generous window; the limit below is what actually bounds the result.
      startDate: new Date(this.now().getTime() - 30 * 24 * 60 * 60 * 1000),
      endDate: this.now(),
      limit: 500,
    });

    const entries: IntegrationAuditEntry[] = rows
      .filter((row) => {
        if (!String(row.action).startsWith("integration.")) return false;
        const meta = (row.metadata ?? {}) as Record<string, unknown>;
        return meta.integration === id;
      })
      .slice(0, limit)
      .map((row) => {
        const meta = (row.metadata ?? {}) as Record<string, unknown>;
        return {
          id: String(row.id),
          integration: id,
          command: String(row.action).replace(/^integration\./, ""),
          result: row.result === "success" ? ("success" as const) : ("failure" as const),
          at: new Date(row.timestamp ?? this.now()).toISOString(),
          ...(typeof meta.detail === "string" ? { detail: meta.detail } : {}),
        };
      });

    return ok(
      "getAudit",
      id,
      { entries },
      entries.length === 0
        ? `No recorded activity for ${descriptor.name} in the last 30 days.`
        : `${entries.length} recent ${descriptor.name} event(s), most recent first.`
    );
  }

  /**
   * Gates a provider action, then hands it to the ONE execution authority.
   *
   * This method does not call a provider. It resolves the action, refuses it if
   * the integration is not connected, demands a confirmation for anything that
   * writes outside JARVIS, and then delegates to ToolExecutor — which runs the
   * permission check, the approval gate, the execution journal and the audit.
   *
   * Duplicating any of that here would produce a second write path with weaker
   * guarantees, which is exactly the thing this architecture exists to prevent.
   */
  private async handleExecuteAction(
    id: IntegrationId,
    descriptor: IntegrationDescriptor,
    input: IntegrationCommandInput,
    context: IntegrationCommandContext
  ): Promise<IntegrationCommandResult> {
    const actionId = input.actionId ?? "";
    const action = descriptor.actions.find((a) => a.id === actionId);
    if (!action) {
      return fail(
        "executeAction",
        id,
        "UNKNOWN_INTEGRATION",
        `${descriptor.name} has no action "${actionId}". Available: ${descriptor.actions.map((a) => a.id).join(", ")}.`
      );
    }

    const view = await this.buildView(id, context.userId);
    if (view.connection !== "CONNECTED") {
      return fail(
        "executeAction",
        id,
        view.connection === "NEEDS_REAUTH" ? "NEEDS_REAUTH" : "NOT_CONNECTED",
        `${descriptor.name} is ${view.connection.toLowerCase().replace(/_/g, " ")}. ${view.detail}`
      );
    }

    const params = input.actionParams ?? {};

    if (action.writesExternally) {
      // A voice session cannot render a confirmation the user can read and
      // check, so it does not get to confirm a write at all. Speech is a fine
      // way to ASK for one; it is not a fine way to authorize it.
      if (context.voice) {
        return fail(
          "executeAction",
          id,
          "CONFIRMATION_REQUIRED",
          `"${action.label}" changes something outside JARVIS, so it cannot be confirmed by voice. Open the Integrations page to review and confirm it.`
        );
      }

      if (!input.confirmationToken) {
        const confirmation = issueConfirmation({
          userId: context.userId,
          integration: id,
          actionId,
          params,
          summary: this.describeWrite(descriptor, action.label, params),
          irreversible: true,
        });
        return fail(
          "executeAction",
          id,
          "CONFIRMATION_REQUIRED",
          confirmation.summary,
          { confirmationRequired: confirmation }
        );
      }

      const consumed = consumeConfirmation({
        token: input.confirmationToken,
        userId: context.userId,
        integration: id,
        actionId,
        params,
      });
      if (!consumed.ok) {
        return fail(
          "executeAction",
          id,
          "CONFIRMATION_REQUIRED",
          consumed.reason === "expired"
            ? "That confirmation has expired. Ask again and confirm the fresh summary."
            : consumed.reason === "mismatch"
              ? "That confirmation was issued for a different action or different parameters, so it was not accepted. Ask again."
              : "That confirmation is not recognised. Ask again and confirm the fresh summary."
        );
      }
    }

    if (!action.toolId || !this.deps.executor) {
      return fail(
        "executeAction",
        id,
        "UNSUPPORTED_COMMAND",
        `"${action.label}" has no executable tool wired in this deployment.`
      );
    }

    const execution = await this.deps.executor.execute({
      toolId: action.toolId,
      params,
      userId: context.userId,
      // The caller's real role is supplied by the router; `user` is the floor,
      // never an escalation — ToolExecutor re-checks permissions regardless.
      role: context.role ?? "viewer",
      traceId: context.traceId ?? `integration-${Date.now()}`,
    });

    const awaitingApproval =
      execution.status === "approval_required" || execution.status === "approval_pending";

    if (execution.status !== "completed" || !execution.result?.success) {
      return fail(
        "executeAction",
        id,
        awaitingApproval ? "CONFIRMATION_REQUIRED" : "PROVIDER_ERROR",
        awaitingApproval
          ? `"${action.label}" is waiting for approval. Approve it on the Approvals page to let it run.`
          : (execution.error ?? execution.result?.error ?? "The action did not complete.").slice(0, 300)
      );
    }

    await this.deps.state.patch(context.userId, id, {
      lastSuccessfulSyncAt: new Date().toISOString(),
    });

    return ok(
      "executeAction",
      id,
      { actionId, result: execution.result.data, executionId: execution.executionId },
      `${action.label} completed.`
    );
  }

  /**
   * The sentence a user is asked to confirm.
   *
   * Names the specific target, because "confirm this action?" is not a question
   * anyone can answer correctly. Parameter VALUES are included — these are
   * campaign ids and phone numbers, not credentials, and a confirmation that
   * hides what it is about is worse than no confirmation at all.
   */
  private describeWrite(
    descriptor: IntegrationDescriptor,
    label: string,
    params: Record<string, unknown>
  ): string {
    const described = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `${k}=${String(v).slice(0, 80)}`)
      .join(", ");

    return `${label} on ${descriptor.name}${described ? ` (${described})` : ""}. This changes something outside JARVIS and cannot be undone from here. Confirm to proceed.`;
  }

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------

  /**
   * Records every command — success AND failure, read AND write.
   *
   * Reads are audited too, which is unusual and deliberate: "who listed the
   * integrations and when" is cheap to record and is exactly the question asked
   * when working out how far an intruder got.
   *
   * The metadata carries the integration, the outcome and the SOURCE, never a
   * credential and never a provider's raw response. `AuditLogger` redacts by
   * key and by value shape on top of that, so a token that reached here anyway
   * does not reach the table.
   */
  private async audit(
    command: IntegrationCommand,
    integration: IntegrationId,
    context: IntegrationCommandContext,
    result: IntegrationCommandResult,
    internalError?: string
  ): Promise<void> {
    try {
      await this.deps.audit.log({
        userId: context.userId,
        action: `integration.${command}`,
        result: result.ok ? "success" : "failure",
        ...(context.traceId ? { traceId: context.traceId } : {}),
        metadata: {
          integration,
          source: context.source,
          ...(result.ok ? {} : { code: result.code }),
          detail: result.ok ? result.message.slice(0, 200) : result.message.slice(0, 200),
          ...(internalError ? { internalError: internalError.slice(0, 200) } : {}),
        },
      });
    } catch {
      // An audit failure must not turn a successful disconnect into an error
      // the user retries. The write already happened; losing the row is bad,
      // reporting a false failure and provoking a retry is worse.
    }
  }
}
