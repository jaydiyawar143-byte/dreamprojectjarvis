// @vitest-environment node
//
// Phase 13 — the web app's health endpoint.
//
// `GET /healthz` is what a container orchestrator and an uptime monitor ask.
// It answers one question — is this Next.js server up and able to respond? —
// and deliberately nothing else: the browser talks to the API directly, so the
// web server does not need the API to serve a page, and its health must not
// depend on it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, dynamic } from "../src/app/healthz/route";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("GET /healthz", () => {
  it("answers 200 with a small fixed body", async () => {
    const response = GET();

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: "ok", service: "jarvis-web" });
    expect(new Date(String(body.timestamp)).toISOString()).toBe(body.timestamp);
  });

  it("is computed on every request and never cached", () => {
    // A prerendered or cached 200 would keep answering after the server died.
    expect(dynamic).toBe("force-dynamic");
    expect(GET().headers.get("cache-control")).toBe("no-store");
  });

  it("reveals nothing about how the deployment is configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "http://internal-api.example:3101/api/v1");
    vi.stubEnv("DATABASE_URL", "postgresql://app:S3cr3t-Pa55@db.internal:5432/jarvis");

    const text = await GET().text();

    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual(["service", "status", "timestamp"]);
    expect(text).not.toContain("internal-api.example");
    expect(text).not.toContain("S3cr3t-Pa55");
  });

  it("does not call the API or anything else to answer", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    GET();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
