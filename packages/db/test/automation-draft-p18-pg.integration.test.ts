// Phase 18, Stage 18.4 — workflow drafts on REAL PostgreSQL.
//
// What only a database can prove:
//   • a stored version is immutable: PostgreSQL itself refuses an UPDATE of
//     its content, hash, status or number — and lets through only the foreign
//     key's own SET NULL when an author's account is deleted;
//   • a revision is ONE conditional UPDATE: of two revisions of the same
//     version, on two connections, exactly one is stored;
//   • the same request twice — even at once, on two connections — is one draft;
//   • every read and write is scoped: another Organization's or another
//     instance's draft is not found, and cannot be revised;
//   • deleting the Organization removes its drafts and their versions.
//
// SAFETY. As every suite here: DATABASE_URL is read before the Prisma client
// is imported, only a separate test database is used (never 5432 or 5433),
// and everything created is removed.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { DraftContent, LibraryScope } from "@jarvis/core";

const EXPLICIT_DATABASE_URL = process.env.DATABASE_URL;
const SAFE_TARGET = !!EXPLICIT_DATABASE_URL && !/:(?:5432|5433)\//.test(EXPLICIT_DATABASE_URL);
const REQUIRED = process.env.JARVIS_REQUIRE_POSTGRES === "1";

type Client = InstanceType<(typeof import("@prisma/client"))["PrismaClient"]>;
type DraftModule = typeof import("../src/repositories/automation-draft-repository.js");

let prisma: Client | null = null;
let second: Client | null = null;
let drafts: DraftModule | null = null;
let dbUp = false;
if (SAFE_TARGET) {
  const Prisma = await import("@prisma/client");
  drafts = await import("../src/repositories/automation-draft-repository.js");
  prisma = new Prisma.PrismaClient();
  second = new Prisma.PrismaClient();
  try {
    await prisma.$queryRaw`SELECT 1`;
    await second.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}

const STAMP = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const userIds: string[] = [];
const tenantIds: string[] = [];
let AUTHOR = "";
let LEAVER = "";
let SCOPE: LibraryScope;
let OTHER_ORG: LibraryScope;
let OTHER_INSTANCE: LibraryScope;

const repo = () => new drafts!.PrismaAutomationDraftRepository(prisma!);
const repo2 = () => new drafts!.PrismaAutomationDraftRepository(second!);

const content = (goal: string): DraftContent => ({
  schemaVersion: 1,
  kind: "new",
  title: goal,
  request: { goal, trigger: "webhook", services: ["Slack"], integrations: [], inputs: [], outcome: "done" },
  source: null,
  questions: [],
  notes: [],
  nodes: [
    { key: "hook", type: "n8n-nodes-base.webhook", label: "Webhook", origin: "added", remove: false, settings: [] },
    { key: "slack", type: "n8n-nodes-base.slack", label: "Slack", origin: "added", remove: false, settings: [{ key: "credential", label: "Slack account", kind: "credential", value: null }] },
  ],
  connections: [{ from: "hook", to: "slack", output: 0 }],
});

let seq = 0;
async function newDraft(scope: LibraryScope = SCOPE, createdById = AUTHOR) {
  seq += 1;
  return repo().createDraft(scope, {
    createdById,
    kind: "new",
    title: `Draft ${seq}`,
    sourceEntryId: null,
    sourceVersionId: null,
    createKey: `key-${STAMP}-${seq}`,
    content: content(`goal ${seq}`),
    contentHash: `${seq}`.padStart(64, "0"),
    status: "unverified",
  });
}

beforeAll(async () => {
  if (!SAFE_TARGET && !REQUIRED) return;
  if (!dbUp) throw new Error("These draft tests need a separate PostgreSQL test database, and none could be reached.");
  for (const name of ["author", "leaver"]) {
    const user = await prisma!.user.create({ data: { email: `p18d-${name}-${STAMP}@jarvis-test.local`, name, password: "x", role: "OWNER" } });
    userIds.push(user.id);
  }
  [AUTHOR, LEAVER] = userIds as [string, string];
  for (const name of ["org", "other"]) {
    const tenant = await prisma!.tenant.create({ data: { name: `p18d ${name} ${STAMP}` } });
    tenantIds.push(tenant.id);
  }
  SCOPE = { tenantId: tenantIds[0]!, providerId: "n8n", instanceKey: `inst-${STAMP}` };
  OTHER_ORG = { ...SCOPE, tenantId: tenantIds[1]! };
  OTHER_INSTANCE = { ...SCOPE, instanceKey: `inst2-${STAMP}` };
});

afterAll(async () => {
  if (prisma) {
    // Versions and drafts cascade with their Organization.
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
    await prisma.$disconnect();
  }
  if (second) await second.$disconnect();
});

describe.skipIf(!SAFE_TARGET && !REQUIRED)("Phase 18.4 — workflow drafts on PostgreSQL", () => {
  it("stores a draft with its first version, and the same request twice — even at once — as one draft", async () => {
    const created = await newDraft();
    expect(created).toMatchObject({ created: true, draft: { latestVersion: 1, kind: "new", createdById: AUTHOR } });
    const version = await repo().findVersion(SCOPE, created.draft.draftId, 1);
    expect(version).toMatchObject({ version: 1, status: "unverified", content: content(`goal ${seq}`) });

    const input = {
      createdById: AUTHOR,
      kind: "new" as const,
      title: "Twice",
      sourceEntryId: null,
      sourceVersionId: null,
      createKey: `twice-${STAMP}`,
      content: content("twice"),
      contentHash: "a".repeat(64),
      status: "unverified" as const,
    };
    const [a, b] = await Promise.all([repo().createDraft(SCOPE, input), repo2().createDraft(SCOPE, input)]);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(a.draft.draftId).toBe(b.draft.draftId);
    expect(await prisma!.automationDraftVersion.count({ where: { draftId: a.draft.draftId } })).toBe(1);
  });

  it("appends a revision only from the latest version — of two at once, exactly one", async () => {
    const { draft } = await newDraft();
    const revision = (expectedVersion: number, goal: string, client = repo()) =>
      client.appendVersion(SCOPE, { draftId: draft.draftId, expectedVersion, createdById: AUTHOR, content: content(goal), contentHash: "b".repeat(64), status: "needs_input" });
    expect(await revision(1, "second")).toMatchObject({ ok: true, version: { version: 2 } });
    expect(await revision(1, "stale base")).toEqual({ ok: false, reason: "conflict" });
    // A base the draft never reached is no base: nothing is stored at a gap.
    expect(await revision(99, "future base")).toEqual({ ok: false, reason: "conflict" });
    expect(await prisma!.automationDraftVersion.count({ where: { draftId: draft.draftId, version: 100 } })).toBe(0);
    expect((await repo().findDraft(SCOPE, draft.draftId))!.latestVersion).toBe(2);

    const results = await Promise.all([revision(2, "racer a"), revision(2, "racer b", repo2())]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, reason: "conflict" });
    expect((await repo().findDraft(SCOPE, draft.draftId))!.latestVersion).toBe(3);
    expect((await repo().listVersions(SCOPE, draft.draftId)).map((v) => v.version)).toEqual([3, 2, 1]);
    // Version 1 is what it was.
    expect((await repo().findVersion(SCOPE, draft.draftId, 1))!.content.request.goal).toBe(`goal ${seq}`);
  });

  it("refuses, in PostgreSQL itself, any change to a stored version", async () => {
    const { draft } = await newDraft();
    const row = await prisma!.automationDraftVersion.findFirstOrThrow({ where: { draftId: draft.draftId, version: 1 } });
    for (const data of [{ content: content("tampered") as never }, { contentHash: "c".repeat(64) }, { status: "validated" }, { version: 7 }, { createdById: LEAVER }]) {
      await expect(prisma!.automationDraftVersion.update({ where: { id: row.id }, data }), JSON.stringify(Object.keys(data))).rejects.toThrow(/immutable/);
    }
    await expect(prisma!.$executeRaw`UPDATE "AutomationDraftVersion" SET "status" = 'validated' WHERE "id" = ${row.id}`).rejects.toThrow(/immutable/);
    expect(await prisma!.automationDraftVersion.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "unverified", contentHash: row.contentHash });
  });

  it("keeps a draft whose author's account is deleted — the one change the guard allows", async () => {
    const { draft } = await newDraft(SCOPE, LEAVER);
    await prisma!.user.delete({ where: { id: LEAVER } });
    userIds.splice(userIds.indexOf(LEAVER), 1);
    expect(await repo().findDraft(SCOPE, draft.draftId)).toMatchObject({ createdById: "" });
    expect(await prisma!.automationDraftVersion.findFirstOrThrow({ where: { draftId: draft.draftId } })).toMatchObject({ createdById: null, version: 1 });
  });

  it("finds, lists and revises only inside its own Organization and instance", async () => {
    const { draft } = await newDraft();
    for (const scope of [OTHER_ORG, OTHER_INSTANCE]) {
      expect(await repo().findDraft(scope, draft.draftId)).toBeNull();
      expect(await repo().findVersion(scope, draft.draftId, 1)).toBeNull();
      expect(await repo().listVersions(scope, draft.draftId)).toEqual([]);
      expect((await repo().listDrafts(scope, { page: 1, limit: 50 })).items.map((d) => d.draftId)).not.toContain(draft.draftId);
      expect(
        await repo().appendVersion(scope, { draftId: draft.draftId, expectedVersion: 1, createdById: AUTHOR, content: content("x"), contentHash: "d".repeat(64), status: "unverified" })
      ).toEqual({ ok: false, reason: "not_found" });
    }
    expect((await repo().listDrafts(SCOPE, { page: 1, limit: 50 })).items.map((d) => d.draftId)).toContain(draft.draftId);
  });

  it("removes an Organization's drafts and their versions with it", async () => {
    const tenant = await prisma!.tenant.create({ data: { name: `p18d gone ${STAMP}` } });
    const scope = { ...SCOPE, tenantId: tenant.id };
    const { draft } = await newDraft(scope);
    await prisma!.tenant.delete({ where: { id: tenant.id } });
    expect(await prisma!.automationDraft.count({ where: { id: draft.draftId } })).toBe(0);
    expect(await prisma!.automationDraftVersion.count({ where: { draftId: draft.draftId } })).toBe(0);
  });
});
