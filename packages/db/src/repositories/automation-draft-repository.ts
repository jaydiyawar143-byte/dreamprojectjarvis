// ---------------------------------------------------------------------------
// Phase 18, Stage 18.4 — workflow drafts' storage (`AutomationDraftStore` in
// @jarvis/core).
//
//   SCOPED. Every read and write names the catalog it belongs to — the
//   Organization, the provider and the instance — so a draft of another
//   Organization, or of another instance, is simply not found.
//
//   IMMUTABLE VERSIONS. There is no update of a version here, and the
//   migration's trigger refuses one in PostgreSQL. A revision appends a
//   version inside ONE transaction that first advances the draft's
//   `latest_version` by ONE conditional UPDATE — only while it is still the
//   version the revision was based on. Of two revisions of the same version,
//   exactly one is stored; the other is told "conflict" and stores nothing.
//   The unique (draft, version) key is the backstop.
//
//   ONE DRAFT PER REQUEST. A draft's `create_key` (the author and its first
//   content, hashed by the service) is unique in its catalog: the same request
//   sent twice — a retry, a second click — returns the first draft.
// ---------------------------------------------------------------------------

import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import type {
  AutomationDraftStore,
  DraftContent,
  DraftKind,
  DraftRecord,
  DraftStatus,
  DraftVersionRecord,
  LibraryScope,
} from "@jarvis/core";

const UNIQUE_CONSTRAINT = "P2002";

type DraftRow = Prisma.AutomationDraftGetPayload<Record<string, never>>;
type VersionRow = Prisma.AutomationDraftVersionGetPayload<Record<string, never>>;

const scopeWhere = (scope: LibraryScope) => ({ tenantId: scope.tenantId, providerId: scope.providerId, instanceKey: scope.instanceKey });

function toDraft(row: DraftRow): DraftRecord {
  return {
    draftId: row.id,
    kind: row.kind as DraftKind,
    title: row.title,
    sourceEntryId: row.sourceEntryId,
    sourceVersionId: row.sourceVersionId,
    latestVersion: row.latestVersion,
    createdById: row.createdById ?? "",
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toVersion(row: VersionRow): DraftVersionRecord {
  return {
    draftId: row.draftId,
    version: row.version,
    content: row.content as unknown as DraftContent,
    contentHash: row.contentHash,
    status: row.status as DraftStatus,
    createdById: row.createdById ?? "",
    createdAt: row.createdAt.toISOString(),
  };
}

export class PrismaAutomationDraftRepository implements AutomationDraftStore {
  constructor(private readonly prisma: PrismaClient) {}

  async createDraft(
    scope: LibraryScope,
    input: Parameters<AutomationDraftStore["createDraft"]>[1]
  ): Promise<{ created: boolean; draft: DraftRecord }> {
    const existing = () =>
      this.prisma.automationDraft.findUnique({
        where: { tenantId_providerId_instanceKey_createKey: { ...scopeWhere(scope), createKey: input.createKey } },
      });
    const found = await existing();
    if (found) return { created: false, draft: toDraft(found) };
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const draft = await tx.automationDraft.create({
          data: {
            ...scopeWhere(scope),
            kind: input.kind,
            title: input.title,
            sourceEntryId: input.sourceEntryId,
            sourceVersionId: input.sourceVersionId,
            latestVersion: 1,
            createKey: input.createKey,
            createdById: input.createdById,
          },
        });
        await tx.automationDraftVersion.create({
          data: {
            draftId: draft.id,
            version: 1,
            content: input.content as unknown as Prisma.InputJsonValue,
            contentHash: input.contentHash,
            status: input.status,
            createdById: input.createdById,
          },
        });
        return draft;
      });
      return { created: true, draft: toDraft(row) };
    } catch (err) {
      if ((err as { code?: string }).code !== UNIQUE_CONSTRAINT) throw err;
      // The same request, stored a moment earlier by another call: answer with it.
      const raced = await existing();
      if (!raced) throw err;
      return { created: false, draft: toDraft(raced) };
    }
  }

  async appendVersion(
    scope: LibraryScope,
    input: Parameters<AutomationDraftStore["appendVersion"]>[1]
  ): Promise<{ ok: true; version: DraftVersionRecord } | { ok: false; reason: "not_found" | "conflict" }> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // ONE conditional UPDATE: the revision is taken only from the version it was based on.
        const claimed = await tx.automationDraft.updateMany({
          where: { id: input.draftId, ...scopeWhere(scope), latestVersion: input.expectedVersion },
          data: { latestVersion: { increment: 1 } },
        });
        if (claimed.count !== 1) {
          const exists = await tx.automationDraft.count({ where: { id: input.draftId, ...scopeWhere(scope) } });
          return { ok: false as const, reason: exists === 1 ? ("conflict" as const) : ("not_found" as const) };
        }
        const row = await tx.automationDraftVersion.create({
          data: {
            draftId: input.draftId,
            version: input.expectedVersion + 1,
            content: input.content as unknown as Prisma.InputJsonValue,
            contentHash: input.contentHash,
            status: input.status,
            createdById: input.createdById,
          },
        });
        return { ok: true as const, version: toVersion(row) };
      });
    } catch (err) {
      if ((err as { code?: string }).code === UNIQUE_CONSTRAINT) return { ok: false, reason: "conflict" };
      throw err;
    }
  }

  async findDraft(scope: LibraryScope, draftId: string): Promise<DraftRecord | null> {
    const row = await this.prisma.automationDraft.findFirst({ where: { id: draftId, ...scopeWhere(scope) } });
    return row ? toDraft(row) : null;
  }

  async findVersion(scope: LibraryScope, draftId: string, version: number): Promise<DraftVersionRecord | null> {
    const row = await this.prisma.automationDraftVersion.findFirst({
      where: { draftId, version, draft: scopeWhere(scope) },
    });
    return row ? toVersion(row) : null;
  }

  async listVersions(scope: LibraryScope, draftId: string): Promise<Array<Omit<DraftVersionRecord, "content">>> {
    const rows = await this.prisma.automationDraftVersion.findMany({
      where: { draftId, draft: scopeWhere(scope) },
      select: { draftId: true, version: true, contentHash: true, status: true, createdById: true, createdAt: true },
      orderBy: { version: "desc" },
    });
    return rows.map((row) => ({
      draftId: row.draftId,
      version: row.version,
      contentHash: row.contentHash,
      status: row.status as DraftStatus,
      createdById: row.createdById ?? "",
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async listDrafts(scope: LibraryScope, query: { page: number; limit: number }): Promise<{ items: DraftRecord[]; total: number }> {
    const where = scopeWhere(scope);
    const [rows, total] = await Promise.all([
      this.prisma.automationDraft.findMany({
        where,
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.automationDraft.count({ where }),
    ]);
    return { items: rows.map(toDraft), total };
  }
}
