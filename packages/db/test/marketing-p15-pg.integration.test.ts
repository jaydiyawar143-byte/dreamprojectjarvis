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
    const results = await Promise.all(Array.from({ length: 10 }, () => repo().claimForPublish(alice, id, expected)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await repo().publishStateOf(alice, id))!.state).toBe("PUBLISHING");
  });

  it("refuses the claim when the saved copy is no longer what was approved", async () => {
    const id = await ready({ body: "Edited after approval" });
    expect(await repo().claimForPublish(alice, id, expected)).toBe(false);
    expect((await repo().publishStateOf(alice, id))!.state).toBe("NONE");
  });

  it("refuses the claim when the link differs from the approved one", async () => {
    const id = await ready({ link: "https://example.com/a" });
    expect(await repo().claimForPublish(alice, id, expected)).toBe(false);
    expect(await repo().claimForPublish(alice, id, { ...expected, link: "https://example.com/a" })).toBe(true);
  });

  it("refuses the claim for a draft, for another channel and for another user", async () => {
    const draft = await ready({ status: "DRAFT" });
    expect(await repo().claimForPublish(alice, draft, expected)).toBe(false);

    const id = await ready();
    expect(await repo().claimForPublish(alice, id, { ...expected, channel: "INSTAGRAM" })).toBe(false);
    const mallory = await newUser("claim-mallory");
    expect(await repo().claimForPublish(mallory, id, expected)).toBe(false);
    expect(await repo().claimForPublish(alice, id, expected)).toBe(true);
  });

  it("while a publish is running the item cannot be edited or reported as published", async () => {
    const id = await ready();
    expect(await repo().claimForPublish(alice, id, expected)).toBe(true);
    expect(await repo().updateContent(alice, ALL, id, { body: "swap the text mid-flight" })).toBeNull();
    expect(await repo().markPublishedByUser(alice, ALL, id, { publishedAt: new Date(), url: null })).toBeNull();
    expect((await repo().findContent(alice, ALL, id))!.body).toBe("Approved text");
  });

  it("finalising writes VERIFIED with its evidence and clears the claim, once", async () => {
    const id = await ready();
    await repo().claimForPublish(alice, id, expected);
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
    await repo().claimForPublish(alice, id, expected);
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
    expect(await repo().claimForPublish(alice, id, expected)).toBe(true);
  });

  it("an unknown outcome leaves the item UNCONFIRMED — not published — and claimable for a checked retry", async () => {
    const id = await ready();
    await repo().claimForPublish(alice, id, expected);
    const released = await repo().releasePublish(alice, id, "UNCONFIRMED", {
      state: "UNCONFIRMED",
      at: "2026-10-12T10:00:00.000Z",
      code: "AMBIGUOUS_OUTCOME",
      targetId: "111",
      targetName: "Shop Page",
      externalId: null,
    });
    expect(released).toMatchObject({ status: "READY", publication: null, publishUnconfirmed: true });
    expect(await repo().claimForPublish(alice, id, expected)).toBe(true);
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
    expect(await repoAt(clock).claimForPublish(alice, id, expected)).toBe(true);

    clock.now = new Date(clock.now.getTime() + CONTENT_PUBLISH_CLAIM_TTL_MS - 1000);
    expect(await repoAt(clock).claimForPublish(alice, id, expected)).toBe(false);
    expect((await repoAt(clock).findContent(alice, ALL, id))!.publishUnconfirmed).toBe(false);

    clock.now = new Date(clock.now.getTime() + 2000);
    expect((await repoAt(clock).findContent(alice, ALL, id))!.publishUnconfirmed).toBe(true);
    expect(await repoAt(clock).claimForPublish(alice, id, expected)).toBe(true);
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
