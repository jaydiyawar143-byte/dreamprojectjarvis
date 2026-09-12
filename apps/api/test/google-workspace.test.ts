// ---------------------------------------------------------------------------
// Phase 12 — Gmail, Drive and Calendar reads.
//
// The provider is mocked; the PRODUCTION CODE PATH IS NOT. Every test below
// drives the real `GoogleWorkspaceTaskService`, the real service classes and
// the real `callGoogle`, with only `fetch` replaced. So the URLs, the field
// masks, the normalization and the error classification under test are exactly
// the ones that run against Google.
//
// What is pinned, and why each matters:
//
//   - the five statuses are distinguished, because they have different remedies
//     and collapsing them makes an assistant retry a revoked grant forever
//   - a missing SCOPE is not a missing CONNECTION
//   - a 401 is never a provider_error
//   - a timeout is reported, not hung
//   - an empty inbox is a SUCCESS, not a failure
//   - no token reaches a response, a log or an audit row
//   - no write action exists at all
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GoogleConfig } from "@jarvis/google-ads";
import type { GoogleCredentials, GoogleConnectionSummary } from "@jarvis/core";
import { GOOGLE_TASK_ACTIONS } from "@jarvis/core";
import { GmailService, GoogleDriveService, GoogleCalendarService } from "@jarvis/google-workspace";
import { GoogleWorkspaceTaskService } from "../src/services/google/workspace-service.js";

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

const ACCESS_TOKEN = "ya29.SUPER-SECRET-ACCESS-TOKEN-value";
const REFRESH_TOKEN = "1//SUPER-SECRET-REFRESH-TOKEN-value";

const CONFIG: GoogleConfig = {
  clientId: "client-id.apps.googleusercontent.com",
  clientSecret: "client-secret-value",
  redirectUri: "http://localhost:3001/api/v1/google/callback",
  developerToken: "",
  apiVersion: "v18",
  timeoutMs: 5_000,
};

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

function connections(options: {
  scopes?: string[];
  expiresAt?: Date;
  connected?: boolean;
  refreshFails?: boolean;
}) {
  const connected = options.connected ?? true;
  const summary: GoogleConnectionSummary = {
    id: "conn-1",
    userId: "u1",
    googleAccountEmail: "operator@example.com",
    scopes: options.scopes ?? [GMAIL_SCOPE, DRIVE_SCOPE, CALENDAR_SCOPE],
    connectedAt: new Date("2026-01-01"),
    expiresAt: options.expiresAt ?? new Date(Date.now() + 3_600_000),
    revokedAt: null,
  };

  const credentials: GoogleCredentials = {
    accessToken: ACCESS_TOKEN,
    refreshToken: REFRESH_TOKEN,
    expiresAt: options.expiresAt ?? new Date(Date.now() + 3_600_000),
    scopes: summary.scopes,
  };

  return {
    updated: [] as Array<{ accessToken: string }>,
    async findByUser() {
      return connected ? summary : null;
    },
    async getCredentials() {
      return connected ? credentials : null;
    },
    async updateAccessToken(_u: string, accessToken: string) {
      this.updated.push({ accessToken });
    },
    async save() {
      return summary;
    },
    async revoke() {},
  };
}

function auditLogger() {
  const rows: Array<{ action: string; result: string; metadata?: Record<string, unknown> }> = [];
  return { rows, log: vi.fn(async (e: never) => void rows.push(e)), query: vi.fn(async () => []) };
}

const allowAll = {
  async check(_u: string, _b: string, limit: number) {
    return { allowed: true, currentCount: 0, limit };
  },
};

const enabled = { async isEnabled() { return true; } };

/** A fetch double returning a fixed JSON body per URL substring. */
/**
 * Decodes a URL for assertion.
 *
 * `URLSearchParams` encodes a space as `+`, which `decodeURIComponent` leaves
 * alone — so a naive decode turns `is:unread in:inbox` into
 * `is:unread+in:inbox` and every query assertion fails for the wrong reason.
 */
function decodeUrl(url: string): string {
  return decodeURIComponent(url.replace(/\+/g, " "));
}

function fetchStub(routes: Array<{ match: string; status?: number; body: unknown }>) {
  const calls: string[] = [];
  const headers: Array<Record<string, string>> = [];

  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    calls.push(href);
    headers.push((init?.headers ?? {}) as Record<string, string>);

    const route = routes.find((r) => href.includes(r.match));
    const status = route?.status ?? (route ? 200 : 404);

    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(route?.body ?? { error: { message: "not stubbed" } }),
    } as Response;
  });

  return { impl: impl as unknown as typeof fetch, calls, headers };
}

function serviceWith(options: {
  fetchImpl?: typeof fetch;
  conns?: ReturnType<typeof connections>;
  config?: GoogleConfig | null;
  rateLimiter?: typeof allowAll;
  isEnabled?: boolean;
}) {
  const audit = auditLogger();
  const conns = options.conns ?? connections({});

  const service = new GoogleWorkspaceTaskService({
    connections: conns as never,
    config: options.config === undefined ? CONFIG : options.config,
    audit: audit as never,
    rateLimiter: options.rateLimiter ?? allowAll,
    integrationState:
      options.isEnabled === false ? { async isEnabled() { return false; } } : enabled,
    ...(options.fetchImpl
      ? {
          gmail: new GmailService({ fetchImpl: options.fetchImpl }),
          drive: new GoogleDriveService({ fetchImpl: options.fetchImpl }),
          calendar: new GoogleCalendarService({ fetchImpl: options.fetchImpl }),
        }
      : {}),
  });

  return { service, audit, conns };
}

const GMAIL_LIST_BODY = {
  messages: [{ id: "m1" }],
  resultSizeEstimate: 1,
};

const GMAIL_MESSAGE_BODY = {
  id: "m1",
  threadId: "t1",
  snippet: "Quarterly numbers attached",
  labelIds: ["UNREAD", "INBOX"],
  internalDate: "1789000000000",
  payload: {
    headers: [
      { name: "From", value: "Priya <priya@example.com>" },
      { name: "To", value: "operator@example.com" },
      { name: "Subject", value: "Q3 numbers" },
    ],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------

describe("Gmail reads", () => {
  it("lists unread inbox messages and normalizes them", async () => {
    const stub = fetchStub([
      { match: "/messages?", body: GMAIL_LIST_BODY },
      { match: "/messages/m1", body: GMAIL_MESSAGE_BODY },
    ]);
    const { service } = serviceWith({ fetchImpl: stub.impl });

    const result = await service.executeTask(
      { action: "gmail.listUnread", params: { limit: 5 } },
      { userId: "u1", source: "frontend" }
    );

    expect(result.success).toBe(true);
    expect(result.status).toBe("ok");
    expect(result.source).toBe("gmail");

    const data = result.data as { messages: Array<Record<string, unknown>> };
    expect(data.messages).toHaveLength(1);
    expect(data.messages[0]).toMatchObject({
      id: "m1",
      from: "Priya <priya@example.com>",
      subject: "Q3 numbers",
      unread: true,
    });
    // internalDate, not the sender's Date header.
    expect(data.messages[0]!.receivedAt).toBe(new Date(1789000000000).toISOString());
  });

  it("queries the inbox specifically, not all unread mail", async () => {
    // Without `in:inbox` this returns unread spam and archived threads, which
    // is not what anyone means by "unread emails".
    const stub = fetchStub([{ match: "/messages?", body: { messages: [] } }]);
    const { service } = serviceWith({ fetchImpl: stub.impl });

    await service.executeTask({ action: "gmail.listUnread" }, { userId: "u1", source: "jarvis" });

    const listUrl = stub.calls.find((c) => c.includes("/messages?"))!;
    expect(decodeUrl(listUrl)).toContain("is:unread in:inbox");
  });

  it("reports an empty inbox as SUCCESS, not as a failure", async () => {
    const stub = fetchStub([{ match: "/messages?", body: { messages: [], resultSizeEstimate: 0 } }]);
    const { service } = serviceWith({ fetchImpl: stub.impl });

    const result = await service.executeTask(
      { action: "gmail.listUnread" },
      { userId: "u1", source: "frontend" }
    );

    // An empty inbox is good news and a successful read of nothing.
    expect(result.success).toBe(true);
    expect(result.status).toBe("ok");
    expect((result.data as { messages: unknown[] }).messages).toEqual([]);
    expect(result.message).toMatch(/no unread/i);
  });

  it("passes a search query through as a parameter", async () => {
    const stub = fetchStub([
      { match: "/messages?", body: GMAIL_LIST_BODY },
      { match: "/messages/m1", body: GMAIL_MESSAGE_BODY },
    ]);
    const { service } = serviceWith({ fetchImpl: stub.impl });

    await service.executeTask(
      { action: "gmail.search", params: { query: "from:priya has:attachment" } },
      { userId: "u1", source: "jarvis" }
    );

    const listUrl = stub.calls.find((c) => c.includes("/messages?"))!;
    expect(decodeUrl(listUrl)).toContain("from:priya has:attachment");
    // The query never becomes part of the path.
    expect(listUrl).toContain("gmail.googleapis.com/gmail/v1/users/me/messages?");
  });

  it("does not fetch bodies when listing", async () => {
    const stub = fetchStub([
      { match: "/messages?", body: GMAIL_LIST_BODY },
      { match: "/messages/m1", body: GMAIL_MESSAGE_BODY },
    ]);
    const { service } = serviceWith({ fetchImpl: stub.impl });

    await service.executeTask({ action: "gmail.listUnread" }, { userId: "u1", source: "frontend" });

    // `format=metadata`: fifty full bodies to show fifty subjects would move a
    // great deal of private content for no benefit.
    const hydrate = stub.calls.find((c) => c.includes("/messages/m1"))!;
    expect(hydrate).toContain("format=metadata");
    expect(hydrate).not.toContain("format=full");
  });

  it("decodes a body only when one message is opened", async () => {
    const body = Buffer.from("Hello from the body", "utf-8").toString("base64url");
    const stub = fetchStub([
      {
        match: "/messages/m1",
        body: {
          ...GMAIL_MESSAGE_BODY,
          payload: {
            ...GMAIL_MESSAGE_BODY.payload,
            mimeType: "text/plain",
            body: { data: body },
          },
        },
      },
    ]);
    const { service } = serviceWith({ fetchImpl: stub.impl });

    const result = await service.executeTask(
      { action: "gmail.getMessage", params: { messageId: "m1" } },
      { userId: "u1", source: "frontend" }
    );

    expect(result.success).toBe(true);
    expect((result.data as { body: string }).body).toBe("Hello from the body");
    expect(stub.calls.some((c) => c.includes("format=full"))).toBe(true);
  });

  it("strips HTML to text rather than returning markup", async () => {
    // Returning provider HTML for the dashboard to render would hand an
    // injection surface to anyone who can email the user.
    const html = Buffer.from(
      "<div><script>alert(1)</script><p>Real <b>content</b></p></div>",
      "utf-8"
    ).toString("base64url");

    const stub = fetchStub([
      {
        match: "/messages/m1",
        body: {
          ...GMAIL_MESSAGE_BODY,
          payload: {
            ...GMAIL_MESSAGE_BODY.payload,
            mimeType: "multipart/alternative",
            parts: [{ mimeType: "text/html", body: { data: html } }],
          },
        },
      },
    ]);
    const { service } = serviceWith({ fetchImpl: stub.impl });

    const result = await service.executeTask(
      { action: "gmail.getMessage", params: { messageId: "m1" } },
      { userId: "u1", source: "frontend" }
    );

    const text = (result.data as { body: string }).body;
    expect(text).toContain("Real");
    expect(text).not.toContain("<script>");
    expect(text).not.toContain("alert(1)");
    expect(text).not.toContain("<b>");
  });
});

// ---------------------------------------------------------------------------

describe("Drive reads", () => {
  const DRIVE_BODY = {
    files: [
      {
        id: "f1",
        name: "Q3 Review.pptx",
        mimeType: "application/vnd.google-apps.presentation",
        modifiedTime: "2026-09-01T10:00:00Z",
        owners: [{ displayName: "Operator" }],
        webViewLink: "https://drive.google.com/file/d/f1/view",
        shared: true,
      },
    ],
  };

  it("normalizes a MIME type into a readable kind", async () => {
    const stub = fetchStub([{ match: "drive/v3/files", body: DRIVE_BODY }]);
    const { service } = serviceWith({ fetchImpl: stub.impl });

    const result = await service.executeTask(
      { action: "drive.listRecentFiles" },
      { userId: "u1", source: "frontend" }
    );

    expect(result.success).toBe(true);
    const files = (result.data as { files: Array<Record<string, unknown>> }).files;
    // "application/vnd.google-apps.presentation" is not something to show a
    // person; "Google Slides" is.
    expect(files[0]).toMatchObject({ name: "Q3 Review.pptx", kind: "Google Slides" });
  });

  it("reads 'presentation' as a KIND filter, not just a name match", async () => {
    // "Drive mein presentation dhoondo" means "find my presentations".
    const stub = fetchStub([{ match: "drive/v3/files", body: DRIVE_BODY }]);
    const { service } = serviceWith({ fetchImpl: stub.impl });

    await service.executeTask(
      { action: "drive.searchFiles", params: { query: "presentation" } },
      { userId: "u1", source: "jarvis" }
    );

    const url = decodeUrl(stub.calls[0]!);
    expect(url).toContain("mimeType = 'application/vnd.google-apps.presentation'");
    expect(url).toContain("trashed = false");
  });

  it("escapes an apostrophe in a filename instead of breaking the query", async () => {
    const stub = fetchStub([{ match: "drive/v3/files", body: { files: [] } }]);
    const { service } = serviceWith({ fetchImpl: stub.impl });

    await service.executeTask(
      { action: "drive.searchFiles", params: { query: "O'Brien deck" } },
      { userId: "u1", source: "jarvis" }
    );

    const url = decodeUrl(stub.calls[0]!);
    expect(url).toContain("O\\'Brien");
  });

  it("excludes trashed files and folders from recent files", async () => {
    const stub = fetchStub([{ match: "drive/v3/files", body: DRIVE_BODY }]);
    const { service } = serviceWith({ fetchImpl: stub.impl });

    await service.executeTask(
      { action: "drive.listRecentFiles" },
      { userId: "u1", source: "frontend" }
    );

    const url = decodeUrl(stub.calls[0]!);
    expect(url).toContain("trashed = false");
    // Folders would otherwise dominate for anyone who reorganises their Drive.
    expect(url).toContain("mimeType != 'application/vnd.google-apps.folder'");
  });

  it("never requests file CONTENT", async () => {
    const stub = fetchStub([{ match: "drive/v3/files", body: DRIVE_BODY }]);
    const { service } = serviceWith({ fetchImpl: stub.impl });

    await service.executeTask(
      { action: "drive.listRecentFiles" },
      { userId: "u1", source: "frontend" }
    );

    // `alt=media` is the content download. This phase is metadata only.
    expect(stub.calls.every((c) => !c.includes("alt=media"))).toBe(true);
  });

  it("distinguishes no size from a size of zero", async () => {
    const stub = fetchStub([
      { match: "drive/v3/files", body: { files: [{ ...DRIVE_BODY.files[0], size: undefined }] } },
    ]);
    const { service } = serviceWith({ fetchImpl: stub.impl });

    const result = await service.executeTask(
      { action: "drive.listRecentFiles" },
      { userId: "u1", source: "frontend" }
    );

    // Google Workspace native files genuinely have no size.
    expect((result.data as { files: Array<{ sizeBytes: null }> }).files[0]!.sizeBytes).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("Calendar reads", () => {
  const EVENTS_BODY = {
    items: [
      {
        id: "e1",
        summary: "Standup",
        start: { dateTime: "2026-09-13T09:00:00Z" },
        end: { dateTime: "2026-09-13T09:15:00Z" },
        status: "confirmed",
        attendees: [{ email: "a@example.com", responseStatus: "accepted" }],
      },
      {
        id: "e2",
        summary: "Cancelled thing",
        start: { dateTime: "2026-09-13T10:00:00Z" },
        end: { dateTime: "2026-09-13T11:00:00Z" },
        status: "cancelled",
      },
      {
        id: "e3",
        summary: "Holiday",
        start: { date: "2026-09-14" },
        end: { date: "2026-09-15" },
        status: "confirmed",
      },
    ],
  };

  it("expands recurring events and orders by start time", async () => {
    // Without singleEvents a weekly standup appears once with a recurrence
    // rule, and "meri next meetings" is wrong for anyone with a repeating
    // calendar — which is everyone.
    const stub = fetchStub([{ match: "calendar/v3", body: EVENTS_BODY }]);
    const { service } = serviceWith({ fetchImpl: stub.impl });

    await service.executeTask(
      { action: "calendar.listUpcomingEvents" },
      { userId: "u1", source: "jarvis" }
    );

    const url = decodeUrl(stub.calls[0]!);
    expect(url).toContain("singleEvents=true");
    expect(url).toContain("orderBy=startTime");
    // Always bounded: without timeMin, Google returns events from the
    // beginning of the calendar.
    expect(url).toContain("timeMin=");
    expect(url).toContain("timeMax=");
  });

  it("excludes cancelled occurrences", async () => {
    const stub = fetchStub([{ match: "calendar/v3", body: EVENTS_BODY }]);
    const { service } = serviceWith({ fetchImpl: stub.impl });

    const result = await service.executeTask(
      { action: "calendar.listUpcomingEvents" },
      { userId: "u1", source: "frontend" }
    );

    const ids = (result.data as { events: Array<{ id: string }> }).events.map((e) => e.id);
    expect(ids).toContain("e1");
    expect(ids).not.toContain("e2");
  });

  it("flags an all-day event rather than placing it at midnight", async () => {
    const stub = fetchStub([{ match: "calendar/v3", body: EVENTS_BODY }]);
    const { service } = serviceWith({ fetchImpl: stub.impl });

    const result = await service.executeTask(
      { action: "calendar.listUpcomingEvents" },
      { userId: "u1", source: "frontend" }
    );

    const events = (result.data as { events: Array<{ id: string; allDay: boolean; start: string }> })
      .events;
    const holiday = events.find((e) => e.id === "e3")!;
    // Converting a bare date to an instant shifts it a day for anyone west
    // of UTC, so it is flagged and passed through as given.
    expect(holiday.allDay).toBe(true);
    expect(holiday.start).toBe("2026-09-14");
  });

  it("honours a one-day window for 'kal ka calendar'", async () => {
    const stub = fetchStub([{ match: "calendar/v3", body: { items: [] } }]);
    const { service } = serviceWith({ fetchImpl: stub.impl });

    await service.executeTask(
      {
        action: "calendar.listUpcomingEvents",
        params: { windowDays: 1, fromIso: "2026-09-13T00:00:00Z" },
      },
      { userId: "u1", source: "jarvis" }
    );

    const url = decodeUrl(stub.calls[0]!);
    expect(url).toContain("timeMin=2026-09-13T00:00:00.000Z");
    expect(url).toContain("timeMax=2026-09-14T00:00:00.000Z");
  });

  it("returns the window it actually queried", async () => {
    const stub = fetchStub([{ match: "calendar/v3", body: { items: [] } }]);
    const { service } = serviceWith({ fetchImpl: stub.impl });

    const result = await service.executeTask(
      { action: "calendar.listUpcomingEvents", params: { windowDays: 3 } },
      { userId: "u1", source: "frontend" }
    );

    const data = result.data as { from: string; to: string };
    expect(Date.parse(data.to) - Date.parse(data.from)).toBe(3 * 86_400_000);
  });
});

// ---------------------------------------------------------------------------

describe("the five statuses are distinguished", () => {
  it("not_connected when no Google account is connected", async () => {
    const { service } = serviceWith({ conns: connections({ connected: false }) });

    const result = await service.executeTask(
      { action: "gmail.listUnread" },
      { userId: "u1", source: "frontend" }
    );

    expect(result.status).toBe("not_connected");
    expect(result.success).toBe(false);
    expect(result.requiredAction).toMatch(/connect your google account/i);
  });

  it("not_connected when the server has no OAuth client", async () => {
    const { service } = serviceWith({ config: null });

    const result = await service.executeTask(
      { action: "gmail.listUnread" },
      { userId: "u1", source: "frontend" }
    );

    expect(result.status).toBe("not_connected");
    expect(result.requiredAction).toMatch(/GOOGLE_CLIENT_ID/);
  });

  it("permission_missing when connected WITHOUT the service scope", async () => {
    // The default connection is Ads-only, which is the progressive-consent
    // default — so Gmail must be refused with the right remedy, not a 403
    // nobody can explain.
    const { service } = serviceWith({
      conns: connections({ scopes: ["https://www.googleapis.com/auth/adwords"] }),
    });

    const result = await service.executeTask(
      { action: "gmail.listUnread" },
      { userId: "u1", source: "frontend" }
    );

    expect(result.status).toBe("permission_missing");
    expect(result.message).toMatch(/does not include Gmail/i);
    expect(result.requiredAction).toMatch(/reconnect/i);
  });

  it("checks the scope BEFORE spending a token refresh", async () => {
    const stub = fetchStub([]);
    const conns = connections({
      scopes: [DRIVE_SCOPE],
      expiresAt: new Date(Date.now() - 1000), // expired
    });
    const { service } = serviceWith({ conns, fetchImpl: stub.impl });

    const result = await service.executeTask(
      { action: "gmail.listUnread" },
      { userId: "u1", source: "frontend" }
    );

    expect(result.status).toBe("permission_missing");
    // No refresh attempted: a refresh spent on a call that cannot succeed is
    // waste, and it would surface as a confusing failure.
    expect(conns.updated).toHaveLength(0);
  });

  it("needs_reauth when the refresh is refused", async () => {
    // Token expired AND the refresh exchange fails.
    const refreshFails = vi.fn(async () => ({
      status: 400,
      text: async () => JSON.stringify({ error: "invalid_grant" }),
    })) as unknown as typeof fetch;

    const conns = connections({ expiresAt: new Date(Date.now() - 1000) });
    const audit = auditLogger();

    const service = new GoogleWorkspaceTaskService({
      connections: conns as never,
      config: CONFIG,
      audit: audit as never,
      rateLimiter: allowAll,
      integrationState: enabled,
      gmail: new GmailService({ fetchImpl: refreshFails }),
    });

    // `resolveAccess` uses the ambient fetch for the refresh, so it is stubbed
    // globally for this one case.
    const original = globalThis.fetch;
    globalThis.fetch = refreshFails;
    try {
      const result = await service.executeTask(
        { action: "gmail.listUnread" },
        { userId: "u1", source: "frontend" }
      );

      expect(result.status).toBe("needs_reauth");
      // Critically NOT provider_error: retrying a revoked grant loops forever.
      expect(result.status).not.toBe("provider_error");
      expect(result.requiredAction).toMatch(/reconnect/i);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("needs_reauth on a provider 401, never provider_error", async () => {
    const stub = fetchStub([
      { match: "/messages?", status: 401, body: { error: { message: "Invalid Credentials" } } },
    ]);
    const { service } = serviceWith({ fetchImpl: stub.impl });

    const result = await service.executeTask(
      { action: "gmail.listUnread" },
      { userId: "u1", source: "frontend" }
    );

    expect(result.status).toBe("needs_reauth");
  });

  it("permission_missing on a 403 with an insufficient-scope reason", async () => {
    const stub = fetchStub([
      {
        match: "/messages?",
        status: 403,
        body: {
          error: {
            message: "Request had insufficient authentication scopes.",
            errors: [{ reason: "insufficientPermissions" }],
          },
        },
      },
    ]);
    const { service } = serviceWith({ fetchImpl: stub.impl });

    const result = await service.executeTask(
      { action: "gmail.listUnread" },
      { userId: "u1", source: "frontend" }
    );

    expect(result.status).toBe("permission_missing");
  });

  it("provider_error on a 500, which a retry might fix", async () => {
    const stub = fetchStub([{ match: "/messages?", status: 500, body: {} }]);
    const { service } = serviceWith({ fetchImpl: stub.impl });

    const result = await service.executeTask(
      { action: "gmail.listUnread" },
      { userId: "u1", source: "frontend" }
    );

    expect(result.status).toBe("provider_error");
  });

  it("provider_error with a timeout message when Google does not respond", async () => {
    // Never hangs: a held-open request shows the user nothing at all.
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

    const service = new GoogleWorkspaceTaskService({
      connections: connections({}) as never,
      config: CONFIG,
      audit: auditLogger() as never,
      rateLimiter: allowAll,
      integrationState: enabled,
      gmail: new GmailService({ fetchImpl: hang, timeoutMs: 30 }),
    });

    const result = await service.executeTask(
      { action: "gmail.listUnread" },
      { userId: "u1", source: "frontend" }
    );

    expect(result.status).toBe("provider_error");
    expect(result.message).toMatch(/did not respond/i);
  });

  it("refuses when the integration is switched off", async () => {
    const { service } = serviceWith({ isEnabled: false });

    const result = await service.executeTask(
      { action: "gmail.listUnread" },
      { userId: "u1", source: "frontend" }
    );

    expect(result.status).toBe("not_connected");
    expect(result.requiredAction).toMatch(/enable google/i);
  });

  it("rate-limits before calling the provider", async () => {
    const stub = fetchStub([{ match: "/messages?", body: GMAIL_LIST_BODY }]);
    const { service } = serviceWith({
      fetchImpl: stub.impl,
      rateLimiter: {
        async check(_u, _b, limit) {
          return { allowed: false, currentCount: limit, limit };
        },
      },
    });

    const result = await service.executeTask(
      { action: "gmail.listUnread" },
      { userId: "u1", source: "frontend" }
    );

    expect(result.status).toBe("provider_error");
    expect(result.message).toMatch(/too many/i);
    // Nothing reached Google.
    expect(stub.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe("no secret escapes", () => {
  it("sends the token as a bearer header and nowhere else", async () => {
    const stub = fetchStub([
      { match: "/messages?", body: GMAIL_LIST_BODY },
      { match: "/messages/m1", body: GMAIL_MESSAGE_BODY },
    ]);
    const { service } = serviceWith({ fetchImpl: stub.impl });

    await service.executeTask({ action: "gmail.listUnread" }, { userId: "u1", source: "frontend" });

    // In the header, yes.
    expect(stub.headers[0]!.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    // In a URL, never — a token in a query string ends up in access logs.
    expect(stub.calls.every((c) => !c.includes(ACCESS_TOKEN))).toBe(true);
  });

  it("returns no token in a successful response", async () => {
    const stub = fetchStub([
      { match: "/messages?", body: GMAIL_LIST_BODY },
      { match: "/messages/m1", body: GMAIL_MESSAGE_BODY },
    ]);
    const { service } = serviceWith({ fetchImpl: stub.impl });

    const result = await service.executeTask(
      { action: "gmail.listUnread" },
      { userId: "u1", source: "frontend" }
    );

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(ACCESS_TOKEN);
    expect(serialized).not.toContain(REFRESH_TOKEN);
    expect(serialized).not.toContain(CONFIG.clientSecret);
  });

  it("returns no token in a failure response", async () => {
    const stub = fetchStub([
      { match: "/messages?", status: 401, body: { error: { message: "Invalid Credentials" } } },
    ]);
    const { service } = serviceWith({ fetchImpl: stub.impl });

    const result = await service.executeTask(
      { action: "gmail.listUnread" },
      { userId: "u1", source: "frontend" }
    );

    expect(JSON.stringify(result)).not.toContain(ACCESS_TOKEN);
  });

  it("puts no token or content in the audit row", async () => {
    const stub = fetchStub([
      { match: "/messages?", body: GMAIL_LIST_BODY },
      { match: "/messages/m1", body: GMAIL_MESSAGE_BODY },
    ]);
    const { service, audit } = serviceWith({ fetchImpl: stub.impl });

    await service.executeTask(
      { action: "gmail.search", params: { query: "from:secret-client@example.com" } },
      { userId: "u1", source: "jarvis" }
    );

    const serialized = JSON.stringify(audit.rows);
    expect(serialized).not.toContain(ACCESS_TOKEN);
    expect(serialized).not.toContain(REFRESH_TOKEN);
    // The SEARCH QUERY is the user's own private text and is not audited.
    expect(serialized).not.toContain("secret-client@example.com");
    // Nor is any subject line.
    expect(serialized).not.toContain("Q3 numbers");
  });

  it("strips a URL out of a provider error message", async () => {
    // A Gmail list URL carries the search query, so a message echoing one
    // would leak the user's own text into the UI.
    const stub = fetchStub([
      {
        match: "/messages?",
        status: 400,
        body: {
          error: { message: "Bad request for https://gmail.googleapis.com/...?q=secret-term" },
        },
      },
    ]);
    const { service } = serviceWith({ fetchImpl: stub.impl });

    const result = await service.executeTask(
      { action: "gmail.search", params: { query: "secret-term" } },
      { userId: "u1", source: "frontend" }
    );

    expect(result.message).not.toContain("secret-term");
    expect(result.message).toContain("[url]");
  });
});

// ---------------------------------------------------------------------------

describe("audit", () => {
  it("records the source, so a spoken read is distinguishable from a click", async () => {
    const stub = fetchStub([
      { match: "/messages?", body: GMAIL_LIST_BODY },
      { match: "/messages/m1", body: GMAIL_MESSAGE_BODY },
    ]);
    const { service, audit } = serviceWith({ fetchImpl: stub.impl });

    await service.executeTask({ action: "gmail.listUnread" }, { userId: "u1", source: "frontend" });
    await service.executeTask({ action: "gmail.listUnread" }, { userId: "u1", source: "jarvis" });

    const sources = audit.rows.map((r) => (r.metadata as { source?: string }).source);
    expect(sources).toContain("frontend");
    expect(sources).toContain("jarvis");
  });

  it("records a result COUNT rather than the results", async () => {
    const stub = fetchStub([
      { match: "/messages?", body: GMAIL_LIST_BODY },
      { match: "/messages/m1", body: GMAIL_MESSAGE_BODY },
    ]);
    const { service, audit } = serviceWith({ fetchImpl: stub.impl });

    await service.executeTask({ action: "gmail.listUnread" }, { userId: "u1", source: "frontend" });

    expect((audit.rows[0]!.metadata as { resultCount?: number }).resultCount).toBe(1);
  });

  it("records failures too", async () => {
    const { service, audit } = serviceWith({ conns: connections({ connected: false }) });

    await service.executeTask({ action: "gmail.listUnread" }, { userId: "u1", source: "frontend" });

    expect(audit.rows[0]!.result).toBe("failure");
    expect((audit.rows[0]!.metadata as { status?: string }).status).toBe("not_connected");
  });
});

// ---------------------------------------------------------------------------

describe("no write action exists", () => {
  it("exposes only read actions", async () => {
    // The closed action list IS the guarantee. A write cannot be reached
    // without first appearing here.
    for (const action of GOOGLE_TASK_ACTIONS) {
      expect(action).toMatch(
        /^(gmail\.(listUnread|search|getMessage|getThread)|drive\.(searchFiles|listRecentFiles|getFileMetadata)|calendar\.(listUpcomingEvents|getEvent))$/
      );
    }
  });

  it("names no send, delete, create or update action", async () => {
    for (const action of GOOGLE_TASK_ACTIONS) {
      expect(action).not.toMatch(/send|delete|create|update|modify|trash|insert|patch/i);
    }
  });

  it("refuses an unknown action before resolving any credential", async () => {
    const stub = fetchStub([]);
    const conns = connections({});
    const { service, audit } = serviceWith({ fetchImpl: stub.impl, conns });

    const result = await service.executeTask(
      { action: "gmail.sendMessage", params: { to: "victim@example.com" } },
      { userId: "u1", source: "jarvis" }
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not a supported Google task/i);
    // Nothing was called, and no token was resolved.
    expect(stub.calls).toHaveLength(0);
    // The attempt is still audited: a refused write attempt is worth seeing.
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.result).toBe("failure");
  });

  it("issues only GET requests", async () => {
    const methods: string[] = [];
    const recordMethod = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      methods.push(init?.method ?? "GET");
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ files: [], items: [], messages: [] }),
      } as Response;
    }) as unknown as typeof fetch;

    const { service } = serviceWith({ fetchImpl: recordMethod });

    for (const action of ["gmail.listUnread", "drive.listRecentFiles", "calendar.listUpcomingEvents"]) {
      await service.executeTask({ action }, { userId: "u1", source: "frontend" });
    }

    expect(methods.length).toBeGreaterThan(0);
    expect(methods.every((m) => m === "GET")).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("tenant isolation", () => {
  it("reads only the calling user's connection", async () => {
    const seen: string[] = [];
    const conns = {
      ...connections({}),
      async findByUser(userId: string) {
        seen.push(userId);
        return null;
      },
    };

    const { service } = serviceWith({ conns: conns as never });
    await service.executeTask({ action: "gmail.listUnread" }, { userId: "user-A", source: "jarvis" });

    expect(seen).toEqual(["user-A"]);
  });
});
