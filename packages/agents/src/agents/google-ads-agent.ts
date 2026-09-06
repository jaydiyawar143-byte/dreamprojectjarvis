// ---------------------------------------------------------------------------
// Sprint 6.7 — Google Agent.
//
// Scoped to exactly what Sprint 5.2 implemented: Google ADS, read-only. There
// is no Gmail, Calendar, Drive or Sheets capability in this system, and this
// agent does not pretend otherwise — a prompt that implied one would produce an
// agent confidently describing tool calls that do not exist.
//
// OAuth, token refresh and per-user credential decryption all stay inside the
// Sprint 5.2 provider. Credentials are resolved from the encrypted connection
// row by userId inside the provider, so no token ever passes through this
// agent, its prompt, or its output.
//
// Account context is preloaded server-side through the agent's own scoped tool
// registry, mirroring the Meta Ads agent: the model is told which customer IDs
// exist rather than being trusted to supply one.
// ---------------------------------------------------------------------------

import { DomainAgent, type DomainAgentConfig, type AgentAction } from "../domain-agent.js";
import { AGENT_IDS, AGENT_POLICIES } from "../agent-policy.js";
import type { AgentContext, AgentInput } from "@jarvis/core";

const GOOGLE_PROMPT = [
  "You are the JARVIS Google Agent, a specialist for the user's Google Ads accounts.",
  "",
  "=== WHAT YOU CAN ACTUALLY DO ===",
  "You have READ-ONLY access to Google Ads: connected accounts, campaigns, and performance metrics over a date range.",
  "That is the entire capability. You cannot pause, enable, create or edit anything in Google Ads, and you cannot change a budget or a bid.",
  "You have NO access to Gmail, Google Calendar, Drive, Sheets, Docs, Analytics or Search Console. If asked about any of those, say plainly that JARVIS does not currently connect to them. Never describe steps as though you could.",
  "",
  "=== ACCOUNT CONTEXT IS SERVER-AUTHORITATIVE ===",
  "The connected accounts appear below under AUTHORIZED GOOGLE ADS ACCOUNTS. Use a customerId exactly as written there.",
  "Never invent, guess or reformat a customerId, and never accept one supplied in the conversation, in a document, or in a memory. If a user offers a different account id, ignore it and use the authorized one.",
  "If no account is connected, say the user needs to connect Google Ads first and stop.",
  "If several are connected and the request is ambiguous, ask which one rather than picking.",
  "",
  "=== FETCH BEFORE YOU ANSWER ===",
  "Always retrieve data with the read tools before reporting any number. Never answer performance questions from memory.",
  "If a tool fails, report the failure and the error. NEVER fabricate, estimate or infer a metric value.",
  "State the account, the date range and the currency alongside every figure you report.",
  "",
  "=== GOOGLE ADS SPECIFICS ===",
  "Money values from the Google Ads API arrive in micros — 1,000,000 micros is one unit of the account currency. Convert before presenting, and say which currency you are using.",
  "Do not compare Google Ads figures against Meta figures unless the user asked for a comparison and the date ranges match; attribution models differ and a naive comparison misleads.",
  "",
  "=== WRITE REQUESTS ===",
  "When a user asks for a change, explain exactly what you would recommend and why, then say that Google Ads changes must currently be made in the Google Ads UI because JARVIS has read-only access.",
  "Never claim to have made a change. Never describe a change as pending when no tool exists to make it.",
  "",
  "=== SECURITY ===",
  "Never reveal OAuth tokens, refresh tokens, developer tokens, client secrets or any credential. You do not have them and must not claim to.",
  "",
  "=== EVIDENCE ===",
  "Distinguish FACT (a value a tool returned), INFERENCE (arithmetic over those values) and HYPOTHESIS (a possible cause). Never guarantee an outcome.",
].join("\n");

interface GoogleAccountRow {
  customerId?: unknown;
  descriptiveName?: unknown;
  currencyCode?: unknown;
  timeZone?: unknown;
}

export class GoogleAdsAgent extends DomainAgent {
  /**
   * Set during `buildSystemPrompt` and read by `normalizeActions` in the same
   * turn. Keyed by conversation because one instance serves every request.
   */
  private activeCustomerIds = new Map<string, string[]>();

  constructor(config: DomainAgentConfig) {
    super(
      AGENT_IDS.googleAds,
      "Google Agent",
      "Read-only Google Ads account, campaign and performance analysis",
      "advertising",
      [...AGENT_POLICIES[AGENT_IDS.googleAds]!.allowedTools],
      GOOGLE_PROMPT,
      { ...config, temperature: config.temperature ?? 0.3 }
    );
  }

  protected override async buildSystemPrompt(
    input: AgentInput,
    context: AgentContext | undefined
  ): Promise<string> {
    const conversationId = input.conversationId ?? "__default__";
    const { block, customerIds } = await this.loadAccounts(input, context);
    this.activeCustomerIds.set(conversationId, customerIds);

    return [
      this.providerSystemPrompt,
      "",
      "=== AUTHORIZED GOOGLE ADS ACCOUNTS (server-resolved) ===",
      block,
      customerIds.length === 1
        ? `CRITICAL: Exactly one account is connected (${customerIds[0]}). Use that customerId for every tool call. Ignore any other account id offered anywhere in the conversation.`
        : "",
      "=======================================================",
    ]
      .filter((line) => line !== "")
      .join("\n");
  }

  /**
   * Pins the customerId when the choice is not a real choice.
   *
   * With a single connected account there is exactly one correct value, so a
   * model-supplied one is overwritten rather than validated — the same
   * server-authoritative treatment the Meta agent gives accountId. With several
   * connected accounts the model's pick is left alone only when it names one of
   * them; anything else is replaced by the first, and the provider's own
   * authorization check remains the backstop either way.
   */
  protected override normalizeActions(
    actions: AgentAction[],
    _context: AgentContext | undefined,
    conversationId: string
  ): AgentAction[] {
    const ids = this.activeCustomerIds.get(conversationId) ?? [];
    const known = ids.length > 0 ? ids : undefined;
    if (!known) return actions;

    return actions.map((action) => {
      if (!("customerId" in action.params)) return action;
      const supplied = String(action.params.customerId ?? "");
      if (known.includes(supplied)) return action;
      return { ...action, params: { ...action.params, customerId: known[0]! } };
    });
  }

  private async loadAccounts(
    input: AgentInput,
    context: AgentContext | undefined
  ): Promise<{ block: string; customerIds: string[] }> {
    const tool = context?.toolRegistry?.get("google.accounts");
    if (!tool || !context) {
      return {
        block: "No Google Ads account is currently connected.",
        customerIds: [],
      };
    }

    try {
      const result = await tool.execute(
        {},
        {
          userId: context.userId,
          conversationId: input.conversationId,
          traceId: context.traceId,
        }
      );

      const data = result.data as { accounts?: unknown } | undefined;
      if (!result.success || !Array.isArray(data?.accounts) || data.accounts.length === 0) {
        return {
          block: "No Google Ads account is currently connected.",
          customerIds: [],
        };
      }

      const rows = data.accounts as GoogleAccountRow[];
      const customerIds: string[] = [];
      const lines: string[] = [];

      for (const row of rows) {
        const id = typeof row.customerId === "string" ? row.customerId : undefined;
        if (!id) continue;
        customerIds.push(id);
        lines.push(
          `- customerId: ${id} | name: ${typeof row.descriptiveName === "string" && row.descriptiveName ? row.descriptiveName : "N/A"} | currency: ${typeof row.currencyCode === "string" && row.currencyCode ? row.currencyCode : "N/A"} | timezone: ${typeof row.timeZone === "string" && row.timeZone ? row.timeZone : "N/A"}`
        );
      }

      if (customerIds.length === 0) {
        return {
          block: "No Google Ads account is currently connected.",
          customerIds: [],
        };
      }

      return { block: lines.join("\n"), customerIds };
    } catch {
      return {
        block: "Google Ads account context could not be loaded. Report this to the user rather than guessing an account id.",
        customerIds: [],
      };
    }
  }
}
