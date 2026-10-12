// Phase 15 — the marketing vocabulary, the input schemas, the content
// lifecycle and the calendar. Pure contracts: no I/O, no clock.
import { describe, it, expect } from "vitest";
import {
  ALL_MARKETING_TOOL_IDS,
  CampaignCreateSchema,
  CampaignUpdateSchema,
  CONTENT_PUBLISH_CLAIM_TTL_MS,
  ContentDraftSchema,
  ContentPlanSchema,
  ContentUpdateSchema,
  MARKETING_LIMITS,
  MARKETING_PUBLISH_TOOL_IDS,
  MARKETING_READ_TOOL_IDS,
  MARKETING_RESEARCH_TOOL_IDS,
  MARKETING_TOOL_IDS,
  MARKETING_WORKSPACE_TOOL_IDS,
  SETTABLE_CONTENT_STATUSES,
  describeMarketingIssues,
  inclusiveDays,
  isCalendarDate,
  isWallClockTime,
  normalizeChannel,
  normalizeCopy,
  normalizeFormat,
  normalizeLink,
  shiftCalendarDate,
  type ContentItemView,
} from "../src/types/marketing.js";
import {
  buildContentCalendar,
  canSetContentStatus,
  channelLabel,
  countByStatus,
  effectivePublishState,
  isEditableContent,
  publishBlockers,
  statusAfterEdit,
} from "../src/marketing-content.js";

function item(overrides: Partial<ContentItemView> = {}): ContentItemView {
  return {
    id: "c1",
    campaignId: null,
    projectId: null,
    title: "Diwali offer",
    channel: "FACEBOOK",
    format: "POST",
    body: "Festive offer is live.",
    link: null,
    notes: null,
    status: "READY",
    scheduledDate: "2026-10-20",
    scheduledTime: null,
    publication: null,
    publishAttempt: null,
    publishUnconfirmed: false,
    createdBy: "user",
    createdAt: "2026-10-12T00:00:00.000Z",
    updatedAt: "2026-10-12T00:00:00.000Z",
    ...overrides,
  };
}

describe("tool ids", () => {
  it("every id is in exactly one group, and the groups cover them all", () => {
    const grouped = [
      ...MARKETING_READ_TOOL_IDS,
      ...MARKETING_WORKSPACE_TOOL_IDS,
      ...MARKETING_RESEARCH_TOOL_IDS,
      ...MARKETING_PUBLISH_TOOL_IDS,
    ];
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual(Object.values(MARKETING_TOOL_IDS).sort());
    expect([...ALL_MARKETING_TOOL_IDS].sort()).toEqual(Object.values(MARKETING_TOOL_IDS).sort());
  });

  it("every id is in the marketing namespace and survives name sanitisation uniquely", () => {
    const sanitized = ALL_MARKETING_TOOL_IDS.map((id) => id.replace(/[^a-zA-Z0-9_-]/g, "-"));
    for (const id of ALL_MARKETING_TOOL_IDS) expect(id.startsWith("marketing.")).toBe(true);
    for (const name of sanitized) expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(new Set(sanitized).size).toBe(sanitized.length);
  });

  it("publishing is never in the read or workspace groups", () => {
    expect(MARKETING_READ_TOOL_IDS).not.toContain(MARKETING_TOOL_IDS.contentPublish);
    expect(MARKETING_WORKSPACE_TOOL_IDS).not.toContain(MARKETING_TOOL_IDS.contentPublish);
  });

  it("PUBLISHED is not a status anyone may set", () => {
    expect(SETTABLE_CONTENT_STATUSES as readonly string[]).not.toContain("PUBLISHED");
  });
});

describe("dates and times", () => {
  it.each(["2026-10-12", "2028-02-29"])("accepts the real date %s", (date) => {
    expect(isCalendarDate(date)).toBe(true);
  });

  it.each(["2026-02-30", "2026-13-01", "2026-1-5", "12-10-2026", "2026-10-12T00:00:00Z", "", null, 20261012])(
    "refuses %s as a date instead of rolling it over",
    (date) => {
      expect(isCalendarDate(date)).toBe(false);
    }
  );

  it.each(["00:00", "09:30", "23:59"])("accepts the time %s", (time) => {
    expect(isWallClockTime(time)).toBe(true);
  });

  it.each(["24:00", "9:30", "09:60", "6pm", ""])("refuses %s as a time", (time) => {
    expect(isWallClockTime(time)).toBe(false);
  });

  it("counts days inclusively and shifts across month and year ends", () => {
    expect(inclusiveDays("2026-10-01", "2026-10-01")).toBe(1);
    expect(inclusiveDays("2026-10-01", "2026-10-31")).toBe(31);
    expect(shiftCalendarDate("2026-10-31", 1)).toBe("2026-11-01");
    expect(shiftCalendarDate("2026-01-01", -1)).toBe("2025-12-31");
  });
});

describe("normalisation", () => {
  it.each<[string, string]>([
    ["instagram", "INSTAGRAM"],
    ["  Facebook ", "FACEBOOK"],
    ["fb", "FACEBOOK"],
    ["IG", "INSTAGRAM"],
    ["Twitter", "X"],
    ["linked-in", "LINKEDIN"],
    ["newsletter", "EMAIL"],
  ])("reads the channel %s as %s", (input, expected) => {
    expect(normalizeChannel(input)).toBe(expected);
  });

  it("returns null for a channel it does not know, rather than filing it under OTHER", () => {
    expect(normalizeChannel("tiktok")).toBeNull();
    expect(normalizeChannel("")).toBeNull();
    expect(normalizeChannel(42)).toBeNull();
  });

  it("reads common format words", () => {
    expect(normalizeFormat("reels")).toBe("REEL");
    expect(normalizeFormat("Carousel")).toBe("CAROUSEL");
    expect(normalizeFormat("hologram")).toBeNull();
  });

  it("makes line endings one kind and trims the ends, and nothing else", () => {
    expect(normalizeCopy("  Line one\r\nLine  two\r\n ")).toBe("Line one\nLine  two");
  });

  it("accepts an http(s) link and refuses anything else", () => {
    expect(normalizeLink("https://example.com/offer?x=1")).toBe("https://example.com/offer?x=1");
    expect(normalizeLink("javascript:alert(1)")).toBeNull();
    expect(normalizeLink("ftp://example.com/file")).toBeNull();
    expect(normalizeLink("not a link")).toBeNull();
  });

  it("refuses a link that carries credentials", () => {
    expect(normalizeLink("https://user:secret@example.com/")).toBeNull();
  });
});

describe("campaign schemas", () => {
  it("accepts a minimal campaign and normalises its channels", () => {
    const parsed = CampaignCreateSchema.parse({ name: "  Diwali Sale  ", channels: ["instagram", "fb"] });
    expect(parsed.name).toBe("Diwali Sale");
    expect(parsed.channels).toEqual(["INSTAGRAM", "FACEBOOK"]);
  });

  it("treats empty strings and nulls from a model as not given", () => {
    const parsed = CampaignCreateSchema.parse({ name: "A", objective: "", brief: null, startDate: "" });
    expect(parsed.objective).toBeUndefined();
    expect(parsed.brief).toBeUndefined();
    expect(parsed.startDate).toBeUndefined();
  });

  it("refuses a start date after the end date", () => {
    const result = CampaignCreateSchema.safeParse({ name: "A", startDate: "2026-11-10", endDate: "2026-11-01" });
    expect(result.success).toBe(false);
  });

  it("refuses an unknown key, so a model cannot smuggle an owner or a project in", () => {
    expect(CampaignCreateSchema.safeParse({ name: "A", userId: "someone-else" }).success).toBe(false);
    expect(CampaignCreateSchema.safeParse({ name: "A", projectId: "p1" }).success).toBe(false);
    expect(CampaignUpdateSchema.safeParse({ name: "B", projectId: "p2" }).success).toBe(false);
  });

  it("refuses a Meta campaign id that is not digits", () => {
    expect(CampaignCreateSchema.safeParse({ name: "A", metaCampaignIds: ["120210000000001"] }).success).toBe(true);
    expect(CampaignCreateSchema.safeParse({ name: "A", metaCampaignIds: ["act_123; DROP"] }).success).toBe(false);
  });

  it("refuses an over-long name", () => {
    const name = "x".repeat(MARKETING_LIMITS.campaignNameMax + 1);
    expect(CampaignCreateSchema.safeParse({ name }).success).toBe(false);
  });

  it("an update with nothing in it is refused", () => {
    expect(CampaignUpdateSchema.safeParse({}).success).toBe(false);
  });

  it("an update can clear a field with null or an empty string", () => {
    expect(CampaignUpdateSchema.parse({ objective: "" }).objective).toBeNull();
    expect(CampaignUpdateSchema.parse({ endDate: null }).endDate).toBeNull();
  });
});

describe("content schemas", () => {
  it("accepts a draft and normalises channel, format and status", () => {
    const parsed = ContentDraftSchema.parse({
      title: "Offer post",
      channel: "insta",
      format: "reels",
      body: "Hello",
      scheduledDate: "2026-10-20",
      scheduledTime: "18:00",
      status: "ready",
    });
    expect(parsed).toMatchObject({ channel: "INSTAGRAM", format: "REEL", status: "READY" });
  });

  it("refuses PUBLISHED as a status on a draft or an update", () => {
    expect(ContentDraftSchema.safeParse({ title: "A", channel: "FACEBOOK", body: "x", status: "PUBLISHED" }).success).toBe(false);
    expect(ContentUpdateSchema.safeParse({ status: "published" }).success).toBe(false);
  });

  it("refuses a channel it does not know, naming the field", () => {
    const result = ContentDraftSchema.safeParse({ title: "A", channel: "tiktok", body: "x" });
    expect(result.success).toBe(false);
    if (!result.success) expect(describeMarketingIssues(result.error)).toContain("channel");
  });

  it("refuses a time without a date", () => {
    expect(ContentDraftSchema.safeParse({ title: "A", channel: "X", body: "x", scheduledTime: "09:00" }).success).toBe(false);
  });

  it("refuses an impossible date", () => {
    expect(ContentDraftSchema.safeParse({ title: "A", channel: "X", body: "x", scheduledDate: "2026-02-30" }).success).toBe(false);
  });

  it("refuses a link that is not http(s)", () => {
    expect(ContentDraftSchema.safeParse({ title: "A", channel: "X", body: "x", link: "javascript:alert(1)" }).success).toBe(false);
  });

  it("refuses copy over the limit", () => {
    const body = "x".repeat(MARKETING_LIMITS.contentBodyMax + 1);
    expect(ContentDraftSchema.safeParse({ title: "A", channel: "X", body }).success).toBe(false);
  });

  it("a plan holds between one item and the batch limit", () => {
    const one = { title: "A", channel: "FACEBOOK", body: "x" };
    expect(ContentPlanSchema.safeParse({ items: [] }).success).toBe(false);
    expect(ContentPlanSchema.safeParse({ items: [one] }).success).toBe(true);
    const tooMany = Array.from({ length: MARKETING_LIMITS.planBatchMax + 1 }, () => one);
    expect(ContentPlanSchema.safeParse({ items: tooMany }).success).toBe(false);
  });

  it("an update with nothing in it is refused", () => {
    expect(ContentUpdateSchema.safeParse({}).success).toBe(false);
  });
});

describe("the content lifecycle", () => {
  it("never lets a published item change status", () => {
    for (const to of SETTABLE_CONTENT_STATUSES) {
      expect(canSetContentStatus("PUBLISHED", to, true).ok).toBe(false);
    }
  });

  it("lets a draft become ready only when it has text", () => {
    expect(canSetContentStatus("DRAFT", "READY", true).ok).toBe(true);
    expect(canSetContentStatus("DRAFT", "READY", false).ok).toBe(false);
  });

  it("makes an archived item pass through a draft before it is ready again", () => {
    expect(canSetContentStatus("ARCHIVED", "READY", true).ok).toBe(false);
    expect(canSetContentStatus("ARCHIVED", "DRAFT", true).ok).toBe(true);
  });

  it("a published item is not editable; everything else is", () => {
    expect(isEditableContent("PUBLISHED")).toBe(false);
    for (const status of ["IDEA", "DRAFT", "READY", "ARCHIVED"] as const) {
      expect(isEditableContent(status)).toBe(true);
    }
  });

  it("editing the copy of a ready item returns it to a draft", () => {
    expect(statusAfterEdit("READY", true, undefined)).toBe("DRAFT");
  });

  it("re-dating a ready item, without touching its copy, leaves it ready", () => {
    expect(statusAfterEdit("READY", false, undefined)).toBe("READY");
  });

  it("an edit that itself says READY stays ready", () => {
    expect(statusAfterEdit("READY", true, "READY")).toBe("READY");
  });
});

describe("the publishing claim", () => {
  const now = new Date("2026-10-12T12:00:00.000Z");

  it("a fresh claim is still held", () => {
    const claimedAt = new Date(now.getTime() - 1000);
    expect(effectivePublishState("PUBLISHING", claimedAt, now)).toBe("PUBLISHING");
  });

  it("an abandoned claim is UNCONFIRMED, never free", () => {
    const claimedAt = new Date(now.getTime() - CONTENT_PUBLISH_CLAIM_TTL_MS - 1);
    expect(effectivePublishState("PUBLISHING", claimedAt, now)).toBe("UNCONFIRMED");
    expect(effectivePublishState("PUBLISHING", null, now)).toBe("UNCONFIRMED");
  });

  it("leaves the other states as they are", () => {
    expect(effectivePublishState("NONE", null, now)).toBe("NONE");
    expect(effectivePublishState("UNCONFIRMED", null, now)).toBe("UNCONFIRMED");
  });
});

describe("why an item cannot be published", () => {
  it("a ready Facebook post with text and a publisher has no blockers", () => {
    expect(publishBlockers(item(), "NONE", ["FACEBOOK"])).toEqual([]);
  });

  it("names the missing publisher for a channel there is none for", () => {
    const blockers = publishBlockers(item({ channel: "INSTAGRAM" }), "NONE", ["FACEBOOK"]);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain("Instagram");
    expect(blockers[0]).toContain("mark it as published");
  });

  it("refuses a draft, an empty item, an archived item and a published one", () => {
    expect(publishBlockers(item({ status: "DRAFT" }), "NONE", ["FACEBOOK"]).join(" ")).toContain("marked ready");
    expect(publishBlockers(item({ body: "   " }), "NONE", ["FACEBOOK"]).join(" ")).toContain("no text");
    expect(publishBlockers(item({ status: "ARCHIVED" }), "NONE", ["FACEBOOK"]).join(" ")).toContain("archived");
    expect(publishBlockers(item({ status: "PUBLISHED" }), "NONE", ["FACEBOOK"]).join(" ")).toContain("already published");
  });

  it("refuses while another publish of the item is running", () => {
    expect(publishBlockers(item(), "PUBLISHING", ["FACEBOOK"]).join(" ")).toContain("already running");
  });

  it("with no publisher at all, every channel is blocked", () => {
    expect(publishBlockers(item(), "NONE", [])).not.toEqual([]);
  });
});

describe("the calendar", () => {
  const items = [
    item({ id: "a", title: "Morning", scheduledDate: "2026-10-20", scheduledTime: "09:00" }),
    item({ id: "b", title: "Evening", scheduledDate: "2026-10-20", scheduledTime: "18:00" }),
    item({ id: "c", title: "Anytime", scheduledDate: "2026-10-20", scheduledTime: null }),
    item({ id: "d", title: "Earlier day", scheduledDate: "2026-10-05" }),
    item({ id: "e", title: "No date", scheduledDate: null }),
    item({ id: "f", title: "Outside", scheduledDate: "2026-11-02" }),
  ];

  it("groups by day in date order, timed items first, and keeps undated ones apart", () => {
    const calendar = buildContentCalendar(items, "2026-10-01", "2026-10-31");
    expect(calendar.days.map((d) => d.date)).toEqual(["2026-10-05", "2026-10-20"]);
    expect(calendar.days[1]!.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(calendar.unscheduled.map((i) => i.id)).toEqual(["e"]);
  });

  it("never places an item outside the window on a day inside it", () => {
    const calendar = buildContentCalendar(items, "2026-10-01", "2026-10-31");
    expect(calendar.days.flatMap((d) => d.items).some((i) => i.id === "f")).toBe(false);
  });

  it("returns only days that hold something", () => {
    expect(buildContentCalendar([], "2026-10-01", "2026-10-31").days).toEqual([]);
  });

  it("counts every status, including the ones with nothing in them", () => {
    const counts = countByStatus([item({ status: "DRAFT" }), item({ status: "DRAFT" }), item({ status: "READY" })]);
    expect(counts).toEqual({ IDEA: 0, DRAFT: 2, READY: 1, PUBLISHED: 0, ARCHIVED: 0 });
  });

  it("has a label for every channel", () => {
    expect(channelLabel("X")).toBe("X");
    expect(channelLabel("LINKEDIN")).toBe("LinkedIn");
  });
});
