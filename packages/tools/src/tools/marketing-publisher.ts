// ---------------------------------------------------------------------------
// ContentPublisher — the boundary to a provider that can publish (Phase 15).
// ---------------------------------------------------------------------------
// The same shape of contract as `MetaAdsProvider` beside it: an interface the
// tool layer and the composition root agree on, implemented in the provider's
// own package. `@jarvis/tools` cannot import a provider SDK or make an HTTP
// call, so this file is types and one error class.
//
// WHAT A PUBLISHER MUST BE ABLE TO DO, AND WHY ALL FOUR.
//
//   listTargets    where it can post — read from the provider, never assumed.
//   publish        post, and hand back the provider's OWN id for the post.
//   read           read that post back. This is what "verified" means: a
//                  publish is not reported as published because the provider
//                  said 200 — it is reported as published because the post
//                  was then read from the provider by its id.
//   findByMessage  look for a post that an EARLIER attempt may have made, when
//                  that attempt's outcome was never learned. Without it, the
//                  only way to recover from a lost response would be to post
//                  again and hope it was not a duplicate.
//
// Implementations must NEVER expose credentials — not in a return value, not
// in a thrown message. A page access token stays inside the provider package.
// ---------------------------------------------------------------------------

import type { MarketingChannel, PublishTarget } from "@jarvis/core";
import type { ProviderCallOptions } from "./meta-ads-provider.js";

/** A post as the provider reports it. */
export interface PublishedPost {
  externalId: string;
  /** The text the provider holds for the post. Null when it returned none. */
  message: string | null;
  /** A link to the post, when the provider gives one. */
  url: string | null;
  /** When the provider says it was created, ISO 8601. Null when unknown. */
  createdAt: string | null;
}

export interface ContentPublisher {
  /** The content channel this publisher serves. */
  readonly channel: MarketingChannel;
  /** A stable name for the provider, recorded with a verified publication. */
  readonly provider: string;

  /** The places this publisher may post to right now. A read. */
  listTargets(options?: ProviderCallOptions): Promise<PublishTarget[]>;

  /** Publish. Resolves only when the provider returned an id for the post. */
  publish(
    input: { targetId: string; message: string; link?: string },
    options?: ProviderCallOptions
  ): Promise<{ externalId: string }>;

  /** Read one post back by the provider's id. Null: the provider says there is no such post. */
  read(input: { targetId: string; externalId: string }, options?: ProviderCallOptions): Promise<PublishedPost | null>;

  /**
   * Look for a post on the target whose text is exactly `message`, created at
   * or after `since`. Null: none was found among the target's recent posts.
   */
  findByMessage(
    input: { targetId: string; message: string; since: Date },
    options?: ProviderCallOptions
  ): Promise<PublishedPost | null>;
}

/**
 * Why a publisher call did not succeed.
 *
 *   NOT_PERMITTED     the provider refused the credential or the permission
 *   TARGET_NOT_FOUND  the target is not one this credential may post to
 *   REJECTED          the provider refused the post itself
 *   RATE_LIMITED      the provider asked for fewer requests
 *   UNAVAILABLE       a READ failed for a reason that is not one of the above
 *   AMBIGUOUS         a WRITE went out and its outcome is not known. The post
 *                     may exist. Never retried blindly.
 */
export type PublisherErrorCode =
  | "NOT_PERMITTED"
  | "TARGET_NOT_FOUND"
  | "REJECTED"
  | "RATE_LIMITED"
  | "UNAVAILABLE"
  | "AMBIGUOUS";

/**
 * A publisher failure, with a fixed message.
 *
 * The message is one of a handful of sentences written in this repository. A
 * provider's own error text never goes into it: that text can name accounts,
 * echo request fragments, or simply be misleading out of context.
 */
export class PublisherError extends Error {
  override readonly name = "PublisherError";
  constructor(
    readonly code: PublisherErrorCode,
    message: string
  ) {
    super(message);
  }
}

/** True when a failed WRITE may nonetheless have happened. */
export function isAmbiguousPublisherError(error: unknown): boolean {
  return error instanceof PublisherError && error.code === "AMBIGUOUS";
}
