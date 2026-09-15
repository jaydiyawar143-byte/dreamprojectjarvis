// ---------------------------------------------------------------------------
// R-21 — how startup parses OPENAI_API_KEY.
//
// `getServerEnv()` is what the API calls before it wires anything, so this is
// the path that decides whether a process without the key starts at all. Each
// case loads a fresh copy of the module, because the parsed environment is
// memoized for the life of the process.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, afterEach } from "vitest";

const DEVELOPMENT = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://user:pass@db.internal:5432/jarvis",
  JWT_SECRET: "Zk4pQ7vR2mX9tL6wB3nH8sD5gY1jF0cA",
  CORS_ORIGIN: "http://localhost:3000",
};

async function loadServerEnv(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [name, value] of Object.entries(env)) {
    vi.stubEnv(name, value);
  }
  const { getServerEnv } = await import("../src/index.js");
  return getServerEnv();
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("R-21 — a blank key is a missing key in development", () => {
  it.each([
    ["missing", undefined],
    ["blank", ""],
    ["whitespace only", "   "],
  ])("starts with a %s key and reports no key", async (_label, key) => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const env = await loadServerEnv({ ...DEVELOPMENT, OPENAI_API_KEY: key });

    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("passes a real key through unchanged", async () => {
    const env = await loadServerEnv({ ...DEVELOPMENT, OPENAI_API_KEY: "sk-test-r21-not-a-real-key" });

    expect(env.OPENAI_API_KEY).toBe("sk-test-r21-not-a-real-key");
  });

  it("still rejects a non-blank value that is not an OpenAI key", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(loadServerEnv({ ...DEVELOPMENT, OPENAI_API_KEY: "not-a-key" })).rejects.toThrow(
      "Invalid server environment variables"
    );
  });
});

describe("R-21 — production refuses to start without the key", () => {
  it("fails before wiring, naming the field and nothing else", async () => {
    const printed: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(" "));
    });

    await expect(
      loadServerEnv({
        ...DEVELOPMENT,
        NODE_ENV: "production",
        CORS_ORIGIN: "https://app.jarvis.example",
        OPENAI_API_KEY: undefined,
      })
    ).rejects.toThrow("Unsafe production configuration");

    const output = printed.join("\n");
    expect(output).toContain("OPENAI_API_KEY");
    expect(output).not.toContain(DEVELOPMENT.JWT_SECRET);
    expect(output).not.toContain(DEVELOPMENT.DATABASE_URL);
  });
});
