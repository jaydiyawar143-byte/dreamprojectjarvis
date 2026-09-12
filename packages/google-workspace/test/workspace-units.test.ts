// ---------------------------------------------------------------------------
// Unit tests for the pure parts of the Workspace package.
//
// The service-level behaviour (statuses, auditing, rate limits) is covered in
// `apps/api/test/google-workspace.test.ts`, which drives the whole stack. What
// is tested HERE is the logic with no I/O in it — query construction, error
// classification and URL building — because those are the pieces where a
// mistake is silent: a malformed Drive query returns an empty list rather than
// an error, and an empty list looks exactly like "you have no files".
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import { buildSearchQuery, buildUrl, callGoogle } from "../src/index.js";

// ---------------------------------------------------------------------------

describe("buildSearchQuery", () => {
  it("always excludes trashed files", () => {
    // A search that returns deleted files looks like a bug and buries the
    // results the user wanted.
    expect(buildSearchQuery("anything")).toContain("trashed = false");
  });

  it("reads a kind word as a mimeType filter and removes it from the name match", () => {
    // "presentation" as a NAME match finds almost nothing; as a kind filter it
    // finds exactly the right set. This is what makes "Drive mein presentation
    // dhoondo" work.
    const query = buildSearchQuery("presentation");

    expect(query).toContain("mimeType = 'application/vnd.google-apps.presentation'");
    expect(query).not.toContain("name contains 'presentation'");
  });

  it("combines a kind filter with the remaining name terms", () => {
    const query = buildSearchQuery("Q3 budget spreadsheet");

    expect(query).toContain("mimeType = 'application/vnd.google-apps.spreadsheet'");
    expect(query).toContain("name contains 'Q3 budget'");
  });

  it("falls back to a name match when no kind is named", () => {
    const query = buildSearchQuery("contract renewal");

    expect(query).toContain("name contains 'contract renewal'");
    expect(query).not.toContain("mimeType =");
  });

  it("escapes an apostrophe rather than breaking the query", () => {
    // Drive queries are strings with quoted literals, so an unescaped
    // apostrophe in an ordinary filename breaks the whole query — and the
    // symptom is an empty result set, not an error.
    const query = buildSearchQuery("O'Brien deck");
    expect(query).toContain("O\\'Brien");
  });

  it("escapes a backslash, which would otherwise escape the closing quote", () => {
    const query = buildSearchQuery("path\\to\\thing");
    expect(query).toContain("\\\\");
  });

  it("recognises each documented kind word", () => {
    const cases: Array<[string, string]> = [
      ["slides", "presentation"],
      ["powerpoint", "presentation"],
      ["sheets", "spreadsheet"],
      ["excel", "spreadsheet"],
      ["docs", "document"],
      ["pdf", "application/pdf"],
      ["folders", "folder"],
    ];

    for (const [word, expected] of cases) {
      expect(buildSearchQuery(word), word).toContain(expected);
    }
  });
});

// ---------------------------------------------------------------------------

describe("buildUrl", () => {
  it("puts every value in the query string, never the path", () => {
    // User input reaching the PATH is how a caller redirects a call to another
    // endpoint. It only ever becomes an encoded parameter.
    const url = buildUrl("https://gmail.googleapis.com/gmail/v1/users/me/messages", {
      q: "is:unread in:inbox",
      maxResults: 10,
    });

    expect(url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages?")).toBe(true);
    expect(new URL(url).searchParams.get("q")).toBe("is:unread in:inbox");
  });

  it("omits undefined and empty values instead of sending blanks", () => {
    const url = buildUrl("https://example.com/x", {
      a: "1",
      b: undefined,
      c: "",
    });

    const params = new URL(url).searchParams;
    expect(params.get("a")).toBe("1");
    expect(params.has("b")).toBe(false);
    expect(params.has("c")).toBe(false);
  });

  it("cannot be made to change host by a parameter value", () => {
    const url = buildUrl("https://gmail.googleapis.com/x", {
      q: "https://evil.example.com/steal",
    });
    expect(new URL(url).host).toBe("gmail.googleapis.com");
  });
});

// ---------------------------------------------------------------------------

describe("callGoogle error classification", () => {
  const stub = (status: number, body: unknown) =>
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    })) as unknown as typeof fetch;

  it("classifies 401 as needs_reauth, which is never retryable", async () => {
    const result = await callGoogle({
      url: "https://example.com/x",
      accessToken: "t",
      fetchImpl: stub(401, { error: { message: "Invalid Credentials" } }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe("needs_reauth");
      expect(result.requiredAction).toMatch(/reconnect/i);
    }
  });

  it("classifies an insufficient-scope 403 as permission_missing", async () => {
    const result = await callGoogle({
      url: "https://example.com/x",
      accessToken: "t",
      fetchImpl: stub(403, {
        error: {
          message: "Request had insufficient authentication scopes.",
          errors: [{ reason: "insufficientPermissions" }],
        },
      }),
    });

    if (!result.ok) expect(result.status).toBe("permission_missing");
  });

  it("classifies a rate-limit 403 as provider_error, not permission_missing", async () => {
    // 403 is overloaded. A quota problem is temporary and a scope problem is
    // not, so they must not share a remedy.
    const result = await callGoogle({
      url: "https://example.com/x",
      accessToken: "t",
      fetchImpl: stub(403, {
        error: { message: "Rate Limit Exceeded", errors: [{ reason: "rateLimitExceeded" }] },
      }),
    });

    if (!result.ok) {
      expect(result.status).toBe("provider_error");
      expect(result.message).toMatch(/rate-limit/i);
    }
  });

  it("explains a disabled API rather than blaming the user's permissions", async () => {
    const result = await callGoogle({
      url: "https://example.com/x",
      accessToken: "t",
      fetchImpl: stub(403, {
        error: {
          message: "Gmail API has not been used in project 123 before or it is disabled.",
          errors: [{ reason: "accessNotConfigured" }],
        },
      }),
    });

    if (!result.ok) {
      expect(result.status).toBe("provider_error");
      expect(result.requiredAction).toMatch(/Google Cloud console/i);
    }
  });

  it("classifies 429 as provider_error", async () => {
    const result = await callGoogle({
      url: "https://example.com/x",
      accessToken: "t",
      fetchImpl: stub(429, {}),
    });
    if (!result.ok) expect(result.status).toBe("provider_error");
  });

  it("strips a URL out of a provider message", async () => {
    // A Gmail list URL carries the search query, which is the user's own text.
    const result = await callGoogle({
      url: "https://example.com/x",
      accessToken: "t",
      fetchImpl: stub(400, {
        error: { message: "Bad request for https://gmail.googleapis.com/v1?q=private-term" },
      }),
    });

    if (!result.ok) {
      expect(result.message).not.toContain("private-term");
      expect(result.message).toContain("[url]");
    }
  });

  it("sends the token as a bearer header and never in the URL", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const recorder = vi.fn(async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
      return { ok: true, status: 200, text: async () => "{}" };
    }) as unknown as typeof fetch;

    await callGoogle({
      url: "https://example.com/x",
      accessToken: "SECRET-TOKEN",
      fetchImpl: recorder,
    });

    expect(seen[0]!.headers.Authorization).toBe("Bearer SECRET-TOKEN");
    // A token in a query string ends up in access logs.
    expect(seen[0]!.url).not.toContain("SECRET-TOKEN");
  });

  it("issues a GET, because this package cannot write", async () => {
    const methods: string[] = [];
    const recorder = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      methods.push(init?.method ?? "GET");
      return { ok: true, status: 200, text: async () => "{}" };
    }) as unknown as typeof fetch;

    await callGoogle({ url: "https://example.com/x", accessToken: "t", fetchImpl: recorder });
    expect(methods).toEqual(["GET"]);
  });

  it("times out rather than hanging", async () => {
    const hang = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        })
    ) as unknown as typeof fetch;

    const result = await callGoogle({
      url: "https://example.com/x",
      accessToken: "t",
      fetchImpl: hang,
      timeoutMs: 25,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe("provider_error");
      expect(result.message).toMatch(/did not respond/i);
    }
  });

  it("survives a non-JSON body instead of throwing", async () => {
    const html = vi.fn(async () => ({
      ok: false,
      status: 502,
      text: async () => "<html>Bad Gateway</html>",
    })) as unknown as typeof fetch;

    const result = await callGoogle({
      url: "https://example.com/x",
      accessToken: "t",
      fetchImpl: html,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("provider_error");
  });
});
