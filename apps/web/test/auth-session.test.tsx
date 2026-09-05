// ---------------------------------------------------------------------------
// Sprint 4.1 — Auth / protected-route session stabilization.
//
// Covers the B1 defect found in the Sprint 4.0 baseline: a hard load of a
// protected route fired its data fetch before the auth provider had hydrated
// the session, so the request went out with no Authorization header and the
// page rendered "Authentication required" despite a perfectly valid session.
//
// Two independent guarantees are asserted here, because the fix has two parts
// and either one regressing brings the bug back:
//
//   1. Token hydration is synchronous at module evaluation, so a component
//      effect — which React runs BEFORE the parent provider's effect — already
//      sees the token.
//   2. A protected route's children do not mount at all until the session has
//      resolved, so no authenticated request can be issued in an unresolved
//      state.
//
// Every test boots a fresh module registry, which is what makes these true
// "browser refresh" simulations rather than in-page navigations.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, afterEach } from "vitest";
import React, { useEffect, useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";

const ACCESS = "access-token-abc";
const REFRESH = "refresh-token-xyz";

const routerPush = vi.fn();
const routerReplace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: routerReplace, prefetch: vi.fn() }),
  usePathname: () => "/approvals",
  useParams: () => ({ id: "opp-1" }),
  useSearchParams: () => new URLSearchParams(),
}));

// ---------------------------------------------------------------------------
// fetch double — records every call so header presence can be asserted
// ---------------------------------------------------------------------------

interface RecordedCall {
  url: string;
  method: string;
  authorization: string | undefined;
}

let calls: RecordedCall[] = [];

interface FetchPlan {
  /** /auth/me outcome. */
  me?: "ok" | "unauthorized";
  /** /auth/refresh outcome. */
  refresh?: "ok" | "fail";
  /** /approvals outcome for a request that carried a bearer token. */
  approvals?: "ok" | "unauthorized";
}

function installFetch(plan: FetchPlan = {}) {
  const { me = "ok", refresh = "ok", approvals = "ok" } = plan;

  const json = (status: number, body: unknown) =>
    Promise.resolve({
      status,
      ok: status < 400,
      json: () => Promise.resolve(body),
    } as Response);

  const unauthorized = () =>
    json(401, {
      success: false,
      error: { code: "AUTHENTICATION_REQUIRED", message: "Authentication required" },
      timestamp: new Date().toISOString(),
    });

  global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method: init?.method ?? "GET",
      authorization: headers["Authorization"],
    });

    if (url.includes("/auth/refresh")) {
      return refresh === "ok"
        ? json(200, {
            success: true,
            data: { accessToken: "access-token-rotated", refreshToken: "refresh-token-rotated", expiresIn: 900 },
            timestamp: new Date().toISOString(),
          })
        : json(401, {
            success: false,
            error: { code: "TOKEN_EXPIRED", message: "Refresh token expired" },
            timestamp: new Date().toISOString(),
          });
    }

    if (url.includes("/auth/me")) {
      if (me === "unauthorized" && headers["Authorization"] === `Bearer ${ACCESS}`) {
        return unauthorized();
      }
      if (!headers["Authorization"]) return unauthorized();
      return json(200, {
        success: true,
        data: {
          id: "user-1",
          email: "person@jarvis.local",
          name: "Person",
          role: "member",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        timestamp: new Date().toISOString(),
      });
    }

    if (url.includes("/approvals")) {
      if (!headers["Authorization"] || approvals === "unauthorized") return unauthorized();
      return json(200, {
        success: true,
        data: [],
        pagination: { page: 1, limit: 20, total: 0, totalPages: 1 },
        timestamp: new Date().toISOString(),
      });
    }

    return json(200, { success: true, data: null, timestamp: new Date().toISOString() });
  }) as unknown as typeof fetch;
}

/** Simulates a fresh document: clean module registry, chosen stored session. */
async function boot(options: { session?: boolean; plan?: FetchPlan } = {}) {
  const { session = true, plan = {} } = options;

  vi.resetModules();
  calls = [];
  routerPush.mockClear();
  routerReplace.mockClear();
  sessionStorage.clear();

  if (session) {
    sessionStorage.setItem("jarvis_access", ACCESS);
    sessionStorage.setItem("jarvis_refresh", REFRESH);
  }

  installFetch(plan);

  const api = await import("../src/lib/api");
  const auth = await import("../src/lib/auth");
  const { RequireAuth } = await import("../src/components/require-auth");
  return { api, auth, RequireAuth };
}

const approvalCalls = () => calls.filter((c) => c.url.includes("/approvals"));

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Synchronous token hydration
// ---------------------------------------------------------------------------

describe("session hydration on a fresh document", () => {
  it("exposes the stored access token before any React effect runs", async () => {
    const { api } = await boot();
    // No render yet, no loadTokens() call yet: module evaluation alone must
    // have restored the session. This is the property that makes a child
    // effect safe, since React runs it before the provider's own effect.
    expect(api.getAccessToken()).toBe(ACCESS);
  });

  it("leaves the token null when no session is stored", async () => {
    const { api } = await boot({ session: false });
    expect(api.getAccessToken()).toBeNull();
  });

  it("survives a browser that refuses session storage", async () => {
    vi.resetModules();
    sessionStorage.clear();
    const getItem = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new DOMException("The operation is insecure.", "SecurityError");
      });
    installFetch();
    // Must not throw while importing the module.
    const api = await import("../src/lib/api");
    expect(api.getAccessToken()).toBeNull();
    getItem.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 2. A child effect must never out-run the provider
// ---------------------------------------------------------------------------

describe("child effect ordering against AuthProvider", () => {
  /** Mimics a protected page: fetches on mount, with no auth co-ordination. */
  function EagerProbe({ call }: { call: () => Promise<unknown> }) {
    const [done, setDone] = useState(false);
    useEffect(() => {
      void call().then(() => setDone(true));
    }, [call]);
    return <p data-testid="probe">{done ? "done" : "loading"}</p>;
  }

  it("sends the bearer token on the first request of a hard page load", async () => {
    const { api, auth } = await boot();
    const { AuthProvider } = auth;

    render(
      <AuthProvider>
        <EagerProbe call={() => api.listApprovals("pending", 1)} />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("done"));

    const first = approvalCalls()[0];
    expect(first).toBeDefined();
    expect(first.authorization).toBe(`Bearer ${ACCESS}`);
  });

  it("does not 401 the first protected request after a refresh", async () => {
    const { api, auth } = await boot();
    const { AuthProvider } = auth;

    render(
      <AuthProvider>
        <EagerProbe call={() => api.listApprovals()} />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("done"));
    expect(approvalCalls().every((c) => c.authorization === `Bearer ${ACCESS}`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. RequireAuth gate
// ---------------------------------------------------------------------------

describe("RequireAuth", () => {
  function Guarded({ onMount }: { onMount: () => void }) {
    useEffect(() => { onMount(); }, [onMount]);
    return <p data-testid="content">protected content</p>;
  }

  it("holds children back until the session resolves, then renders them", async () => {
    const { auth, RequireAuth } = await boot();
    const { AuthProvider } = auth;
    const onMount = vi.fn();

    render(
      <AuthProvider>
        <RequireAuth>
          <Guarded onMount={onMount} />
        </RequireAuth>
      </AuthProvider>
    );

    // First paint: the session is still being validated, so nothing protected
    // has mounted and no effect of its could have fired.
    expect(screen.queryByTestId("content")).toBeNull();
    expect(onMount).not.toHaveBeenCalled();
    expect(screen.getByTestId("session-pending")).toBeInTheDocument();

    await waitFor(() => expect(screen.getByTestId("content")).toBeInTheDocument());
    expect(onMount).toHaveBeenCalledTimes(1);
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it("never mounts children and redirects to login when no session is stored", async () => {
    const { auth, RequireAuth } = await boot({ session: false });
    const { AuthProvider } = auth;
    const onMount = vi.fn();

    render(
      <AuthProvider>
        <RequireAuth>
          <Guarded onMount={onMount} />
        </RequireAuth>
      </AuthProvider>
    );

    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith("/login"));
    expect(onMount).not.toHaveBeenCalled();
    expect(screen.queryByTestId("content")).toBeNull();
    expect(approvalCalls()).toHaveLength(0);
  });

  it("recovers an expired access token through refresh and still renders", async () => {
    const { auth, RequireAuth } = await boot({ plan: { me: "unauthorized", refresh: "ok" } });
    const { AuthProvider } = auth;
    const onMount = vi.fn();

    render(
      <AuthProvider>
        <RequireAuth>
          <Guarded onMount={onMount} />
        </RequireAuth>
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByTestId("content")).toBeInTheDocument());
    expect(calls.some((c) => c.url.includes("/auth/refresh"))).toBe(true);
    expect(onMount).toHaveBeenCalledTimes(1);
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it("clears the session and redirects when refresh also fails", async () => {
    const { api, auth, RequireAuth } = await boot({ plan: { me: "unauthorized", refresh: "fail" } });
    const { AuthProvider } = auth;
    const onMount = vi.fn();

    render(
      <AuthProvider>
        <RequireAuth>
          <Guarded onMount={onMount} />
        </RequireAuth>
      </AuthProvider>
    );

    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith("/login"));
    expect(onMount).not.toHaveBeenCalled();
    expect(api.getAccessToken()).toBeNull();
    expect(sessionStorage.getItem("jarvis_access")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. The real protected routes, through their real layouts
// ---------------------------------------------------------------------------

describe("protected routes end to end", () => {
  it("/approvals loads its data with the restored session", async () => {
    const { auth } = await boot();
    const { AuthProvider } = auth;
    const ApprovalsLayout = (await import("../src/app/approvals/layout")).default;
    const ApprovalsPage = (await import("../src/app/approvals/page")).default;

    render(
      <AuthProvider>
        <ApprovalsLayout>
          <ApprovalsPage />
        </ApprovalsLayout>
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByTestId("approvals-empty")).toBeInTheDocument());

    const first = approvalCalls()[0];
    expect(first).toBeDefined();
    expect(first.authorization).toBe(`Bearer ${ACCESS}`);
    expect(screen.queryByTestId("approvals-error")).toBeNull();
  });

  it("/approvals issues no request at all without a session", async () => {
    const { auth } = await boot({ session: false });
    const { AuthProvider } = auth;
    const ApprovalsLayout = (await import("../src/app/approvals/layout")).default;
    const ApprovalsPage = (await import("../src/app/approvals/page")).default;

    render(
      <AuthProvider>
        <ApprovalsLayout>
          <ApprovalsPage />
        </ApprovalsLayout>
      </AuthProvider>
    );

    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith("/login"));
    expect(approvalCalls()).toHaveLength(0);
  });

  it("/opportunities is guarded by the same layout contract", async () => {
    const { auth } = await boot({ session: false });
    const { AuthProvider } = auth;
    const OpportunitiesLayout = (await import("../src/app/opportunities/layout")).default;

    render(
      <AuthProvider>
        <OpportunitiesLayout>
          <p data-testid="opps">opportunities</p>
        </OpportunitiesLayout>
      </AuthProvider>
    );

    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith("/login"));
    expect(screen.queryByTestId("opps")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. Login -> protected route, the path that already worked
// ---------------------------------------------------------------------------

describe("login then navigate", () => {
  it("stores the session and serves it to a protected request", async () => {
    const { api } = await boot({ session: false });

    global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, method: init?.method ?? "GET", authorization: headers["Authorization"] });

      if (url.includes("/auth/login")) {
        return Promise.resolve({
          status: 200,
          ok: true,
          json: () => Promise.resolve({
            success: true,
            data: {
              user: { id: "user-1", email: "person@jarvis.local", name: "Person", role: "member", createdAt: "", updatedAt: "" },
              tokens: { accessToken: "fresh-access", refreshToken: "fresh-refresh", expiresIn: 900 },
            },
            timestamp: new Date().toISOString(),
          }),
        } as Response);
      }
      return Promise.resolve({
        status: headers["Authorization"] ? 200 : 401,
        ok: !!headers["Authorization"],
        json: () => Promise.resolve({ success: !!headers["Authorization"], data: [], timestamp: "" }),
      } as Response);
    }) as unknown as typeof fetch;

    const res = await api.login("person@jarvis.local", "pw");
    expect(res.success).toBe(true);
    api.setTokens(res.data!.tokens.accessToken, res.data!.tokens.refreshToken);

    await api.listApprovals();
    const first = approvalCalls()[0];
    expect(first.authorization).toBe("Bearer fresh-access");
    expect(sessionStorage.getItem("jarvis_access")).toBe("fresh-access");
  });
});
