"use client";

// ---------------------------------------------------------------------------
// Voice diagnostics — request correlation and per-stage timing.
//
// Every spoken turn gets an id at the moment the microphone opens, and every
// stage of the pipeline is recorded against it: capture, speech-to-text, the
// chat round trip, synthesis, playback. Nothing here changes behaviour — it
// only makes the pipeline legible.
//
// Why it exists: the turn used to have no identity at all. A reply was located
// by scanning the shared message array backwards, and an abandoned turn's audio
// could still arrive and play. Neither of those is visible from the outside;
// you see a wrong answer and cannot tell which request produced it. A requestId
// on every record is what makes "this audio belongs to the turn before last"
// a statement you can check rather than guess at.
//
// The ring buffer always records. Printing is opt-in, so a normal session is
// not noisy, and an automated check can read `window.__jarvisVoiceTrace` on any
// build without a rebuild or a flag flip.
// ---------------------------------------------------------------------------

/** Pipeline stages, in the order a healthy turn passes through them. */
export type VoiceStage =
  | "turn"
  | "capture"
  | "stt"
  | "chat"
  | "tts"
  | "playback";

export type VoiceTraceKind = "start" | "end" | "drop" | "info";

export interface VoiceTraceEvent {
  /** Correlates every record belonging to one spoken turn. */
  requestId: string;
  /** The conversation the turn was started against, when there is one. */
  conversationId: string | null;
  stage: VoiceStage;
  kind: VoiceTraceKind;
  /** Wall-clock, so records can be compared against server audit rows. */
  at: string;
  /** Milliseconds since this turn began. */
  elapsedMs: number;
  /** Milliseconds the stage took, on `end`. */
  durationMs?: number;
  detail?: Record<string, unknown>;
}

/** Bounded so a long session cannot grow the buffer without limit. */
const MAX_EVENTS = 400;

const buffer: VoiceTraceEvent[] = [];

interface TraceGlobal {
  enabled: boolean;
  events: VoiceTraceEvent[];
  dump: () => VoiceTraceEvent[];
  clear: () => void;
  summary: () => Array<Record<string, unknown>>;
}

function printingEnabled(): boolean {
  if (typeof window === "undefined") return false;
  const bag = (window as unknown as { __jarvisVoiceTrace?: TraceGlobal })
    .__jarvisVoiceTrace;
  if (bag?.enabled) return true;
  try {
    if (window.localStorage?.getItem("jarvis:voice-trace") === "1") return true;
  } catch {
    // Storage can be blocked; that is not a reason to fail a voice turn.
  }
  return process.env.NODE_ENV === "development";
}

function record(event: VoiceTraceEvent): void {
  buffer.push(event);
  if (buffer.length > MAX_EVENTS) buffer.splice(0, buffer.length - MAX_EVENTS);

  if (printingEnabled()) {
    // One line per record, structured — the same shape the API logs in, so the
    // two sides of a turn can be read together.
    console.log(
      JSON.stringify({ level: "debug", event: "voice_trace", ...event })
    );
  }
}

/** Everything recorded so far, oldest first. */
export function voiceTraceEvents(): VoiceTraceEvent[] {
  return [...buffer];
}

export function clearVoiceTrace(): void {
  buffer.length = 0;
}

/**
 * One row per turn: what was heard, what answered it, and where the time went.
 *
 * This is the view that answers the question the trace exists for — whether a
 * reply belongs to the request it was played for.
 */
export function voiceTraceSummary(): Array<Record<string, unknown>> {
  const byTurn = new Map<string, Record<string, unknown>>();

  for (const event of buffer) {
    let row = byTurn.get(event.requestId);
    if (!row) {
      row = {
        requestId: event.requestId,
        conversationId: event.conversationId,
        startedAt: event.at,
      };
      byTurn.set(event.requestId, row);
    }
    if (event.stage === "stt" && event.kind === "end") {
      row.transcript = event.detail?.transcript ?? null;
      row.sttMs = event.durationMs;
    }
    if (event.stage === "chat" && event.kind === "end") {
      row.chatRequestId = event.detail?.chatRequestId ?? null;
      row.replyPreview = event.detail?.replyPreview ?? null;
      row.chatMs = event.durationMs;
    }
    if (event.stage === "tts" && event.kind === "end") {
      row.ttsMs = ((row.ttsMs as number) ?? 0) + (event.durationMs ?? 0);
    }
    if (event.stage === "playback" && event.kind === "start") {
      row.speakingStartedAt = event.at;
    }
    // Taken from the moment sound ACTUALLY began, not from the moment the
    // speaking stage opened. A turn that was interrupted before its first
    // segment played must not report a time-to-first-word it never reached —
    // that is the exact number this trace exists to keep honest.
    if (event.stage === "playback" && event.kind === "info" && event.detail?.firstAudio) {
      row.firstAudioMs = row.firstAudioMs ?? event.elapsedMs;
      row.playbackStartedAt = event.at;
    }
    if (event.stage === "playback" && event.kind === "end") {
      row.playbackEndedAt = event.at;
      if (row.firstAudioMs === undefined) row.firstAudioMs = null;
    }
    if (event.kind === "drop") {
      const drops = (row.dropped as string[]) ?? [];
      drops.push(`${event.stage}: ${String(event.detail?.reason ?? "superseded")}`);
      row.dropped = drops;
    }
    if (event.stage === "turn" && event.kind === "end") {
      row.totalMs = event.durationMs;
      row.outcome = event.detail?.outcome ?? null;
    }
  }

  return [...byTurn.values()];
}

/**
 * A trace scoped to one turn.
 *
 * Created when the microphone opens and carried through every await, so a
 * record can never be attributed to the wrong request by accident — the turn
 * holds its own id rather than reading a mutable "current turn" somewhere.
 */
export class VoiceTurnTrace {
  readonly startedAt = Date.now();
  private conversationId: string | null;

  constructor(
    readonly requestId: string,
    conversationId: string | null = null
  ) {
    this.conversationId = conversationId;
  }

  /**
   * Attaches the conversation once the server has assigned one.
   *
   * A first turn has no conversation until the chat reply comes back, and the
   * records made before that would otherwise be uncorrelatable.
   */
  bindConversation(conversationId: string | null | undefined): void {
    if (conversationId) this.conversationId = conversationId;
  }

  private emit(
    stage: VoiceStage,
    kind: VoiceTraceKind,
    detail?: Record<string, unknown>,
    durationMs?: number
  ): void {
    record({
      requestId: this.requestId,
      conversationId: this.conversationId,
      stage,
      kind,
      at: new Date().toISOString(),
      elapsedMs: Date.now() - this.startedAt,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(detail ? { detail } : {}),
    });
  }

  info(stage: VoiceStage, detail?: Record<string, unknown>): void {
    this.emit(stage, "info", detail);
  }

  /**
   * Records that a result arrived for a turn that is no longer current.
   *
   * This is the record that matters most: it is the proof that a stale reply
   * was recognised and discarded rather than spoken.
   */
  drop(stage: VoiceStage, reason: string, detail?: Record<string, unknown>): void {
    this.emit(stage, "drop", { reason, ...detail });
  }

  /** Opens a stage; the returned function closes it and records the duration. */
  stage(
    stage: VoiceStage,
    detail?: Record<string, unknown>
  ): (endDetail?: Record<string, unknown>) => number {
    const begun = Date.now();
    this.emit(stage, "start", detail);
    return (endDetail?: Record<string, unknown>) => {
      const durationMs = Date.now() - begun;
      this.emit(stage, "end", endDetail, durationMs);
      return durationMs;
    };
  }
}

let counter = 0;

/** A new turn id. Monotonic within the page, and readable in a log. */
export function nextVoiceRequestId(): string {
  counter += 1;
  const suffix = Math.random().toString(36).slice(2, 8);
  return `vt-${counter}-${suffix}`;
}

// Exposed for automated checks and for anyone debugging a live session. Read
// only — nothing in the pipeline consults this object except `enabled`.
if (typeof window !== "undefined") {
  const bag = (window as unknown as { __jarvisVoiceTrace?: TraceGlobal });
  bag.__jarvisVoiceTrace = {
    enabled: bag.__jarvisVoiceTrace?.enabled ?? false,
    get events() {
      return voiceTraceEvents();
    },
    dump: voiceTraceEvents,
    clear: clearVoiceTrace,
    summary: voiceTraceSummary,
  } as TraceGlobal;
}
