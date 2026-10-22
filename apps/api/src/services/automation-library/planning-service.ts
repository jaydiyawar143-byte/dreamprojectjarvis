// ---------------------------------------------------------------------------
// Phase 18, Stage 18.4 — workflow planning: matching a request against the
// library, and drafts.
//
// THE ONE IMPLEMENTATION. The Automations page's router and the JARVIS tools
// `automation.workflow.match` and `automation.draft.*` are handed this one
// instance (`AutomationPlanningPort`); the request rules are core's, so a
// sentence and a button are answered and refused alike.
//
// WHOSE. The catalog and its drafts belong to the Organization that owns the
// n8n connection. Authorization and the catalog's scope come from
// `AutomationLibraryService.resolveCatalog` — the same check, and the same
// one answer to an outsider, as every library call:
//
//   match, read a draft     every member of that Organization (shared:read)
//   create, revise a draft  its owners and admins (shared:write)
//
// NOTHING REACHES n8n. Matching reads the stored catalog through the library
// store's own listing and search; a draft is written to JARVIS's store only.
// No method here holds an n8n client, so none can read, change, activate or
// run a workflow, and a draft can never become an approval or an allow-list
// row.
//
// NOTHING IS TAKEN ON TRUST. A draft is built and checked by core's rules
// before it is stored, and an invalid one is refused, never stored. Every
// view re-checks the stored content and reads the source entry again, so a
// draft whose source moved on is shown stale. Versions are immutable: a
// revision names the version it changes, and is stored only while that is
// still the latest.
//
// WHAT LEAVES. Ids, statuses, counts and fixed sentences go to the audit log;
// never the goal, an answer or a label.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import {
  PLANNING_LIMITS,
  applyDraftAnswers,
  buildDraftContent,
  draftContentHash,
  draftDiff,
  draftSchemaHints,
  draftTitle,
  evaluateDraft,
  inspectLibraryEntry,
  isDraftId,
  parseDraftGraph,
  planningSearchTerms,
  rankLibraryCandidates,
  validateAutomationRequest,
  validateDraftCreateInput,
  validateDraftReviseInput,
  withoutLinks,
  type AutomationDraftStore,
  type AutomationLibraryStore,
  type AutomationPlanningPort,
  type AutomationRequest,
  type DraftContent,
  type DraftIssue,
  type DraftListPage,
  type DraftRecord,
  type DraftSource,
  type DraftVersionRecord,
  type DraftView,
  type LibraryEntryRecord,
  type LibraryScope,
  type NodeSchemaRegistry,
  type PlanningMatch,
  type PlanningMatchView,
  type PlanningResult,
} from "@jarvis/core";
import type { LibraryAuditPort, LibraryLog } from "./library-service.js";

/** The library's answer to "whose catalog, and may this caller do this?". */
export interface LibraryCatalogAccess {
  resolveCatalog(
    userId: string,
    operation: "read" | "write"
  ): Promise<{ ok: true; tenantId: string; scope: LibraryScope } | { ok: false; status: number; code: string; message: string; reason: string }>;
}

export interface AutomationPlanningServiceDeps {
  catalog: LibraryCatalogAccess;
  /** The library store: its listing, search and one-entry read. Nothing else is used. */
  entries: Pick<AutomationLibraryStore, "listEntries" | "findEntry">;
  /** Absent: nothing can be drafted; matching still works. */
  drafts: AutomationDraftStore | undefined;
  audit: LibraryAuditPort;
  log?: LibraryLog;
  /**
   * The trusted n8n node schemas (Stage 18.5). Absent or null: a draft's
   * settings are not checked against n8n, and the check says so. One instance
   * is shared by this service, so the router and the tools are answered alike.
   */
  nodeSchema?: NodeSchemaRegistry | null;
}

type Caller = "api" | "jarvis";
type Refusal = { ok: false; status: number; code: string; message: string; issues?: DraftIssue[] };

const refuse = (status: number, code: string, message: string, issues?: DraftIssue[]): Refusal => ({
  ok: false,
  status,
  code,
  message,
  ...(issues ? { issues } : {}),
});

const UNAVAILABLE = refuse(503, "LIBRARY_UNAVAILABLE", "The workflow library could not be read right now. Try again.");
const DRAFTS_UNAVAILABLE = refuse(503, "DRAFTS_UNAVAILABLE", "Workflow drafts could not be read or saved right now. Try again.");
const WRITE_DENIED = "Only an owner or admin of your organization can create or revise workflow drafts.";
const PAGE_LIMIT = 100;

function invalid(issues: DraftIssue[]): Refusal {
  const first = issues[0]!;
  return refuse(
    422,
    issues.some((i) => i.code === "SECRET_REFUSED") ? "SECRET_REFUSED" : "DRAFT_INVALID",
    issues.length === 1 ? `${first.path}: ${first.message}` : `${first.path}: ${first.message} (and ${issues.length - 1} more)`,
    issues
  );
}

export class AutomationPlanningService implements AutomationPlanningPort {
  constructor(private readonly deps: AutomationPlanningServiceDeps) {}

  private async audit(userId: string, action: string, result: "success" | "failure" | "rejected", metadata: Record<string, unknown>): Promise<void> {
    try {
      await this.deps.audit.log({ userId, action: `automation_planning.${action}`, result, metadata });
    } catch {
      /* an audit failure never changes the answer */
    }
  }

  /** The caller's catalog for `operation`, or the refusal — audited as `action`. */
  private async catalog(userId: string, operation: "read" | "write", action: string): Promise<{ ok: true; tenantId: string; scope: LibraryScope } | Refusal> {
    let access: Awaited<ReturnType<LibraryCatalogAccess["resolveCatalog"]>>;
    try {
      access = await this.deps.catalog.resolveCatalog(userId, operation);
    } catch {
      return refuse(503, "AUTHORIZATION_UNAVAILABLE", "Your access could not be checked right now, so nothing was done.");
    }
    if (!access.ok) {
      await this.audit(userId, action, "rejected", { authz: access.reason });
      return refuse(access.status, access.code, operation === "write" && access.code === "PERMISSION_DENIED" ? WRITE_DENIED : access.message);
    }
    return access;
  }

  /**
   * The catalog read for matching, through the library store's own listing:
   * all of a small catalog; a large one searched by the request's own words.
   */
  private async candidatesFor(scope: LibraryScope, request: AutomationRequest): Promise<{ entries: LibraryEntryRecord[]; searched: PlanningMatch["searched"] }> {
    const first = await this.deps.entries.listEntries(scope, { presence: "current", page: 1, limit: PAGE_LIMIT });
    if (first.total <= PLANNING_LIMITS.fullScanMax) {
      const entries = [...first.items];
      for (let page = 2; entries.length < first.total && page <= Math.ceil(PLANNING_LIMITS.fullScanMax / PAGE_LIMIT); page += 1) {
        const next = await this.deps.entries.listEntries(scope, { presence: "current", page, limit: PAGE_LIMIT });
        if (next.items.length === 0) break;
        entries.push(...next.items);
      }
      return { entries, searched: { compared: entries.length, catalogTotal: first.total, method: "full", complete: entries.length >= first.total } };
    }
    const found = new Map<string, LibraryEntryRecord>();
    for (const search of planningSearchTerms(request)) {
      const page = await this.deps.entries.listEntries(scope, { presence: "current", search, page: 1, limit: PLANNING_LIMITS.targetedPerSearch });
      for (const item of page.items) found.set(item.externalId, item);
    }
    const entries = [...found.values()];
    return { entries, searched: { compared: entries.length, catalogTotal: first.total, method: "targeted", complete: false } };
  }

  private async mayDraft(userId: string): Promise<boolean> {
    if (!this.deps.drafts) return false;
    return (await this.deps.catalog.resolveCatalog(userId, "write").catch(() => null))?.ok === true;
  }

  // -------------------------------------------------------------------------
  // Matching.
  // -------------------------------------------------------------------------

  async match(userId: string, input: unknown, options: { via?: Caller } = {}): Promise<PlanningResult<PlanningMatchView>> {
    const read = validateAutomationRequest(input);
    if (!read.ok) return refuse(400, read.code, read.message);
    const access = await this.catalog(userId, "read", "match");
    if (!access.ok) return access;
    let match: PlanningMatch;
    try {
      const { entries, searched } = await this.candidatesFor(access.scope, read.value);
      match = rankLibraryCandidates(read.value, entries, searched);
    } catch {
      this.deps.log?.warn("automation_library_store_unavailable", { stage: "match" });
      return UNAVAILABLE;
    }
    await this.audit(userId, "match", "success", {
      tenantId: access.tenantId,
      outcome: match.outcome,
      candidates: match.candidates.map((c) => c.entryId),
      compared: match.searched.compared,
      method: match.searched.method,
      via: options.via ?? "api",
    });
    return { ok: true, value: { ...match, canDraft: await this.mayDraft(userId) } };
  }

  // -------------------------------------------------------------------------
  // Drafts.
  // -------------------------------------------------------------------------

  async createDraft(userId: string, input: unknown, options: { via?: Caller } = {}): Promise<PlanningResult<{ draft: DraftView; existing: boolean }>> {
    const parsed = validateDraftCreateInput(input);
    if (!parsed.ok) return refuse(400, parsed.code, parsed.message);
    const access = await this.catalog(userId, "write", "draft_create");
    if (!access.ok) return access;
    const store = this.deps.drafts;
    if (!store) return refuse(503, "DRAFTS_UNAVAILABLE", "Workflow drafts are not available on this server.");
    const { request, kind, sourceEntryId, graph, overrideReuse } = parsed.value;

    let source: DraftSource | null = null;
    let liveSource: { versionId: string | null; presence: LibraryEntryRecord["presence"] } | undefined;
    try {
      if (kind === "customization") {
        const entry = await this.deps.entries.findEntry(access.scope, sourceEntryId!);
        if (!entry) return this.rejected(userId, "draft_create", refuse(404, "ENTRY_NOT_FOUND", "No workflow with that id is in your organization's library."));
        const view = inspectLibraryEntry(entry);
        if (view.stale.stale) return this.rejected(userId, "draft_create", refuse(409, "ENTRY_STALE", "That workflow was not seen in the last complete scan. Synchronize the library first."));
        if (!view.versionId) return this.rejected(userId, "draft_create", refuse(409, "VERSION_UNKNOWN", "n8n reported no version for that workflow, so a draft could not be bound to it."));
        if (view.nodeTypes.status === "unavailable") {
          return this.rejected(userId, "draft_create", refuse(409, "NODE_TYPES_UNKNOWN", "That workflow's listing carried no node types, so a customization could not refer to them."));
        }
        source = { entryId: view.entryId, versionId: view.versionId, name: view.name, nodeTypes: view.nodeTypes.items, nodeCount: view.nodeTypes.count };
        liveSource = { versionId: view.versionId, presence: entry.presence };
      } else if (!overrideReuse) {
        // Not a second copy of something that exists: a workflow that appears to cover it is said first.
        const { entries, searched } = await this.candidatesFor(access.scope, request);
        const match = rankLibraryCandidates(request, entries, searched);
        if (match.outcome === "reuse") {
          const best = match.candidates[0]!;
          return this.rejected(
            userId,
            "draft_create",
            refuse(
              409,
              "REUSE_AVAILABLE",
              `"${withoutLinks(best.name)}" (${best.entryId}) in the library appears to cover this request. Inspect it or customize it — or ask again with overrideReuse to draft a new workflow anyway.`
            ),
            { candidate: best.entryId }
          );
        }
      }
    } catch {
      this.deps.log?.warn("automation_library_store_unavailable", { stage: "draft_create" });
      return UNAVAILABLE;
    }

    const built = buildDraftContent({ kind, title: draftTitle(request, parsed.value.title), request, source, graph });
    if (!built.ok) return this.rejected(userId, "draft_create", invalid(built.issues), { issues: built.issues.map((i) => i.code) });
    const evaluation = evaluateDraft(built.content, { ...(kind === "customization" ? { source: liveSource } : {}), scopeVerified: true }, this.deps.nodeSchema ?? null);
    if (evaluation.status === "invalid" || evaluation.status === "stale") {
      return this.rejected(userId, "draft_create", refuse(422, "DRAFT_INVALID", evaluation.checks.find((c) => c.status === "failed")!.message));
    }
    const contentHash = draftContentHash(built.content);
    const createKey = createHash("sha256").update(`automation-draft-create:${userId}:${contentHash}`).digest("hex");

    let stored: { created: boolean; draft: DraftRecord };
    try {
      stored = await store.createDraft(access.scope, {
        createdById: userId,
        kind,
        title: built.content.title,
        sourceEntryId: source?.entryId ?? null,
        sourceVersionId: source?.versionId ?? null,
        createKey,
        content: built.content,
        contentHash,
        status: evaluation.status,
      });
    } catch {
      this.deps.log?.warn("automation_drafts_unavailable", { stage: "create" });
      return DRAFTS_UNAVAILABLE;
    }
    const view = await this.viewOf(userId, access.scope, stored.draft, stored.draft.latestVersion).catch(() => null);
    if (!view) return DRAFTS_UNAVAILABLE;
    await this.audit(userId, "draft_create", "success", {
      tenantId: access.tenantId,
      draftId: stored.draft.draftId,
      kind,
      sourceEntryId: source?.entryId ?? null,
      sourceVersionId: source?.versionId ?? null,
      contentHash,
      status: evaluation.status,
      existing: !stored.created,
      overrideReuse,
      via: options.via ?? "api",
    });
    if (stored.created) this.deps.log?.info("automation_draft_created", { draftId: stored.draft.draftId, kind, status: evaluation.status });
    return { ok: true, value: { draft: view, existing: !stored.created } };
  }

  async reviseDraft(
    userId: string,
    draftId: string,
    input: unknown,
    options: { via?: Caller } = {}
  ): Promise<PlanningResult<{ draft: DraftView; unchanged: boolean }>> {
    if (!isDraftId(draftId)) return refuse(400, "INVALID_DRAFT", "That is not a draft id.");
    const parsed = validateDraftReviseInput(input);
    if (!parsed.ok) return refuse(400, parsed.code, parsed.message);
    const access = await this.catalog(userId, "write", "draft_revise");
    if (!access.ok) return access;
    const store = this.deps.drafts;
    if (!store) return refuse(503, "DRAFTS_UNAVAILABLE", "Workflow drafts are not available on this server.");
    const { baseVersion, graph, answers } = parsed.value;

    let draft: DraftRecord | null;
    let base: DraftVersionRecord | null;
    try {
      draft = await store.findDraft(access.scope, draftId);
      base = draft ? await store.findVersion(access.scope, draftId, baseVersion) : null;
    } catch {
      return DRAFTS_UNAVAILABLE;
    }
    if (!draft) return this.rejected(userId, "draft_revise", refuse(404, "DRAFT_NOT_FOUND", "No draft with that id is in your organization."), { draftId });
    if (!base) return this.rejected(userId, "draft_revise", refuse(404, "VERSION_NOT_FOUND", `This draft has no version ${baseVersion}.`), { draftId });

    // A customization is revised only while its source is where the draft left
    // it — asked first, so a stale draft is never reported as a bad answer.
    let liveSource: { versionId: string | null; presence: LibraryEntryRecord["presence"] } | null | undefined;
    if (base.content.kind === "customization" && base.content.source) {
      try {
        const entry = await this.deps.entries.findEntry(access.scope, base.content.source.entryId);
        liveSource = entry ? { versionId: inspectLibraryEntry(entry).versionId, presence: entry.presence } : null;
      } catch {
        return UNAVAILABLE;
      }
      if (!liveSource || liveSource.presence !== "present" || liveSource.versionId !== base.content.source.versionId) {
        return this.rejected(
          userId,
          "draft_revise",
          refuse(409, "DRAFT_STALE", "The source workflow changed or left the library since this draft was made. Start a new draft from its current version."),
          { draftId }
        );
      }
    }

    // The next content: the base version's, with the proposed graph and the answers applied.
    let next: DraftContent = structuredClone(base.content);
    if (graph) {
      const reparsed = parseDraftGraph(graph, { kind: next.kind, source: next.source });
      if (!reparsed.ok) return this.rejected(userId, "draft_revise", invalid(reparsed.issues), { draftId, issues: reparsed.issues.map((i) => i.code) });
      next = { ...next, nodes: reparsed.nodes, connections: reparsed.connections };
    }
    if (answers) {
      const answered = applyDraftAnswers(next, answers);
      if (!answered.ok) return this.rejected(userId, "draft_revise", invalid(answered.issues), { draftId, issues: answered.issues.map((i) => i.code) });
      next = answered.content;
    }

    const evaluation = evaluateDraft(next, { ...(next.kind === "customization" ? { source: liveSource } : {}), scopeVerified: true }, this.deps.nodeSchema ?? null);
    if (evaluation.status === "stale") {
      return this.rejected(
        userId,
        "draft_revise",
        refuse(409, "DRAFT_STALE", "The source workflow changed or left the library since this draft was made. Start a new draft from its current version."),
        { draftId }
      );
    }
    if (evaluation.status === "invalid") {
      return this.rejected(userId, "draft_revise", refuse(422, "DRAFT_INVALID", evaluation.checks.find((c) => c.status === "failed")!.message), { draftId });
    }

    const contentHash = draftContentHash(next);
    const answerUnchanged = async (version: number) => {
      const view = await this.viewOf(userId, access.scope, draft!, version).catch(() => null);
      return view ? { ok: true as const, value: { draft: view, unchanged: true } } : DRAFTS_UNAVAILABLE;
    };
    if (contentHash === base.contentHash) return answerUnchanged(baseVersion);

    let appended: Awaited<ReturnType<AutomationDraftStore["appendVersion"]>>;
    try {
      appended = await store.appendVersion(access.scope, { draftId, expectedVersion: baseVersion, createdById: userId, content: next, contentHash, status: evaluation.status });
    } catch {
      this.deps.log?.warn("automation_drafts_unavailable", { stage: "revise" });
      return DRAFTS_UNAVAILABLE;
    }
    if (!appended.ok) {
      if (appended.reason === "not_found") return refuse(404, "DRAFT_NOT_FOUND", "No draft with that id is in your organization.");
      // Another revision landed first. If it is this very revision — a retry — it is the answer.
      const latest = await store.findDraft(access.scope, draftId).catch(() => null);
      const head = latest ? await store.findVersion(access.scope, draftId, latest.latestVersion).catch(() => null) : null;
      if (head && head.contentHash === contentHash) return answerUnchanged(head.version);
      return this.rejected(
        userId,
        "draft_revise",
        refuse(409, "DRAFT_CHANGED", `This draft has a newer version${latest ? ` (${latest.latestVersion})` : ""}. Review it, then revise that version.`),
        { draftId, baseVersion }
      );
    }
    const refreshed = (await store.findDraft(access.scope, draftId).catch(() => null)) ?? { ...draft, latestVersion: appended.version.version };
    const view = await this.viewOf(userId, access.scope, refreshed, appended.version.version).catch(() => null);
    if (!view) return DRAFTS_UNAVAILABLE;
    await this.audit(userId, "draft_revise", "success", {
      tenantId: access.tenantId,
      draftId,
      fromVersion: baseVersion,
      version: appended.version.version,
      contentHash,
      status: evaluation.status,
      graphReplaced: graph !== null,
      answers: answers ? Object.keys(answers).length : 0,
      via: options.via ?? "api",
    });
    this.deps.log?.info("automation_draft_revised", { draftId, version: appended.version.version, status: evaluation.status });
    return { ok: true, value: { draft: view, unchanged: false } };
  }

  async getDraft(userId: string, draftId: string, version?: number): Promise<PlanningResult<DraftView>> {
    if (!isDraftId(draftId)) return refuse(400, "INVALID_DRAFT", "That is not a draft id.");
    if (version !== undefined && (!Number.isInteger(version) || version < 1)) return refuse(400, "INVALID_REQUEST", "version is a whole number from 1.");
    const access = await this.catalog(userId, "read", "draft_read");
    if (!access.ok) return access;
    if (!this.deps.drafts) return refuse(503, "DRAFTS_UNAVAILABLE", "Workflow drafts are not available on this server.");
    try {
      const draft = await this.deps.drafts.findDraft(access.scope, draftId);
      if (!draft) return refuse(404, "DRAFT_NOT_FOUND", "No draft with that id is in your organization.");
      const view = await this.viewOf(userId, access.scope, draft, version ?? draft.latestVersion);
      if (!view) return refuse(404, "VERSION_NOT_FOUND", `This draft has no version ${version}.`);
      return { ok: true, value: view };
    } catch {
      return DRAFTS_UNAVAILABLE;
    }
  }

  async listDrafts(userId: string, query: { page: number; limit: number }): Promise<PlanningResult<DraftListPage>> {
    const access = await this.catalog(userId, "read", "draft_read");
    if (!access.ok) return access;
    if (!this.deps.drafts) return refuse(503, "DRAFTS_UNAVAILABLE", "Workflow drafts are not available on this server.");
    try {
      const { items, total } = await this.deps.drafts.listDrafts(access.scope, query);
      return {
        ok: true,
        value: {
          items: items.map((d) => ({ draftId: d.draftId, kind: d.kind, title: d.title, latestVersion: d.latestVersion, sourceEntryId: d.sourceEntryId, updatedAt: d.updatedAt })),
          page: query.page,
          limit: query.limit,
          total,
          totalPages: Math.max(Math.ceil(total / query.limit), 1),
        },
      };
    } catch {
      return DRAFTS_UNAVAILABLE;
    }
  }

  /** A version as every surface sees it: re-checked now, its source read again. Null when there is no such version. */
  private async viewOf(userId: string, scope: LibraryScope, draft: DraftRecord, version: number): Promise<DraftView | null> {
    const store = this.deps.drafts!;
    const record = await store.findVersion(scope, draft.draftId, version);
    if (!record) return null;
    const content = record.content;

    let sourceView: DraftView["source"] = null;
    let live: { versionId: string | null; presence: LibraryEntryRecord["presence"] } | null | undefined;
    if (content.kind === "customization" && content.source) {
      const entry = await this.deps.entries.findEntry(scope, content.source.entryId);
      const currentVersionId = entry ? inspectLibraryEntry(entry).versionId : null;
      live = entry ? { versionId: currentVersionId, presence: entry.presence } : null;
      sourceView = {
        entryId: content.source.entryId,
        versionId: content.source.versionId,
        name: content.source.name,
        currentVersionId,
        drift: !entry
          ? "not_found"
          : entry.presence === "removed"
            ? "removed"
            : entry.presence === "missing"
              ? "missing"
              : currentVersionId !== content.source.versionId
                ? "changed"
                : "none",
      };
    }
    const evaluation = evaluateDraft(content, { ...(content.kind === "customization" ? { source: live } : {}), scopeVerified: true }, this.deps.nodeSchema ?? null);
    const history = await store.listVersions(scope, draft.draftId);
    const isLatest = record.version === draft.latestVersion;
    const hints = draftSchemaHints(content, this.deps.nodeSchema ?? null);
    return {
      draftId: draft.draftId,
      kind: draft.kind,
      title: draft.title,
      createdAt: draft.createdAt,
      latestVersion: draft.latestVersion,
      version: { number: record.version, contentHash: record.contentHash, createdAt: record.createdAt, isLatest, statusWhenSaved: record.status },
      status: evaluation.status,
      content,
      diff: draftDiff(content),
      checks: evaluation.checks,
      requirements: evaluation.requirements,
      ...(hints.length > 0 ? { schema: hints } : {}),
      source: sourceView,
      history: history.map((h) => ({ version: h.version, contentHash: h.contentHash, status: h.status, createdAt: h.createdAt })),
      canRevise: isLatest && evaluation.status !== "stale" && evaluation.status !== "invalid" && (await this.mayDraft(userId)),
    };
  }

  private async rejected(userId: string, action: string, refusal: Refusal, metadata: Record<string, unknown> = {}): Promise<Refusal> {
    await this.audit(userId, action, "rejected", { code: refusal.code, ...metadata });
    return refusal;
  }
}
