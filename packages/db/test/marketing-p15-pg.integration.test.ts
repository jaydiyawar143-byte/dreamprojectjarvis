// Phase 15 — the marketing workspace store, against REAL PostgreSQL.
//
// THE ISOLATION MATRIX. Two users, three projects:
//
//   alice: personal, project A1, project A2
//   bob:   personal, project B1
//
// What is proved here is proved by the DATABASE as well as by the repository:
// a row in a project its owner does not own, a row attached to another user's
// campaign, a PUBLISHED row with no publication record and a VERIFIED
// publication with no evidence are each written directly with SQL and must be
// refused.
//
// SAFETY. Runs only against an explicitly supplied, separate test database —
// never the development (5432) or deployment (5433) one.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { CONTENT_PUBLISH_CLAIM_TTL_MS, type MarketingReportDocument, type PageFetchProvenance } from "@jarvis/core";
import { PrismaMarketingRepository } from "../src/repositories/marketing-repository.js";
import { PrismaAuditRepository } from "../src/repositories/audit-repository.js";
import { PrismaProjectRepository } from "../src/repositories/project-repository.js";

const EXPLICIT_DATABASE_URL = process.env.DATABASE_URL;
const SAFE_TARGET = !!EXPLICIT_DATABASE_URL && !/:(?:5432|5433)\//.test(EXPLICIT_DATABASE_URL);

const prisma = SAFE_TARGET ? new PrismaClient() : null;
let dbUp = false;
if (prisma) {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}

const STAMP = Date.now();
const userIds: string[] = [];

async function newUser(tag: string): Promise<string> {
  const user = await prisma!.user.create({
    data: { email: `p15-mkt-${tag}-${STAMP}-${userIds.length}@jarvis-test.local`, name: `P15 ${tag}`, password: "not-a-real-password-hash", role: "MEMBER" },
  });
  userIds.push(user.id);
  return user.id;
}

/** A repository whose clock the test controls. */
function repoAt(clock: { now: Date }) {
  return new PrismaMarketingRepository(prisma!, () => clock.now);
}
const repo = () => new PrismaMarketingRepository(prisma!);

const ALL = { kind: "ALL" } as const;
const PERSONAL = { kind: "PERSONAL" } as const;
const project = (projectId: string) => ({ kind: "PROJECT", projectId }) as const;

const PROVENANCE: PageFetchProvenance = {
  requestedUrl: "https://shop.example/",
  finalUrl: "https://shop.example/",
  httpStatus: 200,
  fetchedAt: "2026-10-12T00:00:00.000Z",
  contentType: "text/html",
  bytes: 1200,
  truncated: false,
  redirects: 0,
};

const DOCUMENT = { schemaVersion: 1, title: "R" } as unknown as MarketingReportDocument;

afterAll(async () => {
  if (dbUp && userIds.length > 0) {
    // The slot reservations are audit rows, and an audit row keeps its user:
    // they are removed first, by hand, exactly because nothing cascades to them.
    await prisma!.auditLog.deleteMany({ where: { userId: { in: userIds } } });
    // Deleting the users must take every marketing row with it.
    await prisma!.user.deleteMany({ where: { id: { in: userIds } } });
    const left = await prisma!.contentItem.count({ where: { userId: { in: userIds } } });
    expect(left).toBe(0);
  }
  await prisma?.$disconnect();
});

describe.skipIf(!dbUp)("Phase 15 — campaigns: ownership and project scope (PostgreSQL)", () => {
  let alice: string;
  let bob: string;
  let a1: string;
  let a2: string;
  let b1: string;

  beforeAll(async () => {
    const projects = new PrismaProjectRepository(prisma!);
    alice = await newUser("alice");
    bob = await newUser("bob");
    a1 = (await projects.create(alice, { name: "Client One" })).id;
    a2 = (await projects.create(alice, { name: "Client Two" })).id;
    b1 = (await projects.create(bob, { name: "Bob Client" })).id;

    await repo().createCampaign(alice, null, { name: "Alice personal" });
    await repo().createCampaign(alice, a1, { name: "Diwali Sale", channels: ["FACEBOOK", "INSTAGRAM"], startDate: "2026-10-01", endDate: "2026-11-15" });
    await repo().createCampaign(alice, a2, { name: "Diwali Sale" });
    await repo().createCampaign(bob, null, { name: "Bob personal" });
    await repo().createCampaign(bob, b1, { name: "Diwali Sale" });
  });

  it("a view never carries the owner", async () => {
    const [first] = await repo().listCampaigns(alice, ALL);
    expect(Object.keys(first!)).not.toContain("userId");
  });

  it("stores dates as calendar dates and returns them unchanged", async () => {
    const [found] = await repo().findCampaignsByName(alice, project(a1), "diwali sale");
    expect(found).toMatchObject({ startDate: "2026-10-01", endDate: "2026-11-15", channels: ["FACEBOOK", "INSTAGRAM"], projectId: a1 });
  });

  it("each scope sees its own campaigns and nothing else", async () => {
    const names = async (userId: string, scope: Parameters<PrismaMarketingRepository["listCampaigns"]>[1]) =>
      (await repo().listCampaigns(userId, scope)).map((c) => c.name).sort();

    expect(await names(alice, PERSONAL)).toEqual(["Alice personal"]);
    expect(await names(alice, project(a1))).toEqual(["Diwali Sale"]);
    expect(await names(alice, project(a2))).toEqual(["Diwali Sale"]);
    expect(await names(alice, ALL)).toEqual(["Alice personal", "Diwali Sale", "Diwali Sale"]);
    expect(await names(bob, ALL)).toEqual(["Bob personal", "Diwali Sale"]);
  });

  it("naming another user's project selects nothing of theirs", async () => {
    expect(await repo().listCampaigns(alice, project(b1))).toEqual([]);
    expect(await repo().findCampaignsByName(alice, project(b1), "Diwali Sale")).toEqual([]);
  });

  it("another user's campaign id finds nothing, exactly as an unknown id does", async () => {
    const [bobs] = await repo().listCampaigns(bob, project(b1));
    expect(await repo().findCampaign(alice, ALL, bobs!.id)).toBeNull();
    expect(await repo().findCampaign(alice, ALL, "no-such-campaign")).toBeNull();
    expect(await repo().updateCampaign(alice, ALL, bobs!.id, { name: "Taken" })).toBeNull();
    expect((await repo().findCampaign(bob, ALL, bobs!.id))!.name).toBe("Diwali Sale");
  });

  it("a campaign of one project is not reachable from another project of the same user", async () => {
    const [inA1] = await repo().listCampaigns(alice, project(a1));
    expect(await repo().findCampaign(alice, project(a2), inA1!.id)).toBeNull();
    expect(await repo().findCampaign(alice, PERSONAL, inA1!.id)).toBeNull();
    expect(await repo().updateCampaign(alice, project(a2), inA1!.id, { objective: "leak" })).toBeNull();
    expect((await repo().findCampaign(alice, project(a1), inA1!.id))!.objective).toBeNull();
  });

  it("reports how many campaigns lie outside the scope, as a number only", async () => {
    expect(await repo().countCampaignsOutside(alice, PERSONAL)).toBe(2);
    expect(await repo().countCampaignsOutside(alice, project(a1))).toBe(2);
    expect(await repo().countCampaignsOutside(alice, ALL)).toBe(0);
  });

  it("refuses a second campaign with the same name in the same scope, whatever its capitals", async () => {
    await expect(repo().createCampaign(alice, a1, { name: "DIWALI sale" })).rejects.toThrow("already have a campaign with that name");
    await expect(repo().createCampaign(alice, null, { name: "alice PERSONAL" })).rejects.toThrow("already have a campaign with that name");
  });

  it("the personal scope is ONE scope for names — the database enforces it, not just the repository", async () => {
    await expect(
      prisma!.marketingCampaign.create({ data: { userId: alice, projectId: null, name: "ALICE PERSONAL" } })
    ).rejects.toThrow();
  });

  it("refuses a rename onto a name already used in that scope", async () => {
    const extra = await repo().createCampaign(alice, a1, { name: "Winter" });
    await expect(repo().updateCampaign(alice, project(a1), extra.id, { name: "diwali sale" })).rejects.toThrow("already have a campaign with that name");
  });

  it("refuses a campaign in a project the user does not own", async () => {
    await expect(repo().createCampaign(alice, b1, { name: "Intruder" })).rejects.toThrow("That project was not found");
  });

  it("the database itself refuses a campaign in another user's project", async () => {
    await expect(
      prisma!.marketingCampaign.create({ data: { userId: alice, projectId: b1, name: "Direct write" } })
    ).rejects.toThrow();
  });

  it("an update can clear a field, and cannot move a campaign to another project", async () => {
    const created = await repo().createCampaign(alice, a1, { name: "Clearable", objective: "x", endDate: "2026-12-01" });
    const cleared = await repo().updateCampaign(alice, project(a1), created.id, { objective: null, endDate: null, status: "ACTIVE" });
    expect(cleared).toMatchObject({ objective: null, endDate: null, status: "ACTIVE", projectId: a1 });
  });

  it("an archived campaign leaves the default list and stays findable", async () => {
    const created = await repo().createCampaign(alice, a2, { name: "Old one" });
    await repo().updateCampaign(alice, project(a2), created.id, { status: "ARCHIVED" });
    expect((await repo().listCampaigns(alice, project(a2))).map((c) => c.name)).not.toContain("Old one");
    expect((await repo().listCampaigns(alice, project(a2), { includeArchived: true })).map((c) => c.name)).toContain("Old one");
  });
});

describe.skipIf(!dbUp)("Phase 15 — content and the calendar (PostgreSQL)", () => {
  let alice: string;
  let bob: string;
  let a1: string;
  let campaignId: string;
  let bobCampaignId: string;

  beforeAll(async () => {
    const projects = new PrismaProjectRepository(prisma!);
    alice = await newUser("cal-alice");
    bob = await newUser("cal-bob");
    a1 = (await projects.create(alice, { name: "Calendar Client" })).id;
    campaignId = (await repo().createCampaign(alice, a1, { name: "Launch" })).id;
    bobCampaignId = (await repo().createCampaign(bob, null, { name: "Bob Launch" })).id;

    await repo().createContent(
      alice,
      { campaignId, projectId: a1 },
      [
        { title: "Evening", channel: "FACEBOOK", body: "e", scheduledDate: "2026-10-20", scheduledTime: "18:00" },
        { title: "Morning", channel: "INSTAGRAM", body: "m", scheduledDate: "2026-10-20", scheduledTime: "09:00" },
        { title: "No time", channel: "FACEBOOK", body: "n", scheduledDate: "2026-10-20" },
        { title: "Earlier", channel: "FACEBOOK", body: "x", scheduledDate: "2026-10-05", status: "READY" },
        { title: "Next month", channel: "LINKEDIN", body: "y", scheduledDate: "2026-11-03", status: "IDEA" },
        { title: "Undated", channel: "FACEBOOK", body: "z" },
      ],
      "jarvis"
    );
    await repo().createContent(alice, { campaignId: null, projectId: null }, [{ title: "Personal note", channel: "X", body: "p", scheduledDate: "2026-10-20" }], "user");
    await repo().createContent(bob, { campaignId: bobCampaignId, projectId: null }, [{ title: "Bob post", channel: "FACEBOOK", body: "b", scheduledDate: "2026-10-20" }], "user");
  });

  it("a content item carries its campaign's project, and who created it", async () => {
    const { items } = await repo().listContent(alice, project(a1), { campaignId });
    expect(items.every((i) => i.projectId === a1 && i.campaignId === campaignId && i.createdBy === "jarvis")).toBe(true);
    expect(Object.keys(items[0]!)).not.toContain("userId");
  });

  it("reads a date window in date order, timed items first, with the matching total", async () => {
    const { items, total } = await repo().listContent(alice, project(a1), { from: "2026-10-01", to: "2026-10-31" });
    expect(items.map((i) => i.title)).toEqual(["Earlier", "Morning", "Evening", "No time"]);
    expect(total).toBe(4);
  });

  it("includes undated items only when asked", async () => {
    const without = await repo().listContent(alice, project(a1), { from: "2026-10-01", to: "2026-10-31" });
    const withThem = await repo().listContent(alice, project(a1), { from: "2026-10-01", to: "2026-10-31", includeUnscheduled: true });
    expect(without.items.map((i) => i.title)).not.toContain("Undated");
    expect(withThem.items.map((i) => i.title).at(-1)).toBe("Undated");
  });

  it("filters by status and by channel", async () => {
    expect((await repo().listContent(alice, project(a1), { statuses: ["READY"] })).items.map((i) => i.title)).toEqual(["Earlier"]);
    expect((await repo().listContent(alice, project(a1), { channel: "INSTAGRAM" })).items.map((i) => i.title)).toEqual(["Morning"]);
  });

  it("says how many matched even when the page is smaller", async () => {
    const page = await repo().listContent(alice, project(a1), { limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(6);
  });

  it("a project's calendar never shows personal items or another user's", async () => {
    const titles = (await repo().listContent(alice, project(a1), { from: "2026-10-20", to: "2026-10-20" })).items.map((i) => i.title);
    expect(titles).not.toContain("Personal note");
    expect(titles).not.toContain("Bob post");
    expect((await repo().listContent(alice, PERSONAL)).items.map((i) => i.title)).toEqual(["Personal note"]);
    expect((await repo().listContent(bob, ALL)).items.map((i) => i.title)).toEqual(["Bob post"]);
  });

  it("asking for another user's campaign returns nothing", async () => {
    expect((await repo().listContent(alice, ALL, { campaignId: bobCampaignId })).items).toEqual([]);
  });

  it("counts every status for a campaign, zeros included", async () => {
    expect(await repo().countContentByStatus(alice, project(a1), campaignId)).toEqual({ IDEA: 1, DRAFT: 4, READY: 1, PUBLISHED: 0, ARCHIVED: 0 });
  });

  it("refuses content attached to another user's campaign", async () => {
    await expect(
      repo().createContent(alice, { campaignId: bobCampaignId, projectId: null }, [{ title: "Intruder", channel: "FACEBOOK", body: "x" }], "user")
    ).rejects.toThrow("That campaign or project was not found");
  });

  it("the database itself refuses content attached to another user's campaign", async () => {
    await expect(
      prisma!.contentItem.create({ data: { userId: alice, campaignId: bobCampaignId, title: "Direct", channel: "FACEBOOK" } })
    ).rejects.toThrow();
  });

  it("a batch is saved whole or not at all", async () => {
    const before = (await repo().listContent(alice, ALL)).total;
    await expect(
      repo().createContent(
        alice,
        { campaignId: bobCampaignId, projectId: null },
        [
          { title: "One", channel: "FACEBOOK", body: "1" },
          { title: "Two", channel: "FACEBOOK", body: "2" },
        ],
        "user"
      )
    ).rejects.toThrow();
    expect((await repo().listContent(alice, ALL)).total).toBe(before);
  });

  it("an edit applies only inside the caller's scope", async () => {
    const [target] = (await repo().listContent(alice, project(a1), { channel: "INSTAGRAM" })).items;
    expect(await repo().updateContent(bob, ALL, target!.id, { title: "Hijacked" })).toBeNull();
    expect(await repo().updateContent(alice, PERSONAL, target!.id, { title: "Wrong scope" })).toBeNull();
    const edited = await repo().updateContent(alice, project(a1), target!.id, { title: "Morning, edited", scheduledDate: null });
    expect(edited).toMatchObject({ title: "Morning, edited", scheduledDate: null });
  });
});

describe.skipIf(!dbUp)("Phase 15 — published means there is a record of how that is known (PostgreSQL)", () => {
  let alice: string;
  let itemId: string;

  beforeAll(async () => {
    alice = await newUser("pub-alice");
    const [created] = await repo().createContent(alice, { campaignId: null, projectId: null }, [{ title: "Post", channel: "FACEBOOK", body: "Hello", status: "READY" }], "user");
    itemId = created!.id;
  });

  it("the database refuses PUBLISHED with no publication record", async () => {
    await expect(prisma!.contentItem.update({ where: { id: itemId }, data: { status: "PUBLISHED" } })).rejects.toThrow();
  });

  it("the database refuses a publication record on an item that is not PUBLISHED", async () => {
    await expect(
      prisma!.contentItem.update({ where: { id: itemId }, data: { publicationMode: "REPORTED_BY_USER", publishedAt: new Date() } })
    ).rejects.toThrow();
  });

  it("the database refuses VERIFIED without the provider's post id, provider and read-back time", async () => {
    const base = { status: "PUBLISHED", publicationMode: "VERIFIED", publishedAt: new Date() };
    await expect(prisma!.contentItem.update({ where: { id: itemId }, data: base })).rejects.toThrow();
    await expect(prisma!.contentItem.update({ where: { id: itemId }, data: { ...base, externalId: "1_2", publishedVia: "meta-graph" } })).rejects.toThrow();
    await expect(prisma!.contentItem.update({ where: { id: itemId }, data: { ...base, externalId: "1_2", verifiedAt: new Date() } })).rejects.toThrow();
  });

  it("the database refuses a publication mode it does not know", async () => {
    await expect(
      prisma!.contentItem.update({ where: { id: itemId }, data: { status: "PUBLISHED", publicationMode: "TRUST_ME", publishedAt: new Date() } })
    ).rejects.toThrow();
  });

  it("the user reporting a post marks it REPORTED_BY_USER — never VERIFIED — once", async () => {
    const [created] = await repo().createContent(alice, { campaignId: null, projectId: null }, [{ title: "By hand", channel: "INSTAGRAM", body: "x" }], "user");
    const marked = await repo().markPublishedByUser(alice, ALL, created!.id, { publishedAt: new Date("2026-10-10T10:00:00.000Z"), url: "https://instagram.com/p/abc" });
    expect(marked!.status).toBe("PUBLISHED");
    expect(marked!.publication).toEqual({
      mode: "REPORTED_BY_USER",
      publishedAt: "2026-10-10T10:00:00.000Z",
      provider: null,
      targetName: null,
      externalId: null,
      url: "https://instagram.com/p/abc",
      verifiedAt: null,
    });
    expect(await repo().markPublishedByUser(alice, ALL, created!.id, { publishedAt: new Date(), url: null })).toBeNull();
  });

  it("a published item can no longer be edited", async () => {
    const [created] = await repo().createContent(alice, { campaignId: null, projectId: null }, [{ title: "Locked", channel: "X", body: "x" }], "user");
    await repo().markPublishedByUser(alice, ALL, created!.id, { publishedAt: new Date(), url: null });
    expect(await repo().updateContent(alice, ALL, created!.id, { body: "rewritten history" })).toBeNull();
    expect((await repo().findContent(alice, ALL, created!.id))!.body).toBe("x");
  });

  it("an archived item cannot be reported as published", async () => {
    const [created] = await repo().createContent(alice, { campaignId: null, projectId: null }, [{ title: "Shelved", channel: "X", body: "x", status: "ARCHIVED" }], "user");
    expect(await repo().markPublishedByUser(alice, ALL, created!.id, { publishedAt: new Date(), url: null })).toBeNull();
  });

  it("another user cannot report someone else's item as published", async () => {
    const mallory = await newUser("pub-mallory");
    expect(await repo().markPublishedByUser(mallory, ALL, itemId, { publishedAt: new Date(), url: null })).toBeNull();
    expect((await repo().findContent(alice, ALL, itemId))!.status).toBe("READY");
  });
});

describe.skipIf(!dbUp)("Phase 15 — the publish claim has exactly one winner (PostgreSQL)", () => {
  let alice: string;
  const expected = { channel: "FACEBOOK", body: "Approved text", link: null } as const;
  /** What a claim taken from an item with no publish outstanding writes with it. */
  const starting = {
    state: "UNCONFIRMED",
    at: "2026-10-12T09:59:59.000Z",
    code: "SENDING",
    targetId: "111",
    targetName: "Shop Page",
    externalId: null,
    textHash: "hash-of-approved-text",
    lastLookup: null,
  } as const;

  const ready = async (overrides: Partial<{ body: string; link: string | null; status: "READY" | "DRAFT" }> = {}) => {
    const [created] = await repo().createContent(
      alice,
      { campaignId: null, projectId: null },
      [{ title: "Post", channel: "FACEBOOK", body: overrides.body ?? "Approved text", link: overrides.link ?? null, status: overrides.status ?? "READY" }],
      "user"
    );
    return created!.id;
  };

  beforeAll(async () => {
    alice = await newUser("claim-alice");
  });

  it("ten executions race for one item and exactly one takes it", async () => {
    const id = await ready();
    const results = await Promise.all(Array.from({ length: 10 }, () => repo().claimForPublish(alice, id, expected, { from: "NONE", attempt: starting })));
    expect(results.filter(Boolean)).toEqual(["FRESH"]);
    expect((await repo().publishStateOf(alice, id))!.state).toBe("PUBLISHING");
  });

  it("refuses the claim when the saved copy is no longer what was approved", async () => {
    const id = await ready({ body: "Edited after approval" });
    expect(await repo().claimForPublish(alice, id, expected, { from: "NONE", attempt: starting })).toBeNull();
    expect((await repo().publishStateOf(alice, id))!.state).toBe("NONE");
    // A claim that took nothing wrote nothing.
    expect((await repo().findContent(alice, ALL, id))!.publishAttempt).toBeNull();
  });

  it("refuses the claim when the link differs from the approved one", async () => {
    const id = await ready({ link: "https://example.com/a" });
    expect(await repo().claimForPublish(alice, id, expected, { from: "NONE", attempt: starting })).toBeNull();
    expect(await repo().claimForPublish(alice, id, { ...expected, link: "https://example.com/a" }, { from: "NONE", attempt: starting })).toBe("FRESH");
  });

  it("refuses the claim for a draft, for another channel and for another user", async () => {
    const draft = await ready({ status: "DRAFT" });
    expect(await repo().claimForPublish(alice, draft, expected, { from: "NONE", attempt: starting })).toBeNull();

    const id = await ready();
    expect(await repo().claimForPublish(alice, id, { ...expected, channel: "INSTAGRAM" }, { from: "NONE", attempt: starting })).toBeNull();
    const mallory = await newUser("claim-mallory");
    expect(await repo().claimForPublish(mallory, id, expected, { from: "NONE", attempt: starting })).toBeNull();
    expect(await repo().claimForPublish(alice, id, expected, { from: "NONE", attempt: starting })).toBe("FRESH");
  });

  it("while a publish is running the item cannot be edited or reported as published", async () => {
    const id = await ready();
    expect(await repo().claimForPublish(alice, id, expected, { from: "NONE", attempt: starting })).toBe("FRESH");
    expect(await repo().updateContent(alice, ALL, id, { body: "swap the text mid-flight" })).toBeNull();
    expect(await repo().markPublishedByUser(alice, ALL, id, { publishedAt: new Date(), url: null })).toBeNull();
    expect((await repo().findContent(alice, ALL, id))!.body).toBe("Approved text");
  });

  it("finalising writes VERIFIED with its evidence and clears the claim, once", async () => {
    const id = await ready();
    await repo().claimForPublish(alice, id, expected, { from: "NONE", attempt: starting });
    const publication = {
      provider: "meta-graph",
      targetName: "Shop Page",
      externalId: "111_222",
      url: "https://www.facebook.com/111/posts/222",
      publishedAt: new Date("2026-10-12T10:00:00.000Z"),
      verifiedAt: new Date("2026-10-12T10:00:02.000Z"),
    };
    const done = await repo().finalizePublished(alice, id, publication);
    expect(done!.status).toBe("PUBLISHED");
    expect(done!.publication).toEqual({
      mode: "VERIFIED",
      publishedAt: "2026-10-12T10:00:00.000Z",
      provider: "meta-graph",
      targetName: "Shop Page",
      externalId: "111_222",
      url: "https://www.facebook.com/111/posts/222",
      verifiedAt: "2026-10-12T10:00:02.000Z",
    });
    expect(done!.publishUnconfirmed).toBe(false);
    expect((await repo().publishStateOf(alice, id))!.state).toBe("NONE");
    expect(await repo().finalizePublished(alice, id, publication)).toBeNull();
  });

  it("an item that was never claimed cannot be finalised", async () => {
    const id = await ready();
    const result = await repo().finalizePublished(alice, id, {
      provider: "meta-graph",
      targetName: "Shop Page",
      externalId: "1_2",
      url: null,
      publishedAt: new Date(),
      verifiedAt: new Date(),
    });
    expect(result).toBeNull();
    expect((await repo().findContent(alice, ALL, id))!.status).toBe("READY");
  });

  it("a failed attempt releases the claim, records the attempt and publishes nothing", async () => {
    const id = await ready();
    await repo().claimForPublish(alice, id, expected, { from: "NONE", attempt: starting });
    const released = await repo().releasePublish(alice, id, "NONE", {
      state: "FAILED",
      at: "2026-10-12T10:00:00.000Z",
      code: "PROVIDER_REFUSED",
      targetId: "111",
      targetName: "Shop Page",
      externalId: null,
    });
    expect(released).toMatchObject({ status: "READY", publication: null, publishUnconfirmed: false });
    expect(released!.publishAttempt).toMatchObject({ state: "FAILED", code: "PROVIDER_REFUSED" });
    // Nothing is outstanding, so the next claim is a fresh one and may send.
    expect(await repo().claimForPublish(alice, id, expected, { from: "NONE", attempt: starting })).toBe("FRESH");
  });

  it("an unknown outcome leaves the item UNCONFIRMED — not published — and the next claim says so", async () => {
    const id = await ready();
    await repo().claimForPublish(alice, id, expected, { from: "NONE", attempt: starting });
    const original = {
      state: "UNCONFIRMED",
      at: "2026-10-12T10:00:00.000Z",
      code: "AMBIGUOUS_OUTCOME",
      targetId: "111",
      targetName: "Shop Page",
      externalId: null,
      textHash: "hash-of-approved-text",
      lastLookup: null,
    } as const;
    const released = await repo().releasePublish(alice, id, "UNCONFIRMED", original);
    expect(released).toMatchObject({ status: "READY", publication: null, publishUnconfirmed: true });

    // A claim to SEND cannot take it at all — and writes nothing while failing to.
    const another = { ...starting, targetId: "999", targetName: "Some Other Page", textHash: "hash-of-other-text", at: "2026-10-12T11:00:00.000Z" };
    expect(await repo().claimForPublish(alice, id, expected, { from: "NONE", attempt: another })).toBeNull();
    expect((await repo().publishStateOf(alice, id))!.state).toBe("UNCONFIRMED");
    expect((await repo().findContent(alice, ALL, id))!.publishAttempt).toEqual(original);

    // A claim to LOOK takes it — and it is NOT a fresh one: whoever holds it may only look.
    expect(await repo().claimForPublish(alice, id, expected, { from: "UNCONFIRMED" })).toBe("UNCONFIRMED");
    // The record of the ORIGINAL attempt is exactly as it was: its Page, its hash, its time.
    expect((await repo().findContent(alice, ALL, id))!.publishAttempt).toEqual(original);
  });

  it("a fresh claim writes where the attempt is going and a hash of what it sends, in the same statement", async () => {
    const id = await ready();
    expect((await repo().findContent(alice, ALL, id))!.publishAttempt).toBeNull();
    expect(await repo().claimForPublish(alice, id, expected, { from: "NONE", attempt: starting })).toBe("FRESH");
    const row = await prisma!.contentItem.findUniqueOrThrow({ where: { id } });
    expect(row.publishState).toBe("PUBLISHING");
    expect(row.publishAttempt).toEqual(starting);
  });

  it("an item whose publish is UNCONFIRMED cannot be edited — not its words, its date, its status or its notes", async () => {
    const id = await ready();
    await repo().claimForPublish(alice, id, expected, { from: "NONE", attempt: starting });
    await repo().releasePublish(alice, id, "UNCONFIRMED", { ...starting, code: "AMBIGUOUS_OUTCOME" });

    for (const patch of [{ body: "Different words" }, { title: "New title" }, { link: "https://example.com/x" }, { scheduledDate: "2026-11-01" }, { status: "DRAFT" as const }, { status: "ARCHIVED" as const }, { notes: "a note" }]) {
      expect(await repo().updateContent(alice, ALL, id, patch), JSON.stringify(patch)).toBeNull();
    }
    const after = await repo().findContent(alice, ALL, id);
    expect(after).toMatchObject({ body: "Approved text", title: "Post", link: null, status: "READY", scheduledDate: null, notes: null, publishUnconfirmed: true });
    // The user saying "I posted it myself" is still a way out — and is never recorded as verified.
    const reported = await repo().markPublishedByUser(alice, ALL, id, { publishedAt: new Date(), url: null });
    expect(reported!.publication!.mode).toBe("REPORTED_BY_USER");
  });

  it("an abandoned claim cannot be edited either: it is unconfirmed, not free", async () => {
    const clock = { now: new Date("2026-10-12T10:00:00.000Z") };
    const id = await ready();
    expect(await repoAt(clock).claimForPublish(alice, id, expected, { from: "NONE", attempt: starting })).toBe("FRESH");
    clock.now = new Date(clock.now.getTime() + CONTENT_PUBLISH_CLAIM_TTL_MS + 1000);
    expect((await repoAt(clock).findContent(alice, ALL, id))!.publishUnconfirmed).toBe(true);
    expect(await repoAt(clock).updateContent(alice, ALL, id, { body: "Different words" })).toBeNull();
    expect((await repoAt(clock).findContent(alice, ALL, id))!.body).toBe("Approved text");
  });

  it("after the attempt is cleared, the item can be edited again and the next claim is fresh", async () => {
    const id = await ready();
    await repo().claimForPublish(alice, id, expected, { from: "NONE", attempt: starting });
    await repo().releasePublish(alice, id, "UNCONFIRMED", { ...starting, code: "AMBIGUOUS_OUTCOME" });
    expect(await repo().claimUnconfirmed(alice, id)).toBe(true);
    const cleared = await repo().releasePublish(alice, id, "NONE", { ...starting, state: "FAILED", code: "CLEARED_BY_USER", lastLookup: { at: "2026-10-12T10:05:00.000Z", result: "NOT_FOUND" } });
    expect(cleared).toMatchObject({ publishUnconfirmed: false });
    expect(cleared!.publishAttempt).toMatchObject({ state: "FAILED", code: "CLEARED_BY_USER", lastLookup: { at: "2026-10-12T10:05:00.000Z", result: "NOT_FOUND" } });
    expect((await repo().updateContent(alice, ALL, id, { notes: "editable again" }))!.notes).toBe("editable again");
    expect(await repo().claimForPublish(alice, id, expected, { from: "NONE", attempt: starting })).toBe("FRESH");
  });

  it("claimUnconfirmed takes only an unconfirmed item, once, for its owner — and leaves the original attempt alone", async () => {
    const untouched = await ready();
    expect(await repo().claimUnconfirmed(alice, untouched)).toBe(false);
    expect((await repo().publishStateOf(alice, untouched))!.state).toBe("NONE");

    const running = await ready();
    await repo().claimForPublish(alice, running, expected, { from: "NONE", attempt: starting });
    expect(await repo().claimUnconfirmed(alice, running)).toBe(false);

    const id = await ready();
    await repo().claimForPublish(alice, id, expected, { from: "NONE", attempt: starting });
    const original = { ...starting, code: "VERIFY_FAILED", externalId: "111_222" };
    await repo().releasePublish(alice, id, "UNCONFIRMED", original);
    const mallory = await newUser("claim-unconfirmed-mallory");
    expect(await repo().claimUnconfirmed(mallory, id)).toBe(false);

    const results = await Promise.all(Array.from({ length: 10 }, () => repo().claimUnconfirmed(alice, id)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await repo().publishStateOf(alice, id))!.state).toBe("PUBLISHING");
    expect((await repo().findContent(alice, ALL, id))!.publishAttempt).toEqual(original);
  });

  it("a fresh claim and an unconfirmed claim racing for one unconfirmed item: exactly one takes it, and it is never FRESH", async () => {
    const id = await ready();
    await repo().claimForPublish(alice, id, expected, { from: "NONE", attempt: starting });
    await repo().releasePublish(alice, id, "UNCONFIRMED", { ...starting, code: "AMBIGUOUS_OUTCOME" });
    const results = await Promise.all([
      ...Array.from({ length: 4 }, () => repo().claimForPublish(alice, id, expected, { from: "NONE", attempt: starting })),
      ...Array.from({ length: 4 }, () => repo().claimForPublish(alice, id, expected, { from: "UNCONFIRMED" })),
      ...Array.from({ length: 4 }, () => repo().claimUnconfirmed(alice, id)),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results).not.toContain("FRESH");
    // The four claims to send took nothing, whichever of the others won.
    expect(results.slice(0, 4)).toEqual([null, null, null, null]);
  });

  it("releasing a claim that is not held changes nothing", async () => {
    const id = await ready();
    const attempt = { state: "FAILED", at: "2026-10-12T10:00:00.000Z", code: "X", targetId: null, targetName: null, externalId: null } as const;
    expect(await repo().releasePublish(alice, id, "NONE", attempt)).toBeNull();
    expect((await repo().findContent(alice, ALL, id))!.publishAttempt).toBeNull();
  });

  it("a claim that was abandoned reads as UNCONFIRMED and can be taken over; a live one cannot", async () => {
    const clock = { now: new Date("2026-10-12T10:00:00.000Z") };
    const id = await ready();
    expect(await repoAt(clock).claimForPublish(alice, id, expected, { from: "NONE", attempt: starting })).toBe("FRESH");

    clock.now = new Date(clock.now.getTime() + CONTENT_PUBLISH_CLAIM_TTL_MS - 1000);
    expect(await repoAt(clock).claimForPublish(alice, id, expected, { from: "NONE", attempt: starting })).toBeNull();
    expect(await repoAt(clock).claimForPublish(alice, id, expected, { from: "UNCONFIRMED" })).toBeNull();
    expect((await repoAt(clock).findContent(alice, ALL, id))!.publishUnconfirmed).toBe(false);

    clock.now = new Date(clock.now.getTime() + 2000);
    expect((await repoAt(clock).findContent(alice, ALL, id))!.publishUnconfirmed).toBe(true);
    // Taken over — as UNCONFIRMED, never as fresh: the abandoned attempt may have sent.
    // So a claim to send cannot take it over, and writes nothing while failing to.
    const takeover = { ...starting, targetId: "999", targetName: "Some Other Page" };
    expect(await repoAt(clock).claimForPublish(alice, id, expected, { from: "NONE", attempt: takeover })).toBeNull();
    expect((await repoAt(clock).findContent(alice, ALL, id))!.publishAttempt).toEqual(starting);
    expect(await repoAt(clock).claimForPublish(alice, id, expected, { from: "UNCONFIRMED" })).toBe("UNCONFIRMED");
    // And what the abandoned attempt wrote when it started is still there: where it was going.
    expect((await repoAt(clock).findContent(alice, ALL, id))!.publishAttempt).toEqual(starting);
  });
});

describe.skipIf(!dbUp)("Phase 15 — reports and research stay in their scope (PostgreSQL)", () => {
  let alice: string;
  let bob: string;
  let a1: string;
  let campaignId: string;

  beforeAll(async () => {
    const projects = new PrismaProjectRepository(prisma!);
    alice = await newUser("rep-alice");
    bob = await newUser("rep-bob");
    a1 = (await projects.create(alice, { name: "Report Client" })).id;
    campaignId = (await repo().createCampaign(alice, a1, { name: "Reported" })).id;

    const write = (title: string, generatedAt: string, target: { campaignId: string | null; projectId: string | null }) =>
      repo().createReport(alice, {
        kind: "PERFORMANCE",
        title,
        ...target,
        periodStart: "2026-10-01",
        periodEnd: "2026-10-10",
        document: { ...DOCUMENT, title },
        sourcesIncluded: 1,
        sourcesTotal: 2,
        generatedAt: new Date(generatedAt),
      });
    await write("Older", "2026-10-11T00:00:00.000Z", { campaignId, projectId: a1 });
    await write("Newer", "2026-10-12T00:00:00.000Z", { campaignId, projectId: a1 });
    await write("Personal", "2026-10-12T06:00:00.000Z", { campaignId: null, projectId: null });
  });

  it("counts a user's reports — theirs only — so the cap can be answered before anything is read", async () => {
    const counter = await newUser("report-counter");
    const other = await newUser("report-counter-other");
    expect(await repo().countReports(counter)).toBe(0);
    const base = { kind: "PERFORMANCE", title: "R", campaignId: null, projectId: null, periodStart: "2026-09-01", periodEnd: "2026-09-30", document: {} as MarketingReportDocument, sourcesIncluded: 0, sourcesTotal: 0, generatedAt: new Date() } as const;
    await repo().createReport(counter, base);
    await repo().createReport(counter, base);
    await repo().createReport(other, base);
    expect(await repo().countReports(counter)).toBe(2);
    expect(await repo().countReports(other)).toBe(1);
  });

  it("lists reports newest first, as summaries without the document", async () => {
    const list = await repo().listReports(alice, project(a1));
    expect(list.map((r) => r.title)).toEqual(["Newer", "Older"]);
    expect(list[0]).toMatchObject({ periodStart: "2026-10-01", periodEnd: "2026-10-10", sourcesIncluded: 1, sourcesTotal: 2 });
    expect(Object.keys(list[0]!)).not.toContain("document");
    expect(Object.keys(list[0]!)).not.toContain("userId");
  });

  it("returns the newest report of a campaign, with its document", async () => {
    const latest = await repo().latestReport(alice, project(a1), campaignId);
    expect(latest!.title).toBe("Newer");
    expect(latest!.document.title).toBe("Newer");
  });

  it("a report is invisible to another user and to another scope", async () => {
    const [newer] = await repo().listReports(alice, project(a1));
    expect(await repo().findReport(bob, ALL, newer!.id)).toBeNull();
    expect(await repo().findReport(alice, PERSONAL, newer!.id)).toBeNull();
    expect(await repo().listReports(alice, PERSONAL)).toHaveLength(1);
    expect(await repo().listReports(bob, ALL)).toEqual([]);
  });

  it("the database refuses a report in another user's project", async () => {
    await expect(
      prisma!.marketingReport.create({
        data: { userId: bob, projectId: a1, kind: "CLIENT", title: "Leak", periodStart: new Date(), periodEnd: new Date(), document: {} },
      })
    ).rejects.toThrow();
  });

  it("finds the last saved read of an address, within the scope only", async () => {
    const save = (fetchedAt: string, headline: string, scopeProject: string | null) =>
      repo().createResearch(alice, {
        kind: "COMPETITOR_SNAPSHOT",
        campaignId: null,
        projectId: scopeProject,
        host: "rival.example",
        url: "https://rival.example/",
        headline,
        provenance: PROVENANCE,
        fetchedAt: new Date(fetchedAt),
      });
    await save("2026-10-01T00:00:00.000Z", "first", a1);
    await save("2026-10-08T00:00:00.000Z", "second", a1);
    await save("2026-10-09T00:00:00.000Z", "personal", null);

    expect((await repo().latestResearchForUrl(alice, project(a1), "COMPETITOR_SNAPSHOT", "https://rival.example/"))!.headline).toBe("second");
    expect((await repo().latestResearchForUrl(alice, PERSONAL, "COMPETITOR_SNAPSHOT", "https://rival.example/"))!.headline).toBe("personal");
    expect(await repo().latestResearchForUrl(bob, ALL, "COMPETITOR_SNAPSHOT", "https://rival.example/")).toBeNull();
    expect(await repo().latestResearchForUrl(alice, project(a1), "SEO_AUDIT", "https://rival.example/")).toBeNull();
  });

  it("stores how the page was fetched, and never the page", async () => {
    const [summary] = await repo().listResearch(alice, project(a1));
    const full = await repo().findResearch(alice, project(a1), summary!.id);
    expect(full!.provenance).toEqual(PROVENANCE);
    expect(JSON.stringify(full)).not.toContain("<html");
    expect(Object.keys(summary!)).not.toContain("provenance");
  });
});

describe.skipIf(!dbUp)("Phase 15 — a rate-limit slot is reserved atomically (PostgreSQL)", () => {
  const audit = () => new PrismaAuditRepository(prisma!);
  const WINDOW = 10 * 60 * 1000;
  const rows = (userId: string, action: string) => prisma!.auditLog.count({ where: { userId, action } });

  it("sixty reservations asked for at the same moment: exactly the limit is granted, and exactly that many rows exist", async () => {
    const user = await newUser("slot-burst");
    const action = "marketing.limit.research";
    const results = await Promise.all(Array.from({ length: 60 }, () => audit().reserveSlot({ userId: user, action, limit: 20, windowMs: WINDOW })));
    expect(results.filter((result) => result.reserved)).toHaveLength(20);
    expect(results.filter((result) => !result.reserved)).toHaveLength(40);
    expect(await rows(user, action)).toBe(20);
    // Every refusal saw a full window; none was let through "just this once".
    for (const refused of results.filter((result) => !result.reserved)) expect(refused.count).toBe(20);
  });

  it("holds across separate repository instances, as it must across API processes", async () => {
    const user = await newUser("slot-instances");
    const action = "marketing.limit.report";
    const instances = Array.from({ length: 6 }, () => audit());
    const results = await Promise.all(Array.from({ length: 48 }, (_, index) => instances[index % instances.length]!.reserveSlot({ userId: user, action, limit: 10, windowMs: WINDOW })));
    expect(results.filter((result) => result.reserved)).toHaveLength(10);
    expect(await rows(user, action)).toBe(10);
  });

  it("repeated requests: the limit, then refusals that write nothing", async () => {
    const user = await newUser("slot-repeat");
    const action = "marketing.limit.publish_check";
    for (let index = 0; index < 5; index += 1) {
      expect(await audit().reserveSlot({ userId: user, action, limit: 5, windowMs: WINDOW })).toEqual({ reserved: true, count: index + 1 });
    }
    for (let index = 0; index < 3; index += 1) {
      expect(await audit().reserveSlot({ userId: user, action, limit: 5, windowMs: WINDOW })).toEqual({ reserved: false, count: 5 });
    }
    expect(await rows(user, action)).toBe(5);
  });

  it("one user's slots are not another's, and one action's are not another's", async () => {
    const first = await newUser("slot-a");
    const second = await newUser("slot-b");
    for (let index = 0; index < 3; index += 1) await audit().reserveSlot({ userId: first, action: "marketing.limit.research", limit: 3, windowMs: WINDOW });
    expect((await audit().reserveSlot({ userId: first, action: "marketing.limit.research", limit: 3, windowMs: WINDOW })).reserved).toBe(false);
    expect((await audit().reserveSlot({ userId: second, action: "marketing.limit.research", limit: 3, windowMs: WINDOW })).reserved).toBe(true);
    expect((await audit().reserveSlot({ userId: first, action: "marketing.limit.report", limit: 3, windowMs: WINDOW })).reserved).toBe(true);
  });

  it("counts the reservation action EXACTLY: rows that only share its beginning never use a slot", async () => {
    const user = await newUser("slot-exact");
    for (const action of ["marketing.limit.research.outcome", "marketing.limit.researched", "marketing.research.fetch", "marketing.research.throttled"]) {
      await audit().create({ userId: user, action, result: "success" });
    }
    expect(await audit().reserveSlot({ userId: user, action: "marketing.limit.research", limit: 1, windowMs: WINDOW })).toEqual({ reserved: true, count: 1 });
    expect((await audit().reserveSlot({ userId: user, action: "marketing.limit.research", limit: 1, windowMs: WINDOW })).reserved).toBe(false);
  });

  it("a slot is free again once it has left the window", async () => {
    const user = await newUser("slot-window");
    const action = "marketing.limit.research";
    const start = new Date("2026-10-12T10:00:00.000Z");
    expect((await audit().reserveSlot({ userId: user, action, limit: 1, windowMs: WINDOW, now: start })).reserved).toBe(true);
    expect((await audit().reserveSlot({ userId: user, action, limit: 1, windowMs: WINDOW, now: new Date(start.getTime() + WINDOW - 1000) })).reserved).toBe(false);
    expect((await audit().reserveSlot({ userId: user, action, limit: 1, windowMs: WINDOW, now: new Date(start.getTime() + WINDOW + 1000) })).reserved).toBe(true);
  });

  it("the reservation row is a pending audit row carrying the trace, and nothing else", async () => {
    const user = await newUser("slot-row");
    await audit().reserveSlot({ userId: user, action: "marketing.limit.research", limit: 5, windowMs: WINDOW, traceId: "trace-slot" });
    const [row] = await prisma!.auditLog.findMany({ where: { userId: user } });
    expect(row).toMatchObject({ action: "marketing.limit.research", result: "PENDING", traceId: "trace-slot", toolId: null, agentId: null, parameters: null, metadata: null });
  });
});

// ---------------------------------------------------------------------------
// The final safety pass — the second audit's L1, L2 and L6, where the
// database is what has to hold them.
// ---------------------------------------------------------------------------

/**
 * Make the audit log refuse one user's rows for one action, in the database
 * itself, until the returned function is called.
 *
 * A trigger, so the refusal happens where a real one would: inside the
 * transaction that is writing the row. It is scoped to a single test user and
 * a single action, so nothing else running against this database is touched.
 */
async function refuseAuditRows(userId: string, action: string): Promise<() => Promise<void>> {
  if (!/^[A-Za-z0-9_-]+$/.test(userId) || !/^[a-z_.]+$/.test(action)) throw new Error("not a plain id or action");
  const name = `p15_refuse_audit_${userId.replace(/[^A-Za-z0-9]/g, "").toLowerCase()}`;
  await prisma!.$executeRawUnsafe(
    `CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN IF NEW."userId" = '${userId}' AND NEW."action" = '${action}' THEN RAISE EXCEPTION 'p15 test: the audit log refused this row'; END IF; RETURN NEW; END $fn$`
  );
  await prisma!.$executeRawUnsafe(`CREATE TRIGGER ${name} BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  return async () => {
    await prisma!.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON "AuditLog"`);
    await prisma!.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`);
  };
}

describe.skipIf(!dbUp)("Phase 15 — a claim is taken only from the state the approval was made for (PostgreSQL)", () => {
  let alice: string;
  const expected = { channel: "FACEBOOK", body: "Approved text", link: null } as const;
  const starting = {
    state: "UNCONFIRMED",
    at: "2026-10-13T09:59:59.000Z",
    code: "SENDING",
    targetId: "111",
    targetName: "Shop Page",
    externalId: null,
    textHash: "hash-of-approved-text",
    lastLookup: null,
  } as const;
  const SEND = { from: "NONE", attempt: starting } as const;
  const LOOK = { from: "UNCONFIRMED" } as const;
  const unconfirmedRecord = { ...starting, at: "2026-10-13T10:00:00.000Z", code: "AMBIGUOUS_OUTCOME" } as const;
  const clearedRecord = { ...unconfirmedRecord, state: "FAILED", code: "CLEARED_BY_USER", lastLookup: { at: "2026-10-13T10:05:00.000Z", result: "NOT_FOUND" } } as const;

  const ready = async (): Promise<string> => {
    const [created] = await repo().createContent(alice, { campaignId: null, projectId: null }, [{ title: "Post", channel: "FACEBOOK", body: "Approved text", status: "READY" }], "user");
    return created!.id;
  };
  /** An item whose publish went out and never reported back. */
  const unconfirmed = async (): Promise<string> => {
    const id = await ready();
    await repo().claimForPublish(alice, id, expected, SEND);
    await repo().releasePublish(alice, id, "UNCONFIRMED", unconfirmedRecord);
    return id;
  };
  /** The same item after a person settled it as not published. */
  const cleared = async (): Promise<string> => {
    const id = await unconfirmed();
    await repo().claimUnconfirmed(alice, id);
    await repo().releasePublish(alice, id, "NONE", clearedRecord);
    return id;
  };
  const rowOf = (id: string) => prisma!.contentItem.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    alice = await newUser("state-alice");
  });

  it("a claim to LOOK never takes an item with no publish outstanding", async () => {
    const id = await ready();

    expect(await repo().claimForPublish(alice, id, expected, LOOK)).toBeNull();

    const row = await rowOf(id);
    expect(row.publishState).toBe("NONE");
    expect(row.publishClaimedAt).toBeNull();
    expect(row.publishAttempt).toBeNull();
  });

  it("a claim to LOOK does not take an item whose attempt was CLEARED after the look was approved — it cannot become a send", async () => {
    const id = await cleared();

    expect(await repo().claimForPublish(alice, id, expected, LOOK)).toBeNull();

    // Nothing was taken and nothing was written: the item is exactly as the
    // person who cleared it left it.
    const row = await rowOf(id);
    expect(row.publishState).toBe("NONE");
    expect(row.publishClaimedAt).toBeNull();
    expect(row.publishAttempt).toEqual(clearedRecord);
  });

  it("a claim to SEND never takes an item whose earlier publish is unconfirmed", async () => {
    const id = await unconfirmed();

    expect(await repo().claimForPublish(alice, id, expected, SEND)).toBeNull();

    const row = await rowOf(id);
    expect(row.publishState).toBe("UNCONFIRMED");
    expect(row.publishAttempt).toEqual(unconfirmedRecord);
  });

  it("a claim to LOOK takes an unconfirmed item and leaves the record of its attempt exactly as it is", async () => {
    const id = await unconfirmed();

    expect(await repo().claimForPublish(alice, id, expected, LOOK)).toBe("UNCONFIRMED");

    const row = await rowOf(id);
    expect(row.publishState).toBe("PUBLISHING");
    expect(row.publishAttempt).toEqual(unconfirmedRecord);
  });

  it("a claim to LOOK is refused when the saved copy is no longer the approved copy", async () => {
    const id = await unconfirmed();
    await prisma!.contentItem.update({ where: { id }, data: { body: "Words nobody approved" } });

    expect(await repo().claimForPublish(alice, id, expected, LOOK)).toBeNull();
    expect((await rowOf(id)).publishState).toBe("UNCONFIRMED");
  });

  it("a claim to LOOK is refused for another user", async () => {
    const id = await unconfirmed();
    const mallory = await newUser("state-mallory");

    expect(await repo().claimForPublish(mallory, id, expected, LOOK)).toBeNull();
    expect((await rowOf(id)).publishState).toBe("UNCONFIRMED");
  });

  it("ten claims to look and ten claims to send race for a CLEARED item: no look takes it, and exactly one send does", async () => {
    const id = await cleared();

    const results = await Promise.all([
      ...Array.from({ length: 10 }, () => repo().claimForPublish(alice, id, expected, LOOK)),
      ...Array.from({ length: 10 }, () => repo().claimForPublish(alice, id, expected, SEND)),
    ]);

    expect(results.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => null));
    expect(results.slice(10).filter(Boolean)).toEqual(["FRESH"]);
  });

  it("the clearing and a claim to look, at the same moment: the look never comes out holding a claim that may send", async () => {
    for (let round = 0; round < 8; round += 1) {
      const id = await unconfirmed();

      const [settled, look] = await Promise.all([
        (async () => {
          if (!(await repo().claimUnconfirmed(alice, id))) return false;
          await repo().releasePublish(alice, id, "NONE", clearedRecord);
          return true;
        })(),
        repo().claimForPublish(alice, id, expected, LOOK),
      ]);

      // One of the two took the unconfirmed item. Whichever it was, the look
      // is "UNCONFIRMED" or nothing — never "FRESH".
      expect([settled, look === "UNCONFIRMED"].filter(Boolean), `round ${round}`).toHaveLength(1);
      expect(look, `round ${round}`).not.toBe("FRESH");
      if (settled) {
        // Cleared first: a look that arrives afterwards still takes nothing.
        expect(await repo().claimForPublish(alice, id, expected, LOOK), `round ${round}`).toBeNull();
        expect((await rowOf(id)).publishState, `round ${round}`).toBe("NONE");
      }
    }
  });
});

describe.skipIf(!dbUp)("Phase 15 — one post is one item's post (PostgreSQL)", () => {
  let alice: string;
  let bob: string;
  let n = 0;
  const expected = { channel: "FACEBOOK", body: "The same words", link: null } as const;
  const starting = { state: "UNCONFIRMED", at: "2026-10-13T09:59:59.000Z", code: "SENDING", targetId: "111", targetName: "Shop Page", externalId: null, textHash: "hash", lastLookup: null } as const;

  /** A provider post id nothing else in this database has. */
  const postId = () => `111_${STAMP}${(n += 1)}`;
  const publication = (externalId: string, provider = "meta-graph") => ({
    provider,
    targetName: "Shop Page",
    externalId,
    url: `https://www.facebook.com/111/posts/${externalId.split("_")[1]}`,
    publishedAt: new Date("2026-10-13T10:00:00.000Z"),
    verifiedAt: new Date("2026-10-13T10:00:02.000Z"),
  });
  /** An item with the same words as every other one here, taken by a claim that may send. */
  const claimed = async (owner: string): Promise<string> => {
    const [created] = await repo().createContent(owner, { campaignId: null, projectId: null }, [{ title: "Twin", channel: "FACEBOOK", body: "The same words", status: "READY" }], "user");
    expect(await repo().claimForPublish(owner, created!.id, expected, { from: "NONE", attempt: starting })).toBe("FRESH");
    return created!.id;
  };
  const rowOf = (id: string) => prisma!.contentItem.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    alice = await newUser("post-alice");
    bob = await newUser("post-bob");
  });

  it("a second item with identical text cannot be recorded with the post the first one holds", async () => {
    const post = postId();
    const first = await claimed(alice);
    const second = await claimed(alice);
    expect((await repo().finalizePublished(alice, first, publication(post)))!.publication).toMatchObject({ mode: "VERIFIED", externalId: post });

    await expect(repo().finalizePublished(alice, second, publication(post))).rejects.toMatchObject({ code: "POST_RECORDED_ELSEWHERE" });

    // Nothing was written for the second item: not published, no post id, and
    // its claim is still held for whoever asked to decide what happens next.
    const row = await rowOf(second);
    expect(row).toMatchObject({ status: "READY", publicationMode: null, externalId: null, verifiedAt: null, publishState: "PUBLISHING" });
    expect(await prisma!.contentItem.count({ where: { externalId: post } })).toBe(1);
  });

  it("holds whoever the other item belongs to — and says nothing about it", async () => {
    const post = postId();
    const bobs = await claimed(bob);
    const alices = await claimed(alice);
    await repo().finalizePublished(bob, bobs, publication(post));

    const refusal = await repo()
      .finalizePublished(alice, alices, publication(post))
      .then(
        () => null,
        (error: unknown) => error as Error
      );

    expect(refusal).toMatchObject({ name: "PostRecordedElsewhereError", code: "POST_RECORDED_ELSEWHERE" });
    expect(refusal!.message).not.toContain(bobs);
    expect(refusal!.message).not.toContain(bob);
    expect((await rowOf(alices)).publicationMode).toBeNull();
    // Bob's record is untouched.
    expect(await rowOf(bobs)).toMatchObject({ status: "PUBLISHED", publicationMode: "VERIFIED", externalId: post });
  });

  it("answers whether a post is another item's with a yes or a no", async () => {
    const post = postId();
    const holder = await claimed(bob);
    const other = await claimed(alice);
    await repo().finalizePublished(bob, holder, publication(post));

    expect(await repo().isPostRecordedElsewhere("meta-graph", post, other)).toBe(true);
    // The item that holds it is not "elsewhere" to itself.
    expect(await repo().isPostRecordedElsewhere("meta-graph", post, holder)).toBe(false);
    expect(await repo().isPostRecordedElsewhere("meta-graph", postId(), other)).toBe(false);
    // The same id from another provider names another post.
    expect(await repo().isPostRecordedElsewhere("some-other-provider", post, other)).toBe(false);
  });

  it("the same id from a different provider is a different post, and is recorded", async () => {
    const post = postId();
    const first = await claimed(alice);
    const second = await claimed(alice);
    await repo().finalizePublished(alice, first, publication(post, "meta-graph"));

    const recorded = await repo().finalizePublished(alice, second, publication(post, "some-other-provider"));

    expect(recorded!.publication).toMatchObject({ mode: "VERIFIED", externalId: post, provider: "some-other-provider" });
  });

  it("an item reported as published by its owner holds no post, so it takes none away from another item", async () => {
    const post = postId();
    const [reported] = await repo().createContent(alice, { campaignId: null, projectId: null }, [{ title: "Twin", channel: "FACEBOOK", body: "The same words", status: "READY" }], "user");
    await repo().markPublishedByUser(alice, ALL, reported!.id, { publishedAt: new Date(), url: null });
    const item = await claimed(alice);

    expect((await repo().finalizePublished(alice, item, publication(post)))!.publication!.externalId).toBe(post);
  });

  it("two items that found the same post at the same moment: exactly one records it", async () => {
    for (let round = 0; round < 6; round += 1) {
      const post = postId();
      const items = await Promise.all([claimed(alice), claimed(alice), claimed(bob)]);
      const owners = [alice, alice, bob];

      const results = await Promise.allSettled(items.map((id, index) => repo().finalizePublished(owners[index]!, id, publication(post))));

      const recorded = results.filter((result) => result.status === "fulfilled" && result.value !== null);
      const refused = results.filter((result) => result.status === "rejected" && (result.reason as { code?: string }).code === "POST_RECORDED_ELSEWHERE");
      expect(recorded, `round ${round}`).toHaveLength(1);
      expect(refused, `round ${round}`).toHaveLength(2);
      expect(await prisma!.contentItem.count({ where: { externalId: post, publicationMode: "VERIFIED" } }), `round ${round}`).toBe(1);
    }
  });
});

describe.skipIf(!dbUp)("Phase 15 — a person's decision and its audit row are one transaction (PostgreSQL)", () => {
  let alice: string;
  let n = 0;
  const ACTION = "marketing.publish.resolve";
  const expected = { channel: "FACEBOOK", body: "Approved text", link: null } as const;
  const original = { state: "UNCONFIRMED", at: "2026-10-13T10:00:00.000Z", code: "AMBIGUOUS_OUTCOME", targetId: "111", targetName: "Shop Page", externalId: null, textHash: "hash", lastLookup: null } as const;
  const clearedRecord = { ...original, state: "FAILED", code: "CLEARED_BY_USER", lastLookup: { at: "2026-10-13T10:05:00.000Z", result: "NOT_FOUND" } } as const;

  /** An unconfirmed item, taken by the claim a settle takes. */
  const held = async (owner = alice): Promise<string> => {
    const [created] = await repo().createContent(owner, { campaignId: null, projectId: null }, [{ title: "Post", channel: "FACEBOOK", body: "Approved text", status: "READY" }], "user");
    const id = created!.id;
    await repo().claimForPublish(owner, id, expected, { from: "NONE", attempt: { ...original, code: "SENDING" } });
    await repo().releasePublish(owner, id, "UNCONFIRMED", original);
    expect(await repo().claimUnconfirmed(owner, id)).toBe(true);
    return id;
  };
  const record = (contentId: string, outcome: string) => ({ action: ACTION, parameters: { contentId, decision: "NOT_PUBLISHED", outcome, targetId: "111" }, traceId: "trace-settle" });
  const rowOf = (id: string) => prisma!.contentItem.findUniqueOrThrow({ where: { id } });
  const auditOf = (userId: string, contentId: string) =>
    prisma!.auditLog.findMany({ where: { userId, action: ACTION, parameters: { path: ["contentId"], equals: contentId } } });

  beforeAll(async () => {
    alice = await newUser("decision-alice");
  });

  it("clears the attempt and writes the audit row that says so", async () => {
    const id = await held();

    const cleared = await repo().clearUnconfirmed(alice, id, clearedRecord, record(id, "CLEARED"));

    expect(cleared).toMatchObject({ status: "READY", publication: null, publishUnconfirmed: false });
    expect(cleared!.publishAttempt).toMatchObject({ state: "FAILED", code: "CLEARED_BY_USER", lastLookup: { result: "NOT_FOUND" } });
    expect((await rowOf(id)).publishState).toBe("NONE");
    const rows = await auditOf(alice, id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: alice, action: ACTION, result: "SUCCESS", traceId: "trace-settle" });
    expect(rows[0]!.parameters).toEqual({ contentId: id, decision: "NOT_PUBLISHED", outcome: "CLEARED", targetId: "111" });
  });

  it("when the audit row cannot be written, NOTHING is cleared", async () => {
    const id = await held();
    const stop = await refuseAuditRows(alice, ACTION);
    try {
      await expect(repo().clearUnconfirmed(alice, id, clearedRecord, record(id, "CLEARED"))).rejects.toThrow();
    } finally {
      await stop();
    }

    // The transaction that would have cleared it never happened: the item is
    // still held, and the record of the ORIGINAL attempt is untouched.
    const row = await rowOf(id);
    expect(row.publishState).toBe("PUBLISHING");
    expect(row.publishAttempt).toEqual(original);
    expect(await auditOf(alice, id)).toHaveLength(0);
    // Given back, it is unconfirmed as it was — never free to be sent again.
    expect(await repo().releasePublish(alice, id, "UNCONFIRMED", original)).toMatchObject({ publishUnconfirmed: true });
    expect(await repo().claimForPublish(alice, id, expected, { from: "NONE", attempt: { ...original, code: "SENDING" } })).toBeNull();
  });

  it("the refusal is the database's, and once it is lifted the same decision goes through", async () => {
    const id = await held();
    const stop = await refuseAuditRows(alice, ACTION);
    try {
      await expect(repo().clearUnconfirmed(alice, id, clearedRecord, record(id, "CLEARED"))).rejects.toThrow(/refused this row/);
    } finally {
      await stop();
    }

    expect(await repo().clearUnconfirmed(alice, id, clearedRecord, record(id, "CLEARED"))).toMatchObject({ publishUnconfirmed: false });
    expect(await auditOf(alice, id)).toHaveLength(1);
  });

  it("when the item is not held by a claim, nothing is cleared and NO audit row is written", async () => {
    const id = await held();
    await repo().releasePublish(alice, id, "UNCONFIRMED", original);

    expect(await repo().clearUnconfirmed(alice, id, clearedRecord, record(id, "CLEARED"))).toBeNull();

    expect((await rowOf(id)).publishState).toBe("UNCONFIRMED");
    expect((await rowOf(id)).publishAttempt).toEqual(original);
    expect(await auditOf(alice, id)).toHaveLength(0);
  });

  it("another user can neither clear the item nor leave an audit row about it", async () => {
    const id = await held();
    const mallory = await newUser("decision-mallory");

    expect(await repo().clearUnconfirmed(mallory, id, clearedRecord, record(id, "CLEARED"))).toBeNull();

    expect((await rowOf(id)).publishState).toBe("PUBLISHING");
    expect(await auditOf(mallory, id)).toHaveLength(0);
    expect(await auditOf(alice, id)).toHaveLength(0);
  });

  it("an item already recorded as published is not cleared", async () => {
    const id = await held();
    await repo().finalizePublished(alice, id, {
      provider: "meta-graph",
      targetName: "Shop Page",
      externalId: `111_${STAMP}9${(n += 1)}`,
      url: null,
      publishedAt: new Date(),
      verifiedAt: new Date(),
    });

    expect(await repo().clearUnconfirmed(alice, id, clearedRecord, record(id, "CLEARED"))).toBeNull();
    expect(await rowOf(id)).toMatchObject({ status: "PUBLISHED", publicationMode: "VERIFIED" });
    expect(await auditOf(alice, id)).toHaveLength(0);
  });

  it("the audit row is stored without a secret-shaped value, as every audit row is", async () => {
    const id = await held();
    const secret = `EAAB${"x".repeat(60)}`;

    await repo().clearUnconfirmed(alice, id, clearedRecord, { action: ACTION, parameters: { contentId: id, decision: "NOT_PUBLISHED", outcome: "CLEARED", note: secret } });

    const [row] = await auditOf(alice, id);
    expect(JSON.stringify(row!.parameters)).not.toContain(secret);
    expect(row!.parameters).toMatchObject({ contentId: id, outcome: "CLEARED", note: "[REDACTED]" });
  });

  it("recording a found post writes the item and its audit row together", async () => {
    const id = await held();
    const post = `111_${STAMP}9${(n += 1)}`;

    const published = await repo().finalizePublished(
      alice,
      id,
      { provider: "meta-graph", targetName: "Shop Page", externalId: post, url: null, publishedAt: new Date("2026-10-13T10:00:00.000Z"), verifiedAt: new Date("2026-10-13T10:06:00.000Z") },
      { action: ACTION, parameters: { contentId: id, decision: "NOT_PUBLISHED", outcome: "FOUND_PUBLISHED", externalId: post }, traceId: "trace-settle" }
    );

    expect(published!.publication).toMatchObject({ mode: "VERIFIED", externalId: post });
    const rows = await auditOf(alice, id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.parameters).toEqual({ contentId: id, decision: "NOT_PUBLISHED", outcome: "FOUND_PUBLISHED", externalId: post });
  });

  it("and when that audit row cannot be written, the item is NOT recorded as published", async () => {
    const id = await held();
    const post = `111_${STAMP}9${(n += 1)}`;
    const stop = await refuseAuditRows(alice, ACTION);
    try {
      await expect(
        repo().finalizePublished(
          alice,
          id,
          { provider: "meta-graph", targetName: "Shop Page", externalId: post, url: null, publishedAt: new Date(), verifiedAt: new Date() },
          { action: ACTION, parameters: { contentId: id, decision: "NOT_PUBLISHED", outcome: "FOUND_PUBLISHED", externalId: post } }
        )
      ).rejects.toThrow();
    } finally {
      await stop();
    }

    expect(await rowOf(id)).toMatchObject({ status: "READY", publicationMode: null, externalId: null, publishState: "PUBLISHING" });
    expect((await rowOf(id)).publishAttempt).toEqual(original);
    expect(await prisma!.contentItem.count({ where: { externalId: post } })).toBe(0);
    expect(await auditOf(alice, id)).toHaveLength(0);
  });

  it("a publish that is recorded without a decision writes no audit row of its own, as before", async () => {
    const id = await held();

    await repo().finalizePublished(alice, id, { provider: "meta-graph", targetName: "Shop Page", externalId: `111_${STAMP}9${(n += 1)}`, url: null, publishedAt: new Date(), verifiedAt: new Date() });

    expect(await auditOf(alice, id)).toHaveLength(0);
  });
});
