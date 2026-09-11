// ---------------------------------------------------------------------------
// Voice turn identity, cancellation and concurrency.
//
// The reported symptom was that JARVIS sometimes answered a PREVIOUS request:
// asked "how many widgets do you have?", it read out a Solana price from the
// turn before. Every test in this file is a reproduction of one of the ways
// that could happen, written so it fails against the behaviour that produced
// it.
//
// Two defects made it possible, and they compound:
//
//   1. The reply was located by scanning the shared message array backwards for
//      the newest assistant message with content — an association by POSITION.
//      A turn whose own reply was empty walked straight past it and read the
//      previous answer instead.
//
//   2. Nothing cancelled an abandoned turn. Barge-in stopped the audio ELEMENT,
//      which does nothing about a synthesis still in flight; when it landed,
//      its continuation called play() unconditionally.
//
// The chat leg takes seconds and occasionally tens of seconds, so the window in
// which a user gives up and asks again is not theoretical — it is the common
// case for any slow question.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";

const mockTranscribe = vi.fn();
const mockSynthesize = vi.fn();
const mockVoiceStatus = vi.fn();

vi.mock("@/lib/api", () => ({
  transcribeAudio: (...args: unknown[]) => mockTranscribe(...args),
  synthesizeSpeech: (...args: unknown[]) => mockSynthesize(...args),
  getVoiceStatus: (...args: unknown[]) => mockVoiceStatus(...args),
}));

const mockCaptureStart = vi.fn();
const mockCaptureStop = vi.fn();
const mockCaptureCancel = vi.fn();

vi.mock("@/lib/voice/audio-capture", async () => {
  const actual = await vi.importActual<typeof import("@/lib/voice/audio-capture")>(
    "@/lib/voice/audio-capture"
  );
  return {
    ...actual,
    isCaptureSupported: () => true,
    AudioCapture: class {
      start(...args: unknown[]) {
        return mockCaptureStart(...args);
      }
      stop(...args: unknown[]) {
        return mockCaptureStop(...args);
      }
      cancel(...args: unknown[]) {
        return mockCaptureCancel(...args);
      }
      get isRecording() {
        return true;
      }
    },
  };
});

const mockEnqueue = vi.fn();
const mockStop = vi.fn();
let playbackGeneration = 1;

vi.mock("@/lib/voice/audio-playback", async () => {
  const actual = await vi.importActual<typeof import("@/lib/voice/audio-playback")>(
    "@/lib/voice/audio-playback"
  );
  return {
    ...actual,
    // Models the real generation guard: `stop()` moves the token on, and
    // anything still holding the old one is no longer allowed to make sound.
    AudioPlayback: class {
      claim() {
        playbackGeneration += 1;
        return playbackGeneration;
      }
      isCurrent(generation: number) {
        return generation === playbackGeneration;
      }
      setSegmentListeners() {
        return undefined;
      }
      enqueue(...args: unknown[]) {
        mockEnqueue(...args);
        return Promise.resolve();
      }
      play() {
        return Promise.resolve();
      }
      stop(...args: unknown[]) {
        playbackGeneration += 1;
        mockStop(...args);
      }
      unlock() {
        return undefined;
      }
      dispose() {
        return undefined;
      }
      get isPlaying() {
        return false;
      }
    },
  };
});

const mockSendMessage = vi.fn();

vi.mock("@/lib/chat-store", () => ({
  useChatStore: { getState: () => chatState },
}));

let chatState: {
  messages: Array<{ role: string; content: string; metadata?: Record<string, unknown> }>;
  activeConversationId: string | null;
  error: string | null;
  sendMessage: typeof mockSendMessage;
};

import { splitForSpeech, useVoiceStore } from "@/lib/voice/voice-store";
import { clearVoiceTrace, voiceTraceSummary, voiceTraceEvents } from "@/lib/voice/voice-trace";

const CAPTURED = {
  base64: "AAAA",
  mimeType: "audio/webm;codecs=opus",
  durationMs: 1500,
  bytes: 4096,
};

/** A promise whose resolution this test controls, to hold a stage open. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const reply = (text: string, requestId = "chat-x") => ({
  requestId,
  conversationId: "conv-1",
  reply: text,
  superseded: false,
  error: null,
});

function heard(text: string) {
  mockTranscribe.mockResolvedValue({
    success: true,
    data: { text, empty: false, model: "gpt-4o-mini-transcribe" },
  });
}

function resetStore() {
  useVoiceStore.setState({
    state: "idle",
    available: true,
    maxTtsChars: 4000,
    transcript: "",
    notice: null,
    autoSpeak: true,
  });
}

/** Runs one complete turn. */
async function speak() {
  await useVoiceStore.getState().startListening();
  await useVoiceStore.getState().stopListening();
}

beforeEach(() => {
  vi.clearAllMocks();
  clearVoiceTrace();
  resetStore();
  playbackGeneration = 1;

  chatState = {
    messages: [],
    activeConversationId: "conv-1",
    error: null,
    sendMessage: mockSendMessage,
  };

  mockCaptureStart.mockResolvedValue(undefined);
  mockCaptureStop.mockResolvedValue(CAPTURED);
  heard("how many widgets do you have?");
  mockSynthesize.mockResolvedValue({
    success: true,
    data: { audio: "AUDIO", mimeType: "audio/mpeg", model: "gpt-4o-mini-tts", voice: "onyx" },
  });
  mockSendMessage.mockImplementation(async (_text: string, options?: { requestId?: string }) =>
    reply("I have four widgets.", options?.requestId ?? "chat-1")
  );
});

// ---------------------------------------------------------------------------
// 1. The reply spoken is the reply this request produced
// ---------------------------------------------------------------------------

describe("a turn speaks its own answer", () => {
  it("does not read out an older reply when its own turn produced none", async () => {
    // THE REPORTED BUG, reduced. The transcript already holds a previous answer
    // about Solana; this turn's own reply is empty. Scanning the array
    // backwards finds the Solana line and speaks it — an answer to a question
    // asked two turns ago.
    chatState.messages = [
      { role: "user", content: "solana ka price kya hai" },
      { role: "assistant", content: "Solana is trading at 99 dollars and 91 cents." },
    ];
    mockSendMessage.mockImplementation(async (_text: string, options?: { requestId?: string }) =>
      reply("", options?.requestId ?? "chat-2")
    );

    await speak();

    expect(mockSynthesize).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("speaks the text its own request returned, not the newest message", async () => {
    // A concurrent turn landing in the shared array mid-flight is invisible to
    // a turn that holds its own reply.
    mockSendMessage.mockImplementation(async (_text: string, options?: { requestId?: string }) => {
      chatState.messages.push({ role: "assistant", content: "I have four widgets." });
      // Something else finishes and appends after us.
      chatState.messages.push({ role: "assistant", content: "Solana is at 99 dollars." });
      return reply("I have four widgets.", options?.requestId ?? "chat-3");
    });

    await speak();

    expect(mockSynthesize).toHaveBeenCalledTimes(1);
    expect(mockSynthesize).toHaveBeenCalledWith(
      expect.objectContaining({ text: "I have four widgets." }),
      expect.anything()
    );
  });

  it("passes its own request id to the chat pipeline", async () => {
    await speak();

    const [, options] = mockSendMessage.mock.calls[0] as [string, { requestId: string }];
    expect(options.requestId).toMatch(/^vt-\d+-/);
  });
});

// ---------------------------------------------------------------------------
// 2. Stale and cancelled results can never be played
// ---------------------------------------------------------------------------

describe("a superseded turn cannot make sound", () => {
  it("drops a synthesis that lands after the user pressed stop", async () => {
    const synthesis = deferred<unknown>();
    mockSynthesize.mockReturnValue(synthesis.promise);

    const turn = speak();
    // Let the turn reach synthesis.
    await vi.waitFor(() => expect(mockSynthesize).toHaveBeenCalled());

    // The user presses stop. Previously this stopped only sound already
    // playing; the synthesis below was still on its way.
    useVoiceStore.getState().stopSpeaking();

    synthesis.resolve({
      success: true,
      data: { audio: "STALE", mimeType: "audio/mpeg", model: "m", voice: "onyx" },
    });
    await turn;

    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().state).toBe("idle");
  });

  it("drops a synthesis that lands after the user started a new turn", async () => {
    const synthesis = deferred<unknown>();
    mockSynthesize.mockReturnValueOnce(synthesis.promise);

    const first = speak();
    await vi.waitFor(() => expect(mockSynthesize).toHaveBeenCalled());

    // Barge-in: the microphone is pressed while JARVIS is mid-reply.
    await useVoiceStore.getState().startListening();

    synthesis.resolve({
      success: true,
      data: { audio: "STALE", mimeType: "audio/mpeg", model: "m", voice: "onyx" },
    });
    await first;

    expect(mockEnqueue).not.toHaveBeenCalledWith("STALE", expect.anything(), expect.anything());
  });

  it("does not synthesize a chat reply that arrives after the turn was cancelled", async () => {
    const chat = deferred<ReturnType<typeof reply>>();
    mockSendMessage.mockReturnValue(chat.promise);

    const turn = speak();
    await vi.waitFor(() => expect(mockSendMessage).toHaveBeenCalled());

    useVoiceStore.getState().cancel();

    chat.resolve(reply("Solana is at 99 dollars.", "chat-late"));
    await turn;

    expect(mockSynthesize).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("does not act on a transcript that arrives after the turn was cancelled", async () => {
    const transcription = deferred<unknown>();
    mockTranscribe.mockReturnValue(transcription.promise);

    const turn = speak();
    await vi.waitFor(() => expect(mockTranscribe).toHaveBeenCalled());

    useVoiceStore.getState().cancel();

    transcription.resolve({
      success: true,
      data: { text: "late transcript", empty: false, model: "m" },
    });
    await turn;

    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().transcript).toBe("");
  });

  it("aborts the in-flight request rather than leaving it to finish unwatched", async () => {
    const chat = deferred<ReturnType<typeof reply>>();
    mockSendMessage.mockReturnValue(chat.promise);

    const turn = speak();
    await vi.waitFor(() => expect(mockSendMessage).toHaveBeenCalled());

    const [, options] = mockSendMessage.mock.calls[0] as [string, { signal: AbortSignal }];
    expect(options.signal.aborted).toBe(false);

    useVoiceStore.getState().cancel();
    expect(options.signal.aborted).toBe(true);

    chat.resolve(reply("", "chat-aborted"));
    await turn;
  });

  it("cancels a reply already being spoken when replies are muted", async () => {
    const synthesis = deferred<unknown>();
    mockSynthesize.mockReturnValue(synthesis.promise);

    const turn = speak();
    await vi.waitFor(() => expect(mockSynthesize).toHaveBeenCalled());

    useVoiceStore.getState().toggleAutoSpeak();

    synthesis.resolve({
      success: true,
      data: { audio: "STALE", mimeType: "audio/mpeg", model: "m", voice: "onyx" },
    });
    await turn;

    expect(mockEnqueue).not.toHaveBeenCalled();
    useVoiceStore.setState({ autoSpeak: true });
  });
});

// ---------------------------------------------------------------------------
// 3. The diagnostic record
// ---------------------------------------------------------------------------

describe("the voice trace", () => {
  it("associates the transcript, the reply and the request id on one row", async () => {
    heard("how many widgets do you have?");
    await speak();

    const rows = voiceTraceSummary();
    expect(rows).toHaveLength(1);

    const row = rows[0]!;
    expect(row.requestId).toMatch(/^vt-\d+-/);
    expect(row.conversationId).toBe("conv-1");
    expect(row.transcript).toBe("how many widgets do you have?");
    // The association the whole exercise is about: the chat leg was asked
    // under this turn's id, and answered under the same one.
    expect(row.chatRequestId).toBe(row.requestId);
    expect(row.replyPreview).toBe("I have four widgets.");
    expect(row.outcome).toBe("completed");
    expect(row.dropped).toBeUndefined();
  });

  it("records every stage's duration", async () => {
    await speak();

    const row = voiceTraceSummary()[0]!;
    for (const key of ["sttMs", "chatMs", "ttsMs", "totalMs"]) {
      expect(typeof row[key], key).toBe("number");
    }
  });

  it("reports no time-to-first-word for a turn that never made a sound", async () => {
    const synthesis = deferred<unknown>();
    mockSynthesize.mockReturnValue(synthesis.promise);

    const turn = speak();
    await vi.waitFor(() => expect(mockSynthesize).toHaveBeenCalled());
    useVoiceStore.getState().stopSpeaking();
    synthesis.resolve({
      success: true,
      data: { audio: "STALE", mimeType: "audio/mpeg", model: "m", voice: "onyx" },
    });
    await turn;

    // The speaking STAGE opened; no audio ever came out of it. Reporting the
    // stage's start as "time to first word" would credit the pipeline with a
    // moment the user never experienced.
    expect(voiceTraceSummary()[0]!.firstAudioMs).toBeNull();
  });

  it("records the drop when a stale reply is discarded", async () => {
    const chat = deferred<ReturnType<typeof reply>>();
    mockSendMessage.mockReturnValue(chat.promise);

    const turn = speak();
    await vi.waitFor(() => expect(mockSendMessage).toHaveBeenCalled());
    useVoiceStore.getState().cancel();
    chat.resolve(reply("Solana is at 99 dollars.", "chat-late"));
    await turn;

    const drops = voiceTraceEvents().filter((e) => e.kind === "drop");
    expect(drops.map((d) => d.stage)).toContain("chat");
    expect(drops.some((d) => d.detail?.reason === "cancelled")).toBe(true);
  });

  it("gives consecutive turns distinct ids", async () => {
    await speak();
    await speak();

    const ids = voiceTraceSummary().map((r) => r.requestId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 4. Segmenting a reply so the first words arrive sooner
// ---------------------------------------------------------------------------

describe("splitForSpeech", () => {
  it("leaves a short reply whole — there is nothing to win", () => {
    expect(splitForSpeech("The current time is 12:46 PM.")).toEqual([
      "The current time is 12:46 PM.",
    ]);
  });

  it("puts the opening sentence in its own segment so speech can start", () => {
    const long =
      "The current price of Solana is 99 dollars and 91 cents. " +
      "It has decreased by about 1.7 percent over the last twenty-four hours. " +
      "Trading volume is up slightly compared with yesterday, and the market " +
      "capitalisation now sits near 54 billion dollars.";

    const segments = splitForSpeech(long);

    expect(segments.length).toBeGreaterThan(1);
    expect(segments[0]).toBe("The current price of Solana is 99 dollars and 91 cents.");
    // Nothing is lost or duplicated by the split.
    expect(segments.join(" ")).toBe(long.trim());
  });

  it("splits only at sentence boundaries", () => {
    const long = `${"Something happened here. ".repeat(40)}`;
    for (const segment of splitForSpeech(long)) {
      expect(segment.trim().endsWith(".")).toBe(true);
    }
  });

  it("never makes more segments than the cap", () => {
    const long = `${"A sentence of a reasonable length goes here. ".repeat(200)}`;
    expect(splitForSpeech(long).length).toBeLessThanOrEqual(3);
  });

  it("returns nothing for nothing", () => {
    expect(splitForSpeech("   ")).toEqual([]);
  });
});

describe("speaking a long reply", () => {
  it("starts the opening segment before the rest has been generated", async () => {
    const long =
      "The current price of Solana is 99 dollars and 91 cents. " +
      "It has decreased by about 1.7 percent over the last twenty-four hours. " +
      "Trading volume is up slightly compared with yesterday, and the market " +
      "capitalisation now sits near 54 billion dollars.";
    mockSendMessage.mockImplementation(async (_t: string, o?: { requestId?: string }) =>
      reply(long, o?.requestId ?? "chat-long")
    );

    const tail = deferred<unknown>();
    mockSynthesize
      .mockResolvedValueOnce({
        success: true,
        data: { audio: "HEAD", mimeType: "audio/mpeg", model: "m", voice: "onyx" },
      })
      .mockReturnValueOnce(tail.promise);

    const turn = speak();

    // The opening is queued for playback while the remainder is still being
    // synthesized — which is the whole of the latency win.
    await vi.waitFor(() => expect(mockEnqueue).toHaveBeenCalled());
    expect(mockEnqueue.mock.calls[0]?.[0]).toBe("HEAD");

    tail.resolve({
      success: true,
      data: { audio: "TAIL", mimeType: "audio/mpeg", model: "m", voice: "onyx" },
    });
    await turn;

    expect(mockEnqueue.mock.calls.map((c) => c[0])).toEqual(["HEAD", "TAIL"]);
    // Both segments played under the same token, so one stop silences all of it.
    const tokens = new Set(mockEnqueue.mock.calls.map((c) => c[2]));
    expect(tokens.size).toBe(1);
  });
});
