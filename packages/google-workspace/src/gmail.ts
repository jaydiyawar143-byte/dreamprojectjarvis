// ---------------------------------------------------------------------------
// GmailService — read-only.
//
// Four actions, all GETs: list unread, search, get one message, get a thread.
// There is no send, no draft, no delete and no label mutation, and the module
// has no way to express one — `callGoogle` only issues GETs.
//
// PRIVACY SHAPES THE RETURN TYPES. A list returns Google's own `snippet` and
// never a body: fifty full message bodies is a large amount of private content
// to move, cache and log for a view that shows subjects. The body is fetched
// only by `getMessage`, for one message the user explicitly opened.
//
// HTML IS NEVER RETURNED AS HTML. A message body is decoded to plain text, and
// an HTML-only message is stripped to text. Returning provider HTML for the
// dashboard to render would be an injection surface handed to anyone who can
// email the user — which is everyone.
// ---------------------------------------------------------------------------

import type {
  GmailListResult,
  GmailMessageDetail,
  GmailMessageSummary,
  GmailThread,
} from "@jarvis/core";
import { buildUrl, callGoogle, type GoogleCallOutcome } from "./http.js";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Hard ceiling on how many messages one call will fetch. */
const MAX_RESULTS = 25;

// ---------------------------------------------------------------------------
// Provider payload shapes (only the fields actually read)
// ---------------------------------------------------------------------------

interface RawHeader {
  name?: string;
  value?: string;
}

interface RawPart {
  mimeType?: string;
  filename?: string;
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: RawPart[];
  headers?: RawHeader[];
}

interface RawMessage {
  id?: string;
  threadId?: string;
  snippet?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: RawPart;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function header(message: RawMessage, name: string): string {
  const headers = message.payload?.headers ?? [];
  const found = headers.find((h) => h.name?.toLowerCase() === name.toLowerCase());
  return found?.value ?? "";
}

/** Base64url → text. Gmail encodes every body part this way. */
function decodeBody(data: string | undefined): string {
  if (!data) return "";
  try {
    const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(normalized, "base64").toString("utf-8");
  } catch {
    return "";
  }
}

/**
 * Reduces HTML to readable text.
 *
 * Deliberately lossy and deliberately not a parser: the goal is that NOTHING
 * executable survives, not that formatting is preserved. Script and style
 * contents are dropped wholesale rather than escaped, because their text is
 * noise to a reader and dangerous to a renderer.
 */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Walks the MIME tree for a body, preferring text/plain over text/html. */
function extractBody(part: RawPart | undefined): string {
  if (!part) return "";

  if (part.mimeType === "text/plain" && part.body?.data) {
    return decodeBody(part.body.data);
  }

  if (part.parts) {
    const plain = part.parts.find((p) => p.mimeType === "text/plain" && p.body?.data);
    if (plain) return decodeBody(plain.body!.data);

    const html = part.parts.find((p) => p.mimeType === "text/html" && p.body?.data);
    if (html) return htmlToText(decodeBody(html.body!.data));

    for (const child of part.parts) {
      const nested = extractBody(child);
      if (nested) return nested;
    }
  }

  if (part.mimeType === "text/html" && part.body?.data) {
    return htmlToText(decodeBody(part.body.data));
  }

  return decodeBody(part.body?.data);
}

function collectAttachments(
  part: RawPart | undefined
): Array<{ filename: string; mimeType: string; sizeBytes: number }> {
  if (!part) return [];
  const out: Array<{ filename: string; mimeType: string; sizeBytes: number }> = [];

  const walk = (node: RawPart) => {
    // A part with a filename AND an attachmentId is a real attachment; a part
    // with a filename alone can be an inline image with no separate body.
    if (node.filename && node.body?.attachmentId) {
      out.push({
        filename: node.filename,
        mimeType: node.mimeType ?? "application/octet-stream",
        sizeBytes: node.body.size ?? 0,
      });
    }
    for (const child of node.parts ?? []) walk(child);
  };

  walk(part);
  return out;
}

function toSummary(raw: RawMessage): GmailMessageSummary {
  const labels = raw.labelIds ?? [];
  const to = header(raw, "To");

  return {
    id: raw.id ?? "",
    threadId: raw.threadId ?? "",
    from: header(raw, "From"),
    to: to ? to.split(",").map((s) => s.trim()).filter(Boolean) : [],
    subject: header(raw, "Subject") || "(no subject)",
    snippet: (raw.snippet ?? "").slice(0, 400),
    // `internalDate` is epoch millis as a string; the Date header is the
    // sender's clock and can be wrong or absent.
    receivedAt: raw.internalDate
      ? new Date(Number(raw.internalDate)).toISOString()
      : new Date(0).toISOString(),
    unread: labels.includes("UNREAD"),
    hasAttachments: collectAttachments(raw.payload).length > 0,
    labels,
  };
}

// ---------------------------------------------------------------------------

export interface GmailServiceDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class GmailService {
  constructor(private readonly deps: GmailServiceDeps = {}) {}

  private call<T>(url: string, accessToken: string, signal?: AbortSignal) {
    return callGoogle<T>({
      url,
      accessToken,
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      ...(this.deps.timeoutMs ? { timeoutMs: this.deps.timeoutMs } : {}),
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Lists messages matching a Gmail query, hydrating each one.
   *
   * Gmail's list endpoint returns ids only, so each message needs a second
   * call. They run in PARALLEL and are bounded by `MAX_RESULTS`: serially this
   * would be twenty-five round trips, and unbounded it would be however many
   * the mailbox has.
   */
  private async listByQuery(
    accessToken: string,
    query: string,
    limit: number,
    pageToken?: string,
    signal?: AbortSignal
  ): Promise<GoogleCallOutcome<GmailListResult>> {
    const capped = Math.min(Math.max(limit, 1), MAX_RESULTS);

    const listed = await this.call<{
      messages?: Array<{ id: string }>;
      nextPageToken?: string;
      resultSizeEstimate?: number;
    }>(
      buildUrl(`${GMAIL_API}/messages`, {
        q: query,
        maxResults: capped,
        pageToken,
      }),
      accessToken,
      signal
    );

    if (!listed.ok) return listed;

    const ids = (listed.body.messages ?? []).map((m) => m.id);
    if (ids.length === 0) {
      return {
        ok: true,
        body: { messages: [], estimatedTotal: listed.body.resultSizeEstimate ?? 0, nextPageToken: null },
      };
    }

    // `metadata` format: headers and labels, no body. Exactly what a list
    // needs, and it keeps message bodies out of a bulk fetch entirely.
    const details = await Promise.all(
      ids.map((id) =>
        this.call<RawMessage>(
          buildUrl(`${GMAIL_API}/messages/${encodeURIComponent(id)}`, {
            format: "metadata",
          }) +
            "&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date",
          accessToken,
          signal
        )
      )
    );

    // One failed hydration must not lose the whole page. A message that could
    // not be read is omitted; if EVERY one failed, that is a real failure and
    // is reported as one rather than as an empty inbox.
    const messages = details.filter((d) => d.ok).map((d) => toSummary((d as { body: RawMessage }).body));

    if (messages.length === 0) {
      const firstFailure = details.find((d) => !d.ok);
      if (firstFailure && !firstFailure.ok) return firstFailure;
    }

    return {
      ok: true,
      body: {
        messages,
        estimatedTotal: listed.body.resultSizeEstimate ?? null,
        nextPageToken: listed.body.nextPageToken ?? null,
      },
    };
  }

  /** "meri unread Gmail emails" — newest first, inbox only. */
  async listUnread(
    accessToken: string,
    limit = 10,
    signal?: AbortSignal
  ): Promise<GoogleCallOutcome<GmailListResult>> {
    // `in:inbox` matters: without it this includes unread spam and unread
    // messages in archived threads, which is not what anyone means.
    return this.listByQuery(accessToken, "is:unread in:inbox", limit, undefined, signal);
  }

  /**
   * Searches with the user's own Gmail query.
   *
   * The query is passed through as a URL PARAMETER, so it cannot alter the
   * endpoint. Gmail's query language is itself read-only — there is no
   * search expression that mutates a mailbox.
   */
  async search(
    accessToken: string,
    query: string,
    limit = 10,
    pageToken?: string,
    signal?: AbortSignal
  ): Promise<GoogleCallOutcome<GmailListResult>> {
    const trimmed = query.trim();
    if (!trimmed) {
      return {
        ok: false,
        status: "provider_error",
        message: "A search query is required.",
      };
    }
    return this.listByQuery(accessToken, trimmed, limit, pageToken, signal);
  }

  /** One message, with its body. The only path that fetches body content. */
  async getMessage(
    accessToken: string,
    messageId: string,
    signal?: AbortSignal
  ): Promise<GoogleCallOutcome<GmailMessageDetail>> {
    const outcome = await this.call<RawMessage>(
      buildUrl(`${GMAIL_API}/messages/${encodeURIComponent(messageId)}`, { format: "full" }),
      accessToken,
      signal
    );
    if (!outcome.ok) return outcome;

    const summary = toSummary(outcome.body);
    return {
      ok: true,
      body: {
        ...summary,
        // Bounded: a mailing-list digest can be megabytes, and neither a chat
        // reply nor a dashboard panel benefits from all of it.
        body: extractBody(outcome.body.payload).slice(0, 20_000),
        attachments: collectAttachments(outcome.body.payload),
      },
    };
  }

  /** A whole thread, as summaries. Bodies stay behind `getMessage`. */
  async getThread(
    accessToken: string,
    threadId: string,
    signal?: AbortSignal
  ): Promise<GoogleCallOutcome<GmailThread>> {
    const outcome = await this.call<{ id?: string; messages?: RawMessage[] }>(
      buildUrl(`${GMAIL_API}/threads/${encodeURIComponent(threadId)}`, { format: "metadata" }),
      accessToken,
      signal
    );
    if (!outcome.ok) return outcome;

    const messages = (outcome.body.messages ?? []).map(toSummary);
    return {
      ok: true,
      body: {
        id: outcome.body.id ?? threadId,
        subject: messages[0]?.subject ?? "(no subject)",
        messageCount: messages.length,
        messages,
      },
    };
  }
}
