// ---------------------------------------------------------------------------
// Conversation mode: hands-free turns, and the ways it must switch itself off.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mockTranscribe = vi.fn();
const mockSynthesize = vi.fn();
vi.mock("@/lib/api", () => ({
  transcribeAudio: (...a: unknown[]) => mockTranscribe(...a),
  synthesizeSpeech: (...a: unknown[]) => mockSynthesize(...a),
  getVoiceStatus: vi.fn(),
}));

const mockCaptureStart = vi.fn();
const mockCaptureStop = vi.fn();
const mockCaptureCancel = vi.fn();
vi.mock("@/lib/voice/audio-capture", async () => {
  const actual = await vi.importActual<typeof import("@/lib/voice/audio-capture")>("@/lib/voice/audio-capture");
  return {
    ...actual,
    isCaptureSupported: () => true,
    AudioCapture: class {
      start(...a: unknown[]) { return mockCaptureStart(...a); }
      stop(...a: unknown[]) { return mockCaptureStop(...a); }
      cancel(...a: unknown[]) { return mockCaptureCancel(...a); }
      getStream() { return {} as MediaStream; }
      get isRecording() { return true; }
    },
  };
});

// The microphone level the monitor reads. Tests set it directly.
let level = 0;
let tapAvailable = true;
vi.mock("@/lib/voice/audio-analyser", () => ({
  tapStream: () => (tapAvailable ? { read: () => ({ level }), stop: () => undefined } : null),
}));

vi.mock("@/lib/voice/audio-playback", async () => {
  const actual = await vi.importActual<typeof import("@/lib/voice/audio-playback")>("@/lib/voice/audio-playback");
  let gen = 1;
  return {
    ...actual,
    AudioPlayback: class {
      claim() { gen += 1; return gen; }
      isCurrent(g: number) { return g === gen; }
      setSegmentListeners() { return undefined; }
      enqueue() { return Promise.resolve(); }
      play() { return Promise.resolve(); }
      stop() { gen += 1; }
      unlock() { return undefined; }
      dispose() { return undefined; }
      get isPlaying() { return false; }
    },
  };
});

const mockSendMessage = vi.fn();
vi.mock("@/lib/chat-store", () => ({ useChatStore: { getState: () => chatState } }));
let chatState: {
  messages: Array<{ role: string; content: string; metadata?: Record<string, unknown> }>;
  activeConversationId: string | null;
  error: string | null;
  sendMessage: typeof mockSendMessage;
};

import { useVoiceStore } from "@/lib/voice/voice-store";

const CAPTURED = { base64: "AAAA", mimeType: "audio/webm", durationMs: 1500, bytes: 4096 };

/** Advances fake time in small steps so the 80 ms monitor and promise chains both run. */
async function advance(ms: number) {
  for (let t = 0; t < ms; t += 80) {
    await vi.advanceTimersByTimeAsync(80);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  level = 0;
  tapAvailable = true;
  useVoiceStore.setState({
    state: "idle", available: true, maxTtsChars: 4000, transcript: "",
    notice: null, autoSpeak: true, conversationMode: false,
  });
  chatState = { messages: [], activeConversationId: "conv-1", error: null, sendMessage: mockSendMessage };
  mockCaptureStart.mockResolvedValue(undefined);
  mockCaptureStop.mockResolvedValue(CAPTURED);
  mockTranscribe.mockResolvedValue({ success: true, data: { text: "hello", empty: false, model: "m" } });
  mockSynthesize.mockResolvedValue({ success: true, data: { audio: "A", mimeType: "audio/mpeg", model: "m", voice: "v" } });
  mockSendMessage.mockImplementation(async (_t: string, o?: { requestId?: string }) => ({
    requestId: o?.requestId ?? "r", conversationId: "conv-1", reply: "Hi there.", superseded: false, error: null,
  }));
});

afterEach(() => {
  useVoiceStore.getState().endConversation();
  vi.useRealTimers();
});

describe("conversation mode", () => {
  it("ends the take by itself when the person stops talking, then listens again after the reply", async () => {
    await useVoiceStore.getState().startConversation();
    expect(useVoiceStore.getState().state).toBe("listening");

    level = 0.6; // speaking
    await advance(500);
    level = 0.0; // pause
    await advance(1_500);

    expect(mockCaptureStop).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);

    await advance(1_000); // reply spoken, re-open delay elapses
    expect(useVoiceStore.getState().conversationMode).toBe(true);
    expect(useVoiceStore.getState().state).toBe("listening");
    expect(mockCaptureStart).toHaveBeenCalledTimes(2);
  });

  it("ends the mode instead of looping when nobody speaks", async () => {
    await useVoiceStore.getState().startConversation();
    await advance(9_000);

    const s = useVoiceStore.getState();
    expect(s.conversationMode).toBe(false);
    expect(s.state).toBe("idle");
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockCaptureCancel).toHaveBeenCalled();
  });

  it("does not reopen the microphone while an action waits for approval", async () => {
    mockSendMessage.mockImplementation(async (_t: string, o?: { requestId?: string }) => {
      chatState.messages.push({
        role: "assistant", content: "Send the email?",
        metadata: { pendingAction: { state: "WAITING_CONFIRMATION" } },
      });
      return { requestId: o?.requestId ?? "r", conversationId: "conv-1", reply: "Send the email?", superseded: false, error: null };
    });

    await useVoiceStore.getState().startConversation();
    level = 0.6; await advance(500);
    level = 0.0; await advance(3_000);

    const s = useVoiceStore.getState();
    expect(s.conversationMode).toBe(false);
    expect(s.state).toBe("idle");
    expect(s.notice?.message).toMatch(/approval/i);
    expect(mockCaptureStart).toHaveBeenCalledTimes(1);
  });

  it("switches off when the microphone is denied", async () => {
    mockCaptureStart.mockRejectedValue(Object.assign(new Error("denied"), { reason: "permission-denied" }));
    await useVoiceStore.getState().startConversation();
    expect(useVoiceStore.getState().conversationMode).toBe(false);
    expect(useVoiceStore.getState().state).not.toBe("listening");
  });

  it("switches off when the microphone level cannot be read", async () => {
    tapAvailable = false;
    await useVoiceStore.getState().startConversation();
    await advance(200);
    expect(useVoiceStore.getState().conversationMode).toBe(false);
    expect(useVoiceStore.getState().state).toBe("idle");
  });

  it("ending the mode mid-take releases the microphone", async () => {
    await useVoiceStore.getState().startConversation();
    useVoiceStore.getState().endConversation();
    expect(useVoiceStore.getState().conversationMode).toBe(false);
    expect(useVoiceStore.getState().state).toBe("idle");
    expect(mockCaptureCancel).toHaveBeenCalled();
  });

  it("does not reopen after the person turns it off during the reply", async () => {
    await useVoiceStore.getState().startConversation();
    level = 0.6; await advance(500);
    level = 0.0; await advance(1_500);
    useVoiceStore.getState().endConversation();
    await advance(2_000);
    expect(mockCaptureStart).toHaveBeenCalledTimes(1);
  });

  it("a plain microphone press never turns the mode on", async () => {
    await useVoiceStore.getState().startListening();
    level = 0.6; await advance(500);
    level = 0.0; await advance(3_000);
    expect(useVoiceStore.getState().conversationMode).toBe(false);
    expect(mockCaptureStop).not.toHaveBeenCalled();
  });
});
