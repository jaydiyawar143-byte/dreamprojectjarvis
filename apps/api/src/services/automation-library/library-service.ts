// ---------------------------------------------------------------------------
// Phase 18, Stage 18.1 — the Automation Library service.
//
// THE ONE IMPLEMENTATION. Reading the catalog, reading its sync status and
// starting a synchronization all live here; the router translates HTTP into
// these calls and back, and decides nothing (the marketing service's rule,
// applied to the library). A later JARVIS tool reaches the same methods.
//
// WHOSE CATALOG. The n8n REST connection is a shared connection: an operator
// records which Organization owns it (`AutomationConnectorOwner`, n8n/rest).
// Every call asks `SharedConnectionAccess` — the one reader every shared
// connection is checked through — from the database, now:
//
//   read   every member of the owning Organization (`shared:read`);
//   sync   its owners and admins (`shared:sync`): a sync reads the provider
//          page after page on the shared credential, like a connection test.
//
// The Organization comes from the owner record and the instance from the
// server's configuration — never from the request. Anyone outside the owning
// Organization gets one answer, whether or not n8n is configured, and it is
// given BEFORE the configuration is looked at.
//
// SPENT BEFORE IT IS STARTED. A sync takes the caller's slot and the
// Organization's slot — count and reservation in one step in PostgreSQL —
// before anything reaches n8n. A budget that cannot be checked refuses.
//
// ONE RUN AT A TIME, PER CATALOG. Starting takes the catalog's lease in the
// database; a second start while one runs is refused, on this instance or any
// other. The run then continues in the background and the caller follows it on
// the status endpoint: a bounded run can outlast an HTTP request.
//
// WHAT LEAVES. Listing metadata, counts, states and fixed failure sentences.
// Never a cursor, the instance's address, a credential or a provider's words.
//
// STAGE 18.2 — ONE PORT, EVERY SURFACE. The service implements
// `AutomationLibraryPort` (@jarvis/core); the API router and the JARVIS
// tools are both given this one instance, so a sentence and a button get the
// same answer and the same refusal, in the same words.
//
// CONTINUE UNTIL COMPLETE. `startSync` with `continueUntilComplete` starts a
// CHAIN: the bounded runs above, one after another, until the scan completes.
// It adds no second engine, lease or budget — each run is an ordinary run that
// also carries the chain's id — and only these rules:
//   • started by an owner or admin (`shared:sync`), like any sync, and spent
//     before it starts: the caller's slot once, the Organization's slot for
//     every run;
//   • one chain per catalog. A request while one is alive — a second click, a
//     retry, another admin — is answered with THAT chain, and an idempotency
//     key returns the chain it first started; nothing is spent again;
//   • before every run the requester's authorization and the catalog's scope
//     are read again from the database. A change stops the chain;
//   • hard limits: runs, pages and wall time (`LIBRARY_CHAIN_MAX_*`). A failure
//     not worth retrying stops it at once; one worth retrying, at most
//     `LIBRARY_CHAIN_MAX_CONSECUTIVE_FAILURES` in a row;
//   • COMPLETE only when its last run reported a complete scan — the store
//     closed it in the transaction of the last page. Never otherwise;
//   • its state is in the database, so a restart loses nothing: a chain whose
//     process died is shown as interrupted and closed by the next start, and
//     the scan resumes from its last stored page. Nothing restarts by itself.
//
// STAGE 18.3B — INSPECT ONE ENTRY, AND PROPOSE IT FOR THE TRIGGER ALLOW-LIST.
//   inspect   any member: the sanitized structure of one entry, built from the
//             catalog alone (`inspectLibraryEntry`). n8n is not contacted.
//   propose   an owner or admin (`shared:write`): an APPROVAL ROW in the one
//             approval store for the page-only tool
//             `automation.library.allowlist.add`, bound to {entryId, versionId}.
//             That tool is a shared-connection write, so the store binds the
//             approval to the Organization that owns n8n and only ANOTHER of
//             its owners or admins may approve it. Nothing else changes.
//   apply     run by that tool, through ToolExecutor, with the approval: the
//             requester's role and the catalog entry and version are checked
//             again, the workflow is read once from n8n for its webhook target
//             (the trigger allow-list stores a path, nothing more), the tool
//             consumes the approval with the Organization's scope, and only
//             then is the row written. Nothing is activated, edited or run.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import {
  APPROVAL_TTL_MS,
  AUTOMATION_LIBRARY_PROVIDER,
  AUTOMATION_LIBRARY_TOOL_IDS,
  computeParamsHash,
  inspectLibraryEntry,
  isLibraryEntryId,
  libraryEntryRef,
  validateLibraryAllowlistParams,
  type Approval,
  type LibraryAllowlistApplied,
  type LibraryAllowlistParams,
  type LibraryAllowlistProposal,
  type LibraryAllowlistRegistry,
  type LibraryInspectionView,
  type LibraryProposalStatus,
  type LibraryTriggerTargetSource,
  type SharedConnectionScope,
  LIBRARY_CHAIN_MAX_CONSECUTIVE_FAILURES,
  LIBRARY_CHAIN_MAX_MS,
  LIBRARY_CHAIN_MAX_PAGES,
  LIBRARY_CHAIN_MAX_RUNS,
  LIBRARY_CHAIN_RETRY_DELAY_MS,
  LIBRARY_CHAIN_STALE_MS,
  LIBRARY_CHAIN_STOP_MESSAGES,
  LIBRARY_FAILURE_MESSAGES,
  LIBRARY_LEASE_MS,
  SHARED_INTEGRATION_CONNECTORS,
  deriveLibraryState,
  isRetryableLibraryFailure,
  type AutomationLibraryPort,
  type AutomationLibraryStore,
  type LibraryChainState,
  type LibraryChainStatus,
  type LibraryChainStopCode,
  type LibraryChainView,
  type LibraryEntryPage,
  type LibraryEntryQuery,
  type LibraryFailureCode,
  type LibraryPageSource,
  type LibraryResult,
  type LibraryRunRecord,
  type LibraryRunView,
  type LibraryScope,
  type LibraryStatusView,
  type LibrarySyncStarted,
} from "@jarvis/core";
import { sharedWriteScope } from "@jarvis/security";
import {
  SHARED_ACCESS_UNVERIFIED,
  sharedConnectionUnavailable,
  type SharedConnectionAccessPort,
} from "../tenancy/shared-connection-access.js";
import {
  clampLibraryPageSize,
  clampLibraryPagesPerRun,
  continueLibraryRun,
  type LibraryRunOutcome,
} from "./sync-engine.js";

/** What a synchronization may spend, reserved before n8n is called. */
export const LIBRARY_SYNC_BUDGETS = {
  perUser: { limit: 10, windowMs: 10 * 60_000 },
  perOrganization: { limit: 60, windowMs: 60 * 60_000 },
} as const;

export type LibraryBudgetDecision = { allowed: boolean; reason?: "LIMIT" | "UNAVAILABLE" };

export interface LibrarySyncBudgetPort {
  reserveForUser(userId: string): Promise<LibraryBudgetDecision>;
  reserveForOrganization(scope: LibraryScope, userId: string): Promise<LibraryBudgetDecision>;
}

export interface LibraryAuditPort {
  log(entry: { userId: string; action: string; result: "success" | "failure" | "rejected"; metadata?: Record<string, unknown> }): Promise<unknown>;
}

export interface LibraryLog {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
}

export type { LibraryEntryPage, LibraryResult, LibraryRunView, LibraryStatusView } from "@jarvis/core";

export interface AutomationLibraryServiceDeps {
  store: AutomationLibraryStore;
  /** Absent: nobody's standing can be checked, and every call is refused. */
  access: SharedConnectionAccessPort | undefined;
  /** Null when n8n is not configured on this server. */
  source: { pages: LibraryPageSource; instanceKey: string } | null;
  /** Absent: no synchronization starts. */
  budget: LibrarySyncBudgetPort | undefined;
  audit: LibraryAuditPort;
  limits?: { pageSize?: number; maxPagesPerRun?: number; leaseMs?: number };
  /** Stage 18.2 — a chain's hard limits. Each may only be lowered below the constants. */
  chainLimits?: { maxRuns?: number; maxPages?: number; maxMs?: number; staleMs?: number; retryDelayMs?: number };
  now?: () => Date;
  newId?: () => string;
  /** True while the server is stopping: a run ends PARTIAL at its next page, and a chain stops. */
  shouldStop?: () => boolean;
  /** The pause before a chain retries; a test replaces it. */
  sleep?: (ms: number) => Promise<void>;
  log?: LibraryLog;
  /**
   * Stage 18.3B — the one approval store: a proposal is an approval row, and
   * its standing is read back from it. Absent: nothing can be proposed.
   */
  approvals?: {
    create(data: Omit<Approval, "id" | "status" | "createdAt">): Promise<Approval>;
    listByUser(userId: string, options?: { limit?: number }): Promise<{ items: Approval[]; total: number }>;
  };
  /** Stage 18.3B — the per-account trigger allow-list (`N8nWorkflow`). Absent: nothing can be applied. */
  allowlist?: LibraryAllowlistRegistry;
  /** Stage 18.3B — the one live read an approved change makes. Null or absent where n8n is not configured. */
  triggerTargets?: LibraryTriggerTargetSource | null;
}

export interface LibrarySyncAccepted {
  runId: string;
  /** Continued an open scan rather than starting one. */
  resumed: boolean;
  state: "running";
  /** Settles when the run ends. For tests and the shutdown path; never sent to a client. */
  completion: Promise<LibraryRunOutcome>;
}

/** How a chain ended. */
export interface LibraryChainOutcome {
  chainId: string;
  status: Exclude<LibraryChainStatus, "RUNNING">;
  stopCode: LibraryChainStopCode | null;
  failureCode: LibraryFailureCode | null;
  runs: number;
  pages: number;
}

export interface LibraryContinuationAccepted {
  chainId: string;
  /** The chain already existed: an alive one, or the one this idempotency key started. Nothing was spent. */
  existing: boolean;
  state: "running" | LibraryChainStatus;
  /** Settles when a chain THIS call started ends; null for an existing one. Never sent to a client. */
  completion: Promise<LibraryChainOutcome> | null;
}

/** Who asked, for the audit row only. Decides nothing. */
export type LibraryCaller = "api" | "jarvis";

const INTEGRATION_NAME = "n8n";
const N8N_REST = SHARED_INTEGRATION_CONNECTORS.n8n;

const NOT_CONFIGURED = {
  status: 503,
  code: "N8N_NOT_CONFIGURED",
  message: "n8n is not configured on this server.",
} as const;

function refuse(status: number, code: string, message: string): { ok: false; status: number; code: string; message: string } {
  return { ok: false, status, code, message };
}

const SYNC_ALREADY_RUNNING = {
  status: 409,
  code: "SYNC_ALREADY_RUNNING",
  message: "A synchronization of this library is already running. Follow it on the status endpoint.",
} as const;

const LIBRARY_UNREACHABLE = {
  status: 503,
  code: "LIBRARY_UNAVAILABLE",
  message: "The workflow library could not be reached, so nothing was started.",
} as const;

/** The limit, or a lower one asked for. Never higher. */
const atMost = (limit: number, asked: number | undefined) =>
  asked !== undefined && Number.isFinite(asked) && asked >= 1 ? Math.min(Math.trunc(asked), limit) : limit;

/** How a chain is shown: one that died with its process is interrupted, whatever its row still says. */
function chainView(chain: LibraryChainState): LibraryChainView {
  const dead = chain.status === "RUNNING" && !chain.alive;
  const status: LibraryChainStatus = dead ? "INTERRUPTED" : chain.status;
  const stopCode: LibraryChainStopCode | null = dead ? "INTERRUPTED" : chain.stopCode;
  return {
    chainId: chain.chainId,
    status,
    stop: stopCode ? { code: stopCode, message: LIBRARY_CHAIN_STOP_MESSAGES[stopCode] } : null,
    runFailure: chain.failureCode ? { code: chain.failureCode, message: LIBRARY_FAILURE_MESSAGES[chain.failureCode] } : null,
    runs: chain.runs,
    pages: chain.pages,
    recordsObserved: chain.recordsObserved,
    limits: { maxRuns: chain.maxRuns, maxPages: chain.maxPages, deadlineAt: chain.deadlineAt },
    startedAt: chain.startedAt,
    finishedAt: chain.finishedAt,
  };
}

/** What a request for a chain is told about one that already exists. */
const existingState = (chain: LibraryChainState): "running" | LibraryChainStatus =>
  chain.status === "RUNNING" ? (chain.alive ? "running" : "INTERRUPTED") : chain.status;

function runView(run: LibraryRunRecord): LibraryRunView {
  return {
    runId: run.runId,
    status: run.status,
    resumed: run.resumed,
    pagesFetched: run.pagesFetched,
    recordsObserved: run.recordsObserved,
    created: run.created,
    updated: run.updated,
    unchanged: run.unchanged,
    rejected: run.rejected,
    markedMissing: run.markedMissing,
    markedRemoved: run.markedRemoved,
    failure: run.failureCode ? { code: run.failureCode, message: LIBRARY_FAILURE_MESSAGES[run.failureCode] } : null,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}

export class AutomationLibraryService implements AutomationLibraryPort {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly chain: { maxRuns: number; maxPages: number; maxMs: number; staleMs: number; retryDelayMs: number };

  constructor(private readonly deps: AutomationLibraryServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => randomUUID());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()));
    const limits = deps.chainLimits ?? {};
    this.chain = {
      maxRuns: atMost(LIBRARY_CHAIN_MAX_RUNS, limits.maxRuns),
      maxPages: atMost(LIBRARY_CHAIN_MAX_PAGES, limits.maxPages),
      maxMs: atMost(LIBRARY_CHAIN_MAX_MS, limits.maxMs),
      staleMs: atMost(LIBRARY_CHAIN_STALE_MS, limits.staleMs),
      retryDelayMs: atMost(LIBRARY_CHAIN_RETRY_DELAY_MS, limits.retryDelayMs),
    };
  }

  /** Whether the server has n8n configured. Said only to a caller already authorized. */
  get configured(): boolean {
    return this.deps.source !== null;
  }

  private async audit(
    userId: string,
    action: "read" | "sync" | "sync_run" | "sync_chain" | "inspect" | "allowlist_propose" | "allowlist_apply",
    result: "success" | "failure" | "rejected",
    metadata: Record<string, unknown>
  ): Promise<void> {
    try {
      await this.deps.audit.log({ userId, action: `automation_library.${action}`, result, metadata });
    } catch {
      /* an audit failure never changes the answer */
    }
  }

  /**
   * The owning Organization, when this caller may perform `operation` — or the
   * refusal. Outsiders are told one sentence, whatever is configured.
   */
  private async authorize(
    userId: string,
    operation: "read" | "sync" | "write"
  ): Promise<{ ok: true; tenantId: string } | { ok: false; status: number; code: string; message: string; reason: string }> {
    if (!this.deps.access) {
      return { ...refuse(503, "AUTHORIZATION_UNAVAILABLE", SHARED_ACCESS_UNVERIFIED), reason: "AUTHORIZATION_UNAVAILABLE" };
    }
    const decision = await this.deps.access.check(userId, N8N_REST, operation);
    if (decision.allowed) return { ok: true, tenantId: decision.tenantId };
    if (decision.code === "AUTHORIZATION_UNAVAILABLE") {
      return { ...refuse(503, "AUTHORIZATION_UNAVAILABLE", SHARED_ACCESS_UNVERIFIED), reason: decision.code };
    }
    if (!decision.member) {
      return { ...refuse(403, "NOT_AVAILABLE", sharedConnectionUnavailable(INTEGRATION_NAME)), reason: decision.code };
    }
    return {
      ...refuse(
        403,
        "PERMISSION_DENIED",
        operation === "sync"
          ? "Only an owner or admin of your organization can synchronize the n8n workflow library."
          : operation === "write"
            ? "Only an owner or admin of your organization can propose or add a workflow to the trigger allow-list."
            : "Your organization role does not allow reading the n8n workflow library."
      ),
      reason: decision.code,
    };
  }

  private scopeFor(tenantId: string): LibraryScope {
    return { tenantId, providerId: AUTOMATION_LIBRARY_PROVIDER, instanceKey: this.deps.source!.instanceKey };
  }

  /**
   * Stage 18.4 — the caller's catalog, for the planning service: the same
   * authorization, the same one answer to an outsider, and the same scope as
   * every library call. It audits nothing; the caller does.
   */
  async resolveCatalog(
    userId: string,
    operation: "read" | "write"
  ): Promise<{ ok: true; tenantId: string; scope: LibraryScope } | { ok: false; status: number; code: string; message: string; reason: string }> {
    const access = await this.authorize(userId, operation);
    if (!access.ok) return access;
    if (!this.deps.source) return { ...refuse(NOT_CONFIGURED.status, NOT_CONFIGURED.code, NOT_CONFIGURED.message), reason: NOT_CONFIGURED.code };
    return { ok: true, tenantId: access.tenantId, scope: this.scopeFor(access.tenantId) };
  }

  async status(userId: string): Promise<LibraryResult<LibraryStatusView>> {
    const access = await this.authorize(userId, "read");
    if (!access.ok) {
      await this.audit(userId, "read", "rejected", { authz: access.reason });
      return refuse(access.status, access.code, access.message);
    }
    if (!this.deps.source) {
      return {
        ok: true,
        value: {
          configured: false,
          state: "never_synced",
          canSync: false,
          catalog: { present: 0, missing: 0, removed: 0 },
          currentScan: null,
          lastCompleteScan: null,
          runs: [],
          continuation: null,
        },
      };
    }
    const now = this.now();
    let record: Awaited<ReturnType<AutomationLibraryStore["readStatus"]>>;
    try {
      record = await this.deps.store.readStatus(this.scopeFor(access.tenantId), now, this.chain.staleMs);
    } catch {
      this.deps.log?.warn("automation_library_store_unavailable", { stage: "status" });
      return refuse(503, "LIBRARY_UNAVAILABLE", "The workflow library could not be read right now. Try again.");
    }
    const latest = record.runs[0] ?? null;
    // Whether this reader may start a sync — the same question a start asks,
    // answered now. A hint for the screen; a start is checked again.
    const canSync = (await this.authorize(userId, "sync").catch(() => null))?.ok === true;
    return {
      ok: true,
      value: {
        configured: true,
        state: deriveLibraryState({
          leaseHeld: record.leaseHeld,
          latestRunStatus: latest?.status ?? null,
          scanOpen: record.scan !== null,
          lastCompleteAt: record.lastComplete?.at ?? null,
          chainActive: record.chain?.alive === true,
        }),
        canSync,
        catalog: record.entries,
        currentScan: record.scan,
        lastCompleteScan: record.lastComplete ? { completedAt: record.lastComplete.at, records: record.lastComplete.records } : null,
        runs: record.runs.map(runView),
        continuation: record.chain ? chainView(record.chain) : null,
      },
    };
  }

  async list(userId: string, query: LibraryEntryQuery): Promise<LibraryResult<LibraryEntryPage>> {
    const access = await this.authorize(userId, "read");
    if (!access.ok) {
      await this.audit(userId, "read", "rejected", { authz: access.reason });
      return refuse(access.status, access.code, access.message);
    }
    if (!this.deps.source) return refuse(NOT_CONFIGURED.status, NOT_CONFIGURED.code, NOT_CONFIGURED.message);
    let found: Awaited<ReturnType<AutomationLibraryStore["listEntries"]>>;
    try {
      found = await this.deps.store.listEntries(this.scopeFor(access.tenantId), query);
    } catch {
      this.deps.log?.warn("automation_library_store_unavailable", { stage: "list" });
      return refuse(503, "LIBRARY_UNAVAILABLE", "The workflow library could not be read right now. Try again.");
    }
    const { items, total } = found;
    return {
      ok: true,
      value: { items, page: query.page, limit: query.limit, total, totalPages: Math.max(Math.ceil(total / query.limit), 1) },
    };
  }

  /**
   * The one entry every surface starts a sync through (`AutomationLibraryPort`):
   * one bounded run, or — with `continueUntilComplete` — a chain of them. The
   * work continues after the answer; the caller follows it on `status`.
   */
  async startSync(
    userId: string,
    options: { restart?: boolean; continueUntilComplete?: boolean; idempotencyKey?: string; via?: LibraryCaller } = {}
  ): Promise<LibraryResult<LibrarySyncStarted>> {
    if (options.continueUntilComplete === true) {
      const started = await this.startContinuation(userId, options);
      if (!started.ok) return started;
      void started.value.completion?.catch(() => undefined);
      const { chainId, existing, state } = started.value;
      return { ok: true, value: { mode: "continue", chainId, existing, state } };
    }
    const started = await this.requestSync(userId, { restart: options.restart === true, ...(options.via ? { via: options.via } : {}) });
    if (!started.ok) return started;
    // The run's end is audited and logged by the service.
    void started.value.completion.catch(() => undefined);
    const { runId, resumed } = started.value;
    return { ok: true, value: { mode: "run", runId, resumed, state: "running" } };
  }

  /**
   * The caller's slot, then the Organization's for this catalog — reserved
   * before anything reaches n8n. Unknown is no. Null when both were reserved.
   */
  private async reserveToStart(
    userId: string,
    scope: LibraryScope
  ): Promise<{ status: number; code: string; message: string; reason: string } | null> {
    const budget = this.deps.budget;
    const unavailable = { allowed: false, reason: "UNAVAILABLE" as const };
    const mine = budget ? await budget.reserveForUser(userId).catch(() => unavailable) : unavailable;
    const ours = mine.allowed && budget ? await budget.reserveForOrganization(scope, userId).catch(() => unavailable) : null;
    const refusal = !mine.allowed ? mine : ours && !ours.allowed ? ours : null;
    if (!refusal) return null;
    return {
      status: 429,
      code: "RATE_LIMITED",
      reason: refusal.reason ?? "LIMIT",
      message:
        refusal.reason === "UNAVAILABLE"
          ? "The synchronization budget could not be checked, so nothing was started."
          : !mine.allowed
            ? `You have started ${LIBRARY_SYNC_BUDGETS.perUser.limit} synchronizations in the last ${LIBRARY_SYNC_BUDGETS.perUser.windowMs / 60_000} minutes. Try again later.`
            : `Your organization has started ${LIBRARY_SYNC_BUDGETS.perOrganization.limit} synchronizations of this library in the last hour. Try again later.`,
    };
  }

  async requestSync(
    userId: string,
    options: { restart?: boolean; via?: LibraryCaller } = {}
  ): Promise<LibraryResult<LibrarySyncAccepted>> {
    const via = options.via ?? "api";
    const access = await this.authorize(userId, "sync");
    if (!access.ok) {
      await this.audit(userId, "sync", "rejected", { authz: access.reason, via });
      return refuse(access.status, access.code, access.message);
    }
    const tenantId = access.tenantId;
    if (!this.deps.source) {
      await this.audit(userId, "sync", "failure", { reason: "not_configured", tenantId, via });
      return refuse(NOT_CONFIGURED.status, NOT_CONFIGURED.code, NOT_CONFIGURED.message);
    }
    const scope = this.scopeFor(tenantId);

    const refusal = await this.reserveToStart(userId, scope);
    if (refusal) {
      await this.audit(userId, "sync", "rejected", { rateLimited: true, reason: refusal.reason, tenantId, via });
      return refuse(refusal.status, refusal.code, refusal.message);
    }

    const limits = this.deps.limits ?? {};
    const leaseMs = limits.leaseMs ?? LIBRARY_LEASE_MS;
    const runId = this.newId();
    let begun: Awaited<ReturnType<AutomationLibraryStore["beginRun"]>>;
    try {
      begun = await this.deps.store.beginRun({
        scope,
        runId,
        newScanId: this.newId(),
        requestedById: userId,
        pageSize: clampLibraryPageSize(limits.pageSize),
        restart: options.restart === true,
        leaseMs,
        now: this.now(),
        // A single run: refused while a live chain holds the catalog.
        chainStaleMs: this.chain.staleMs,
      });
    } catch {
      await this.audit(userId, "sync", "failure", { reason: "store_unavailable", tenantId, via });
      this.deps.log?.warn("automation_library_store_unavailable", { stage: "begin" });
      return refuse(LIBRARY_UNREACHABLE.status, LIBRARY_UNREACHABLE.code, LIBRARY_UNREACHABLE.message);
    }
    if (!begun.ok) {
      await this.audit(userId, "sync", "rejected", { reason: "SYNC_ALREADY_RUNNING", tenantId, via });
      return refuse(SYNC_ALREADY_RUNNING.status, SYNC_ALREADY_RUNNING.code, SYNC_ALREADY_RUNNING.message);
    }

    await this.audit(userId, "sync", "success", {
      runId,
      resumed: begun.resumed,
      recoveredRuns: begun.recoveredRuns,
      tenantId,
      via,
    });
    this.deps.log?.info("automation_library_run_started", { runId, resumed: begun.resumed, recoveredRuns: begun.recoveredRuns });

    // The run continues after the answer: a bounded run can outlast a request.
    const completion = continueLibraryRun({
      store: this.deps.store,
      source: this.deps.source.pages,
      scope,
      runId,
      checkpoint: begun.checkpoint,
      maxPages: clampLibraryPagesPerRun(limits.maxPagesPerRun),
      leaseMs,
      now: this.now,
      ...(this.deps.shouldStop ? { shouldStop: this.deps.shouldStop } : {}),
    }).then(async (outcome) => {
      await this.audit(userId, "sync_run", outcome.status === "FAILED" ? "failure" : "success", {
        runId,
        status: outcome.status,
        failureCode: outcome.failureCode,
        pagesFetched: outcome.pagesFetched,
        recordsObserved: outcome.recordsObserved,
        created: outcome.created,
        updated: outcome.updated,
        rejected: outcome.rejected,
        markedMissing: outcome.markedMissing,
        markedRemoved: outcome.markedRemoved,
        tenantId,
      });
      const fields = { runId, status: outcome.status, failureCode: outcome.failureCode, pagesFetched: outcome.pagesFetched };
      if (outcome.status === "FAILED") this.deps.log?.warn("automation_library_run_finished", fields);
      else this.deps.log?.info("automation_library_run_finished", fields);
      return outcome;
    });

    return { ok: true, value: { runId, resumed: begun.resumed, state: "running", completion } };
  }

  // -------------------------------------------------------------------------
  // Stage 18.3B — inspection and the trigger allow-list
  // -------------------------------------------------------------------------

  /** The entry, for an authorized caller of this catalog — or the refusal. Fails closed. */
  private async entryFor(
    userId: string,
    entryId: string,
    operation: "read" | "write",
    auditAs: "inspect" | "allowlist_propose" | "allowlist_apply"
  ): Promise<
    | { ok: true; tenantId: string; scope: LibraryScope; entry: Awaited<ReturnType<AutomationLibraryStore["findEntry"]>> & object }
    | { ok: false; status: number; code: string; message: string }
  > {
    if (!isLibraryEntryId(entryId)) return refuse(400, "INVALID_ENTRY", "That is not a workflow library entry id.");
    const access = await this.authorize(userId, operation);
    if (!access.ok) {
      await this.audit(userId, auditAs, "rejected", { authz: access.reason, entryId });
      return refuse(access.status, access.code, access.message);
    }
    if (!this.deps.source) return refuse(NOT_CONFIGURED.status, NOT_CONFIGURED.code, NOT_CONFIGURED.message);
    const scope = this.scopeFor(access.tenantId);
    let entry: Awaited<ReturnType<AutomationLibraryStore["findEntry"]>>;
    try {
      entry = await this.deps.store.findEntry(scope, entryId);
    } catch {
      this.deps.log?.warn("automation_library_store_unavailable", { stage: "find_entry" });
      return refuse(503, "LIBRARY_UNAVAILABLE", "The workflow library could not be read right now. Try again.");
    }
    if (!entry) return refuse(404, "ENTRY_NOT_FOUND", "No workflow with that id is in your organization's library.");
    return { ok: true, tenantId: access.tenantId, scope, entry };
  }

  /** The caller's latest proposal for this entry, from the approval store. */
  private async latestProposal(userId: string, entryId: string): Promise<{ approval: Approval; status: LibraryProposalStatus } | null> {
    if (!this.deps.approvals) return null;
    const { items } = await this.deps.approvals.listByUser(userId, { limit: 100 });
    const mine = items
      .filter((a) => a.toolId === AUTOMATION_LIBRARY_TOOL_IDS.allowlistAdd && (a.params as Record<string, unknown>)?.entryId === entryId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const approval = mine[0];
    if (!approval) return null;
    const lapsed = (approval.status === "pending" || approval.status === "approved") && Date.parse(approval.expiresAt) <= this.now().getTime();
    const status: LibraryProposalStatus = lapsed
      ? "expired"
      : approval.status === "pending"
        ? "awaiting_approval"
        : approval.status === "approved"
          ? "approved"
          : approval.status === "rejected"
            ? "rejected"
            : approval.status === "consumed"
              ? "used"
              : "expired";
    return { approval, status };
  }

  /** The sanitized structure of one entry, from the catalog alone, with the caller's proposal and allow-list standing. */
  async inspect(userId: string, entryId: string): Promise<LibraryResult<LibraryInspectionView>> {
    const found = await this.entryFor(userId, entryId, "read", "inspect");
    if (!found.ok) return found;
    const inspection = inspectLibraryEntry(found.entry);
    const ref = libraryEntryRef(found.scope.instanceKey, entryId);

    let allowlist: LibraryInspectionView["allowlist"] = { status: "not_on_allowlist", registeredVersionId: null };
    let proposal: Awaited<ReturnType<AutomationLibraryService["latestProposal"]>> = null;
    let standingKnown = true;
    try {
      const rows = this.deps.allowlist ? await this.deps.allowlist.findLibraryRegistrations(userId, [ref]) : [];
      const row = rows.find((r) => r.entryRef === ref);
      if (row) {
        allowlist = {
          status: row.versionId !== null && row.versionId === inspection.versionId ? "on_allowlist" : "on_allowlist_other_version",
          registeredVersionId: row.versionId,
        };
      }
      proposal = await this.latestProposal(userId, entryId);
    } catch {
      // The view is still given; nothing may be proposed on a standing that could not be read.
      standingKnown = false;
    }

    const blocked = await this.proposeBlocker(userId, inspection, allowlist, proposal, standingKnown);
    return {
      ok: true,
      value: {
        ...inspection,
        inspectedAt: this.now().toISOString(),
        source: "catalog",
        allowlist,
        proposal: proposal
          ? {
              status: proposal.status,
              approvalId: proposal.approval.id,
              versionId: typeof (proposal.approval.params as Record<string, unknown>).versionId === "string" ? ((proposal.approval.params as Record<string, unknown>).versionId as string) : null,
            }
          : null,
        canPropose: blocked === null,
        proposeBlockedReason: blocked,
      },
    };
  }

  /** Why this caller may not propose this entry now, or null when they may. */
  private async proposeBlocker(
    userId: string,
    inspection: ReturnType<typeof inspectLibraryEntry>,
    allowlist: LibraryInspectionView["allowlist"],
    proposal: { approval: Approval; status: LibraryProposalStatus } | null,
    standingKnown: boolean
  ): Promise<string | null> {
    const access = await this.authorize(userId, "write").catch(() => null);
    if (!access?.ok) return "Only an owner or admin of your organization can propose a workflow for the trigger allow-list.";
    if (!this.deps.approvals || !this.deps.allowlist) return "Proposals are not available on this server.";
    if (!standingKnown) return "The allow-list could not be read right now, so nothing can be proposed. Try again.";
    if (inspection.stale.stale) return "This workflow was not seen in the last complete scan. Synchronize the library first.";
    if (!inspection.versionId) return "n8n did not report a version for this workflow, so a proposal could not be bound to it.";
    if (!inspection.trigger.kinds.some((k) => k.kind === "webhook")) return "This workflow has no webhook trigger, which the trigger allow-list needs.";
    if (allowlist.status === "on_allowlist") return "This workflow is already on your trigger allow-list at its current version.";
    const sameVersion = proposal && (proposal.approval.params as Record<string, unknown>).versionId === inspection.versionId;
    if (sameVersion && proposal.status === "awaiting_approval") return "A proposal for this version is already waiting for approval.";
    if (sameVersion && proposal.status === "approved") return "A proposal for this version is approved and ready to add.";
    return null;
  }

  /**
   * Propose an entry for the caller's trigger allow-list: one approval row in
   * the approval store, bound to {entryId, versionId}. A repeated request for
   * the same entry and version returns the waiting proposal. Nothing changes.
   */
  async proposeAllowlist(
    userId: string,
    entryId: string,
    options: { via?: LibraryCaller } = {}
  ): Promise<LibraryResult<LibraryAllowlistProposal>> {
    const via = options.via ?? "api";
    const found = await this.entryFor(userId, entryId, "write", "allowlist_propose");
    if (!found.ok) return found;
    const approvals = this.deps.approvals;
    if (!approvals || !this.deps.allowlist) return refuse(503, "PROPOSALS_UNAVAILABLE", "Proposals are not available on this server.");
    const inspection = inspectLibraryEntry(found.entry);
    const refusal = (status: number, code: string, message: string) => {
      void this.audit(userId, "allowlist_propose", "rejected", { reason: code, entryId, tenantId: found.tenantId, via });
      return refuse(status, code, message);
    };
    if (inspection.stale.stale) return refusal(409, "ENTRY_STALE", "This workflow was not seen in the last complete scan. Synchronize the library first.");
    if (!inspection.versionId) return refusal(409, "VERSION_UNKNOWN", "n8n did not report a version for this workflow, so a proposal could not be bound to it.");
    if (!inspection.trigger.kinds.some((k) => k.kind === "webhook")) {
      return refusal(409, "NO_WEBHOOK_TRIGGER", "This workflow has no webhook trigger, which the trigger allow-list needs.");
    }

    const params: LibraryAllowlistParams = { entryId, versionId: inspection.versionId };
    const paramsHash = computeParamsHash(params as unknown as Record<string, unknown>);
    try {
      const registered = await this.deps.allowlist.findLibraryRegistrations(userId, [libraryEntryRef(found.scope.instanceKey, entryId)]);
      if (registered.some((r) => r.versionId === inspection.versionId)) {
        return refusal(409, "ALREADY_ON_ALLOWLIST", "This workflow is already on your trigger allow-list at its current version.");
      }
      // A retry, a second click: the proposal waiting for exactly this entry and version answers.
      const { items } = await approvals.listByUser(userId, { limit: 100 });
      const now = this.now().getTime();
      const waiting = items.find(
        (a) =>
          a.toolId === AUTOMATION_LIBRARY_TOOL_IDS.allowlistAdd &&
          a.paramsHash === paramsHash &&
          (a.status === "pending" || a.status === "approved") &&
          Date.parse(a.expiresAt) > now
      );
      if (waiting) {
        return {
          ok: true,
          value: {
            approvalId: waiting.id,
            existing: true,
            status: waiting.status === "approved" ? "approved" : "awaiting_approval",
            entryId,
            versionId: params.versionId,
            expiresAt: waiting.expiresAt,
          },
        };
      }
      // The store binds the approval to the Organization that owns n8n, from
      // its owner record — never from here.
      const created = await approvals.create({
        userId,
        toolId: AUTOMATION_LIBRARY_TOOL_IDS.allowlistAdd,
        action: "execute",
        params: params as unknown as Record<string, unknown>,
        paramsHash,
        riskLevel: "HIGH_IMPACT",
        expiresAt: new Date(now + APPROVAL_TTL_MS).toISOString(),
      });
      await this.audit(userId, "allowlist_propose", "success", {
        approvalId: created.id,
        entryId,
        versionId: params.versionId,
        tenantId: found.tenantId,
        via,
      });
      return {
        ok: true,
        value: { approvalId: created.id, existing: false, status: "awaiting_approval", entryId, versionId: params.versionId, expiresAt: created.expiresAt },
      };
    } catch {
      this.deps.log?.warn("automation_library_store_unavailable", { stage: "allowlist_propose" });
      return refusal(503, "PROPOSALS_UNAVAILABLE", "The proposal could not be recorded right now, so nothing was proposed. Try again.");
    }
  }

  /**
   * Put an approved proposal's workflow on the requester's trigger allow-list.
   * Run ONLY by `automation.library.allowlist.add`, through ToolExecutor, with
   * the approval: every check is made again here, the workflow's webhook
   * target is read once from n8n, `consume` (the tool's) spends the approval
   * with the Organization's scope, and only then is the row written.
   */
  async applyAllowlist(
    userId: string,
    raw: LibraryAllowlistParams,
    consume: (scope: SharedConnectionScope) => Promise<{ ok: true } | { ok: false; reason: string }>
  ): Promise<LibraryResult<LibraryAllowlistApplied>> {
    const params = validateLibraryAllowlistParams(raw);
    if (!params) return refuse(400, "INVALID_REQUEST", "A proposal names exactly one entry and its version.");
    const found = await this.entryFor(userId, params.entryId, "write", "allowlist_apply");
    if (!found.ok) return found;
    const fail = async (status: number, code: string, message: string, result: "rejected" | "failure" = "rejected") => {
      await this.audit(userId, "allowlist_apply", result, { reason: code, entryId: params.entryId, versionId: params.versionId, tenantId: found.tenantId });
      return refuse(status, code, message);
    };
    if (!this.deps.allowlist || !this.deps.triggerTargets) return fail(503, "PROPOSALS_UNAVAILABLE", "Adding to the trigger allow-list is not available on this server.");

    const inspection = inspectLibraryEntry(found.entry);
    if (inspection.stale.stale) return fail(409, "ENTRY_STALE", "This workflow was not seen in the last complete scan, so it was not added.");
    if (inspection.versionId !== params.versionId) {
      return fail(409, "VERSION_CHANGED", "The workflow changed in the library since it was proposed, so it was not added. Propose it again.");
    }

    // The one live read: n8n's current definition, reduced to the webhook
    // target before it leaves the n8n client.
    let read: Awaited<ReturnType<LibraryTriggerTargetSource["fetchTriggerTarget"]>>;
    try {
      read = await this.deps.triggerTargets.fetchTriggerTarget(params.entryId);
    } catch {
      read = { ok: false, error: { code: "PROVIDER_UNAVAILABLE" } };
    }
    if (!read.ok) return fail(503, "PROVIDER_UNAVAILABLE", "n8n could not be read to confirm the workflow, so nothing was added.", "failure");
    const target = read.target;
    if (target.versionId !== params.versionId) {
      return fail(409, "VERSION_CHANGED", "The workflow changed in n8n since it was proposed, so it was not added. Propose it again.");
    }
    if (target.webhooks.length !== 1) {
      return fail(
        409,
        "WEBHOOK_UNUSABLE",
        target.webhooks.length === 0
          ? "The workflow has no enabled webhook trigger in n8n, so it was not added."
          : "The workflow has more than one webhook trigger, so which one to call is not clear. It was not added."
      );
    }
    const webhook = target.webhooks[0]!;
    if (!webhook.path) return fail(409, "WEBHOOK_UNUSABLE", "The workflow's webhook path is an expression or not a plain path, so it was not added.");
    if (webhook.method !== "POST") return fail(409, "WEBHOOK_UNUSABLE", "The workflow's webhook does not accept POST, which the trigger sends, so it was not added.");
    if (webhook.authentication !== "none") {
      return fail(409, "WEBHOOK_UNUSABLE", "The workflow's webhook requires authentication the trigger does not send, so it was not added.");
    }

    // Everything checked: the approval is spent now, with the Organization's
    // scope re-checked by the store under its locks.
    let consumed: Awaited<ReturnType<typeof consume>>;
    try {
      consumed = await consume(sharedWriteScope(found.tenantId, N8N_REST));
    } catch {
      consumed = { ok: false, reason: "unavailable" };
    }
    if (!consumed.ok) return fail(409, "APPROVAL_REFUSED", "The approval could not be used — it may have expired, been used, or not been approved by another owner or admin.");

    let outcome: Awaited<ReturnType<LibraryAllowlistRegistry["registerLibraryWorkflow"]>>["outcome"];
    try {
      ({ outcome } = await this.deps.allowlist.registerLibraryWorkflow({
        userId,
        name: inspection.name,
        webhookPath: webhook.path,
        entryRef: libraryEntryRef(found.scope.instanceKey, params.entryId),
        versionId: params.versionId,
      }));
    } catch {
      this.deps.log?.warn("automation_library_store_unavailable", { stage: "allowlist_register" });
      return fail(503, "ALLOWLIST_UNAVAILABLE", "The approval was used but the allow-list could not be written. Propose it again.", "failure");
    }
    if (outcome === "conflict") {
      return fail(409, "ALLOWLIST_CONFLICT", "Another workflow on your trigger allow-list already uses this webhook, so it was not added.");
    }
    await this.audit(userId, "allowlist_apply", "success", {
      entryId: params.entryId,
      versionId: params.versionId,
      outcome,
      tenantId: found.tenantId,
    });
    this.deps.log?.info("automation_library_allowlist_applied", { outcome });
    return { ok: true, value: { entryId: params.entryId, versionId: params.versionId, outcome } };
  }

  // -------------------------------------------------------------------------
  // Stage 18.2 — continue until complete
  // -------------------------------------------------------------------------

  /**
   * Starts a chain, or answers with the one a repeated request would
   * duplicate. Authorized and spent exactly as a single run is.
   */
  async startContinuation(
    userId: string,
    options: { restart?: boolean; idempotencyKey?: string; via?: LibraryCaller } = {}
  ): Promise<LibraryResult<LibraryContinuationAccepted>> {
    const via = options.via ?? "api";
    const access = await this.authorize(userId, "sync");
    if (!access.ok) {
      await this.audit(userId, "sync", "rejected", { authz: access.reason, mode: "continue", via });
      return refuse(access.status, access.code, access.message);
    }
    const tenantId = access.tenantId;
    if (!this.deps.source) {
      await this.audit(userId, "sync", "failure", { reason: "not_configured", mode: "continue", tenantId, via });
      return refuse(NOT_CONFIGURED.status, NOT_CONFIGURED.code, NOT_CONFIGURED.message);
    }
    const scope = this.scopeFor(tenantId);
    const key = options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {};

    // A repeated click, a retry, another admin: the chain that exists answers,
    // before anything is spent.
    let existing: LibraryChainState | null;
    try {
      existing = await this.deps.store.peekChain(scope, { requestedById: userId, ...key, now: this.now(), staleMs: this.chain.staleMs });
    } catch {
      this.deps.log?.warn("automation_library_store_unavailable", { stage: "chain_peek" });
      return refuse(LIBRARY_UNREACHABLE.status, LIBRARY_UNREACHABLE.code, LIBRARY_UNREACHABLE.message);
    }
    if (existing) {
      await this.audit(userId, "sync", "success", { mode: "continue", chainId: existing.chainId, existing: true, tenantId, via });
      return { ok: true, value: { chainId: existing.chainId, existing: true, state: existingState(existing), completion: null } };
    }

    const refusal = await this.reserveToStart(userId, scope);
    if (refusal) {
      await this.audit(userId, "sync", "rejected", { rateLimited: true, reason: refusal.reason, mode: "continue", tenantId, via });
      return refuse(refusal.status, refusal.code, refusal.message);
    }

    let started: Awaited<ReturnType<AutomationLibraryStore["startChain"]>>;
    try {
      started = await this.deps.store.startChain({
        scope,
        chainId: this.newId(),
        requestedById: userId,
        ...key,
        limits: { maxRuns: this.chain.maxRuns, maxPages: this.chain.maxPages, maxMs: this.chain.maxMs },
        staleMs: this.chain.staleMs,
        now: this.now(),
      });
    } catch {
      await this.audit(userId, "sync", "failure", { reason: "store_unavailable", mode: "continue", tenantId, via });
      this.deps.log?.warn("automation_library_store_unavailable", { stage: "chain_start" });
      return refuse(LIBRARY_UNREACHABLE.status, LIBRARY_UNREACHABLE.code, LIBRARY_UNREACHABLE.message);
    }
    if (!started.ok) {
      await this.audit(userId, "sync", "rejected", { reason: "SYNC_ALREADY_RUNNING", mode: "continue", tenantId, via });
      return refuse(SYNC_ALREADY_RUNNING.status, SYNC_ALREADY_RUNNING.code, SYNC_ALREADY_RUNNING.message);
    }
    const chain = started.chain;
    if (!started.created) {
      await this.audit(userId, "sync", "success", { mode: "continue", chainId: chain.chainId, existing: true, tenantId, via });
      return { ok: true, value: { chainId: chain.chainId, existing: true, state: existingState(chain), completion: null } };
    }

    await this.audit(userId, "sync", "success", { mode: "continue", chainId: chain.chainId, existing: false, tenantId, via });
    this.deps.log?.info("automation_library_chain_started", { chainId: chain.chainId });
    const completion = this.driveChain({
      chainId: chain.chainId,
      scope,
      userId,
      restart: options.restart === true,
      deadline: new Date(chain.deadlineAt),
    });
    return { ok: true, value: { chainId: chain.chainId, existing: false, state: "running", completion } };
  }

  /**
   * Runs a chain's bounded runs, one after another, until the scan completes
   * or something stops it. Every decision is made again before every run:
   * the limits, the requester's authorization and the catalog's scope, the
   * Organization's budget, and the chain's hold on the catalog.
   */
  private async driveChain(input: {
    chainId: string;
    scope: LibraryScope;
    userId: string;
    restart: boolean;
    deadline: Date;
  }): Promise<LibraryChainOutcome> {
    const { chainId, scope, userId, deadline } = input;
    const store = this.deps.store;
    const limits = this.deps.limits ?? {};
    const leaseMs = limits.leaseMs ?? LIBRARY_LEASE_MS;
    let runs = 0;
    let pages = 0;
    let failuresInARow = 0;
    // The first run's Organization slot was reserved when the chain started.
    let slotReserved = true;

    const end = async (
      status: LibraryChainOutcome["status"],
      stopCode: LibraryChainStopCode | null,
      failureCode: LibraryFailureCode | null = null
    ): Promise<LibraryChainOutcome> => {
      try {
        await store.finishChain({ scope, chainId, status, stopCode, failureCode, now: this.now() });
      } catch {
        // Left RUNNING, its heartbeat goes stale: it is shown as interrupted,
        // and the next start closes it. Nothing is claimed for it.
        this.deps.log?.warn("automation_library_store_unavailable", { stage: "chain_finish" });
      }
      await this.audit(userId, "sync_chain", status === "COMPLETE" ? "success" : "failure", {
        chainId,
        status,
        stopCode,
        failureCode,
        runs,
        pages,
        tenantId: scope.tenantId,
      });
      const fields = { chainId, status, stopCode, failureCode, runs, pages };
      if (status === "COMPLETE") this.deps.log?.info("automation_library_chain_finished", fields);
      else this.deps.log?.warn("automation_library_chain_finished", fields);
      return { chainId, status, stopCode, failureCode, runs, pages };
    };
    const stop = (code: LibraryChainStopCode, failureCode: LibraryFailureCode | null = null) => end("STOPPED", code, failureCode);
    const stopping = () => this.deps.shouldStop?.() === true;

    try {
      for (;;) {
        // 1. The hard limits.
        if (stopping()) return await stop("SHUTDOWN");
        if (runs >= this.chain.maxRuns) return await stop("RUN_LIMIT");
        if (pages >= this.chain.maxPages) return await stop("PAGE_LIMIT");
        if (this.now() >= deadline) return await stop("TIME_LIMIT");

        // 2. The requester may still synchronize, and the catalog is still
        //    the one this chain began on: read from the database, now.
        const access = await this.authorize(userId, "sync").catch(() => null);
        if (!access) return await stop("AUTHORIZATION_UNAVAILABLE");
        if (!access.ok) return await stop(access.code === "AUTHORIZATION_UNAVAILABLE" ? "AUTHORIZATION_UNAVAILABLE" : "AUTHORIZATION_CHANGED");
        if (!this.deps.source) return await stop("SCOPE_CHANGED");
        const current = this.scopeFor(access.tenantId);
        if (current.tenantId !== scope.tenantId || current.instanceKey !== scope.instanceKey) return await stop("SCOPE_CHANGED");

        // 3. The Organization's budget for this catalog, for every run.
        if (!slotReserved) {
          const unavailable = { allowed: false, reason: "UNAVAILABLE" as const };
          const ours = this.deps.budget
            ? await this.deps.budget.reserveForOrganization(scope, userId).catch(() => unavailable)
            : unavailable;
          if (!ours.allowed) return await stop(ours.reason === "UNAVAILABLE" ? "BUDGET_UNAVAILABLE" : "BUDGET_EXHAUSTED");
        }
        slotReserved = false;

        // 4. One ordinary bounded run, as this chain's — refused if the chain
        //    no longer holds the catalog or a run holds the lease.
        const runId = this.newId();
        let begun: Awaited<ReturnType<AutomationLibraryStore["beginRun"]>>;
        try {
          begun = await store.beginRun({
            scope,
            runId,
            newScanId: this.newId(),
            requestedById: userId,
            pageSize: clampLibraryPageSize(limits.pageSize),
            restart: input.restart && runs === 0,
            leaseMs,
            now: this.now(),
            chainId,
            chainStaleMs: this.chain.staleMs,
          });
        } catch {
          return await stop("STORE_UNAVAILABLE");
        }
        if (!begun.ok) return await stop(begun.reason === "CHAIN_LOST" ? "CHAIN_LOST" : "SYNC_ALREADY_RUNNING");
        runs += 1;

        const outcome = await continueLibraryRun({
          store,
          source: this.deps.source.pages,
          scope,
          runId,
          checkpoint: begun.checkpoint,
          maxPages: Math.min(clampLibraryPagesPerRun(limits.maxPagesPerRun), this.chain.maxPages - pages),
          leaseMs,
          now: this.now,
          // The run ends PARTIAL at a page boundary when the server stops or
          // the chain's time is up.
          shouldStop: () => stopping() || this.now() >= deadline,
        });
        pages += outcome.pagesFetched;
        await this.audit(userId, "sync_run", outcome.status === "FAILED" ? "failure" : "success", {
          runId,
          chainId,
          status: outcome.status,
          failureCode: outcome.failureCode,
          pagesFetched: outcome.pagesFetched,
          recordsObserved: outcome.recordsObserved,
          created: outcome.created,
          updated: outcome.updated,
          rejected: outcome.rejected,
          markedMissing: outcome.markedMissing,
          markedRemoved: outcome.markedRemoved,
          tenantId: scope.tenantId,
        });

        let held: boolean;
        try {
          held = await store.recordChainProgress({
            scope,
            chainId,
            now: this.now(),
            run: { runId, pages: outcome.pagesFetched, records: outcome.recordsObserved, failureCode: outcome.failureCode },
          });
        } catch {
          held = false;
          if (outcome.status !== "COMPLETE") return await stop("STORE_UNAVAILABLE");
        }

        // 5. Complete only because the store completed the scan.
        if (outcome.status === "COMPLETE") return await end("COMPLETE", null);
        if (!held) return await stop("CHAIN_LOST");
        if (outcome.status === "FAILED") {
          if (!isRetryableLibraryFailure(outcome.failureCode)) return await stop("RUN_FAILED", outcome.failureCode);
          failuresInARow += 1;
          if (failuresInARow >= LIBRARY_CHAIN_MAX_CONSECUTIVE_FAILURES) return await stop("RETRY_LIMIT", outcome.failureCode);
          await this.sleep(this.chain.retryDelayMs * failuresInARow);
          continue;
        }
        failuresInARow = 0;
      }
    } catch {
      return stop("INTERRUPTED");
    }
  }
}
