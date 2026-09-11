// ---------------------------------------------------------------------------
// Sprint 8.3-8.7 — Voice client tests.
//
// The microphone and the audio element are mocked; what is under test is the
// turn logic: that the state machine is respected, that a transcript reaches
// the EXISTING chat pipeline unchanged, and above all that a spoken word can
// never resolve an approval.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";

// --- mocks must be declared before the modules under test are imported -----

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
let captureSupported = true;

vi.mock("@/lib/voice/audio-capture", async () => {
  const actual = await vi.importActual<typeof import("@/lib/voice/audio-capture")>(
    "@/lib/voice/audio-capture"
  );
  return {
    ...actual,
    isCaptureSupported: () => captureSupported,
    // Methods, not field initializers: `vi.mock` factories are hoisted above
    // the const declarations above, and the store constructs this class at
    // module scope. A field initializer would read the mocks before they
    // exist; a method body reads them at call time.
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

const mockPlay = vi.fn();
const mockEnqueue = vi.fn();
const mockStop = vi.fn();
const mockUnlock = vi.fn();

/**
 * Generation the fake playback reports as live.
 *
 * A test that wants to model "the user stopped while the reply was being
 * synthesized" moves this on, exactly as the real `stop()` does.
 */
let playbackGeneration = 1;

vi.mock("@/lib/voice/audio-playback", async () => {
  const actual = await vi.importActual<typeof import("@/lib/voice/audio-playback")>(
    "@/lib/voice/audio-playback"
  );
  return {
    ...actual,
    AudioPlayback: class {
      claim() {
        return playbackGeneration;
      }
      isCurrent(generation: number) {
        return generation === playbackGeneration;
      }
      setSegmentListeners() {
        return undefined;
      }
      enqueue(...args: unknown[]) {
        return mockEnqueue(...args) ?? Promise.resolve();
      }
      play(...args: unknown[]) {
        return mockPlay(...args);
      }
      stop(...args: unknown[]) {
        playbackGeneration += 1;
        return mockStop(...args);
      }
      unlock(...args: unknown[]) {
        return mockUnlock(...args);
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
  useChatStore: {
    getState: () => chatState,
  },
}));

let chatState: {
  messages: Array<{ role: string; content: string; metadata?: Record<string, unknown> }>;
  activeConversationId: string | null;
  error: string | null;
  sendMessage: typeof mockSendMessage;
};

import { textForSpeech, useVoiceStore } from "@/lib/voice/voice-store";
import { CaptureError } from "@/lib/voice/audio-capture";

const CAPTURED = {
  base64: "AAAA",
  mimeType: "audio/webm;codecs=opus",
  durationMs: 1500,
  bytes: 4096,
};

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

describe("Sprint 8 — voice client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captureSupported = true;
    resetStore();

    chatState = {
      messages: [],
      activeConversationId: "conv-1",
      error: null,
      sendMessage: mockSendMessage,
    };

    mockCaptureStart.mockResolvedValue(undefined);
    mockCaptureStop.mockResolvedValue(CAPTURED);
    mockTranscribe.mockResolvedValue({
      success: true,
      data: { text: "show me campaign performance", empty: false, model: "whisper-1" },
    });
    mockSynthesize.mockResolvedValue({
      success: true,
      data: { audio: "BBBB", mimeType: "audio/mpeg", model: "tts", voice: "alloy" },
    });
    mockPlay.mockResolvedValue(undefined);
    mockEnqueue.mockResolvedValue(undefined);
    playbackGeneration = 1;

    // `sendMessage` returns the reply it produced. The voice turn speaks THAT
    // string rather than looking for the newest assistant message, which is
    // what let a slow turn read out the previous turn's answer.
    mockSendMessage.mockImplementation(async (content: string, options?: { requestId?: string }) => {
      chatState.messages.push({ role: "assistant", content: "Here is the report." });
      return {
        requestId: options?.requestId ?? "chat-1",
        conversationId: chatState.activeConversationId,
        reply: "Here is the report.",
        superseded: false,
        error: null,
      };
    });
  });

  // -------------------------------------------------------------------------
  // The locked approval rule
  // -------------------------------------------------------------------------

  describe("voice cannot approve an action", () => {
    beforeEach(() => {
      chatState.messages = [
        {
          role: "assistant",
          content: "I can pause that campaign. Approve?",
          metadata: {
            pendingAction: { state: "WAITING_CONFIRMATION", toolId: "meta.campaign.pause" },
          },
        },
      ];
    });

    it("does not send a spoken 'yes' into the pipeline", async () => {
      mockTranscribe.mockResolvedValue({
        success: true,
        data: { text: "yes go ahead", empty: false, model: "whisper-1" },
      });

      await useVoiceStore.getState().startListening();
      await useVoiceStore.getState().stopListening();

      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it("does not send a mis-heard confirmation either", async () => {
      // "no" misheard as "yo" is exactly the failure this rule exists for.
      for (const heard of ["yo", "haan kar do", "yeah", "approve it"]) {
        vi.clearAllMocks();
        resetStore();
        mockCaptureStart.mockResolvedValue(undefined);
        mockCaptureStop.mockResolvedValue(CAPTURED);
        mockTranscribe.mockResolvedValue({
          success: true,
          data: { text: heard, empty: false, model: "whisper-1" },
        });

        await useVoiceStore.getState().startListening();
        await useVoiceStore.getState().stopListening();

        expect(mockSendMessage, heard).not.toHaveBeenCalled();
      }
    });

    it("still shows the user what was heard", async () => {
      mockTranscribe.mockResolvedValue({
        success: true,
        data: { text: "yes go ahead", empty: false, model: "whisper-1" },
      });

      await useVoiceStore.getState().startListening();
      await useVoiceStore.getState().stopListening();

      expect(useVoiceStore.getState().transcript).toBe("yes go ahead");
    });

    it("explains that approval must happen on screen", async () => {
      await useVoiceStore.getState().startListening();
      await useVoiceStore.getState().stopListening();

      const notice = useVoiceStore.getState().notice;
      expect(notice?.message).toMatch(/approv/i);
      expect(notice?.message).toMatch(/on screen/i);
      expect(notice?.benign).toBe(true);
      expect(useVoiceStore.getState().state).toBe("idle");
    });

    it("resumes normally once the approval is resolved", async () => {
      chatState.messages = [
        {
          role: "assistant",
          content: "Done.",
          metadata: { pendingAction: { state: "COMPLETED" } },
        },
      ];

      await useVoiceStore.getState().startListening();
      await useVoiceStore.getState().stopListening();

      expect(mockSendMessage).toHaveBeenCalledWith(
        "show me campaign performance",
        expect.objectContaining({ requestId: expect.stringMatching(/^vt-/) })
      );
    });
  });

  // -------------------------------------------------------------------------
  // The happy path reuses the existing pipeline
  // -------------------------------------------------------------------------

  describe("a normal voice turn", () => {
    it("sends the transcript verbatim through the chat store", async () => {
      await useVoiceStore.getState().startListening();
      await useVoiceStore.getState().stopListening();

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      // The transcript is unchanged; the second argument is the turn's identity,
      // which is how the reply that comes back is known to belong to it.
      expect(mockSendMessage).toHaveBeenCalledWith(
        "show me campaign performance",
        expect.objectContaining({ requestId: expect.stringMatching(/^vt-/) })
      );
    });

    it("speaks the reply and returns to idle", async () => {
      await useVoiceStore.getState().startListening();
      await useVoiceStore.getState().stopListening();

      expect(mockSynthesize).toHaveBeenCalledTimes(1);
      // Queued under the turn's playback token, not played blind.
      expect(mockEnqueue).toHaveBeenCalledWith("BBBB", "audio/mpeg", 1);
      expect(useVoiceStore.getState().state).toBe("idle");
    });

    it("passes the active conversation through for correlation", async () => {
      await useVoiceStore.getState().startListening();
      await useVoiceStore.getState().stopListening();

      expect(mockTranscribe).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: "conv-1" }),
        expect.anything()
      );
    });

    it("does not speak when replies are muted", async () => {
      useVoiceStore.setState({ autoSpeak: false });

      await useVoiceStore.getState().startListening();
      await useVoiceStore.getState().stopListening();

      expect(mockSendMessage).toHaveBeenCalled();
      expect(mockSynthesize).not.toHaveBeenCalled();
    });

    it("unlocks audio during the click, before any await", async () => {
      // Browsers only allow playback traceable to a user gesture.
      await useVoiceStore.getState().startListening();
      expect(mockUnlock).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // States and failures
  // -------------------------------------------------------------------------

  describe("state handling", () => {
    it("reports an unsupported browser instead of failing silently", async () => {
      captureSupported = false;

      await useVoiceStore.getState().startListening();

      expect(useVoiceStore.getState().state).toBe("unsupported");
      expect(useVoiceStore.getState().notice?.message).toMatch(/cannot record/i);
    });

    it("surfaces a denied microphone with a recoverable message", async () => {
      mockCaptureStart.mockRejectedValue(
        new CaptureError("permission-denied", "denied")
      );

      await useVoiceStore.getState().startListening();

      expect(useVoiceStore.getState().state).toBe("permission-denied");
      expect(useVoiceStore.getState().notice?.message).toMatch(/allow it/i);
    });

    it("treats silence as benign and returns to idle", async () => {
      mockTranscribe.mockResolvedValue({
        success: true,
        data: { text: "", empty: true, model: "whisper-1" },
      });

      await useVoiceStore.getState().startListening();
      await useVoiceStore.getState().stopListening();

      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(useVoiceStore.getState().state).toBe("idle");
      expect(useVoiceStore.getState().notice?.benign).toBe(true);
    });

    it("treats a too-short take as benign", async () => {
      mockCaptureStop.mockRejectedValue(new CaptureError("no-audio", "too short"));

      await useVoiceStore.getState().startListening();
      await useVoiceStore.getState().stopListening();

      expect(useVoiceStore.getState().state).toBe("idle");
      expect(useVoiceStore.getState().notice?.benign).toBe(true);
    });

    it("surfaces a provider outage as a real error", async () => {
      mockTranscribe.mockResolvedValue({
        success: false,
        error: { code: "VOICE_PROVIDER_UNAVAILABLE", message: "down" },
      });

      await useVoiceStore.getState().startListening();
      await useVoiceStore.getState().stopListening();

      expect(useVoiceStore.getState().state).toBe("error");
      expect(useVoiceStore.getState().notice?.benign).toBe(false);
      expect(useVoiceStore.getState().notice?.message).toMatch(/still type/i);
    });

    it("keeps the reply when only the audio fails", async () => {
      mockSynthesize.mockResolvedValue({
        success: false,
        error: { code: "VOICE_SYNTHESIS_FAILED", message: "boom" },
      });

      await useVoiceStore.getState().startListening();
      await useVoiceStore.getState().stopListening();

      // The answer is already on screen; losing the audio is not an error state.
      expect(mockSendMessage).toHaveBeenCalled();
      expect(useVoiceStore.getState().state).toBe("idle");
      expect(useVoiceStore.getState().notice?.benign).toBe(true);
    });

    it("surfaces a chat pipeline failure", async () => {
      mockSendMessage.mockImplementation(async (_content: string, options?: { requestId?: string }) => {
        chatState.error = "Meta data retrieval failed";
        return {
          requestId: options?.requestId ?? "chat-1",
          conversationId: "conv-1",
          reply: "",
          superseded: false,
          error: "Meta data retrieval failed",
        };
      });

      await useVoiceStore.getState().startListening();
      await useVoiceStore.getState().stopListening();

      expect(useVoiceStore.getState().notice?.message).toBe("Meta data retrieval failed");
      expect(mockSynthesize).not.toHaveBeenCalled();
    });

    it("ignores stopListening when not listening", async () => {
      await useVoiceStore.getState().stopListening();
      expect(mockTranscribe).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Barge-in
  // -------------------------------------------------------------------------

  describe("interrupting playback", () => {
    it("stops the audio and returns to idle", () => {
      useVoiceStore.setState({ state: "speaking" });

      useVoiceStore.getState().stopSpeaking();

      expect(mockStop).toHaveBeenCalled();
      expect(useVoiceStore.getState().state).toBe("idle");
    });

    it("does not send anything upstream", () => {
      // Stopping playback must never look like cancelling the turn: the tool
      // already ran and was audited.
      useVoiceStore.setState({ state: "speaking" });

      useVoiceStore.getState().stopSpeaking();

      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(mockTranscribe).not.toHaveBeenCalled();
    });

    it("cancel releases the microphone", () => {
      useVoiceStore.getState().cancel();

      expect(mockCaptureCancel).toHaveBeenCalled();
      expect(mockStop).toHaveBeenCalled();
      expect(useVoiceStore.getState().state).toBe("idle");
    });

    it("muting replies stops any audio already playing", () => {
      useVoiceStore.setState({ autoSpeak: true });

      useVoiceStore.getState().toggleAutoSpeak();

      expect(useVoiceStore.getState().autoSpeak).toBe(false);
      expect(mockStop).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Availability
  // -------------------------------------------------------------------------

  describe("availability", () => {
    it("hides voice when the deployment has it switched off", async () => {
      useVoiceStore.setState({ available: null });
      mockVoiceStatus.mockResolvedValue({
        success: false,
        error: { code: "NOT_FOUND", message: "404" },
      });

      await useVoiceStore.getState().checkAvailability();

      expect(useVoiceStore.getState().available).toBe(false);
    });

    it("adopts the server's character ceiling", async () => {
      useVoiceStore.setState({ available: null });
      mockVoiceStatus.mockResolvedValue({
        success: true,
        data: { enabled: true, maxTtsChars: 1200 },
      });

      await useVoiceStore.getState().checkAvailability();

      expect(useVoiceStore.getState().available).toBe(true);
      expect(useVoiceStore.getState().maxTtsChars).toBe(1200);
    });
  });
});

// ---------------------------------------------------------------------------

describe("Sprint 8 — text prepared for speech", () => {
  it("strips markdown that would otherwise be read aloud", () => {
    const spoken = textForSpeech("## Summary\n\n**CPA** rose by *12%*.\n\n- Campaign A\n- Campaign B");

    expect(spoken).not.toContain("##");
    expect(spoken).not.toContain("**");
    expect(spoken).toContain("Summary");
    expect(spoken).toContain("CPA");
    expect(spoken).toContain("12%");
  });

  it("does not read code blocks aloud", () => {
    const spoken = textForSpeech("Here:\n\n```js\nconst x = 1;\n```\n\nDone.");

    expect(spoken).not.toContain("const x = 1");
    expect(spoken).toContain("Done.");
  });

  it("keeps link text and drops the URL", () => {
    const spoken = textForSpeech("See [the dashboard](https://example.com/very/long/url).");

    expect(spoken).toContain("the dashboard");
    expect(spoken).not.toContain("https://");
  });

  it("truncates at a sentence boundary rather than mid-word", () => {
    const long = "This is a sentence. ".repeat(50);
    const spoken = textForSpeech(long, 200);

    expect(spoken.length).toBeLessThanOrEqual(200);
    expect(spoken.endsWith(".")).toBe(true);
  });

  it("leaves short plain text untouched", () => {
    expect(textForSpeech("Your CPA is 12 rupees.")).toBe("Your CPA is 12 rupees.");
  });
});
