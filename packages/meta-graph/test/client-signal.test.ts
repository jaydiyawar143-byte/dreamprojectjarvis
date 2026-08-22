// PHASE 10.4 — MetaHttpClient AbortSignal propagation + transport classification.
//
// Proves (all against a MOCKED global fetch — no real network):
//  1. The caller's signal is combined into the signal handed to fetch.
//  2. A pre-aborted signal never calls fetch and reports phase "before-send"
//     with sideEffectPossible=false (safe FAILED territory).
//  3. An in-flight abort of a GET is side-effect free.
//  4. An in-flight abort of a POST marks sideEffectPossible=true
//     (ambiguous -> UNKNOWN territory for the journal).
//  5. The client's own timeout timer produces the SAME typed abort error
//     (one authoritative controller per request).
//  6. Explicit provider failures (400) and successes pass through unchanged.
//  7. No credential material ever appears in thrown abort errors.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMetaHttpClient,
  MetaRequestAbortedError,
} from "../src/client.js";
import type { MetaConfig } from "../src/config.js";

const config: MetaConfig = {
  accessToken: "EAA_SECRET_TEST_TOKEN",
  adAccountId: "act_123456",
  apiVersion: "v21.0",
  baseUrl: "https://graph.local/v21.0",
  timeoutMs: 5000,
  maxRetries: 0,
};

type FetchMock = ReturnType<typeof vi.fn>;

let fetchMock: FetchMock;

function hangingFetch(): void {
  fetchMock.mockImplementation(
    (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError"))
        );
      })
  );
}

function okFetch(): void {
  fetchMock.mockImplementation(async () =>
    new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Phase 10.4 — meta client signal handling", () => {
  it("1. caller's signal reaches fetch (combined signal instance)", async () => {
    okFetch();
    const client = createMetaHttpClient(config);
    const caller = new AbortController();
    await client.request({
      method: "GET",
      path: "me/adaccounts",
      signal: caller.signal,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // The combined signal must react to the caller's signal.
    let propagated = false;
    init.signal?.addEventListener("abort", () => (propagated = true));
    caller.abort();
    expect(propagated).toBe(true);
  });

  it("2. pre-aborted POST signal: fetch never called; before-send; no side effect possible", async () => {
    const client = createMetaHttpClient(config);
    const caller = new AbortController();
    caller.abort();
    await expect(
      client.request({
        method: "POST",
        path: "act_123456/campaigns",
        body: { name: "X" },
        signal: caller.signal,
      })
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(MetaRequestAbortedError);
      expect((err as MetaRequestAbortedError).phase).toBe("before-send");
      expect((err as MetaRequestAbortedError).sideEffectPossible).toBe(false);
      return true;
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("3. in-flight GET cancellation is deterministic (no side effect possible)", async () => {
    hangingFetch();
    const client = createMetaHttpClient(config);
    const caller = new AbortController();
    const pending = client.request({
      method: "GET",
      path: "100000001/campaigns",
      signal: caller.signal,
    });
    setTimeout(() => caller.abort(), 5);
    const err = await pending.then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(MetaRequestAbortedError);
    expect((err as MetaRequestAbortedError).phase).toBe("in-flight");
    expect((err as MetaRequestAbortedError).sideEffectPossible).toBe(false);
  });

  it("4. in-flight POST cancellation flags possible external side effect", async () => {
    hangingFetch();
    const client = createMetaHttpClient(config);
    const caller = new AbortController();
    const pending = client.request({
      method: "POST",
      path: "act_123456/campaigns",
      body: { name: "Campaign X" },
      signal: caller.signal,
    });
    setTimeout(() => caller.abort(), 5);
    const err = await pending.then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(MetaRequestAbortedError);
    expect((err as MetaRequestAbortedError).phase).toBe("in-flight");
    expect((err as MetaRequestAbortedError).sideEffectPossible).toBe(true);
  });

  it("5. client timeout fires its own AbortController producing the same typed error", async () => {
    hangingFetch();
    const client = createMetaHttpClient(config);
    const started = Date.now();
    const err = await client
      .request({ method: "POST", path: "act_123456/campaigns", body: {}, timeoutMs: 25 })
      .then(
        () => null,
        (e: unknown) => e
      );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(err).toBeInstanceOf(MetaRequestAbortedError);
    expect((err as MetaRequestAbortedError).phase).toBe("in-flight");
    expect((err as MetaRequestAbortedError).sideEffectPossible).toBe(true);
  });

  it("6a. explicit provider failure passes through unchanged (classification stays deterministic)", async () => {
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify({ error: { message: "Invalid objective", type: "OAuthException", code: 100 } }), { status: 400 })
    );
    const client = createMetaHttpClient(config);
    const resp = await client.request({
      method: "POST",
      path: "act_123456/campaigns",
      body: { name: "X" },
    });
    expect(resp.status).toBe(400);
    expect((resp.body as { error: { code: number } }).error.code).toBe(100);
  });

  it("6b. explicit success passes through unchanged", async () => {
    okFetch();
    const client = createMetaHttpClient(config);
    const resp = await client.request({
      method: "POST",
      path: "act_123456/campaigns",
      body: { name: "X" },
    });
    expect(resp.status).toBe(200);
  });

  it("7. abort errors never leak credentials", async () => {
    hangingFetch();
    const client = createMetaHttpClient(config);
    const caller = new AbortController();
    const pending = client.request({
      method: "POST",
      path: "act_123456/campaigns",
      body: { access_token: "EAA_SECRET_TEST_TOKEN" },
      signal: caller.signal,
    });
    setTimeout(() => caller.abort(), 5);
    const err = (await pending.then(
      () => null,
      (e: unknown) => e
    )) as Error | null;
    expect(err).toBeTruthy();
    const leaked =
      err!.message.includes("EAA_SECRET_TEST_TOKEN") ||
      /access_token/i.test(err!.message) ||
      (err!.stack ?? "").includes("EAA_SECRET_TEST_TOKEN");
    expect(leaked).toBe(false);
  });

  it("8. PATCH-style updates are Graph POSTs: update requests carry the signal too", async () => {
    hangingFetch();
    const client = createMetaHttpClient(config);
    const caller = new AbortController();
    // Status toggle / budget write shape: POST to entity id.
    const pending = client.request({
      method: "POST",
      path: "100000001",
      body: { status: "PAUSED" },
      signal: caller.signal,
    });
    setTimeout(() => caller.abort(), 5);
    const err = (await pending.then(
      () => null,
      (e: unknown) => e
    )) as MetaRequestAbortedError | null;
    expect(err).toBeInstanceOf(MetaRequestAbortedError);
    expect(err!.sideEffectPossible).toBe(true);
  });
});
