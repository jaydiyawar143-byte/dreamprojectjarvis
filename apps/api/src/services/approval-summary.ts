// ---------------------------------------------------------------------------
// PHASE 10.7 — deterministic, server-generated approval summaries.
//
// The AI may PROPOSE parameter values, but the approval representation a
// human sees is generated HERE from the validated parameters stored on the
// durable approval row. AI-generated descriptions are never used as the
// source of truth.
//
// Security properties:
//  - output contains ONLY fields derived from validated params + tool id
//  - account identifiers are partially redacted (act_123••••789)
//  - no tokens/keys/URLs ever enter these strings
// ---------------------------------------------------------------------------

import {
  computerControlApprovalSummary,
  isComputerControlAction,
  isGoogleWriteAction,
  parseComputerControlRequest,
  readComputerControlApprovalRecord,
} from "@jarvis/core";
import { clientWritePlan } from "./client-views.js";

export interface ApprovalSummary {
  /** Human-readable action sentence, e.g. "Create Meta campaign …". */
  actionSummary: string;
  /** Redacted target account, e.g. "act_123••••789". */
  accountRedacted?: string;
  /** Formatted budget when parameters contain one. */
  budget?: string;
  /** Target resource (campaign/adset/ad name or id). */
  targetResource?: string;
  /** Extra key: value lines shown under the summary. */
  detailLines: Array<{ label: string; value: string }>;
}

/** Redact an account identifier: keep prefix and last 4 characters. */
export function redactAccountId(accountId: unknown): string | undefined {
  if (typeof accountId !== "string" || accountId.length === 0) return undefined;
  if (accountId.length <= 8) return `${accountId.slice(0, 2)}••••`;
  const digits = accountId.replace(/^act_/, "");
  const suffix = digits.slice(-4);
  return `act_${digits.slice(0, Math.min(3, digits.length))}••••${suffix}`;
}

function formatMoney(amount: unknown, currency?: unknown): string {
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (typeof n !== "number" || !Number.isFinite(n)) return String(amount);
  const cur = typeof currency === "string" && currency.length <= 5 ? currency : "USD";
  try {
    // Budgets are stored in minor units by Meta conventions in this codebase
    // only when explicitly suffixed; here params carry major units.
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: cur,
    }).format(n);
  } catch {
    return `${n} ${cur}`;
  }
}

/**
 * Build the deterministic approval representation for a tool execution.
 * Unknown tools fall back to a generic but still fully server-derived form.
 */
export function buildApprovalSummary(
  toolId: string,
  params: Record<string, unknown>
): ApprovalSummary {
  // Phase 19.1 — browser and desktop actions have their own value-free
  // summary. The generic loop below echoes scalar parameters, which would put
  // `browser.type`'s text or a submitted field value on the approval screen.
  // The action is forced from `toolId`, so a stored `action` cannot redirect
  // the summary to another action.
  if (isComputerControlAction(toolId)) {
    return buildComputerControlApprovalSummary(toolId, params);
  }

  // Phase 19.1 (audit C1) — a Google write is approved on the reviewed plan,
  // which the response carries separately as `plan`. The generic loop below
  // echoes every scalar parameter, and a plan can carry fields that are not
  // part of what a person is deciding (an internal note, a provider draft id).
  // Those must not leak back through the summary.
  if (isGoogleWriteAction(toolId)) {
    const plan = clientWritePlan(toolId, params);
    return {
      actionSummary: `Execute ${toolId} exactly as reviewed in the plan. Nothing outside the plan can run.`,
      targetResource: plan?.target?.label ?? plan?.target?.id,
      detailLines: [],
    };
  }

  const accountRedacted = redactAccountId(params.accountId);
  const detailLines: ApprovalSummary["detailLines"] = [];

  for (const [key, value] of Object.entries(params)) {
    if (
      key === "accountId" ||
      key === "name" ||
      key === "objective" ||
      key === "dailyBudget" ||
      key === "lifetimeBudget" ||
      key === "currency" ||
      key === "status"
    ) {
      continue;
    }
    if (value !== undefined && value !== null && typeof value !== "object") {
      detailLines.push({ label: key, value: String(value) });
    }
  }

  switch (toolId) {
    case "meta.campaign.create": {
      const budget =
        params.dailyBudget !== undefined
          ? `daily budget ${formatMoney(params.dailyBudget, params.currency)}`
          : params.lifetimeBudget !== undefined
            ? `lifetime budget ${formatMoney(params.lifetimeBudget, params.currency)}`
            : undefined;
      return {
        actionSummary:
          `Create Meta campaign "${String(params.name ?? "")}"` +
          (params.objective ? ` with objective ${String(params.objective)}` : "") +
          (budget ? ` and ${budget}` : "") +
          ".",
        accountRedacted,
        budget,
        targetResource:
          typeof params.name === "string" ? params.name : undefined,
        detailLines,
      };
    }
    case "meta.campaign.update_budget":
    case "meta.adset.update_budget": {
      const entity = toolId === "meta.campaign.update_budget" ? "campaign" : "ad set";
      const budget = `${formatMoney(params.dailyBudget ?? params.budget ?? params.amount, params.currency)}`;
      return {
        actionSummary: `Update ${entity} ${String(params.campaignId ?? params.adSetId ?? params.entityId ?? "")} daily budget to ${budget}.`,
        accountRedacted,
        budget,
        targetResource:
          String(params.campaignId ?? params.adSetId ?? params.entityId ?? "") ||
          undefined,
        detailLines,
      };
    }
    case "meta.campaign.pause":
    case "meta.campaign.resume":
    case "meta.adset.pause":
    case "meta.adset.resume":
    case "meta.ad.pause":
    case "meta.ad.resume": {
      const verb = toolId.includes("pause") ? "Pause" : "Resume";
      const entity = toolId.includes(".campaign.")
        ? "campaign"
        : toolId.includes(".adset.")
          ? "ad set"
          : "ad";
      const id = String(params.campaignId ?? params.adSetId ?? params.adId ?? "");
      return {
        actionSummary: `${verb} ${entity} ${id}.`,
        accountRedacted,
        targetResource: id || undefined,
        detailLines,
      };
    }
    // Phase 15 — a publish. The words shown here are the parameters the
    // approval is bound to: the exact text and the place, built by the server
    // from the saved content item. They are what will run, or nothing will —
    // the tool refuses if the saved item no longer says this.
    //
    // The same parameters say WHICH of two things is being approved. With
    // `earlierAttempt`, an earlier attempt's outcome is not known and this
    // approval only looks for its post; it is held to that at execution, so
    // what is said here is what can happen.
    case "marketing.content.publish": {
      const target = typeof params.targetName === "string" ? params.targetName : "the selected Page";
      const message = typeof params.message === "string" ? params.message : "";
      const look = typeof params.earlierAttempt === "string";
      return {
        actionSummary: look
          ? `Look on ${target} for the post an earlier attempt may have made. Nothing new will be posted.`
          : `Publish this post publicly to ${target}. JARVIS cannot undo it.`,
        targetResource: target,
        detailLines: [
          { label: look ? "Look on" : "Publish to", value: target },
          { label: look ? "Text to look for" : "Text to be posted", value: message },
          ...(typeof params.link === "string" ? [{ label: "Link", value: params.link }] : []),
        ],
      };
    }
    // Phase 18.3B — a proposal from the n8n workflow library. Its parameters
    // are two ids; the approver is told what the change is and is not.
    case "automation.library.allowlist.add": {
      const entry = typeof params.entryId === "string" ? params.entryId : "the workflow";
      return {
        actionSummary: `Add n8n workflow ${entry} to the requester's trigger allow-list, at the version shown. Nothing in n8n changes and nothing runs; each trigger still needs its own approval.`,
        targetResource: entry,
        detailLines: [
          { label: "Workflow", value: entry },
          { label: "Version", value: typeof params.versionId === "string" ? params.versionId : "unknown" },
        ],
      };
    }
    default:
      break;
  }

  return {
    actionSummary: `Execute ${toolId}${
      Object.keys(params).length > 0 ? " with reviewed parameters" : ""
    }.`,
    accountRedacted,
    detailLines,
  };
}

/**
 * Phase 19.1 — a browser or desktop approval, built only from the validated
 * action and bounded fields. It never echoes a typed value, an option value,
 * a submitted field value, a path/query, a cookie or a token.
 *
 * A stored row whose parameters no longer parse gets a fixed, honest sentence
 * and no parameter echo: it cannot be approved on the strength of a summary it
 * cannot show. Execution validates the parameters again, so nothing runs.
 *
 * Phase 19.5 — once an approval is rejected, consumed or expired, its exact
 * parameters are gone and the row holds only its value-free record (S3). The
 * summary is then read from that record, by core's one reader, which accepts
 * it only for this action and only well formed.
 */
function buildComputerControlApprovalSummary(
  toolId: string,
  params: Record<string, unknown>
): ApprovalSummary {
  const parsed = parseComputerControlRequest({ ...params, action: toolId });
  if (!parsed.ok) {
    const recorded = readComputerControlApprovalRecord(toolId, params);
    if (recorded) {
      return {
        actionSummary: recorded.actionSummary,
        targetResource: recorded.targetResource,
        detailLines: [...recorded.detailLines],
      };
    }
    const surface = toolId.startsWith("desktop.") ? "desktop" : "browser";
    return {
      actionSummary: `A ${surface} control action could not be verified from its stored parameters. Do not approve it unless you asked for it; nothing will run.`,
      detailLines: [{ label: "Action", value: toolId }],
    };
  }

  const summary = computerControlApprovalSummary(parsed.value);
  return {
    actionSummary: summary.actionSummary,
    targetResource: summary.targetResource,
    detailLines: [...summary.detailLines],
  };
}
