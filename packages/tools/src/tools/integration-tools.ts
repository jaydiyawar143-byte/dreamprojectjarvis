// ---------------------------------------------------------------------------
// JARVIS integration-management tools — the SECOND arm onto one service.
//
// Every tool here is a translation, not an implementation. It turns a model's
// arguments into an `IntegrationCommandInput` and hands it to
// `IntegrationCommandPort` — which the API implements by calling the very same
// `IntegrationCommandService` instance the REST routes call.
//
//     "JARVIS, Gmail connection test karo"  ──┐
//                                             ├──► IntegrationCommandService
//     [Test connection] button on the page  ──┘
//
// SO THERE IS NO PROVIDER LOGIC IN THIS FILE, and there must never be. Not an
// HTTP call, not a scope list, not an OAuth URL, not a key. A tool that reached
// a provider directly would be a path on which the permission check, the rate
// limit, the audit row and the write confirmation are all absent — and absent
// silently. The port is a deliberately narrow seam: one method, whose argument
// type makes it impossible to ask for anything the button cannot also ask for.
//
// WHY THE PORT AT ALL. `@jarvis/tools` must stay free of HTTP, databases and
// provider SDKs — the same reason `MapsPort` exists in this directory. The
// implementation lives in the API, where the encryption key and the Prisma
// client already are.
//
// RISK LEVELS ARE HONEST. Reads are READ_ONLY and auto-approve. `disconnect`
// revokes a token at Google, so it is EXTERNAL_SIDE_EFFECT and stops at the
// approval boundary like every other outward-facing change. `configure` writes
// only to our own encrypted store, so it is LOW_IMPACT.
// ---------------------------------------------------------------------------

import { BaseTool } from "../base-tool.js";
import type { ToolContext, ToolResult } from "@jarvis/core";
import {
  INTEGRATION_CATALOG,
  GOOGLE_SERVICES,
  resolveIntegrationAlias,
  resolveGoogleServiceAlias,
  type IntegrationCommandInput,
  type IntegrationCommandResult,
  type IntegrationId,
} from "@jarvis/core";

/**
 * The seam between a sentence and the command service.
 *
 * One method on purpose. A port with twelve methods would invite an
 * implementation that handles one of them differently from the REST route; with
 * one method taking the shared input type, "the tool does what the button does"
 * is the only thing it CAN do.
 */
export interface IntegrationCommandPort {
  execute(
    input: IntegrationCommandInput,
    context: {
      userId: string;
      source: "jarvis";
      traceId?: string;
      role?: "owner" | "admin" | "member" | "viewer";
    }
  ): Promise<IntegrationCommandResult>;
}

/** Names JARVIS will accept, listed once so every tool's help text agrees. */
const KNOWN = INTEGRATION_CATALOG.map((d) => `${d.id} (${d.name})`).join(", ");
const KNOWN_GOOGLE_SERVICES = GOOGLE_SERVICES.map((s) => s.id).join(", ");

/**
 * Resolves whatever the user said into an integration id.
 *
 * Returns a STRUCTURED ambiguity rather than a guess. "JARVIS, disconnect
 * karo" with no subject must produce a question, not a coin flip — the cost of
 * guessing wrong on a disconnect is a broken integration and a re-consent, and
 * the cost of asking is one short sentence.
 */
function resolve(raw: unknown): { id: IntegrationId } | { ask: string } {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) {
    return { ask: `Which integration did you mean? I manage: ${KNOWN}.` };
  }

  const id = resolveIntegrationAlias(text);
  if (!id) {
    return {
      ask: `I do not manage an integration called "${text.slice(0, 60)}". I manage: ${KNOWN}.`,
    };
  }
  return { id };
}

/**
 * The shared body of every tool.
 *
 * Each subclass supplies only the command and any extra arguments, so the
 * resolution, the ambiguity question and the result translation are written
 * once. A per-tool copy of this would be twelve chances to forget the
 * `ok: false` branch.
 */
abstract class IntegrationTool extends BaseTool {
  constructor(
    protected readonly port: IntegrationCommandPort,
    id: string,
    name: string,
    description: string,
    parameters: ConstructorParameters<typeof BaseTool>[4],
    requiresApproval = false,
    permissions: ConstructorParameters<typeof BaseTool>[6] = ["read"],
    risk: ConstructorParameters<typeof BaseTool>[7] = "READ_ONLY"
  ) {
    super(id, name, description, "integration", parameters, requiresApproval, permissions, risk);
  }

  /**
   * Runs a command and turns the envelope into a `ToolResult`.
   *
   * `message` is carried into both arms because it is written to be SPOKEN —
   * the service composes one sentence a model can relay verbatim, which is what
   * keeps a Hindi-English request from being answered with a JSON dump.
   */
  protected async run(
    input: IntegrationCommandInput,
    context: ToolContext
  ): Promise<ToolResult> {
    const result = await this.port.execute(input, {
      userId: context.userId,
      source: "jarvis",
      ...(context.traceId ? { traceId: context.traceId } : {}),
    });

    if (!result.ok) {
      return this.failure(result.message);
    }

    return this.success(result.data, {
      message: result.message,
      integration: result.integration,
      command: result.command,
      ...(result.view ? { health: result.view.health, connection: result.view.connection } : {}),
    });
  }

  /** One-parameter tools all take the same "which integration" argument. */
  protected async runOn(
    command: IntegrationCommandInput["command"],
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolResult> {
    const resolved = resolve(params.integration);
    if ("ask" in resolved) return this.failure(resolved.ask);
    return this.run({ command, integration: resolved.id }, context);
  }
}

const INTEGRATION_PARAM = [
  {
    name: "integration",
    type: "string",
    description: `Which integration. Accepts an id or a common name — ${KNOWN}. "gmail", "drive", "calendar", "youtube", "sheets", "docs" and "adwords" all resolve to the Google integration.`,
    required: true,
  },
] as const;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export class ListIntegrationsTool extends IntegrationTool {
  constructor(port: IntegrationCommandPort) {
    super(
      port,
      "integration.list",
      "List integrations",
      "Lists every integration JARVIS can manage with its connection state, health, connected account and what still needs configuring. Use this for 'kaunse integrations hain', 'what is connected', or when the user names no specific integration.",
      []
    );
  }

  async execute(_params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    return this.run({ command: "list", integration: null }, context);
  }
}

export class GetIntegrationStatusTool extends IntegrationTool {
  constructor(port: IntegrationCommandPort) {
    super(
      port,
      "integration.status",
      "Get integration status",
      "Reports one integration's full state: connected or not, health, the connected account, enabled services, permission summary, configuration completeness, last test and last successful sync. Use for 'Google ka status batao', 'Drive connected hai kya'.",
      [...INTEGRATION_PARAM]
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    return this.runOn("status", params, context);
  }
}

export class GetIntegrationHealthTool extends IntegrationTool {
  constructor(port: IntegrationCommandPort) {
    super(
      port,
      "integration.health",
      "Get integration health",
      "Reports health, the last error, the last successful sync and any usage counter. Narrower than status — use when the user asks whether something is working, degraded or erroring.",
      [...INTEGRATION_PARAM]
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    return this.runOn("getHealth", params, context);
  }
}

export class GetIntegrationPermissionsTool extends IntegrationTool {
  constructor(port: IntegrationCommandPort) {
    super(
      port,
      "integration.permissions",
      "Get integration permissions",
      "Lists the permissions and OAuth scopes actually GRANTED for an integration, each marked read or write. Use for 'kaunse permissions active hain', 'what access does JARVIS have', 'active scopes dikhao'.",
      [...INTEGRATION_PARAM]
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    return this.runOn("getPermissions", params, context);
  }
}

export class GetIntegrationAuditTool extends IntegrationTool {
  constructor(port: IntegrationCommandPort) {
    super(
      port,
      "integration.audit",
      "Get integration activity",
      "Recent recorded activity for one integration — connects, configuration changes, tests, reconnects and disconnects, with their outcomes. Use for 'is integration pe kya hua', 'recent activity dikhao'.",
      [
        ...INTEGRATION_PARAM,
        {
          name: "limit",
          type: "number",
          description: "How many entries to return. Default 20, maximum 100.",
          required: false,
        },
      ]
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const resolved = resolve(params.integration);
    if ("ask" in resolved) return this.failure(resolved.ask);

    const limit = Number(params.limit);
    return this.run(
      {
        command: "getAudit",
        integration: resolved.id,
        ...(Number.isFinite(limit) ? { limit } : {}),
      },
      context
    );
  }
}

/**
 * A REAL call to the provider.
 *
 * READ_ONLY despite reaching outside, because every provider test in this
 * system is a read that changes nothing: it reads a phone number's metadata, an
 * account list, a geocode. Marking it as a side effect would push a diagnostic
 * behind an approval, which is the wrong trade — a user debugging a broken
 * connection should not need a second person to let them check it.
 *
 * A NEGATIVE VERDICT IS A SUCCESSFUL TEST. "The token is invalid" is the ANSWER
 * to "test this connection", not a failure to answer it. Returning a failed
 * ToolResult for it makes the Orchestrator's all-tools-failed guard fire, and
 * the user asking precisely because something is broken gets "Data retrieval
 * failed" instead of the diagnosis they asked for. So a verdict comes back as
 * `success` carrying the bad news, and only things that genuinely PREVENTED a
 * test — a rate limit, an unknown integration — are failures.
 */
export class TestIntegrationConnectionTool extends IntegrationTool {
  constructor(port: IntegrationCommandPort) {
    super(
      port,
      "integration.test",
      "Test integration connection",
      "Performs a REAL, read-only call to the provider to verify the stored credentials actually work, and records the verdict. Use for 'Gmail test karo', 'connection test karo', 'check if Meta is working'. Sends nothing and changes nothing.",
      [...INTEGRATION_PARAM]
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const resolved = resolve(params.integration);
    if ("ask" in resolved) return this.failure(resolved.ask);

    const result = await this.port.execute(
      { command: "testConnection", integration: resolved.id },
      {
        userId: context.userId,
        source: "jarvis",
        ...(context.traceId ? { traceId: context.traceId } : {}),
      }
    );

    if (result.ok) {
      return this.success(result.data, {
        message: result.message,
        integration: result.integration,
        command: result.command,
      });
    }

    // Codes that mean "the test ran and the answer is bad news".
    const VERDICTS = ["PROVIDER_ERROR", "NOT_CONNECTED", "NEEDS_REAUTH", "NOT_CONFIGURED"];
    if (VERDICTS.includes(result.code)) {
      return this.success(
        { connected: false, reason: result.message, code: result.code },
        { message: result.message, integration: result.integration, command: result.command }
      );
    }

    // Rate limited, unknown integration, internal error: the test did NOT run,
    // so there is no verdict to report and this really is a failure.
    return this.failure(result.message);
  }
}

export class ValidateIntegrationConfigTool extends IntegrationTool {
  constructor(port: IntegrationCommandPort) {
    super(
      port,
      "integration.validate",
      "Validate integration configuration",
      "Checks configuration for completeness and format WITHOUT saving or calling the provider. For server-managed integrations it reports which environment variables are missing. Use for 'Maps API key validate karo', 'configuration sahi hai kya'.",
      [
        ...INTEGRATION_PARAM,
        {
          name: "config",
          type: "object",
          description:
            "Optional field values to validate. Omit to validate what is already stored or set in the environment.",
          required: false,
        },
      ]
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const resolved = resolve(params.integration);
    if ("ask" in resolved) return this.failure(resolved.ask);

    return this.run(
      {
        command: "validateConfig",
        integration: resolved.id,
        config: (params.config ?? {}) as Record<string, string>,
      },
      context
    );
  }
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

/**
 * Begins OAuth consent.
 *
 * Returns a URL for the user to open. It cannot itself grant anything — consent
 * happens in the user's browser, on Google's page — so this is LOW_IMPACT
 * rather than an external side effect, and it deliberately requests READ scopes
 * only. There is no argument to this tool that can ask for write access.
 */
export class ConnectIntegrationTool extends IntegrationTool {
  constructor(port: IntegrationCommandPort) {
    super(
      port,
      "integration.connect",
      "Connect an integration",
      `Starts the consent flow and returns a link the user must open to authorize JARVIS. Requests READ-ONLY scopes for the named services only. Use for 'Google account connect karo', 'connect my Google account'. Google services: ${KNOWN_GOOGLE_SERVICES}.`,
      [
        ...INTEGRATION_PARAM,
        {
          name: "services",
          type: "array",
          description: `For Google: which services to request read access to (${KNOWN_GOOGLE_SERVICES}). Defaults to ads. Ask the user rather than requesting everything.`,
          required: false,
        },
      ],
      false,
      ["read", "write"],
      "LOW_IMPACT"
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const resolved = resolve(params.integration);
    if ("ask" in resolved) return this.failure(resolved.ask);

    // "Gmail connect karo" names both the integration AND the service. Honour
    // the service the user actually said rather than silently connecting Ads.
    const spoken =
      typeof params.integration === "string" ? resolveGoogleServiceAlias(params.integration) : null;

    const requested = Array.isArray(params.services)
      ? (params.services as unknown[]).filter((s): s is string => typeof s === "string")
      : spoken
        ? [spoken]
        : undefined;

    return this.run(
      {
        command: "connect",
        integration: resolved.id,
        ...(requested && requested.length > 0 ? { services: requested } : {}),
      },
      context
    );
  }
}

/**
 * Saves configuration.
 *
 * LOW_IMPACT: it writes to OUR encrypted store and reaches no provider. The
 * values are validated server-side exactly as a form submission is — a model is
 * not a trusted client, and this tool gets no shortcut a browser would not get.
 */
export class ConfigureIntegrationTool extends IntegrationTool {
  constructor(port: IntegrationCommandPort) {
    super(
      port,
      "integration.configure",
      "Configure an integration",
      "Saves configuration values for an integration (for example a Google Ads customer ID or developer token, or Meta ad account ID). Values are validated and stored encrypted. Never echo a secret back to the user after saving it.",
      [
        ...INTEGRATION_PARAM,
        {
          name: "config",
          type: "object",
          description:
            "Field values to save, keyed by field name. Only the fields being changed need to be included; omitted fields keep their stored values.",
          required: true,
        },
      ],
      false,
      ["read", "write"],
      "LOW_IMPACT"
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const resolved = resolve(params.integration);
    if ("ask" in resolved) return this.failure(resolved.ask);

    const config = params.config;
    if (typeof config !== "object" || config === null || Array.isArray(config)) {
      return this.failure(
        "Tell me which settings to save, as field-value pairs. Ask integration.status for the field names this integration expects."
      );
    }

    return this.run(
      { command: "configure", integration: resolved.id, config: config as Record<string, string> },
      context
    );
  }
}

export class ReconnectIntegrationTool extends IntegrationTool {
  constructor(port: IntegrationCommandPort) {
    super(
      port,
      "integration.reconnect",
      "Reconnect an integration",
      "Refreshes expired authorization without discarding the connection. If the provider refuses the refresh, returns a re-consent link and says why. Use for 'Google reconnect karo', 'YouTube integration reconnect karo', 'token expire ho gaya'.",
      [...INTEGRATION_PARAM],
      false,
      ["read", "write"],
      "LOW_IMPACT"
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    return this.runOn("reconnect", params, context);
  }
}

export class EnableIntegrationTool extends IntegrationTool {
  constructor(port: IntegrationCommandPort) {
    super(
      port,
      "integration.enable",
      "Enable an integration",
      "Switches an integration back on, keeping its stored credentials. No reconnection is needed.",
      [...INTEGRATION_PARAM],
      false,
      ["read", "write"],
      "LOW_IMPACT"
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    return this.runOn("enable", params, context);
  }
}

export class DisableIntegrationTool extends IntegrationTool {
  constructor(port: IntegrationCommandPort) {
    super(
      port,
      "integration.disable",
      "Disable an integration",
      "Switches an integration off WITHOUT deleting its credentials, so it can be re-enabled without another consent round trip. Prefer this over disconnect when the user says 'band karo' or 'turn it off'.",
      [...INTEGRATION_PARAM],
      false,
      ["read", "write"],
      "LOW_IMPACT"
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    return this.runOn("disable", params, context);
  }
}

/**
 * Removes the connection and revokes the token at the provider.
 *
 * EXTERNAL_SIDE_EFFECT with `requiresApproval`, because it changes state at
 * Google and cannot be undone from here: restoring access needs the user to
 * walk through consent again. This is the one management verb that earns the
 * approval boundary, and it earns it for the same reason a Meta budget change
 * does — it is irreversible from inside JARVIS.
 */
export class DisconnectIntegrationTool extends IntegrationTool {
  constructor(port: IntegrationCommandPort) {
    super(
      port,
      "integration.disconnect",
      "Disconnect an integration",
      "Removes stored credentials and revokes the token at the provider. IRREVERSIBLE from JARVIS — reconnecting requires the user to grant consent again. If the user only wants to pause an integration, use integration.disable instead.",
      [...INTEGRATION_PARAM],
      true,
      ["read", "write"],
      "EXTERNAL_SIDE_EFFECT"
    );
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    return this.runOn("disconnect", params, context);
  }
}

// ---------------------------------------------------------------------------

/** Every integration tool, built over one port. */
export function createIntegrationTools(port: IntegrationCommandPort): BaseTool[] {
  return [
    new ListIntegrationsTool(port),
    new GetIntegrationStatusTool(port),
    new GetIntegrationHealthTool(port),
    new GetIntegrationPermissionsTool(port),
    new GetIntegrationAuditTool(port),
    new TestIntegrationConnectionTool(port),
    new ValidateIntegrationConfigTool(port),
    new ConnectIntegrationTool(port),
    new ConfigureIntegrationTool(port),
    new ReconnectIntegrationTool(port),
    new EnableIntegrationTool(port),
    new DisableIntegrationTool(port),
    new DisconnectIntegrationTool(port),
  ];
}

/** The registry ids, so the agent policy and the tests can name them without drift. */
export const INTEGRATION_TOOL_IDS = [
  "integration.list",
  "integration.status",
  "integration.health",
  "integration.permissions",
  "integration.audit",
  "integration.test",
  "integration.validate",
  "integration.connect",
  "integration.configure",
  "integration.reconnect",
  "integration.enable",
  "integration.disable",
  "integration.disconnect",
] as const;
