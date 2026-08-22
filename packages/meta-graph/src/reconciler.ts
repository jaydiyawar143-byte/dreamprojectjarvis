import type {
  ExecutionReconciler,
  ReconciliationEvidence,
  ReconciliationResult,
  ReconciliationReasonCode,
} from "@jarvis/core";
import { JarvisError } from "@jarvis/core";
import type { MetaGraphProvider } from "./provider.js";
import { MetaRequestAbortedError } from "./client.js";
import { redactSecrets } from "@jarvis/core";

// ---------------------------------------------------------------------------
// MetaCampaignReconciler — Phase 10.5 provider-specific reconciliation
// ---------------------------------------------------------------------------
// Answers ONE read-only question for an UNKNOWN campaign-creation execution:
// "Did the original createCampaign land on the configured ad account?"
//
// IDEMPOTENCY LIMITATION (documented per phase spec §2):
// The Meta Marketing API does NOT accept a client-supplied idempotency or
// request token on campaign creation. Once a create request times out in
// flight, there is no deterministic server-side handle to look up "the
// campaign created by THAT request". Correlation therefore relies on
// multi-field EVIDENCE matching:
//
//   required   exact account (verified upstream, re-checked here)
//   required   exact campaign name
//   required   creation timestamp inside the execution's correlation window
//   supporting objective / daily budget / lifetime budget / buying type —
//              compared whenever present in the evidence
//
// A candidate matches only if EVERY available criterion holds.
//   exactly one match            -> FOUND
//   zero matches + complete scan -> NOT_FOUND (authoritative)
//   multiple matches             -> UNCERTAIN (name collisions are real)
//   incomplete scan/payload      -> UNCERTAIN (never a guess)
//
// A false-positive FOUND would overwrite an UNKNOWN record with a wrong
// external ID and hide a possible duplicate spend; it is strictly worse than
// remaining UNKNOWN. When in doubt: UNCERTAIN.
// ---------------------------------------------------------------------------

export interface MetaCampaignReconcilerOptions {
  /**
   * Server-configured ad account (e.g. act_123). Reconciliation queries ONLY
   * this account and refuses evidence pointing anywhere else.
   */
  configuredAccountId: string;
  /** Evaluation clock (tests may inject). */
  now?: () => Date;
  /** Hard bound on pages scanned per attempt before declaring partial evidence. */
  maxPages?: number;
  /** Page size for the campaigns query. */
  pageLimit?: number;
  /** Tolerance applied to both ends of the correlation time window (ms). */
  timeSkewMs?: number;
}

export class MetaCampaignReconciler implements ExecutionReconciler {
  private readonly maxPages: number;
  private readonly pageLimit: number;
  private readonly timeSkewMs: number;

  constructor(
    private readonly deps: {
      provider: Pick<MetaGraphProvider, "getCampaigns">;
    },
    private readonly options: MetaCampaignReconcilerOptions
  ) {
    this.maxPages = options.maxPages ?? 10;
    this.pageLimit = options.pageLimit ?? 100;
    this.timeSkewMs = options.timeSkewMs ?? 120_000;
  }

  async reconcile(evidence: ReconciliationEvidence): Promise<ReconciliationResult> {
    // ---- Account isolation (defense in depth) ----------------------------
    const configured = this.normalizeAccount(this.options.configuredAccountId);
    const requested = this.normalizeAccount(evidence.accountId);
    if (!configured || !requested || configured !== requested) {
      return {
        outcome: "PROVIDER_ERROR",
        authoritative: false,
        reasonCode: "ACCOUNT_MISMATCH",
        detail: `Execution account ${redactSecrets(requested ?? "(unparseable)")} does not match the configured reconciliation account`,
      };
    }

    // ---- Evidence completeness -------------------------------------------
    const resource = evidence.resource;
    if (!resource.name || resource.name.trim() === "") {
      return {
        outcome: "UNCERTAIN",
        authoritative: false,
        reasonCode: "INSUFFICIENT_EVIDENCE",
        detail: "No campaign name available for correlation; name is required secondary evidence",
      };
    }
    const targetName = resource.name.trim();
    const createdAfter = evidence.createdAfter
      ? evidence.createdAfter.getTime() - this.timeSkewMs
      : undefined;
    const createdBefore = evidence.createdBefore
      ? evidence.createdBefore.getTime() + this.timeSkewMs
      : undefined;

    // ---- Authoritative scan of ONLY the configured account ----------------
    let scanned = 0;
    let candidates = 0;
    let firstMatchId: string | undefined;
    let unparsedPayloads = 0;
    let partial = false;
    let after: string | undefined;

    try {
      for (let page = 0; page < this.maxPages; page++) {
        const resp = await this.deps.provider.getCampaigns(
          configured,
          { limit: this.pageLimit, after },
          undefined
        );
        const rows = resp.data ?? [];
        scanned += rows.length;

        for (const c of rows) {
          const candidateMatches =
            c.name.trim() === targetName &&
            (resource.objective === undefined || c.objective === resource.objective) &&
            (resource.dailyBudgetCents === undefined ||
              c.dailyBudget === undefined ||
              normalizeCents(c.dailyBudget) === normalizeCents(resource.dailyBudgetCents)) &&
            (resource.lifetimeBudgetCents === undefined ||
              c.lifetimeBudget === undefined ||
              normalizeCents(c.lifetimeBudget) === normalizeCents(resource.lifetimeBudgetCents)) &&
            (resource.buyingType === undefined || c.buyingType === resource.buyingType);

          if (!candidateMatches) continue;

          // Correlation window: a candidate whose creation time cannot be
          // verified can never be CONFIRMED as ours. Track it separately so a
          // clean-looking NOT_FOUND is not declared over unverifiable data.
          if (!c.createdAt) {
            unparsedPayloads++;
            continue;
          }
          const createdMs = Date.parse(c.createdAt);
          if (Number.isNaN(createdMs)) {
            unparsedPayloads++;
            continue;
          }
          if (
            (createdAfter !== undefined && createdMs < createdAfter) ||
            (createdBefore !== undefined && createdMs > createdBefore)
          ) {
            continue;
          }

          candidates++;
          firstMatchId = c.campaignId;
          if (candidates > 1) break;
        }

        after = resp.nextPage;
        if (candidates > 1) break;
        if (!after) break;
        if (page === this.maxPages - 1) partial = true;
      }
    } catch (err) {
      return this.mapProviderError(err);
    }

    if (candidates === 1) {
      return {
        outcome: "FOUND",
        authoritative: true,
        externalResourceId: firstMatchId,
        reasonCode: "MATCHED_SINGLE_CANDIDATE",
        detail: `Exactly one campaign matched all correlation criteria within the execution window`,
      };
    }
    if (candidates > 1) {
      return {
        outcome: "UNCERTAIN",
        authoritative: false,
        reasonCode: "MULTIPLE_CANDIDATES",
        detail: `${candidates} campaigns share the correlation evidence; refusing to guess`,
      };
    }
    if (partial) {
      return {
        outcome: "UNCERTAIN",
        authoritative: false,
        reasonCode: "PARTIAL_PAGE",
        detail: `Scan stopped after ${scanned}+ campaigns without exhausting the result set`,
      };
    }
    if (unparsedPayloads > 0) {
      return {
        outcome: "UNCERTAIN",
        authoritative: false,
        reasonCode: "MALFORMED_RESPONSE",
        detail: `${unparsedPayloads} same-name candidate(s) lacked a verifiable creation timestamp`,
      };
    }
    return {
      outcome: "NOT_FOUND",
      authoritative: true,
      reasonCode: "NO_CANDIDATES",
      detail: `Complete scan of ${scanned} campaign(s) found none matching the execution evidence`,
    };
  }

  private mapProviderError(err: unknown): ReconciliationResult {
    // Transport aborts (Phase 10.4): always uncertainty, NEVER absence.
    if (err instanceof MetaRequestAbortedError) {
      return {
        outcome: "UNCERTAIN",
        authoritative: false,
        reasonCode: err.message.toLowerCase().includes("timeout") ? "TIMEOUT" : "NETWORK_FAILURE",
        detail: redactSecrets(err.message),
      };
    }
    if (err instanceof JarvisError) {
      switch (err.code) {
        case "AUTHENTICATION_REQUIRED":
          return fail("AUTHENTICATION_FAILED", err.message);
        case "AUTHORIZATION_FAILED":
          return fail("AUTHORIZATION_FAILED", err.message);
        case "RATE_LIMITED":
        case "TOOL_RATE_LIMITED":
          return uncertain("RATE_LIMITED", err.message);
        case "TOOL_TIMEOUT":
          return uncertain("TIMEOUT", err.message);
        case "INVALID_REQUEST":
          return uncertain("MALFORMED_RESPONSE", err.message);
        default:
          return failOrUncertain(err);
      }
    }
    // Network-level failures (fetch failed, ECONNRESET, ...) are retryable
    // uncertainty — never NOT_FOUND.
    const message = err instanceof Error ? err.message : String(err);
    if (/timeout|timed?\s*out/i.test(message)) return uncertain("TIMEOUT", message);
    return uncertain("NETWORK_FAILURE", message);

    function fail(code: ReconciliationReasonCode, raw: string): ReconciliationResult {
      return { outcome: "PROVIDER_ERROR", authoritative: false, reasonCode: code, detail: redactSecrets(raw) };
    }
    function uncertain(code: ReconciliationReasonCode, raw: string): ReconciliationResult {
      return { outcome: "UNCERTAIN", authoritative: false, reasonCode: code, detail: redactSecrets(raw) };
    }
    function failOrUncertain(e: JarvisError): ReconciliationResult {
      // 5xx-class provider failures prevent reliable determination.
      return e.statusCode >= 500
        ? fail("PROVIDER_INTERNAL_ERROR", e.message)
        : uncertain("PROVIDER_INTERNAL_ERROR", e.message);
    }
  }

  private normalizeAccount(accountId: string): string | null {
    const trimmed = accountId.trim();
    const withPrefix = /^act_\d+$/.test(trimmed)
      ? trimmed
      : /^\d+$/.test(trimmed)
        ? `act_${trimmed}`
        : null;
    return withPrefix;
  }
}

function normalizeCents(value: string): string {
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : value.trim();
}
