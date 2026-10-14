// Phase 15 — publishing a text post to a Facebook Page.
//
// No network: every test injects the HTTP client. What is pinned here is the
// provider's own safety — the target is checked against Meta's list before
// anything is sent, the Page token never leaves the module, Meta's error text
// never reaches a caller, and a write that may have happened is said to be
// ambiguous rather than failed.
//
// NOT covered, and not claimed: a real post to a real Page. See
// docs/phases/phase-15.md, "What was verified and how".
import { describe, it, expect } from "vitest";
import { PublisherError } from "@jarvis/tools";
import { MetaRequestAbortedError, type MetaHttpClient, type MetaHttpRequest, type MetaHttpResponse } from "../src/client.js";
import { META_PAGE_PUBLISHER_ID, createMetaPagePublisher } from "../src/page-publisher.js";
import { isPagePublishingEnabled } from "../src/config.js";

const USER_TOKEN = "EAAuserTokenNeverShown";
const PAGE_TOKEN = "EAApageTokenNeverShown";
const PAGE_ID = "1234567890";
const POST_ID = `${PAGE_ID}_5550001`;

const PAGES = {
  data: [
    { id: PAGE_ID, name: "Shop Page", tasks: ["ADVERTISE", "CREATE_CONTENT", "MANAGE"], access_token: PAGE_TOKEN },
    { id: "2222222222", name: "Read-only Page", tasks: ["ANALYZE"], access_token: "EAAotherPageToken" },
    { id: "not-a-page-id", name: "Malformed", tasks: ["CREATE_CONTENT"], access_token: "EAAbad" },
  ],
};

interface Recorded {
  token: string;
  request: MetaHttpRequest;
}

type Responder = (request: MetaHttpRequest, token: string) => MetaHttpResponse | Promise<MetaHttpResponse>;

function harness(respond: Responder) {
  const recorded: Recorded[] = [];
  const clientFor = (token: string): MetaHttpClient => ({
    async request(request) {
      recorded.push({ token, request });
      return respond(request, token);
    },
  });
  const publisher = createMetaPagePublisher({ accessToken: USER_TOKEN, clientFor });
  return { publisher, recorded };
}

const ok = (body: unknown): MetaHttpResponse => ({ status: 200, body });
const metaError = (status: number, code: number, type = "OAuthException", message = "Provider text that must not leak: act_999 EAAleak"): MetaHttpResponse => ({
  status,
  body: { error: { message, type, code, fbtrace_id: "trace" } },
});

/** Pages listing succeeds; everything else is decided by `rest`. */
const withPages =
  (rest: Responder): Responder =>
  (request, token) =>
    request.path === "me/accounts" ? ok(PAGES) : rest(request, token);

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}

describe("what the publisher is", () => {
  const { publisher } = harness(() => ok(PAGES));

  it("serves the Facebook channel and names its provider", () => {
    expect(publisher.channel).toBe("FACEBOOK");
    expect(publisher.provider).toBe(META_PAGE_PUBLISHER_ID);
  });

  it("can list, publish, read and look for a post — and nothing else", () => {
    const methods = Object.keys(publisher).filter((key) => typeof (publisher as unknown as Record<string, unknown>)[key] === "function");
    expect(methods.sort()).toEqual(["findByMessage", "listTargets", "publish", "read"]);
  });
});

describe("listing where it can post", () => {
  it("returns only Pages the token may create content on", async () => {
    const { publisher } = harness(() => ok(PAGES));
    expect(await publisher.listTargets()).toEqual([{ id: PAGE_ID, name: "Shop Page", channel: "FACEBOOK", provider: "meta-graph" }]);
  });

  it("does not even ask Meta for the Page tokens when it only lists", async () => {
    const { publisher, recorded } = harness(() => ok(PAGES));
    await publisher.listTargets();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.token).toBe(USER_TOKEN);
    expect(String(recorded[0]!.request.params?.fields)).not.toContain("access_token");
  });

  it("never returns a token, whatever Meta sent", async () => {
    const { publisher } = harness(() => ok(PAGES));
    const text = JSON.stringify(await publisher.listTargets());
    expect(text).not.toContain("EAA");
    expect(text).not.toContain("access_token");
  });

  it("returns an empty list when the token reaches no Page", async () => {
    expect(await harness(() => ok({ data: [] })).publisher.listTargets()).toEqual([]);
    expect(await harness(() => ok({})).publisher.listTargets()).toEqual([]);
  });

  it("a refused token is a fixed sentence, not Meta's own text", async () => {
    const error = await failure(harness(() => metaError(401, 190)).publisher.listTargets());
    expect(error).toBeInstanceOf(PublisherError);
    expect((error as PublisherError).code).toBe("NOT_PERMITTED");
    expect(error.message).not.toContain("act_999");
    expect(error.message).not.toContain("EAA");
  });

  it("a network failure while listing is 'could not be reached'", async () => {
    const { publisher } = harness(() => {
      throw new TypeError("fetch failed: getaddrinfo ENOTFOUND graph.facebook.com");
    });
    const error = (await failure(publisher.listTargets())) as PublisherError;
    expect(error.code).toBe("UNAVAILABLE");
    expect(error.message).toBe("Facebook could not be reached to check.");
  });
});

describe("publishing", () => {
  const posting = (after: Responder = () => ok({ id: POST_ID })) => harness(withPages(after));

  it("posts the text to the Page's feed, as the Page", async () => {
    const { publisher, recorded } = posting();
    const result = await publisher.publish({ targetId: PAGE_ID, message: "Festive offer is live." });
    expect(result).toEqual({ externalId: POST_ID });

    const post = recorded.find((r) => r.request.method === "POST")!;
    expect(post.token).toBe(PAGE_TOKEN);
    expect(post.request.path).toBe(`${PAGE_ID}/feed`);
    expect(post.request.body).toEqual({ message: "Festive offer is live." });
  });

  it("sends a link only when there is one", async () => {
    const { publisher, recorded } = posting();
    await publisher.publish({ targetId: PAGE_ID, message: "Read more", link: "https://shop.example/offer" });
    expect(recorded.find((r) => r.request.method === "POST")!.request.body).toEqual({ message: "Read more", link: "https://shop.example/offer" });
  });

  it("makes exactly one POST", async () => {
    const { publisher, recorded } = posting();
    await publisher.publish({ targetId: PAGE_ID, message: "Once" });
    expect(recorded.filter((r) => r.request.method === "POST")).toHaveLength(1);
  });

  it("forwards the caller's cancellation signal to every request", async () => {
    const { publisher, recorded } = posting();
    const controller = new AbortController();
    await publisher.publish({ targetId: PAGE_ID, message: "x" }, { signal: controller.signal });
    expect(recorded.every((r) => r.request.signal === controller.signal)).toBe(true);
  });

  it.each<[string, string]>([
    ["a Page the token cannot create content on", "2222222222"],
    ["a Page the token does not reach at all", "9999999999"],
  ])("refuses %s, and sends no post", async (_label, targetId) => {
    const { publisher, recorded } = posting();
    const error = (await failure(publisher.publish({ targetId, message: "x" }))) as PublisherError;
    expect(error.code).toBe("TARGET_NOT_FOUND");
    expect(recorded.filter((r) => r.request.method === "POST")).toHaveLength(0);
  });

  it.each(["me", "../1234567890", "1234567890/feed?x=", "https://evil.example", "act_123", ""])(
    "refuses the target id %j without making any request",
    async (targetId) => {
      const { publisher, recorded } = posting();
      const error = (await failure(publisher.publish({ targetId, message: "x" }))) as PublisherError;
      expect(error.code).toBe("TARGET_NOT_FOUND");
      expect(recorded).toHaveLength(0);
    }
  );

  it("refuses empty text without sending anything", async () => {
    const { publisher, recorded } = posting();
    expect(((await failure(publisher.publish({ targetId: PAGE_ID, message: "  \n " }))) as PublisherError).code).toBe("REJECTED");
    expect(recorded).toHaveLength(0);
  });

  it.each<[string, MetaHttpResponse, string]>([
    ["a refused permission", metaError(403, 200), "NOT_PERMITTED"],
    ["an expired token", metaError(401, 190), "NOT_PERMITTED"],
    ["a post Meta rejects", metaError(400, 100, "GraphMethodException"), "REJECTED"],
    ["a rate limit", metaError(429, 32), "RATE_LIMITED"],
  ])("%s is a known failure: nothing was published", async (_label, response, code) => {
    const error = (await failure(posting(() => response).publisher.publish({ targetId: PAGE_ID, message: "x" }))) as PublisherError;
    expect(error).toBeInstanceOf(PublisherError);
    expect(error.code).toBe(code);
  });

  it.each<[string, MetaHttpResponse]>([
    ["a server error after the post was sent", metaError(500, 1, "OAuthException")],
    ["a gateway timeout after the post was sent", metaError(504, 0, "")],
    ["a success with no post id", ok({ success: true })],
    ["a success with a malformed id", ok({ id: "not an id" })],
  ])("%s is AMBIGUOUS — the post may exist", async (_label, response) => {
    const error = (await failure(posting(() => response).publisher.publish({ targetId: PAGE_ID, message: "x" }))) as PublisherError;
    expect(error.code).toBe("AMBIGUOUS");
    expect(error.message).toContain("may or may not have been published");
  });

  it("a connection that dies after the post was sent is AMBIGUOUS", async () => {
    const { publisher } = posting(() => {
      throw new TypeError("fetch failed");
    });
    expect(((await failure(publisher.publish({ targetId: PAGE_ID, message: "x" }))) as PublisherError).code).toBe("AMBIGUOUS");
  });

  it("an abort keeps the client's own account of whether the request had left", async () => {
    const before = await failure(
      posting(() => {
        throw new MetaRequestAbortedError("before-send", "POST");
      }).publisher.publish({ targetId: PAGE_ID, message: "x" })
    );
    expect(before).toBeInstanceOf(MetaRequestAbortedError);
    expect((before as MetaRequestAbortedError).sideEffectPossible).toBe(false);

    const inFlight = await failure(
      posting(() => {
        throw new MetaRequestAbortedError("in-flight", "POST");
      }).publisher.publish({ targetId: PAGE_ID, message: "x" })
    );
    expect((inFlight as MetaRequestAbortedError).sideEffectPossible).toBe(true);
  });

  it("no failure ever carries Meta's own text or a token", async () => {
    const responses = [metaError(403, 200), metaError(400, 100), metaError(500, 1), metaError(429, 32)];
    for (const response of responses) {
      const error = await failure(posting(() => response).publisher.publish({ targetId: PAGE_ID, message: "x" }));
      expect(error.message).not.toContain("act_999");
      expect(error.message).not.toContain("EAA");
      expect(error.message).not.toContain("Provider text");
    }
  });

  it("the Page token appears in nothing the publisher returns", async () => {
    const { publisher } = posting();
    const result = await publisher.publish({ targetId: PAGE_ID, message: "x" });
    expect(JSON.stringify(result)).not.toContain(PAGE_TOKEN);
  });
});

describe("reading a post back", () => {
  const post = { id: POST_ID, message: "Festive offer is live.", created_time: "2026-10-12T10:00:00+0000", permalink_url: "https://www.facebook.com/1234567890/posts/5550001" };

  it("returns the post as Meta holds it, read as the Page", async () => {
    const { publisher, recorded } = harness(withPages(() => ok(post)));
    expect(await publisher.read({ targetId: PAGE_ID, externalId: POST_ID })).toEqual({
      externalId: POST_ID,
      message: "Festive offer is live.",
      url: "https://www.facebook.com/1234567890/posts/5550001",
      createdAt: "2026-10-12T10:00:00.000Z",
    });
    const read = recorded.find((r) => r.request.path === POST_ID)!;
    expect(read.token).toBe(PAGE_TOKEN);
    expect(read.request.method).toBe("GET");
  });

  it.each<[string, MetaHttpResponse]>([
    ["a 404", { status: 404, body: { error: { message: "nope", type: "GraphMethodException", code: 803 } } }],
    ["Meta's 'object does not exist'", metaError(400, 100, "GraphMethodException")],
  ])("%s means there is no such post — an answer, not a failure", async (_label, response) => {
    const { publisher } = harness(withPages(() => response));
    expect(await publisher.read({ targetId: PAGE_ID, externalId: POST_ID })).toBeNull();
  });

  it("a server error while reading is 'could not check' — never 'not there'", async () => {
    const { publisher } = harness(withPages(() => metaError(500, 1)));
    expect(((await failure(publisher.read({ targetId: PAGE_ID, externalId: POST_ID }))) as PublisherError).code).toBe("UNAVAILABLE");
  });

  it("does not ask Meta about something that is not a post id", async () => {
    const { publisher, recorded } = harness(withPages(() => ok(post)));
    expect(await publisher.read({ targetId: PAGE_ID, externalId: "me/accounts" })).toBeNull();
    expect(recorded).toHaveLength(0);
  });

  it("drops a permalink that is not https", async () => {
    const { publisher } = harness(withPages(() => ok({ ...post, permalink_url: "javascript:alert(1)" })));
    expect((await publisher.read({ targetId: PAGE_ID, externalId: POST_ID }))!.url).toBeNull();
  });

  it("refuses to read on a Page the token cannot post to", async () => {
    const { publisher } = harness(withPages(() => ok(post)));
    expect(((await failure(publisher.read({ targetId: "2222222222", externalId: POST_ID }))) as PublisherError).code).toBe("TARGET_NOT_FOUND");
  });
});

describe("looking for a post an earlier attempt may have made", () => {
  const since = new Date("2026-10-12T09:59:00.000Z");
  const feed = (posts: unknown[]) => harness(withPages(() => ok({ data: posts })));
  const entry = (id: string, message: string, created: string) => ({ id: `${PAGE_ID}_${id}`, message, created_time: created, permalink_url: `https://www.facebook.com/${PAGE_ID}/posts/${id}` });

  it("finds the post whose text is exactly the one sent", async () => {
    const { publisher, recorded } = feed([
      entry("1", "A different post", "2026-10-12T10:01:00+0000"),
      entry("2", "Festive offer is live.", "2026-10-12T10:00:30+0000"),
    ]);
    const found = await publisher.findByMessage({ targetId: PAGE_ID, message: "Festive offer is live.", since });
    expect(found!.externalId).toBe(`${PAGE_ID}_2`);

    const request = recorded.find((r) => r.request.path === `${PAGE_ID}/published_posts`)!;
    expect(request.token).toBe(PAGE_TOKEN);
    expect(request.request.params).toMatchObject({ since: Math.floor(since.getTime() / 1000) });
  });

  it("treats line endings and surrounding space as the same text", async () => {
    const { publisher } = feed([entry("3", "Line one\nLine two", "2026-10-12T10:00:30+0000")]);
    expect(await publisher.findByMessage({ targetId: PAGE_ID, message: "  Line one\r\nLine two \n", since })).not.toBeNull();
  });

  it("does not match text that merely contains, or is contained in, the one sent", async () => {
    const { publisher } = feed([entry("4", "Festive offer is live. Shop now!", "2026-10-12T10:00:30+0000"), entry("5", "Festive offer", "2026-10-12T10:00:30+0000")]);
    expect(await publisher.findByMessage({ targetId: PAGE_ID, message: "Festive offer is live.", since })).toBeNull();
  });

  it("ignores a post with the same text that is older than the attempt", async () => {
    const { publisher } = feed([entry("6", "Festive offer is live.", "2026-10-01T10:00:00+0000")]);
    expect(await publisher.findByMessage({ targetId: PAGE_ID, message: "Festive offer is live.", since })).toBeNull();
  });

  it("returns null when the Page has no recent posts", async () => {
    expect(await feed([]).publisher.findByMessage({ targetId: PAGE_ID, message: "x", since })).toBeNull();
  });

  it("a failure while looking is 'could not check' — never 'not found'", async () => {
    const { publisher } = harness(withPages(() => metaError(500, 1)));
    expect(((await failure(publisher.findByMessage({ targetId: PAGE_ID, message: "x", since }))) as PublisherError).code).toBe("UNAVAILABLE");
  });

  // Second audit, L2 — two calendar items can hold the same words. A post
  // that is already known to be another item's is passed over, so that this
  // item's own post, further down, can still be found.
  describe("passing over posts the caller knows are something else's", () => {
    const twins = () =>
      feed([
        entry("7", "Festive offer is live.", "2026-10-12T10:02:00+0000"),
        entry("8", "A different post", "2026-10-12T10:01:00+0000"),
        entry("9", "Festive offer is live.", "2026-10-12T10:00:30+0000"),
      ]);
    const look = (publisher: ReturnType<typeof feed>["publisher"], excludeIds?: readonly string[]) =>
      publisher.findByMessage({ targetId: PAGE_ID, message: "Festive offer is live.", since, ...(excludeIds ? { excludeIds } : {}) });

    it("with nothing to pass over, the first post with the text is the answer — as before", async () => {
      expect((await look(twins().publisher))!.externalId).toBe(`${PAGE_ID}_7`);
      expect((await look(twins().publisher, []))!.externalId).toBe(`${PAGE_ID}_7`);
    });

    it("passes over a post it was told is another's, and finds the next one with the same text", async () => {
      expect((await look(twins().publisher, [`${PAGE_ID}_7`]))!.externalId).toBe(`${PAGE_ID}_9`);
    });

    it("says not found when every post with the text is one it was told to pass over", async () => {
      expect(await look(twins().publisher, [`${PAGE_ID}_7`, `${PAGE_ID}_9`])).toBeNull();
    });

    it("never hands back a post it was told to pass over", async () => {
      const { publisher } = feed([entry("7", "Festive offer is live.", "2026-10-12T10:02:00+0000")]);
      expect(await look(publisher, [`${PAGE_ID}_7`])).toBeNull();
    });

    it("an id that is not on the Page changes nothing", async () => {
      expect((await look(twins().publisher, [`${PAGE_ID}_404`]))!.externalId).toBe(`${PAGE_ID}_7`);
    });

    it("sends the provider nothing about what it passes over: the same single read", async () => {
      const { publisher, recorded } = twins();
      await look(publisher, [`${PAGE_ID}_7`]);

      const reads = recorded.filter((r) => r.request.path === `${PAGE_ID}/published_posts`);
      expect(reads).toHaveLength(1);
      expect(JSON.stringify(reads[0]!.request.params)).not.toContain(`${PAGE_ID}_7`);
    });
  });
});

// ---------------------------------------------------------------------------
// The switch. Having the credentials is not the same as being asked to publish.
// ---------------------------------------------------------------------------

describe("publishing is switched on by the operator, exactly", () => {
  it("is off when the variable is absent", () => {
    expect(isPagePublishingEnabled({})).toBe(false);
  });

  it("is on for exactly the word true", () => {
    expect(isPagePublishingEnabled({ MARKETING_PUBLISH_ENABLED: "true" })).toBe(true);
  });

  it.each(["", "false", "0", "1", "yes", "on", "TRUE", "True", " true", "true ", "enabled"])("stays off for %j", (value) => {
    expect(isPagePublishingEnabled({ MARKETING_PUBLISH_ENABLED: value })).toBe(false);
  });

  it("is not switched on by the credentials that read the ad account", () => {
    expect(isPagePublishingEnabled({ META_ACCESS_TOKEN: "not-a-real-token", META_AD_ACCOUNT_ID: "act_000000000000015" })).toBe(false);
  });

  it("reads the process environment when given nothing", () => {
    const before = process.env.MARKETING_PUBLISH_ENABLED;
    try {
      delete process.env.MARKETING_PUBLISH_ENABLED;
      expect(isPagePublishingEnabled()).toBe(false);
      process.env.MARKETING_PUBLISH_ENABLED = "true";
      expect(isPagePublishingEnabled()).toBe(true);
    } finally {
      if (before === undefined) delete process.env.MARKETING_PUBLISH_ENABLED;
      else process.env.MARKETING_PUBLISH_ENABLED = before;
    }
  });
});
