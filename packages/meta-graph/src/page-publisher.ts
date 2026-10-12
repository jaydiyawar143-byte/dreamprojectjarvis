// ---------------------------------------------------------------------------
// Phase 15 — publishing a text post to a Facebook Page.
//
// The only code in JARVIS that can put a post on a Page. It implements the
// `ContentPublisher` contract from `@jarvis/tools`, exactly as the provider
// beside it implements `MetaAdsProvider`, and it is reached only through the
// approval-gated `marketing.content.publish` tool, run by `ToolExecutor`.
//
// WHAT IT CAN DO, AND NOTHING ELSE.
//   - list the Pages the configured token may create content on;
//   - post text, with an optional link, to one of them;
//   - read a post back by its id;
//   - look through a Page's recent posts for one with a given text.
// There is no method to delete, edit, comment, boost or message, and none to
// post a photo or a video. Instagram is not here at all: it needs a hosted
// media file for every post and a linked business account, and neither exists.
//
// TWO TOKENS, AND WHERE EACH LIVES.
//   The configured token (META_ACCESS_TOKEN) can LIST Pages. Posting as a Page
//   needs that Page's own access token, which Meta hands out from the same
//   listing. The page token is fetched when it is needed, used for the calls
//   that need it, and dropped: it is never returned from a method, never put
//   in an error message, never cached and never logged.
//
// THE TARGET IS NEVER TAKEN ON TRUST. A target id from a caller is checked
// against the provider's own list before anything is sent, so a Page the
// token cannot post to — or an id that is not a Page at all — is refused here.
//
// ERRORS ARE FIXED SENTENCES (`PublisherError`). Meta's own error text is
// classified and then discarded; it never reaches a caller.
//
// A WRITE THAT MAY HAVE HAPPENED IS SAID TO BE AMBIGUOUS. A 5xx or a timeout
// after a POST was sent does not mean the post was not made. Those are raised
// as AMBIGUOUS — and an abort raised by the HTTP client keeps its own type,
// which already says whether the request had been transmitted.
// ---------------------------------------------------------------------------

import type { PublishTarget } from "@jarvis/core";
import {
  PublisherError,
  type ContentPublisher,
  type ProviderCallOptions,
  type PublishedPost,
} from "@jarvis/tools";

import {
  MetaRequestAbortedError,
  createMetaHttpClient,
  extractError,
  isSuccessResponse,
  type MetaHttpClient,
  type MetaHttpResponse,
} from "./client.js";
import { META_DEFAULT_API_VERSION, type MetaConfig } from "./config.js";
import type { ClassifiedMetaError } from "./error-handler.js";

export const META_PAGE_PUBLISHER_ID = "meta-graph";

/** The Page task that allows creating posts. */
const CREATE_CONTENT_TASK = "CREATE_CONTENT";

/** How many of a Page's recent posts are looked through for a lost one. */
const RECENT_POSTS_LIMIT = 25;

const PAGE_ID = /^\d{5,25}$/;
const POST_ID = /^\d{5,25}(_\d{1,25})?$/;

export interface MetaPagePublisherConfig {
  accessToken: string;
  apiVersion?: string;
  baseUrl?: string;
  timeoutMs?: number;
  /**
   * Builds an HTTP client that authenticates as `accessToken`. Production
   * leaves this unset; tests inject one so no network call is made.
   */
  clientFor?: (accessToken: string) => MetaHttpClient;
}

interface PageRecord {
  id: string;
  name: string;
  canCreateContent: boolean;
  /** Present only when the listing asked for it. Never leaves this module. */
  accessToken?: string;
}

function fixedError(classified: ClassifiedMetaError, during: "read" | "write"): PublisherError {
  switch (classified.code) {
    case "AUTHENTICATION_REQUIRED":
    case "AUTHORIZATION_FAILED":
      return new PublisherError("NOT_PERMITTED", "Facebook refused the publishing connection or its permission to post.");
    case "RATE_LIMITED":
      return new PublisherError("RATE_LIMITED", "Facebook asked for fewer requests. Try again later.");
    case "INVALID_REQUEST":
      return during === "write"
        ? new PublisherError("REJECTED", "Facebook refused the post.")
        : new PublisherError("UNAVAILABLE", "Facebook could not answer the request.");
    default:
      // A timeout or a server error AFTER a write was sent says nothing about
      // whether the write was applied.
      return during === "write"
        ? new PublisherError("AMBIGUOUS", "Facebook did not confirm the post, and it may or may not have been published.")
        : new PublisherError("UNAVAILABLE", "Facebook could not be reached to check.");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toPost(value: unknown): PublishedPost | null {
  const record = asRecord(value);
  if (typeof record.id !== "string" || !POST_ID.test(record.id)) return null;
  const url = typeof record.permalink_url === "string" && /^https:\/\//.test(record.permalink_url) ? record.permalink_url : null;
  const created = typeof record.created_time === "string" ? new Date(record.created_time) : null;
  return {
    externalId: record.id,
    message: typeof record.message === "string" ? record.message : null,
    url,
    createdAt: created && !Number.isNaN(created.getTime()) ? created.toISOString() : null,
  };
}

/** Line endings made one kind and the ends trimmed — the comparison the content store makes. */
function sameText(a: string, b: string): boolean {
  const normalize = (text: string): string => text.replace(/\r\n?/g, "\n").trim();
  return normalize(a) === normalize(b);
}

export function createMetaPagePublisher(config: MetaPagePublisherConfig): ContentPublisher {
  const baseConfig = (accessToken: string): MetaConfig => ({
    accessToken,
    // The HTTP client needs a complete config object; nothing here addresses
    // an ad account, so this field is never read.
    adAccountId: "unused",
    apiVersion: config.apiVersion ?? META_DEFAULT_API_VERSION,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    timeoutMs: config.timeoutMs ?? 30000,
    maxRetries: 0,
  });
  const clientFor = config.clientFor ?? ((accessToken: string) => createMetaHttpClient(baseConfig(accessToken)));

  /** One GET. A failure of any kind is a fixed `PublisherError`. */
  async function get(
    client: MetaHttpClient,
    path: string,
    params: Record<string, string | number | boolean | undefined>,
    options?: ProviderCallOptions
  ): Promise<MetaHttpResponse> {
    let response: MetaHttpResponse;
    try {
      response = await client.request({ method: "GET", path, params, signal: options?.signal });
    } catch {
      // A read that did not complete changed nothing. Whatever the cause, the
      // caller learns only that the check could not be made.
      throw new PublisherError("UNAVAILABLE", "Facebook could not be reached to check.");
    }
    return response;
  }

  async function listPages(withTokens: boolean, options?: ProviderCallOptions): Promise<PageRecord[]> {
    const response = await get(
      clientFor(config.accessToken),
      "me/accounts",
      { fields: withTokens ? "id,name,tasks,access_token" : "id,name,tasks", limit: 100 },
      options
    );
    if (!isSuccessResponse(response)) throw fixedError(extractError(response), "read");

    const data = asRecord(response.body).data;
    if (!Array.isArray(data)) return [];

    const pages: PageRecord[] = [];
    for (const entry of data) {
      const record = asRecord(entry);
      if (typeof record.id !== "string" || !PAGE_ID.test(record.id)) continue;
      const tasks = Array.isArray(record.tasks) ? record.tasks : [];
      pages.push({
        id: record.id,
        name: typeof record.name === "string" && record.name.trim().length > 0 ? record.name.trim().slice(0, 200) : record.id,
        canCreateContent: tasks.includes(CREATE_CONTENT_TASK),
        ...(withTokens && typeof record.access_token === "string" && record.access_token.length > 0
          ? { accessToken: record.access_token }
          : {}),
      });
    }
    return pages;
  }

  /** A client that acts as the Page — or a refusal, when the token may not post there. */
  async function pageClient(targetId: string, options?: ProviderCallOptions): Promise<MetaHttpClient> {
    if (!PAGE_ID.test(targetId)) {
      throw new PublisherError("TARGET_NOT_FOUND", "That is not a Page this connection can publish to.");
    }
    const page = (await listPages(true, options)).find((candidate) => candidate.id === targetId);
    if (!page || !page.canCreateContent || !page.accessToken) {
      throw new PublisherError("TARGET_NOT_FOUND", "That is not a Page this connection can publish to.");
    }
    return clientFor(page.accessToken);
  }

  return {
    channel: "FACEBOOK",
    provider: META_PAGE_PUBLISHER_ID,

    async listTargets(options?: ProviderCallOptions): Promise<PublishTarget[]> {
      const pages = await listPages(false, options);
      return pages
        .filter((page) => page.canCreateContent)
        .map((page) => ({ id: page.id, name: page.name, channel: "FACEBOOK" as const, provider: META_PAGE_PUBLISHER_ID }));
    },

    async publish(input, options?: ProviderCallOptions): Promise<{ externalId: string }> {
      const message = input.message.replace(/\r\n?/g, "\n").trim();
      if (message.length === 0) throw new PublisherError("REJECTED", "There is no text to publish.");

      // Everything up to here is a read. Nothing has been sent that could post.
      const client = await pageClient(input.targetId, options);

      let response: MetaHttpResponse;
      try {
        response = await client.request({
          method: "POST",
          path: `${input.targetId}/feed`,
          body: { message, ...(input.link ? { link: input.link } : {}) },
          signal: options?.signal,
        });
      } catch (error) {
        // The client already says whether the request had left the process;
        // that distinction is exactly what decides FAILED from UNKNOWN.
        if (error instanceof MetaRequestAbortedError) throw error;
        throw new PublisherError("AMBIGUOUS", "The post was sent but Facebook's answer never arrived. It may or may not have been published.");
      }

      if (!isSuccessResponse(response)) throw fixedError(extractError(response), "write");

      const id = asRecord(response.body).id;
      if (typeof id !== "string" || !POST_ID.test(id)) {
        // Accepted, with no usable id: the post may well exist.
        throw new PublisherError("AMBIGUOUS", "Facebook accepted the request but did not return the post's id. It may or may not have been published.");
      }
      return { externalId: id };
    },

    async read(input, options?: ProviderCallOptions): Promise<PublishedPost | null> {
      if (!POST_ID.test(input.externalId)) return null;
      const client = await pageClient(input.targetId, options);
      const response = await get(client, input.externalId, { fields: "id,message,created_time,permalink_url" }, options);

      if (!isSuccessResponse(response)) {
        // "No such object" is an answer, not a failure: the post is not there.
        if (response.status === 404) return null;
        const classified = extractError(response);
        if (classified.metaCode === 100 || classified.metaCode === 803) return null;
        throw fixedError(classified, "read");
      }
      return toPost(response.body);
    },

    async findByMessage(input, options?: ProviderCallOptions): Promise<PublishedPost | null> {
      const client = await pageClient(input.targetId, options);
      const response = await get(
        client,
        `${input.targetId}/published_posts`,
        {
          fields: "id,message,created_time,permalink_url",
          limit: RECENT_POSTS_LIMIT,
          since: Math.floor(input.since.getTime() / 1000),
        },
        options
      );
      if (!isSuccessResponse(response)) throw fixedError(extractError(response), "read");

      const data = asRecord(response.body).data;
      if (!Array.isArray(data)) return null;
      for (const entry of data) {
        const post = toPost(entry);
        if (!post || post.message === null) continue;
        if (!sameText(post.message, input.message)) continue;
        if (post.createdAt !== null && new Date(post.createdAt).getTime() < input.since.getTime()) continue;
        return post;
      }
      return null;
    },
  };
}
