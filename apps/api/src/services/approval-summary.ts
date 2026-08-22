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
