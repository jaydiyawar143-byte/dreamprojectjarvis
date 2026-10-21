// ---------------------------------------------------------------------------
// Phase 18.2 — the server's own memory of what it just transcribed.
//
// A spoken turn reaches the chat route as text, through the same
// `POST /api/v1/chat` a typed turn uses. The voice client says so
// (`inputMode: "voice"`), and the chat route also asks this: did the server
// itself transcribe exactly this text for this account a moment ago? Either
// marks the turn as voice, so the execution layer refuses what speech may not
// start (`voiceToolRefusal`) even from a client that left the flag out.
//
// It only narrows. Not finding a transcript never proves a turn was typed, and
// a recognised one only ever refuses — so a text that happens to match one is
// treated as spoken, which costs nothing but a click.
//
// WHAT IS KEPT. A SHA-256 of the account and the normalized text, with the
// time it expires — never the text. Bounded in size and in time, in this
// process's memory: on a deployment with several API instances a transcript
// made on one is not recognised on another, and the client's flag is what
// marks that turn.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

/** How long a transcript is recognised: one turn's round trip, generously. */
export const RECENT_TRANSCRIPT_TTL_MS = 2 * 60_000;
/** The most transcripts remembered at once; the oldest is forgotten first. */
export const RECENT_TRANSCRIPT_MAX = 2_000;

const normalize = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();

export class RecentTranscripts {
  /** Hash → expiry. A Map keeps insertion order, so the first key is the oldest. */
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs: number = RECENT_TRANSCRIPT_TTL_MS,
    private readonly max: number = RECENT_TRANSCRIPT_MAX
  ) {}

  private keyOf(userId: string, text: string): string | null {
    const normalized = normalize(text);
    if (normalized.length === 0) return null;
    return createHash("sha256").update(userId).update("\u0000").update(normalized).digest("hex");
  }

  /** Remembers a transcript the server produced for this account. */
  remember(userId: string, text: string): void {
    const key = this.keyOf(userId, text);
    if (!key) return;
    this.seen.delete(key);
    this.seen.set(key, this.now() + this.ttlMs);
    while (this.seen.size > this.max) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }

  /** Whether this text is one the server transcribed for this account, recently. */
  recognises(userId: string, text: string): boolean {
    const key = this.keyOf(userId, text);
    if (!key) return false;
    const expires = this.seen.get(key);
    if (expires === undefined) return false;
    if (expires <= this.now()) {
      this.seen.delete(key);
      return false;
    }
    return true;
  }
}
