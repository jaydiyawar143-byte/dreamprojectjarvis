// ---------------------------------------------------------------------------
// Sprint 8.0 — Voice contract tests.
//
// Contracts only. No provider, no route, no browser: this phase ships types,
// pure data and two pure functions, and these tests pin exactly that.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  SPEECH_FORMAT_MIME_TYPES,
  SUPPORTED_AUDIO_MIME_TYPES,
  SpeechAudioFormatSchema,
  SpeechSynthesisRequestSchema,
  SpeechSynthesisResultSchema,
  TranscriptionRequestSchema,
  TranscriptionResultSchema,
  VOICE_APPROVAL_POLICY,
  VOICE_ERROR_STATUS,
  VOICE_STATE_TRANSITIONS,
  VoiceErrorCodeSchema,
  VoiceProvenanceSchema,
  VoiceStateSchema,
  canTransitionVoiceState,
  isSupportedAudioMimeType,
  isVoiceBusy,
  normalizeAudioMimeType,
  type VoiceState,
} from "../src/types/voice.js";

describe("Sprint 8.0 — voice contracts", () => {
  // -------------------------------------------------------------------------
  // Approval safety — the locked decision
  // -------------------------------------------------------------------------

  describe("approval policy", () => {
    it("forbids voice from confirming a pending action", () => {
      expect(VOICE_APPROVAL_POLICY.canConfirmPendingActions).toBe(false);
      expect(VOICE_APPROVAL_POLICY.requiresOnScreenConfirmation).toBe(true);
    });

    it("cannot be flipped at runtime", () => {
      expect(() => {
        (VOICE_APPROVAL_POLICY as { canConfirmPendingActions: boolean }).canConfirmPendingActions =
          true;
      }).toThrow();

      expect(VOICE_APPROVAL_POLICY.canConfirmPendingActions).toBe(false);
    });

    it("has an error code for the refusal", () => {
      expect(VoiceErrorCodeSchema.safeParse("VOICE_APPROVAL_REQUIRES_UI").success).toBe(
        true
      );
    });
  });

  // -------------------------------------------------------------------------
  // State machine
  // -------------------------------------------------------------------------

  describe("voice state", () => {
    it("accepts every declared state and rejects anything else", () => {
      for (const state of [
        "idle",
        "requesting-permission",
        "listening",
        "transcribing",
        "processing",
        "speaking",
        "permission-denied",
        "unsupported",
        "error",
      ]) {
        expect(VoiceStateSchema.safeParse(state).success, state).toBe(true);
      }

      expect(VoiceStateSchema.safeParse("wake-word").success).toBe(false);
      expect(VoiceStateSchema.safeParse("").success).toBe(false);
    });

    it("declares transitions for every state", () => {
      for (const state of VoiceStateSchema.options) {
        expect(VOICE_STATE_TRANSITIONS[state], state).toBeDefined();
      }
    });

    it("only names real states as targets", () => {
      const valid = new Set<string>(VoiceStateSchema.options);
      for (const [from, targets] of Object.entries(VOICE_STATE_TRANSITIONS)) {
        for (const to of targets) {
          expect(valid.has(to), `${from} -> ${to}`).toBe(true);
        }
      }
    });

    it("allows the happy path end to end", () => {
      const path: VoiceState[] = [
        "idle",
        "requesting-permission",
        "listening",
        "transcribing",
        "processing",
        "speaking",
        "idle",
      ];
      for (let i = 0; i < path.length - 1; i++) {
        expect(
          canTransitionVoiceState(path[i]!, path[i + 1]!),
          `${path[i]} -> ${path[i + 1]}`
        ).toBe(true);
      }
    });

    it("refuses to chain speaking straight back into listening", () => {
      // That chain is what quietly turns push-to-talk into an open mic.
      expect(canTransitionVoiceState("speaking", "listening")).toBe(false);
      expect(canTransitionVoiceState("speaking", "idle")).toBe(true);
    });

    it("treats an unsupported browser as terminal", () => {
      expect(VOICE_STATE_TRANSITIONS.unsupported).toEqual([]);
      expect(canTransitionVoiceState("unsupported", "listening")).toBe(false);
      expect(canTransitionVoiceState("unsupported", "idle")).toBe(false);
    });

    it("lets a denied permission be retried", () => {
      expect(canTransitionVoiceState("permission-denied", "requesting-permission")).toBe(
        true
      );
      expect(canTransitionVoiceState("error", "idle")).toBe(true);
    });

    it("never jumps from idle straight into processing or speaking", () => {
      expect(canTransitionVoiceState("idle", "processing")).toBe(false);
      expect(canTransitionVoiceState("idle", "speaking")).toBe(false);
    });

    it("reports which states are busy", () => {
      expect(isVoiceBusy("idle")).toBe(false);
      expect(isVoiceBusy("permission-denied")).toBe(false);
      expect(isVoiceBusy("unsupported")).toBe(false);
      expect(isVoiceBusy("error")).toBe(false);

      for (const busy of [
        "requesting-permission",
        "listening",
        "transcribing",
        "processing",
        "speaking",
      ] as VoiceState[]) {
        expect(isVoiceBusy(busy), busy).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Audio formats
  // -------------------------------------------------------------------------

  describe("audio media types", () => {
    it("strips codec parameters", () => {
      // What Chromium's MediaRecorder actually reports.
      expect(normalizeAudioMimeType("audio/webm;codecs=opus")).toBe("audio/webm");
      expect(normalizeAudioMimeType("audio/mp4; codecs=mp4a.40.2")).toBe("audio/mp4");
      expect(normalizeAudioMimeType("  AUDIO/WEBM  ")).toBe("audio/webm");
    });

    it("returns null for anything that is not a media type string", () => {
      expect(normalizeAudioMimeType(undefined)).toBeNull();
      expect(normalizeAudioMimeType(null)).toBeNull();
      expect(normalizeAudioMimeType(42)).toBeNull();
      expect(normalizeAudioMimeType("")).toBeNull();
      expect(normalizeAudioMimeType(";codecs=opus")).toBeNull();
    });

    it("accepts what the major browsers produce", () => {
      expect(isSupportedAudioMimeType("audio/webm;codecs=opus")).toBe(true); // Chromium
      expect(isSupportedAudioMimeType("audio/mp4")).toBe(true); // Safari
      expect(isSupportedAudioMimeType("audio/wav")).toBe(true);
    });

    it("rejects non-audio and unknown types", () => {
      expect(isSupportedAudioMimeType("video/mp4")).toBe(false);
      expect(isSupportedAudioMimeType("application/json")).toBe(false);
      expect(isSupportedAudioMimeType("text/html")).toBe(false);
      expect(isSupportedAudioMimeType(undefined)).toBe(false);
    });

    it("maps every synthesis format to a media type", () => {
      for (const format of SpeechAudioFormatSchema.options) {
        expect(SPEECH_FORMAT_MIME_TYPES[format], format).toBeTruthy();
      }
    });

    it("keeps the accepted-upload list frozen", () => {
      expect(() => {
        (SUPPORTED_AUDIO_MIME_TYPES as unknown as string[]).push("application/zip");
      }).toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Transcription
  // -------------------------------------------------------------------------

  describe("transcription contract", () => {
    it("accepts a minimal upload", () => {
      const parsed = TranscriptionRequestSchema.safeParse({
        audio: "AAAA",
        mimeType: "audio/webm;codecs=opus",
      });
      expect(parsed.success).toBe(true);
    });

    it("requires audio and a media type", () => {
      expect(TranscriptionRequestSchema.safeParse({ mimeType: "audio/webm" }).success).toBe(
        false
      );
      expect(TranscriptionRequestSchema.safeParse({ audio: "AAAA" }).success).toBe(false);
      expect(
        TranscriptionRequestSchema.safeParse({ audio: "", mimeType: "audio/webm" }).success
      ).toBe(false);
    });

    it("rejects a negative duration", () => {
      expect(
        TranscriptionRequestSchema.safeParse({
          audio: "AAAA",
          mimeType: "audio/webm",
          durationMs: -1,
        }).success
      ).toBe(false);
    });

    it("treats an empty transcript as a valid result", () => {
      // Silence is an answer, not a failure.
      const parsed = TranscriptionResultSchema.safeParse({ text: "", model: "whisper-1" });
      expect(parsed.success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Synthesis
  // -------------------------------------------------------------------------

  describe("synthesis contract", () => {
    it("accepts text alone", () => {
      expect(SpeechSynthesisRequestSchema.safeParse({ text: "Hello" }).success).toBe(true);
    });

    it("rejects empty text", () => {
      expect(SpeechSynthesisRequestSchema.safeParse({ text: "" }).success).toBe(false);
      expect(SpeechSynthesisRequestSchema.safeParse({}).success).toBe(false);
    });

    it("rejects an unknown output format", () => {
      expect(
        SpeechSynthesisRequestSchema.safeParse({ text: "Hi", format: "midi" }).success
      ).toBe(false);
    });

    it("describes a complete result", () => {
      const parsed = SpeechSynthesisResultSchema.safeParse({
        audio: "AAAA",
        mimeType: "audio/mpeg",
        model: "gpt-4o-mini-tts",
        voice: "alloy",
        format: "mp3",
        characterCount: 5,
      });
      expect(parsed.success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Errors
  // -------------------------------------------------------------------------

  describe("error codes", () => {
    it("maps every code to an HTTP status", () => {
      for (const code of VoiceErrorCodeSchema.options) {
        expect(VOICE_ERROR_STATUS[code], code).toBeTypeOf("number");
      }
    });

    it("treats an empty transcript as success, not failure", () => {
      expect(VOICE_ERROR_STATUS.VOICE_TRANSCRIPTION_EMPTY).toBe(200);
    });

    it("uses the documented statuses for size and format limits", () => {
      expect(VOICE_ERROR_STATUS.VOICE_AUDIO_TOO_LARGE).toBe(413);
      expect(VOICE_ERROR_STATUS.VOICE_TEXT_TOO_LONG).toBe(413);
      expect(VOICE_ERROR_STATUS.VOICE_UNSUPPORTED_FORMAT).toBe(415);
      expect(VOICE_ERROR_STATUS.VOICE_RATE_LIMITED).toBe(429);
    });

    it("does not report a provider outage as a client error", () => {
      expect(VOICE_ERROR_STATUS.VOICE_PROVIDER_UNAVAILABLE).toBeGreaterThanOrEqual(500);
      expect(VOICE_ERROR_STATUS.VOICE_TRANSCRIPTION_FAILED).toBeGreaterThanOrEqual(500);
      expect(VOICE_ERROR_STATUS.VOICE_SYNTHESIS_FAILED).toBeGreaterThanOrEqual(500);
    });
  });

  // -------------------------------------------------------------------------
  // Provenance
  // -------------------------------------------------------------------------

  describe("message provenance", () => {
    it("records how a turn was produced", () => {
      const parsed = VoiceProvenanceSchema.safeParse({
        source: "voice",
        sttModel: "whisper-1",
        audioDurationMs: 2400,
        spoken: true,
        ttsModel: "gpt-4o-mini-tts",
        ttsVoice: "alloy",
      });
      expect(parsed.success).toBe(true);
    });

    it("accepts a plain text turn", () => {
      expect(VoiceProvenanceSchema.safeParse({ source: "text" }).success).toBe(true);
    });

    it("refuses to carry audio into the conversation record", () => {
      // The whole point of .strict(): a recording must never reach Message.metadata.
      expect(
        VoiceProvenanceSchema.safeParse({ source: "voice", audio: "AAAA" }).success
      ).toBe(false);
      expect(
        VoiceProvenanceSchema.safeParse({ source: "voice", audioBase64: "AAAA" }).success
      ).toBe(false);
      expect(
        VoiceProvenanceSchema.safeParse({ source: "voice", recording: {} }).success
      ).toBe(false);
    });

    it("requires a known source", () => {
      expect(VoiceProvenanceSchema.safeParse({ source: "wake-word" }).success).toBe(false);
      expect(VoiceProvenanceSchema.safeParse({}).success).toBe(false);
    });
  });
});
