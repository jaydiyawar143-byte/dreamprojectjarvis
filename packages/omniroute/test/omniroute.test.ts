import { describe, it, expect, vi } from "vitest";
import {
  checkOmniRouteConnection,
  createOmniRouteConfig,
  isOmniRouteConfigured,
  omniRouteModelsUrl,
  OMNIROUTE_DEFAULT_TIMEOUT_MS,
  type OmniRouteConfig,
} from "../src/index.js";

const KEY = "OMNI-KEY-SECRET";

const config = (overrides: Partial<OmniRouteConfig> = {}): OmniRouteConfig => ({
  baseUrl: "http://gateway.test:20128/v1",
  apiKey: KEY,
  timeoutMs: 1000,
  ...overrides,
});

const MODELS = { object: "list", data: [{ id: "openai/gpt-4o" }, { id: "anthropic/claude" }] };

function answer(status: number, body: unknown = ""): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { status, ok: status >= 200 && status < 300, text: async () => text } as Response;
}

/** Answers the keyed request and the keyless probe separately, by the header. */
function gateway(withKey: Response, withoutKey: Response = answer(401)) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    return headers.Authorization ? withKey : withoutKey;
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

// ---------------------------------------------------------------------------

describe("configuration", () => {
  it("is configured only when both variables are present and not blank", () => {
    expect(isOmniRouteConfigured({ OMNIROUTE_BASE_URL: "http://x", OMNIROUTE_API_KEY: "k" })).toBe(true);
    expect(isOmniRouteConfigured({ OMNIROUTE_BASE_URL: "http://x" })).toBe(false);
    expect(isOmniRouteConfigured({ OMNIROUTE_API_KEY: "k" })).toBe(false);
    expect(isOmniRouteConfigured({ OMNIROUTE_BASE_URL: "http://x", OMNIROUTE_API_KEY: "  " })).toBe(false);
  });

  it("completes a bare origin with /v1 and strips trailing slashes", () => {
    expect(createOmniRouteConfig({ baseUrl: "http://localhost:20128", apiKey: "k" }).baseUrl).toBe(
      "http://localhost:20128/v1"
    );
    expect(createOmniRouteConfig({ baseUrl: "http://localhost:20128/v1///", apiKey: "k" }).baseUrl).toBe(
      "http://localhost:20128/v1"
    );
  });

  it("keeps a path the operator named rather than rewriting it", () => {
    expect(createOmniRouteConfig({ baseUrl: "https://proxy.test/ai/v1/", apiKey: "k" }).baseUrl).toBe(
      "https://proxy.test/ai/v1"
    );
  });

  it("reads the environment and applies the default timeout", () => {
    const parsed = createOmniRouteConfig(
      {},
      { OMNIROUTE_BASE_URL: " http://localhost:20128/v1 ", OMNIROUTE_API_KEY: "k" }
    );
    expect(parsed.baseUrl).toBe("http://localhost:20128/v1");
    expect(parsed.timeoutMs).toBe(OMNIROUTE_DEFAULT_TIMEOUT_MS);
  });

  it("refuses a URL with no scheme, without throwing past the parser", () => {
    expect(() => createOmniRouteConfig({ baseUrl: "localhost:20128", apiKey: "k" })).toThrow(/baseUrl/);
    expect(() => createOmniRouteConfig({ baseUrl: "not a url", apiKey: "k" })).toThrow(/baseUrl/);
  });

  it("refuses a scheme other than http or https", () => {
    expect(() => createOmniRouteConfig({ baseUrl: "ftp://gateway.test", apiKey: "k" })).toThrow(/http or https/);
  });

  it("refuses a URL that carries a credential, and never repeats it", () => {
    // The base URL is displayed on the card; a password in it would be too.
    let message = "";
    try {
      createOmniRouteConfig({ baseUrl: "http://admin:HUNTER2@gateway.test/v1", apiKey: "k" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/must not embed credentials/);
    expect(message).not.toContain("HUNTER2");
  });

  it("refuses a query or fragment", () => {
    expect(() => createOmniRouteConfig({ baseUrl: "http://gateway.test/v1?key=x", apiKey: "k" })).toThrow(
      /query or fragment/
    );
  });

  it("names the missing key without echoing any value", () => {
    expect(() => createOmniRouteConfig({ baseUrl: "http://gateway.test", apiKey: "" })).toThrow(
      /OMNIROUTE_API_KEY is required/
    );
  });
});

// ---------------------------------------------------------------------------

describe("connection check", () => {
  it("reads the model list from the configured base, with the key in the header only", async () => {
    const fetchImpl = gateway(answer(200, MODELS));
    await checkOmniRouteConnection(config(), { fetch: fetchImpl });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("http://gateway.test:20128/v1/models");
    expect(String(url)).not.toContain(KEY);
    expect((init as RequestInit).method).toBe("GET");
    expect(((init as RequestInit).headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
  });

  it("never follows a redirect", async () => {
    const fetchImpl = gateway(answer(200, MODELS));
    await checkOmniRouteConnection(config(), { fetch: fetchImpl });
    for (const [, init] of fetchImpl.mock.calls) {
      expect((init as RequestInit).redirect).toBe("manual");
    }
  });

  it("probes WITHOUT the key, and reports a key that was really checked", async () => {
    const fetchImpl = gateway(answer(200, MODELS), answer(401));
    const result = await checkOmniRouteConnection(config(), { fetch: fetchImpl });

    expect(result).toEqual({ ok: true, modelCount: 2, keyRequired: true });
    const probe = fetchImpl.mock.calls[1]![1] as RequestInit;
    expect((probe.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("reports a gateway that answers without a key as such", async () => {
    // OmniRoute's default: REQUIRE_API_KEY off. The keyed call succeeding
    // proves nothing about the key.
    const result = await checkOmniRouteConnection(config(), {
      fetch: gateway(answer(200, MODELS), answer(200, MODELS)),
    });
    expect(result).toEqual({ ok: true, modelCount: 2, keyRequired: false });
  });

  it("knows nothing about the key when the probe gets some other answer", async () => {
    const odd = await checkOmniRouteConnection(config(), { fetch: gateway(answer(200, MODELS), answer(500)) });
    expect(odd).toEqual({ ok: true, modelCount: 2, keyRequired: null });

    const calls = { n: 0 };
    const failingProbe = vi.fn(async () => {
      calls.n += 1;
      if (calls.n === 1) return answer(200, MODELS);
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;
    expect(await checkOmniRouteConnection(config(), { fetch: failingProbe })).toEqual({
      ok: true,
      modelCount: 2,
      keyRequired: null,
    });
  });

  it("counts only entries that have an id", async () => {
    const result = await checkOmniRouteConnection(config(), {
      fetch: gateway(answer(200, { data: [{ id: "a" }, { id: "" }, {}, null, "b"] })),
    });
    expect(result).toMatchObject({ ok: true, modelCount: 1 });
  });

  it("does not probe after a failure", async () => {
    const fetchImpl = gateway(answer(401));
    await checkOmniRouteConnection(config(), { fetch: fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, "UNAUTHORIZED"],
    [403, "UNAUTHORIZED"],
    [404, "NOT_FOUND"],
    [302, "REDIRECTED"],
    [500, "HTTP_ERROR"],
    [503, "HTTP_ERROR"],
  ] as const)("classifies HTTP %i as %s", async (status, reason) => {
    const result = await checkOmniRouteConnection(config(), { fetch: gateway(answer(status)) });
    expect(result).toEqual({ ok: false, reason, httpStatus: status });
  });

  it("treats a 200 that is not a model list as unexpected, never as connected", async () => {
    for (const body of ["<html>login</html>", { models: [] }, [], "", { data: "nope" }]) {
      const result = await checkOmniRouteConnection(config(), { fetch: gateway(answer(200, body)) });
      expect(result).toMatchObject({ ok: false, reason: "UNEXPECTED_RESPONSE" });
    }
  });

  it("classifies an abort as TIMEOUT and anything else as UNREACHABLE", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(
      await checkOmniRouteConnection(config(), { fetch: vi.fn().mockRejectedValue(abort) as unknown as typeof fetch })
    ).toEqual({ ok: false, reason: "TIMEOUT" });
    expect(
      await checkOmniRouteConnection(config(), {
        fetch: vi.fn().mockRejectedValue(new TypeError("fetch failed")) as unknown as typeof fetch,
      })
    ).toEqual({ ok: false, reason: "UNREACHABLE" });
  });

  it("aborts a request that outlives the timeout", async () => {
    const hanging = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
          );
        })
    ) as unknown as typeof fetch;
    expect(await checkOmniRouteConnection(config({ timeoutMs: 20 }), { fetch: hanging })).toEqual({
      ok: false,
      reason: "TIMEOUT",
    });
  });

  it("carries no gateway text and no key in any failure", async () => {
    const result = await checkOmniRouteConnection(config(), {
      fetch: vi.fn().mockRejectedValue(new Error(`connect ECONNREFUSED with ${KEY}`)) as unknown as typeof fetch,
    });
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(JSON.stringify(result)).not.toContain("ECONNREFUSED");
  });

  it("builds the URL from configuration and a literal only", () => {
    expect(omniRouteModelsUrl(config({ baseUrl: "https://proxy.test/ai/v1" }))).toBe("https://proxy.test/ai/v1/models");
  });
});
