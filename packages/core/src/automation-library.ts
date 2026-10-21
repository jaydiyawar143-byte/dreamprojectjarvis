// ---------------------------------------------------------------------------
// Phase 18, Stage 18.1 — the persistent Automation Library: its rules.
//
// WHAT IT IS. A durable catalog of the workflows an n8n instance holds, built
// by reading the instance's Public REST API page by page and stored so it
// survives a restart. It is large-catalog work: an instance can hold more than
// 10,000 workflows, more than one bounded traversal reaches, so a catalog is
// built by SCANS that may span several bounded RUNS, each resuming from a
// checkpoint the previous one saved.
//
// WHAT THIS FILE HOLDS. The pure part, beside the Automation Registry: how a
// listed workflow is normalized and fingerprinted, how a fetch failure is named,
// how a cursor is remembered for cycle detection, how an instance is identified
// without storing its address, and the two ports a sync drives — a page source
// (the network) and a store (the database). No I/O here; nothing here holds a
// credential, and nothing here can run, activate or edit a workflow.
//
// A CATALOG ENTRY IS AN OBSERVATION, NOT A PERMISSION. That a workflow was seen
// in the instance says nothing about who may trigger it: triggering stays the
// per-account allow-list (`N8nWorkflow`) and the approval-gated `n8n.trigger`.
//
// HONESTY RULES this file encodes:
//   • A scan is COMPLETE only when the cursor chain ran out — `nextCursor` came
//     back empty — with every page stored. A run that stopped at its page budget
//     is PARTIAL; a run that failed is FAILED. Nothing truncated is complete.
//   • A cursor that comes back a second time in one scan is a cycle: the scan
//     fails and is never completed by it.
//   • Absence is not proven by one scan. n8n's workflow cursor carries an
//     offset, so a deletion while a long scan runs can shift the window and skip
//     a workflow that still exists. An entry is therefore reported removed only
//     after it was missing from `LIBRARY_MISSED_SCANS_BEFORE_REMOVED`
//     CONSECUTIVE complete scans, and it is never deleted — only marked.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

/** The provider whose workflows the library catalogs today. */
export const AUTOMATION_LIBRARY_PROVIDER = "n8n";

/** n8n's documented maximum page size for a listing. */
export const LIBRARY_MAX_PAGE_SIZE = 250;

/** Pages one run reads before it stops and saves its place. Bounded on purpose. */
export const LIBRARY_MAX_PAGES_PER_RUN = 20;

/**
 * Pages one SCAN may read, across all its runs, before it is abandoned as
 * unbounded — a million workflows at the maximum page size. A real instance
 * stops well before; a provider whose cursor never ends does not.
 */
export const LIBRARY_MAX_PAGES_PER_SCAN = 4000;

/** Consecutive complete scans an entry must be missing from before it is removed. */
export const LIBRARY_MISSED_SCANS_BEFORE_REMOVED = 2;

/**
 * How long a run's claim on its scope lasts without being renewed. Every stored
 * page renews it, so it must outlast one fetch (n8n's timeout is at most two
 * minutes) plus the write that follows.
 */
export const LIBRARY_LEASE_MS = 3 * 60_000;

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** One run's outcome. RUNNING only while it holds its lease. */
export type LibraryRunStatus = "RUNNING" | "PARTIAL" | "COMPLETE" | "FAILED";

/** Why a run failed. Stable codes; the sentences below are what a person reads. */
export type LibraryFailureCode =
  | "PROVIDER_AUTH_FAILED"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_RESPONSE_INVALID"
  | "PROVIDER_REJECTED_REQUEST"
  | "CURSOR_REJECTED"
  | "CURSOR_CYCLE"
  | "SCAN_TOO_LONG"
  | "LEASE_LOST"
  | "INTERRUPTED"
  | "PERSISTENCE_FAILED";

/**
 * Fixed sentences. A provider's own error text never reaches a run, a log or a
 * reader: it can echo a key, a URL or an instance's internals.
 */
export const LIBRARY_FAILURE_MESSAGES: Readonly<Record<LibraryFailureCode, string>> = {
  PROVIDER_AUTH_FAILED: "n8n refused the server's API key, so the workflow list could not be read.",
  PROVIDER_RATE_LIMITED: "n8n is rate-limiting this server. The pages already read are kept; try again later.",
  PROVIDER_TIMEOUT: "n8n did not answer in time. The pages already read are kept; the next run continues from them.",
  PROVIDER_UNAVAILABLE: "n8n could not be reached. The pages already read are kept; the next run continues from them.",
  PROVIDER_RESPONSE_INVALID: "n8n answered with a workflow list this server could not read.",
  PROVIDER_REJECTED_REQUEST: "n8n refused the workflow list request.",
  CURSOR_REJECTED:
    "n8n no longer accepts the saved position in the workflow list. The next run starts the scan again from the first page; nothing already read is lost.",
  CURSOR_CYCLE:
    "n8n returned a position in the workflow list it had already returned in this scan. The scan was stopped and is not complete; the next run starts again from the first page.",
  SCAN_TOO_LONG: "The scan read more pages than any catalog this server accepts. It was stopped and is not complete.",
  LEASE_LOST: "Another run took over this library while this one was working. Its pages are kept.",
  INTERRUPTED: "The run stopped without finishing — the server restarted or lost contact with it. The next run continues from its last stored page.",
  PERSISTENCE_FAILED: "A page could not be stored. Nothing from it was recorded; the next run reads it again.",
};

/** What the library as a whole looks like to a reader. */
export type LibraryState = "never_synced" | "running" | "partial" | "complete" | "failed";

/**
 * One entry's standing in the catalog: seen in the last complete scan (or since),
 * missing from the latest complete scan(s) but not yet confirmed gone, or
 * confirmed gone after consecutive complete scans.
 */
export type LibraryEntryPresence = "present" | "missing" | "removed";

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * A workflow as a page source delivers it — structurally the REST registry's
 * input plus the metadata a listing may carry. Every optional field is absent
 * when the provider did not send it; absent is "unknown", never "none".
 */
export interface LibraryRemoteWorkflow {
  id: string;
  name: string;
  active: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
  versionId?: string | null;
  tags?: readonly string[] | null;
  nodeTypes?: readonly string[] | null;
  nodeCount?: number | null;
}

/** A workflow as the library stores it. Metadata only — never a node's parameters. */
export interface LibraryWorkflowRecord {
  externalId: string;
  name: string;
  active: boolean;
  remoteCreatedAt: string | null;
  remoteUpdatedAt: string | null;
  versionId: string | null;
  /** Null: the listing did not say. */
  tags: string[] | null;
  /** Null: the listing did not include nodes. */
  nodeTypes: string[] | null;
  nodeCount: number | null;
  /** Lower-cased name, tags and node types, for search. */
  searchText: string;
  /** SHA-256 of every stored field above — changes when the workflow's listing changes. */
  fingerprint: string;
}

const EXTERNAL_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const VERSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const NODE_TYPE = /^[A-Za-z0-9@][A-Za-z0-9@._/:-]{0,149}$/;
const MAX_NAME = 256;

/** Stage 18.3B — the stored patterns, re-checked by the inspection on the way out. */
export const LIBRARY_EXTERNAL_ID_PATTERN = EXTERNAL_ID;
export const LIBRARY_VERSION_ID_PATTERN = VERSION_ID;
export const LIBRARY_NODE_TYPE_PATTERN = NODE_TYPE;
const MAX_TAG = 64;
const MAX_TAGS = 50;
const MAX_NODE_TYPES = 200;
const MAX_NODE_COUNT = 100_000;
const MAX_SEARCH_TEXT = 2000;

/** Control characters out, whitespace collapsed, length bounded. */
function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (text.length === 0) return null;
  return text.length <= max ? text : text.slice(0, max);
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function normalizeTags(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const tags: string[] = [];
  for (const item of value) {
    const tag = cleanText(item, MAX_TAG);
    if (tag) tags.push(tag);
  }
  return sortedUnique(tags).slice(0, MAX_TAGS);
}

function normalizeNodeTypes(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const types = value.filter((item): item is string => typeof item === "string" && NODE_TYPE.test(item));
  return sortedUnique(types).slice(0, MAX_NODE_TYPES);
}

/** The normalized search text of a record: what a filter matches against. */
export function librarySearchText(name: string, tags: readonly string[] | null, nodeTypes: readonly string[] | null): string {
  return normalizeLibrarySearch([name, ...(tags ?? []), ...(nodeTypes ?? [])].join(" ")).slice(0, MAX_SEARCH_TEXT);
}

/** How a search query and a record's text are compared: NFKC, lower case, single spaces. */
export function normalizeLibrarySearch(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * The fingerprint of a record: SHA-256 over every field the library stores
 * about the workflow, in a fixed order. Equal fingerprints mean the listing did
 * not change; a different one means it did. It is a fingerprint of the
 * listing's metadata — n8n's own `versionId` included when sent — and never of
 * the workflow's nodes, whose parameters the library does not read.
 */
export function libraryFingerprint(record: Omit<LibraryWorkflowRecord, "searchText" | "fingerprint">): string {
  const canonical = JSON.stringify([
    record.externalId,
    record.name,
    record.active,
    record.remoteCreatedAt,
    record.remoteUpdatedAt,
    record.versionId,
    record.tags,
    record.nodeTypes,
    record.nodeCount,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * One listed workflow as a stored record, or null when it cannot be addressed
 * (no usable id). Every field is bounded; nothing outside the allowed fields
 * survives, whatever the source sent.
 */
export function normalizeLibraryWorkflow(raw: LibraryRemoteWorkflow | null | undefined): LibraryWorkflowRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const externalId = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!EXTERNAL_ID.test(externalId)) return null;

  const versionId = typeof raw.versionId === "string" && VERSION_ID.test(raw.versionId) ? raw.versionId : null;
  const nodeCount =
    typeof raw.nodeCount === "number" && Number.isInteger(raw.nodeCount) && raw.nodeCount >= 0 && raw.nodeCount <= MAX_NODE_COUNT
      ? raw.nodeCount
      : null;
  const base = {
    externalId,
    name: cleanText(raw.name, MAX_NAME) ?? "",
    active: raw.active === true,
    remoteCreatedAt: isoOrNull(raw.createdAt),
    remoteUpdatedAt: isoOrNull(raw.updatedAt),
    versionId,
    tags: normalizeTags(raw.tags),
    nodeTypes: normalizeNodeTypes(raw.nodeTypes),
    nodeCount,
  };
  return {
    ...base,
    searchText: librarySearchText(base.name, base.tags, base.nodeTypes),
    fingerprint: libraryFingerprint(base),
  };
}

/**
 * A page with every external id once. When a page repeats a workflow, the last
 * occurrence wins — the order of first appearance is kept.
 */
export function dedupeLibraryPage(records: readonly LibraryWorkflowRecord[]): LibraryWorkflowRecord[] {
  const byId = new Map<string, LibraryWorkflowRecord>();
  for (const record of records) {
    if (byId.has(record.externalId)) byId.delete(record.externalId);
    byId.set(record.externalId, record);
  }
  const order = new Map<string, number>();
  records.forEach((record, index) => {
    if (!order.has(record.externalId)) order.set(record.externalId, index);
  });
  return [...byId.values()].sort((a, b) => order.get(a.externalId)! - order.get(b.externalId)!);
}

// ---------------------------------------------------------------------------
// Cursors, instances, failures
// ---------------------------------------------------------------------------

/**
 * How a cursor is remembered for cycle detection: a hash. The cursor itself is
 * kept only as the scan's resume point, never in a trail and never shown.
 */
export function libraryCursorHash(cursor: string): string {
  return createHash("sha256").update(`library-cursor:${cursor}`).digest("hex");
}

/**
 * The identity of one n8n instance: a hash of its base URL's scheme, host and
 * path. Pointing the server at another instance starts another catalog, and the
 * address itself is never stored. Null for anything that is not an http(s) URL.
 */
export function libraryInstanceKey(baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  // Host and path only: credentials in the URL, a query or a fragment never
  // contribute — and are never stored, since only the hash is.
  const identity = `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "")}`;
  return createHash("sha256").update(`library-instance:${identity}`).digest("hex").slice(0, 32);
}

/**
 * A page source's failure, as the library names it. The input is structural —
 * a classified provider error's code and status — so core never imports a
 * provider package and never sees the provider's message.
 */
export function classifyLibraryFetchFailure(
  error: { code: string; httpStatus?: number },
  context: { cursorSent: boolean }
): LibraryFailureCode {
  switch (error.code) {
    case "AUTHENTICATION_REQUIRED":
    case "AUTHORIZATION_FAILED":
      return "PROVIDER_AUTH_FAILED";
    case "RATE_LIMITED":
      return "PROVIDER_RATE_LIMITED";
    case "TOOL_TIMEOUT":
      return "PROVIDER_TIMEOUT";
    case "INVALID_REQUEST":
      // No HTTP status: the request succeeded and the BODY was unreadable.
      if (error.httpStatus === undefined) return "PROVIDER_RESPONSE_INVALID";
      // A 400/422 to a request that carried a saved position is the position
      // being refused. Without one, it is the request itself.
      if ((error.httpStatus === 400 || error.httpStatus === 422) && context.cursorSent) return "CURSOR_REJECTED";
      return "PROVIDER_REJECTED_REQUEST";
    default:
      return "PROVIDER_UNAVAILABLE";
  }
}

/** Where an entry stands, from what complete scans recorded about it. */
export function libraryEntryPresence(entry: { missedScans: number; removedAt: string | Date | null }): LibraryEntryPresence {
  if (entry.removedAt) return "removed";
  return entry.missedScans > 0 ? "missing" : "present";
}

/**
 * The library's state for a reader. `running` while a live lease is held;
 * otherwise the latest run decides — a failed (or interrupted) run is
 * `failed`, a scan still open is `partial` — and only with no scan open and a
 * complete scan on record is it `complete`.
 */
export function deriveLibraryState(input: {
  leaseHeld: boolean;
  latestRunStatus: LibraryRunStatus | null;
  scanOpen: boolean;
  lastCompleteAt: string | null;
  /** Stage 18.2 — a continue-until-complete chain is alive (between its runs too). */
  chainActive?: boolean;
}): LibraryState {
  if (input.leaseHeld || input.chainActive === true) return "running";
  if (input.latestRunStatus === null) return "never_synced";
  // A RUNNING run with no live lease was interrupted and not yet recovered.
  if (input.latestRunStatus === "FAILED" || input.latestRunStatus === "RUNNING") return "failed";
  if (input.scanOpen) return "partial";
  return input.lastCompleteAt ? "complete" : "partial";
}

// ---------------------------------------------------------------------------
// The ports a sync drives. Network and database stay apart so each can be
// tested — and replaced — without the other.
// ---------------------------------------------------------------------------

/** One catalog: an Organization's view of one provider instance. */
export interface LibraryScope {
  /** The Organization that owns the connection, from the operator's record. */
  tenantId: string;
  providerId: string;
  /** `libraryInstanceKey` of the configured instance. */
  instanceKey: string;
}

/** The network side: one page of the provider's workflow list. */
export interface LibraryPageSource {
  fetchPage(input: { cursor: string | null; limit: number }): Promise<
    | { ok: true; workflows: readonly LibraryRemoteWorkflow[]; nextCursor: string | null }
    | { ok: false; error: { code: string; httpStatus?: number } }
  >;
}

/** Where an open scan stands. The cursor is the resume point and never leaves the server. */
export interface LibraryCheckpoint {
  scanId: string;
  /** The next page's cursor; null when the scan has not read its first page yet. */
  cursor: string | null;
  /** Fixed for the scan: a provider cursor can encode the page size. */
  pageSize: number;
  pagesFetched: number;
  recordsObserved: number;
  /** Hashes of every cursor already requested in this scan. */
  cursorTrail: readonly string[];
  scanStartedAt: string;
}

export interface LibraryBeginInput {
  scope: LibraryScope;
  runId: string;
  /** Used only when a new scan starts. */
  newScanId: string;
  requestedById: string | null;
  pageSize: number;
  /** Discard an open scan and start a new one from the first page. */
  restart: boolean;
  leaseMs: number;
  now: Date;
  /**
   * Stage 18.2 — the continue-until-complete chain this run belongs to. While
   * a chain is alive only ITS runs may start; a run that is no chain's waits
   * for it (LEASE_HELD), and a chain found dead is closed as interrupted.
   */
  chainId?: string;
  /** How long a chain may go without a heartbeat (and without a live run) before it is dead. */
  chainStaleMs?: number;
}

export type LibraryBeginResult =
  | { ok: true; resumed: boolean; checkpoint: LibraryCheckpoint; recoveredRuns: number }
  /** LEASE_HELD: another run, or a live chain, holds the catalog. CHAIN_LOST: the given chain no longer does. */
  | { ok: false; reason: "LEASE_HELD" | "CHAIN_LOST" };

export interface LibraryPersistInput {
  scope: LibraryScope;
  runId: string;
  scanId: string;
  /** Valid, de-duplicated records of the page. */
  records: readonly LibraryWorkflowRecord[];
  /** Rows the provider returned on this page, valid or not. */
  observed: number;
  /** Rows dropped because they could not be addressed. */
  rejected: number;
  /** Hash of the cursor this page was requested with; null for a scan's first page. */
  requestedCursorHash: string | null;
  /** Where the scan goes next — or END: the chain ran out, the scan is complete. */
  next: { cursor: string } | "END";
  leaseMs: number;
  now: Date;
}

export interface LibraryPageCounts {
  created: number;
  updated: number;
  unchanged: number;
  markedMissing: number;
  markedRemoved: number;
}

export type LibraryPersistResult =
  | ({ ok: true; checkpoint: LibraryCheckpoint | null } & LibraryPageCounts)
  | { ok: false; reason: "LEASE_LOST" };

export interface LibraryFinishInput {
  scope: LibraryScope;
  runId: string;
  status: "PARTIAL" | "FAILED";
  failureCode: LibraryFailureCode | null;
  /** Close the open scan: the next run starts a new one from the first page. */
  resetScan: boolean;
  now: Date;
}

export interface LibraryRunRecord {
  runId: string;
  scanId: string;
  status: LibraryRunStatus;
  resumed: boolean;
  pagesFetched: number;
  recordsObserved: number;
  created: number;
  updated: number;
  unchanged: number;
  rejected: number;
  markedMissing: number;
  markedRemoved: number;
  failureCode: LibraryFailureCode | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface LibraryStatusRecord {
  /** A live lease: a run is working on this scope now. */
  leaseHeld: boolean;
  scan: { pagesFetched: number; recordsObserved: number; startedAt: string } | null;
  lastComplete: { at: string; records: number } | null;
  /** Most recent first. */
  runs: LibraryRunRecord[];
  entries: { present: number; missing: number; removed: number };
  /** Stage 18.2 — the most recent continue-until-complete chain, if any. */
  chain?: LibraryChainState | null;
}

export interface LibraryEntryQuery {
  /** Matched against name, tags and node types. */
  search?: string;
  active?: boolean;
  /** `current` (default): present and missing; `all` adds removed. */
  presence?: "current" | "present" | "missing" | "removed" | "all";
  page: number;
  limit: number;
}

export interface LibraryEntryRecord {
  externalId: string;
  name: string;
  active: boolean;
  remoteCreatedAt: string | null;
  remoteUpdatedAt: string | null;
  versionId: string | null;
  tags: string[] | null;
  nodeTypes: string[] | null;
  nodeCount: number | null;
  fingerprint: string;
  /** The surface that observed it. */
  source: "rest";
  presence: LibraryEntryPresence;
  firstSeenAt: string;
  lastSeenAt: string;
  contentChangedAt: string;
  missingSince: string | null;
  removedAt: string | null;
}

/**
 * The database side. Every write is scoped, and every write a run makes is
 * fenced by the run's lease: a page is stored, and the checkpoint advanced past
 * it, in ONE transaction that first renews the lease — so a run that lost its
 * lease stores nothing, and a checkpoint never points past an unstored page.
 */
export interface AutomationLibraryStore {
  /** Takes the scope's lease (recovering any run that died holding one), then opens or resumes a scan. */
  beginRun(input: LibraryBeginInput): Promise<LibraryBeginResult>;
  /** Stores one page and advances the checkpoint; at END, reconciles, closes the scan and completes the run. */
  persistPage(input: LibraryPersistInput): Promise<LibraryPersistResult>;
  /** Ends a run that did not complete its scan, and releases the lease if this run still holds it. */
  finishRun(input: LibraryFinishInput): Promise<void>;
  /** `chainStaleMs` decides whether the latest chain is still alive (default `LIBRARY_CHAIN_STALE_MS`). */
  readStatus(scope: LibraryScope, now: Date, chainStaleMs?: number): Promise<LibraryStatusRecord>;
  listEntries(scope: LibraryScope, query: LibraryEntryQuery): Promise<{ items: LibraryEntryRecord[]; total: number }>;
  /** Stage 18.3B — one entry of this scope, or null. Never another scope's. */
  findEntry(scope: LibraryScope, entryId: string): Promise<LibraryEntryRecord | null>;

  // Stage 18.2 — continue-until-complete chains. One alive chain per catalog,
  // held by a pointer on the catalog's sync row and claimed under a row lock.
  /** A chain a new request would duplicate: the one with this idempotency key, or the one alive now. Reads only. */
  peekChain(
    scope: LibraryScope,
    input: { requestedById: string; idempotencyKey?: string; now: Date; staleMs: number }
  ): Promise<LibraryChainState | null>;
  /** Claims the catalog for a new chain — or returns the chain already holding it. */
  startChain(input: LibraryChainStartInput): Promise<LibraryChainStartResult>;
  /** A heartbeat, with one finished run's progress when given. False: the chain no longer holds the catalog. */
  recordChainProgress(input: LibraryChainProgressInput): Promise<boolean>;
  /** Ends a chain and releases the catalog, if the chain still holds it. */
  finishChain(input: LibraryChainFinishInput): Promise<void>;
}

// ---------------------------------------------------------------------------
// Stage 18.2 — continue-until-complete
//
// A CHAIN is a person's request to keep running bounded runs of one scan until
// it completes. It reuses everything a run has — the engine, the lease, the
// budgets — and adds only what a chain needs: hard limits, a pointer that
// keeps a second chain (or a stray single run) off the catalog, and a record a
// screen can follow and a restart can recover from.
// ---------------------------------------------------------------------------

/** Runs one chain may start. 25 runs × 20 pages × 250 = 125,000 workflows. */
export const LIBRARY_CHAIN_MAX_RUNS = 25;
/** Pages one chain may read across its runs. */
export const LIBRARY_CHAIN_MAX_PAGES = 500;
/** How long one chain may keep going. */
export const LIBRARY_CHAIN_MAX_MS = 30 * 60_000;
/**
 * A chain stops at this many failed runs in a row, even when each failure is
 * one worth retrying. A failure not worth retrying stops it at once.
 */
export const LIBRARY_CHAIN_MAX_CONSECUTIVE_FAILURES = 3;
/** The pause before a retry, times the failures so far in a row. */
export const LIBRARY_CHAIN_RETRY_DELAY_MS = 10_000;
/**
 * How long a chain may go without a heartbeat while no run of it holds the
 * lease before it counts as dead (the process that drove it stopped). Its runs
 * renew the lease page by page, so a long run never makes a live chain stale.
 */
export const LIBRARY_CHAIN_STALE_MS = LIBRARY_LEASE_MS;

/** Run failures a chain tries again: transient by nature. Everything else stops it. */
export const LIBRARY_RETRYABLE_FAILURES: ReadonlySet<LibraryFailureCode> = new Set<LibraryFailureCode>([
  "PROVIDER_TIMEOUT",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_RATE_LIMITED",
  "PERSISTENCE_FAILED",
]);

export function isRetryableLibraryFailure(code: LibraryFailureCode | null): boolean {
  return code !== null && LIBRARY_RETRYABLE_FAILURES.has(code);
}

/** A chain's standing. COMPLETE only when its last run completed a scan. */
export type LibraryChainStatus = "RUNNING" | "COMPLETE" | "STOPPED" | "INTERRUPTED";

/** Why a chain stopped before a complete scan. */
export type LibraryChainStopCode =
  | "RUN_LIMIT"
  | "PAGE_LIMIT"
  | "TIME_LIMIT"
  | "BUDGET_EXHAUSTED"
  | "BUDGET_UNAVAILABLE"
  | "AUTHORIZATION_CHANGED"
  | "AUTHORIZATION_UNAVAILABLE"
  | "SCOPE_CHANGED"
  | "SYNC_ALREADY_RUNNING"
  | "RUN_FAILED"
  | "RETRY_LIMIT"
  | "SHUTDOWN"
  | "STORE_UNAVAILABLE"
  | "CHAIN_LOST"
  | "INTERRUPTED";

export const LIBRARY_CHAIN_STOP_MESSAGES: Readonly<Record<LibraryChainStopCode, string>> = {
  RUN_LIMIT: `The chain started its ${LIBRARY_CHAIN_MAX_RUNS} runs without finishing the scan. Its place is kept; continue again to go on.`,
  PAGE_LIMIT: `The chain read its ${LIBRARY_CHAIN_MAX_PAGES} pages without finishing the scan. Its place is kept; continue again to go on.`,
  TIME_LIMIT: "The chain reached its time limit without finishing the scan. Its place is kept; continue again to go on.",
  BUDGET_EXHAUSTED: "The organization's synchronization budget for this library is spent. Its place is kept; continue later.",
  BUDGET_UNAVAILABLE: "The synchronization budget could not be checked, so the chain stopped. Its place is kept.",
  AUTHORIZATION_CHANGED:
    "The person who started the chain may no longer synchronize this library, so it stopped. Its place is kept.",
  AUTHORIZATION_UNAVAILABLE: "Organization access could not be verified, so the chain stopped. Its place is kept.",
  SCOPE_CHANGED:
    "The n8n connection now belongs to another organization or another instance, so the chain stopped and read nothing more.",
  SYNC_ALREADY_RUNNING: "Another synchronization of this library started, so the chain stopped.",
  RUN_FAILED: "A run failed in a way another try would not fix, so the chain stopped. The run's own reason is shown with it.",
  RETRY_LIMIT: `${LIBRARY_CHAIN_MAX_CONSECUTIVE_FAILURES} runs in a row failed for a reason that is usually temporary, so the chain stopped. Its place is kept; continue later.`,
  SHUTDOWN: "The server stopped while the chain was running. Its place is kept; continue again to go on.",
  STORE_UNAVAILABLE: "The workflow library could not be reached, so the chain stopped. Its place is kept.",
  CHAIN_LOST: "The chain lost its hold on the library and stopped.",
  INTERRUPTED: "The chain stopped without finishing — the server restarted or lost contact with it. Its place is kept; continue again to go on.",
};

/** One chain as the store keeps it. */
export interface LibraryChainRecord {
  chainId: string;
  status: LibraryChainStatus;
  stopCode: LibraryChainStopCode | null;
  /** The last failed run's code, when the chain stopped because of it. */
  failureCode: LibraryFailureCode | null;
  runs: number;
  pages: number;
  recordsObserved: number;
  maxRuns: number;
  maxPages: number;
  deadlineAt: string;
  startedAt: string;
  heartbeatAt: string;
  finishedAt: string | null;
  /** Internal: who started it — the one whose authorization is re-checked. */
  requestedById: string | null;
}

/**
 * A chain with whether it is alive now: RUNNING, holding the catalog, and
 * either one of its runs holds the lease or its heartbeat is fresh. A RUNNING
 * chain that is not alive died with its process, and is shown as interrupted.
 */
export type LibraryChainState = LibraryChainRecord & { alive: boolean };

export interface LibraryChainStartInput {
  scope: LibraryScope;
  chainId: string;
  requestedById: string;
  /** A client's key for one click: a retry with the same key returns the same chain. */
  idempotencyKey?: string;
  limits: { maxRuns: number; maxPages: number; maxMs: number };
  staleMs: number;
  now: Date;
}

export type LibraryChainStartResult =
  | { ok: true; created: boolean; chain: LibraryChainState }
  | { ok: false; reason: "SYNC_RUNNING" };

export interface LibraryChainProgressInput {
  scope: LibraryScope;
  chainId: string;
  now: Date;
  /** One finished run's progress; absent for a heartbeat alone. */
  run?: { runId: string; pages: number; records: number; failureCode: LibraryFailureCode | null };
}

export interface LibraryChainFinishInput {
  scope: LibraryScope;
  chainId: string;
  status: Exclude<LibraryChainStatus, "RUNNING">;
  stopCode: LibraryChainStopCode | null;
  failureCode: LibraryFailureCode | null;
  now: Date;
}

// ---------------------------------------------------------------------------
// Stage 18.2 — the views every surface shows, and the one port that serves
// them. The API router and the JARVIS tools are given the same object, so a
// sentence and a button get the same answer and the same refusal.
// ---------------------------------------------------------------------------

export type LibraryResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message: string };

export interface LibraryRunView {
  runId: string;
  status: LibraryRunStatus;
  resumed: boolean;
  pagesFetched: number;
  recordsObserved: number;
  created: number;
  updated: number;
  unchanged: number;
  rejected: number;
  markedMissing: number;
  markedRemoved: number;
  failure: { code: string; message: string } | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface LibraryChainView {
  chainId: string;
  /** INTERRUPTED is also how a chain whose process died is shown, before it is closed. */
  status: LibraryChainStatus;
  stop: { code: LibraryChainStopCode; message: string } | null;
  /** The failed run behind a RUN_FAILED stop. */
  runFailure: { code: string; message: string } | null;
  runs: number;
  pages: number;
  recordsObserved: number;
  limits: { maxRuns: number; maxPages: number; deadlineAt: string };
  startedAt: string;
  finishedAt: string | null;
}

export interface LibraryStatusView {
  configured: boolean;
  state: LibraryState;
  /** Whether THIS reader may start a sync, as the server decides it now. A hint for the screen; every start is checked again. */
  canSync: boolean;
  catalog: { present: number; missing: number; removed: number };
  currentScan: { pagesFetched: number; recordsObserved: number; startedAt: string } | null;
  lastCompleteScan: { completedAt: string; records: number } | null;
  runs: LibraryRunView[];
  /** The latest continue-until-complete chain. */
  continuation: LibraryChainView | null;
}

export interface LibraryEntryPage {
  items: LibraryEntryRecord[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** What starting a sync answers — one bounded run, or a chain of them. */
export type LibrarySyncStarted =
  | { mode: "run"; runId: string; resumed: boolean; state: "running" }
  | { mode: "continue"; chainId: string; existing: boolean; state: "running" | LibraryChainStatus };

/** The one port every surface reaches the Automation Library through. */
export interface AutomationLibraryPort {
  list(userId: string, query: LibraryEntryQuery): Promise<LibraryResult<LibraryEntryPage>>;
  status(userId: string): Promise<LibraryResult<LibraryStatusView>>;
  startSync(
    userId: string,
    /** `via` names the surface for the audit row only; it decides nothing. */
    options: { restart?: boolean; continueUntilComplete?: boolean; idempotencyKey?: string; via?: "api" | "jarvis" }
  ): Promise<LibraryResult<LibrarySyncStarted>>;
  /** Stage 18.3B — the sanitized structure of one entry, from the catalog alone. */
  inspect(userId: string, entryId: string): Promise<LibraryResult<import("./automation-inspection.js").LibraryInspectionView>>;
  /** Stage 18.3B — propose an entry for the caller's trigger allow-list (an approval; nothing changes yet). */
  proposeAllowlist(
    userId: string,
    entryId: string,
    options?: { via?: "api" | "jarvis" }
  ): Promise<LibraryResult<import("./automation-inspection.js").LibraryAllowlistProposal>>;
}

// ---------------------------------------------------------------------------
// Stage 18.2 — request rules shared by the API and the tools, so equivalent
// requests are answered in the same words.
// ---------------------------------------------------------------------------

/** The registry ids of the library's JARVIS tools. */
export const AUTOMATION_LIBRARY_TOOL_IDS = {
  search: "automation.library.search",
  status: "automation.library.status",
  sync: "automation.library.sync",
  /** Stage 18.3B — the sanitized structure of one entry. Read-only. */
  inspect: "automation.library.inspect",
  /** Stage 18.3B — ask for an entry to go on the trigger allow-list: creates an approval, changes nothing. */
  propose: "automation.library.allowlist.propose",
  /**
   * Stage 18.3B — put it there, with an approved proposal. On NO agent's
   * allowlist: the Automations page runs it through ToolExecutor, naming the
   * approval. A write through the shared n8n connection (SHARED_CONNECTION_TOOLS).
   */
  allowlistAdd: "automation.library.allowlist.add",
} as const;

export const LIBRARY_LIST_LIMIT_MAX = 100;
export const LIBRARY_LIST_LIMIT_DEFAULT = 50;
export const LIBRARY_SEARCH_MAX = 100;
const LIBRARY_PRESENCE = new Set(["current", "present", "missing", "removed", "all"]);

export const LIBRARY_INVALID_QUERY_MESSAGE = `Use page (1 or more), limit (1 to ${LIBRARY_LIST_LIMIT_MAX}), search (up to ${LIBRARY_SEARCH_MAX} characters), active (true or false) and presence (current, present, missing, removed or all).`;
export const LIBRARY_SCOPE_REFUSED_MESSAGE =
  "This takes its organization, instance and position from the server; they cannot be supplied in the request.";
export const LIBRARY_INVALID_SYNC_MESSAGE = "restart and continueUntilComplete must be true or false, and idempotencyKey 8 to 64 letters, digits, '-' or '_'.";

/**
 * Fields that would name a scope or a provider position. All of them are the
 * server's; compared case- and separator-insensitively.
 */
const LIBRARY_SERVER_ONLY_FIELDS: ReadonlySet<string> = new Set([
  "userid",
  "owneruserid",
  "tenantid",
  "organizationid",
  "orgid",
  "businessid",
  "accountid",
  "workspaceid",
  "providerid",
  "instanceid",
  "instancekey",
  "baseurl",
  "url",
  "cursor",
  "scanid",
  "apikey",
  "credential",
  "credentials",
  "token",
]);

/** Whether a request's fields try to name what only the server may decide. */
export function namesLibraryServerScope(source: unknown): boolean {
  return (
    source !== null &&
    typeof source === "object" &&
    Object.keys(source as object).some((key) => LIBRARY_SERVER_ONLY_FIELDS.has(key.toLowerCase().replace(/[-_\s]/g, "")))
  );
}

/** A number from a number or a numeric string; undefined when absent; null when not a number. */
function numberOf(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim().length > 0) return Number(value);
  return null;
}

/** A boolean from a boolean or "true"/"false"; undefined when absent; null otherwise. */
function booleanOf(value: unknown): boolean | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

/**
 * The catalog query, validated and bounded — or null when any part of it is
 * not acceptable. Takes a URL's strings and a tool's typed values alike.
 */
export function validateLibraryEntryQuery(input: {
  page?: unknown;
  limit?: unknown;
  search?: unknown;
  active?: unknown;
  presence?: unknown;
}): LibraryEntryQuery | null {
  const page = numberOf(input.page);
  const limit = numberOf(input.limit);
  const active = booleanOf(input.active);
  if (page === null || limit === null || active === null) return null;
  const pageNumber = page ?? 1;
  const limitNumber = limit ?? LIBRARY_LIST_LIMIT_DEFAULT;
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > 100_000) return null;
  if (!Number.isInteger(limitNumber) || limitNumber < 1 || limitNumber > LIBRARY_LIST_LIMIT_MAX) return null;
  if (input.search !== undefined && (typeof input.search !== "string" || input.search.length > LIBRARY_SEARCH_MAX)) return null;
  if (input.presence !== undefined && (typeof input.presence !== "string" || !LIBRARY_PRESENCE.has(input.presence))) return null;
  const search = typeof input.search === "string" ? input.search.trim() : "";
  return {
    page: pageNumber,
    limit: limitNumber,
    ...(search.length > 0 ? { search } : {}),
    ...(active !== undefined ? { active } : {}),
    ...(input.presence !== undefined ? { presence: input.presence as LibraryEntryQuery["presence"] } : {}),
  };
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,64}$/;

/** The sync options, validated — or null when any part of them is not acceptable. */
export function validateLibrarySyncOptions(input: {
  restart?: unknown;
  continueUntilComplete?: unknown;
  idempotencyKey?: unknown;
}): { restart: boolean; continueUntilComplete: boolean; idempotencyKey?: string } | null {
  const restart = booleanOf(input.restart);
  const continueUntilComplete = booleanOf(input.continueUntilComplete);
  if (restart === null || continueUntilComplete === null) return null;
  if (input.idempotencyKey !== undefined && (typeof input.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(input.idempotencyKey))) {
    return null;
  }
  return {
    restart: restart ?? false,
    continueUntilComplete: continueUntilComplete ?? false,
    ...(typeof input.idempotencyKey === "string" ? { idempotencyKey: input.idempotencyKey } : {}),
  };
}
