// ---------------------------------------------------------------------------
// Phase 18.4 — an in-memory `AutomationDraftStore` for tests.
//
// It behaves as the PostgreSQL repository does where it matters: every read is
// scoped; a stored version is a copy the caller cannot change afterwards; a
// revision is appended only while the version it names is still the latest,
// checked and taken in one synchronous step (so of two at once, one wins); and
// a create key already used in a scope returns the draft it made.
// ---------------------------------------------------------------------------

import type { AutomationDraftStore, DraftRecord, DraftVersionRecord, LibraryScope } from "@jarvis/core";

const scopeKey = (scope: LibraryScope) => `${scope.tenantId}|${scope.providerId}|${scope.instanceKey}`;

export class MemoryDraftStore implements AutomationDraftStore {
  readonly drafts = new Map<string, DraftRecord & { scope: string; createKey: string }>();
  readonly versions = new Map<string, DraftVersionRecord[]>();
  failing = false;
  private seq = 0;
  private clock = Date.parse("2026-10-21T09:00:00.000Z");

  private tick(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  private check(): void {
    if (this.failing) throw new Error("draft store unreachable");
  }

  async createDraft(scope: LibraryScope, input: Parameters<AutomationDraftStore["createDraft"]>[1]): Promise<{ created: boolean; draft: DraftRecord }> {
    this.check();
    const key = scopeKey(scope);
    const existing = [...this.drafts.values()].find((d) => d.scope === key && d.createKey === input.createKey);
    if (existing) return { created: false, draft: this.public(existing) };
    const now = this.tick();
    this.seq += 1;
    const draftId = `draft-${String(this.seq).padStart(8, "0")}`;
    const record = {
      draftId,
      kind: input.kind,
      title: input.title,
      sourceEntryId: input.sourceEntryId,
      sourceVersionId: input.sourceVersionId,
      latestVersion: 1,
      createdById: input.createdById,
      createdAt: now,
      updatedAt: now,
      scope: key,
      createKey: input.createKey,
    };
    this.drafts.set(draftId, record);
    this.versions.set(draftId, [
      { draftId, version: 1, content: structuredClone(input.content), contentHash: input.contentHash, status: input.status, createdById: input.createdById, createdAt: now },
    ]);
    return { created: true, draft: this.public(record) };
  }

  async appendVersion(
    scope: LibraryScope,
    input: Parameters<AutomationDraftStore["appendVersion"]>[1]
  ): Promise<{ ok: true; version: DraftVersionRecord } | { ok: false; reason: "not_found" | "conflict" }> {
    this.check();
    const draft = this.drafts.get(input.draftId);
    if (!draft || draft.scope !== scopeKey(scope)) return { ok: false, reason: "not_found" };
    // Checked and taken in one synchronous step, as the conditional UPDATE is.
    if (draft.latestVersion !== input.expectedVersion) return { ok: false, reason: "conflict" };
    draft.latestVersion += 1;
    const now = this.tick();
    draft.updatedAt = now;
    const version: DraftVersionRecord = {
      draftId: input.draftId,
      version: draft.latestVersion,
      content: structuredClone(input.content),
      contentHash: input.contentHash,
      status: input.status,
      createdById: input.createdById,
      createdAt: now,
    };
    this.versions.get(input.draftId)!.push(version);
    return { ok: true, version: structuredClone(version) };
  }

  async findDraft(scope: LibraryScope, draftId: string): Promise<DraftRecord | null> {
    this.check();
    const draft = this.drafts.get(draftId);
    return draft && draft.scope === scopeKey(scope) ? this.public(draft) : null;
  }

  async findVersion(scope: LibraryScope, draftId: string, version: number): Promise<DraftVersionRecord | null> {
    this.check();
    const draft = this.drafts.get(draftId);
    if (!draft || draft.scope !== scopeKey(scope)) return null;
    const found = this.versions.get(draftId)?.find((v) => v.version === version);
    return found ? structuredClone(found) : null;
  }

  async listVersions(scope: LibraryScope, draftId: string): Promise<Array<Omit<DraftVersionRecord, "content">>> {
    this.check();
    const draft = this.drafts.get(draftId);
    if (!draft || draft.scope !== scopeKey(scope)) return [];
    return [...(this.versions.get(draftId) ?? [])].reverse().map(({ content: _content, ...rest }) => rest);
  }

  async listDrafts(scope: LibraryScope, query: { page: number; limit: number }): Promise<{ items: DraftRecord[]; total: number }> {
    this.check();
    const mine = [...this.drafts.values()].filter((d) => d.scope === scopeKey(scope)).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return { items: mine.slice((query.page - 1) * query.limit, query.page * query.limit).map((d) => this.public(d)), total: mine.length };
  }

  private public(d: DraftRecord & { scope: string; createKey: string }): DraftRecord {
    const { scope: _scope, createKey: _createKey, ...rest } = d;
    return { ...rest };
  }
}
