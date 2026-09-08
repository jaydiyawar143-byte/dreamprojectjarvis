// ---------------------------------------------------------------------------
// Sprint 4.1 — Auth / protected-route session stabilization.
// UI V2 — reworked for HttpOnly refresh-cookie sessions.
//
// Covers the B1 defect found in the Sprint 4.0 baseline: a hard load of a
// protected route fired its data fetch before the auth provider had resolved
// the session, so the page rendered "Authentication required" despite a
// perfectly valid session.
//
// WHAT CHANGED IN V2. The session no longer lives in sessionStorage; it lives
// in an HttpOnly cookie that script cannot read, and the access token is held
// in memory only. That closes an XSS exposure, and it is also what makes login
// survive a closed tab — sessionStorage never could.
//
// The consequence for these tests is that synchronous hydration is GONE and
// cannot come back: obtaining an access token now requires a network round trip
// (POST /auth/refresh, which the browser answers with the cookie). So the two
// guarantees are now:
//
//   1. A protected route's children do not mount until the session resolves,
//      so no authenticated request is issued in an unresolved state. This is
//      the guarantee that actually prevents the B1 defect.
//   2. A request that IS issued early still succeeds, because a 401 triggers a
//      transparent refresh-and-retry rather than an error page.
//
// Plus one new guarantee V2 adds: no token of any kind is written to web
// storage.
//
// Every test boots a fresh module registry, which is what makes these true
// "browser refresh" simulations rather than in-page navigations.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, afterEach } from "vitest";
import React, { useEffect, useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";

/** What POST /auth/refresh hands back on the first (bootstrap) exchange. */
const ACCESS = "access-token-abc";
/** What a SECOND refresh hands back, after the first token is rejected. */
const ROTATED = "access-token-rotated";

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
  // Counts exchanges so the second one can rotate, which is how an expired
  // access token is distinguished from a dead session.
  let refreshes = 0;

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
      // "refresh: fail" IS the no-session case: the browser either holds no
      // cookie or holds an expired one, and the server refuses it.
      if (refresh !== "ok") {
        return json(401, {
          success: false,
          error: { code: "TOKEN_EXPIRED", message: "Refresh token expired" },
          timestamp: new Date().toISOString(),
        });
      }
      const accessToken = refreshes === 0 ? ACCESS : ROTATED;
      refreshes += 1;
      // NOTE: no refreshToken in the body. The real API withholds it from a
      // cookie-mode client and sets it as HttpOnly instead; a test double that
      // returned one would be asserting a contract the server does not honour.
      return json(200, {
        success: true,
        data: { accessToken, expiresIn: 900 },
        timestamp: new Date().toISOString(),
      });
    }

    if (url.includes("/auth/me")) {
      // Models an access token that expired in flight: the bootstrap token is
      // refused, the rotated one that follows it is accepted.
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

/**
 * Simulates a fresh document.
 *
 * `session: true` means the browser still holds a valid HttpOnly refresh
 * cookie — which, since script cannot read it, is expressed the only way it
 * can be: the refresh exchange succeeds. Nothing is seeded into web storage,
 * because V2 puts nothing there.
 */
async function boot(options: { session?: boolean; plan?: FetchPlan } = {}) {
  const { session = true, plan = {} } = options;

  vi.resetModules();
  calls = [];
  routerPush.mockClear();
  routerReplace.mockClear();
  sessionStorage.clear();
  localStorage.clear();

  installFetch({ ...plan, refresh: plan.refresh ?? (session ? "ok" : "fail") });

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
// 1. Session restore from the refresh cookie
// ---------------------------------------------------------------------------

describe("session hydration on a fresh document", () => {
  it("starts with no token and obtains one by redeeming the cookie", async () => {
    const { api } = await boot();

    // Module evaluation alone CANNOT restore the session in V2: the token is
    // not in storage, it is behind a network exchange the browser authenticates
    // with a cookie this code cannot see.
    expect(api.getAccessToken()).toBeNull();

    await expect(api.bootstrapSession()).resolves.toBe(true);
    expect(api.getAccessToken()).toBe(ACCESS);
  });

  it("writes no credential of any kind to web storage", async () => {
    const { api } = await boot();
    await api.bootstrapSession();

    // The whole point of the cookie: an XSS that can read storage finds
    // nothing worth having.
    const stored = [
      ...Object.keys(sessionStorage),
      ...Object.keys(localStorage),
    ];
    expect(stored).not.toContain("jarvis_access");
    expect(stored).not.toContain("jarvis_refresh");

    const values = [
      ...Object.keys(sessionStorage).map((k) => sessionStorage.getItem(k)),
      ...Object.keys(localStorage).map((k) => localStorage.getItem(k)),
    ];
    expect(values).not.toContain(ACCESS);
  });

  it("removes tokens left in storage by the previous version", async () => {
    vi.resetModules();
    sessionStorage.clear();
    localStorage.clear();
    // A browser upgrading from the pre-V2 build is still holding a real
    // refresh token. Leaving it would preserve the exposure the cookie exists
    // to remove, so importing the module must clear it.
    sessionStorage.setItem("jarvis_access", "stale-access");
    sessionStorage.setItem("jarvis_refresh", "stale-refresh");

    installFetch();
    await import("../src/lib/api");

    expect(sessionStorage.getItem("jarvis_access")).toBeNull();
    expect(sessionStorage.getItem("jarvis_refresh")).toBeNull();
  });

  it("leaves the token null when the cookie is absent or expired", async () => {
    const { api } = await boot({ session: false });
    await expect(api.bootstrapSession()).resolves.toBe(false);
    expect(api.getAccessToken()).toBeNull();
  });

  it("survives a browser that refuses web storage", async () => {
    vi.resetModules();
    sessionStorage.clear();
    const getItem = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new DOMException("The operation is insecure.", "SecurityError");
      });
    const removeItem = vi
      .spyOn(Storage.prototype, "removeItem")
      .mockImplementation(() => {
        throw new DOMException("The operation is insecure.", "SecurityError");
      });
    installFetch();
    // Must not throw while importing the module. Blocked storage is survivable
    // in V2 precisely because no credential depends on it.
    const api = await import("../src/lib/api");
    expect(api.getAccessToken()).toBeNull();
    await expect(api.bootstrapSession()).resolves.toBe(true);
    getItem.mockRestore();
    removeItem.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 2. An early request must still succeed
//
// V2 cannot promise the FIRST request carries a token — the token is behind a
// network exchange. It promises the request still succeeds: a 401 triggers a
// transparent refresh-and-retry. In the real app RequireAuth (section 3) stops
// protected pages mounting this early at all; this section covers the case
// where something slips through anyway.
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

  it("recovers a request issued before the session resolved", async () => {
    const { api, auth } = await boot();
    const { AuthProvider } = auth;

    render(
      <AuthProvider>
        <EagerProbe call={() => api.listApprovals("pending", 1)} />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("done"));

    // It is retried, and the retry carries a bearer token. What must NOT
    // happen is the B1 defect: giving up and rendering "Authentication
    // required" while a valid session exists.
    const authorized = approvalCalls().filter((c) => c.authorization !== undefined);
    expect(authorized.length).toBeGreaterThan(0);
    expect(authorized.some((c) => c.authorization === `Bearer ${ACCESS}`)).toBe(true);
  });

  it("shares one refresh across simultaneous unauthenticated requests", async () => {
    const { api, auth } = await boot();
    const { AuthProvider } = auth;

    render(
      <AuthProvider>
        <EagerProbe
          call={() => Promise.all([api.listApprovals(), api.listApprovals(), api.listApprovals()])}
        />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("done"));

    // Each refresh ROTATES the server-side token, so racing refreshes would
    // invalidate one another and log the user out. Exactly one exchange must
    // serve them all.
    const refreshCalls = calls.filter((c) => c.url.includes("/auth/refresh"));
    expect(refreshCalls).toHaveLength(1);
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

  it("never mounts children and redirects to login without a valid cookie", async () => {
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
              // Cookie-mode login: the refresh token is set as an HttpOnly
              // cookie and deliberately withheld from the body.
              tokens: { accessToken: "fresh-access", expiresIn: 900 },
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
    expect(res.data!.tokens).not.toHaveProperty("refreshToken");
    api.setAccessToken(res.data!.tokens.accessToken);

    await api.listApprovals();
    const first = approvalCalls()[0];
    expect(first.authorization).toBe("Bearer fresh-access");
    // Held in memory, never written down.
    expect(api.getAccessToken()).toBe("fresh-access");
    expect(sessionStorage.getItem("jarvis_access")).toBeNull();
  });
});
