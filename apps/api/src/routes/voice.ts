// ---------------------------------------------------------------------------
// Sprint 8.1 / 8.2 — Voice routes.
//
// Two stateless transformations and a status probe. Neither endpoint touches a
// conversation, a memory, an agent or an approval: the transcript goes back to
// the browser, and the browser sends it through the SAME `POST /api/v1/chat`
// a typed message goes through. That is what keeps routing, tool allowlists,
// permissions, approval gates, tenant isolation and audit in exactly one place
// instead of two.
//
// Audio arrives as base64 in a JSON body, matching the Sprint 3 knowledge
// upload: no multipart dependency, and the app-wide express.json parser
// already handles it.
//
// Audio is NEVER persisted. It exists as a Buffer for the length of one
// provider call and is then discarded. Only the transcript is stored, and only
// through the ordinary chat pipeline.
// ---------------------------------------------------------------------------

import { Router } from "express";
import type { Response } from "express";
import { randomUUID } from "node:crypto";
import { createAuthMiddleware, type AuthenticatedRequest } from "../middleware/auth.js";
import type { Container } from "../services/container.js";
import {
  DbBackedRateLimiter,
  RATE_LIMIT_NAMESPACES,
  VOICE_RATE_LIMITS,
} from "../services/rate-limiter.js";
import type { VoiceConfig } from "@jarvis/config";
import {
  JarvisError,
  SpeechSynthesisRequestSchema,
  TranscriptionRequestSchema,
  VOICE_ERROR_STATUS,
  isSupportedAudioMimeType,
  normalizeAudioMimeType,
  prepareForSpeech,
  type IVoiceProvider,
  type VoiceErrorCode,
} from "@jarvis/core";

export interface VoiceRouterDeps {
  provider: IVoiceProvider;
  config: VoiceConfig;
}

const now = () => new Date().toISOString();

/** Base64 without whitespace, as `Buffer.from` silently ignores bad characters. */
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

function fail(
  res: Response,
  code: VoiceErrorCode,
  message: string,
  traceId: string
): void {
  res.status(VOICE_ERROR_STATUS[code]).json({
    success: false,
    error: { code, message },
    traceId,
    timestamp: now(),
  });
}

function decodeAudio(
  raw: unknown,
  maxBytes: number
): { ok: true; bytes: Buffer } | { ok: false; code: VoiceErrorCode; message: string } {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, code: "VOICE_AUDIO_INVALID", message: "audio must be a base64 string" };
  }

  const compact = raw.replace(/\s/g, "");
  if (!BASE64_PATTERN.test(compact)) {
    return { ok: false, code: "VOICE_AUDIO_INVALID", message: "audio is not valid base64" };
  }

  // Checked BEFORE decoding: base64 length bounds the decoded size, so an
  // oversized payload is rejected without allocating a buffer for it.
  const approxBytes = Math.floor((compact.length * 3) / 4);
  if (approxBytes > maxBytes) {
    return {
      ok: false,
      code: "VOICE_AUDIO_TOO_LARGE",
      message: `Audio exceeds the maximum size of ${maxBytes} bytes`,
    };
  }

  const bytes = Buffer.from(compact, "base64");
  if (bytes.length === 0) {
    return { ok: false, code: "VOICE_AUDIO_INVALID", message: "audio is empty" };
  }
  if (bytes.length > maxBytes) {
    return {
      ok: false,
      code: "VOICE_AUDIO_TOO_LARGE",
      message: `Audio exceeds the maximum size of ${maxBytes} bytes`,
    };
  }

  return { ok: true, bytes };
}

export function createVoiceRouter(container: Container, deps: VoiceRouterDeps): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(container.tokenService);
  const rateLimiter = new DbBackedRateLimiter(
    container.auditLogger,
    RATE_LIMIT_NAMESPACES.voice
  );

  /**
   * Consumes one unit of the caller's budget.
   *
   * Every attempt is audited whether it is allowed or throttled — the audit
   * table IS the counter, so an un-audited attempt would be a free one.
   */
  async function withinBudget(
    res: Response,
    userId: string,
    bucket: keyof typeof VOICE_RATE_LIMITS,
    traceId: string
  ): Promise<boolean> {
    const policy = VOICE_RATE_LIMITS[bucket];
    const decision = await rateLimiter.check(userId, bucket, policy.limit, policy.windowMs);

    if (!decision.allowed) {
      await container.auditLogger.log({
        userId,
        action: `voice.${bucket}`,
        result: "failure",
        traceId,
        metadata: { rateLimited: true, currentCount: decision.currentCount },
      });
      fail(res, "VOICE_RATE_LIMITED", "Too many voice requests. Try again shortly.", traceId);
      return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // GET /status — lets the client decide whether to show a microphone at all
  // -------------------------------------------------------------------------
  router.get("/status", requireAuth, (_req: AuthenticatedRequest, res: Response) => {
    res.status(200).json({
      success: true,
      data: {
        enabled: true,
        sttModel: deps.provider.sttModel,
        ttsModel: deps.provider.ttsModel,
        voice: deps.provider.defaultVoice,
        maxAudioBytes: deps.config.maxAudioBytes,
        maxTtsChars: deps.config.maxTtsChars,
        // Surfaced so the UI never has to hardcode the rule; see
        // VOICE_APPROVAL_POLICY in @jarvis/core.
        canConfirmApprovals: false,
      },
      timestamp: now(),
    });
  });

  // -------------------------------------------------------------------------
  // POST /transcribe — audio -> text
  // -------------------------------------------------------------------------
  router.post("/transcribe", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const traceId = randomUUID();
    const userId = req.auth?.userId;
    if (!userId) {
      return fail(res, "VOICE_PERMISSION_DENIED", "Authentication required", traceId);
    }

    if (!(await withinBudget(res, userId, "transcribe", traceId))) return;

    const parsed = TranscriptionRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return fail(res, "VOICE_AUDIO_INVALID", "audio and mimeType are required", traceId);
    }

    const { audio, mimeType, language, durationMs, requestId, conversationId } = parsed.data;

    if (!isSupportedAudioMimeType(mimeType)) {
      return fail(
        res,
        "VOICE_UNSUPPORTED_FORMAT",
        `Unsupported audio format: ${normalizeAudioMimeType(mimeType) ?? "unknown"}`,
        traceId
      );
    }

    const decoded = decodeAudio(audio, deps.config.maxAudioBytes);
    if (!decoded.ok) {
      return fail(res, decoded.code, decoded.message, traceId);
    }

    try {
      const result = await deps.provider.transcribe({
        audio: decoded.bytes,
        mimeType,
        ...(language ? { language } : {}),
      });

      // Length and timing only. The transcript itself is conversation content
      // and belongs in the Message row, not scattered through the audit log.
      await container.auditLogger.log({
        userId,
        action: "voice.transcribe",
        result: "success",
        traceId,
        ipAddress: req.ip,
        metadata: {
          model: result.model,
          audioBytes: decoded.bytes.length,
          transcriptLength: result.text.length,
          ...(durationMs !== undefined ? { audioDurationMs: durationMs } : {}),
          ...(requestId ? { requestId } : {}),
          ...(conversationId ? { conversationId } : {}),
          latencyMs: result.latencyMs,
        },
      });

      // An empty transcript is a successful request whose answer is "nothing
      // was said" — silence, a mis-tap, a cough. The client shows "I didn't
      // catch that" rather than an error state.
      res.status(200).json({
        success: true,
        data: {
          text: result.text,
          empty: result.text.length === 0,
          model: result.model,
          latencyMs: result.latencyMs,
          // Echoed back so the client can prove the transcript it received
          // belongs to the turn it asked about, without trusting call ordering.
          ...(requestId ? { requestId } : {}),
        },
        traceId,
        timestamp: now(),
      });
    } catch (err) {
      await container.auditLogger.log({
        userId,
        action: "voice.transcribe",
        result: "failure",
        traceId,
        ipAddress: req.ip,
        metadata: {
          audioBytes: decoded.bytes.length,
          ...(requestId ? { requestId } : {}),
          error: err instanceof JarvisError ? err.code : "UNKNOWN",
        },
      });

      const unavailable =
        err instanceof JarvisError &&
        (err.code === "TOOL_UNAVAILABLE" || err.code === "TOOL_RATE_LIMITED");

      return fail(
        res,
        unavailable ? "VOICE_PROVIDER_UNAVAILABLE" : "VOICE_TRANSCRIPTION_FAILED",
        "Could not transcribe the recording. Please try again.",
        traceId
      );
    }
  });

  // -------------------------------------------------------------------------
  // POST /speak — text -> audio
  // -------------------------------------------------------------------------
  router.post("/speak", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const traceId = randomUUID();
    const userId = req.auth?.userId;
    if (!userId) {
      return fail(res, "VOICE_PERMISSION_DENIED", "Authentication required", traceId);
    }

    if (!(await withinBudget(res, userId, "speak", traceId))) return;

    const parsed = SpeechSynthesisRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return fail(res, "VOICE_TEXT_EMPTY", "text is required", traceId);
    }

    const { text, voice, format, requestId, conversationId } = parsed.data;

    if (text.trim().length === 0) {
      return fail(res, "VOICE_TEXT_EMPTY", "text is required", traceId);
    }

    // Rejected rather than truncated: silently speaking half a reply would
    // leave the user believing they heard all of it.
    if (text.length > deps.config.maxTtsChars) {
      return fail(
        res,
        "VOICE_TEXT_TOO_LONG",
        `Text exceeds the maximum of ${deps.config.maxTtsChars} characters`,
        traceId
      );
    }

    // -----------------------------------------------------------------------
    // Spoken form, prepared HERE rather than by the caller.
    //
    // The web client already stripped markdown on its way in, which fixed the
    // symptom for one caller and left the endpoint itself speaking whatever it
    // was handed — raw tables, tool ids, error enums, approval tokens. Doing it
    // at the route makes it a property of /speak: every caller gets it, and a
    // future one cannot forget to.
    //
    // The length check above still runs against the ORIGINAL text, so a request
    // that was too long is still refused rather than silently shrunk into range
    // by preparation and half-spoken.
    // -----------------------------------------------------------------------
    const prepared = prepareForSpeech(text, deps.config.maxTtsChars);
    const spokenText = prepared.text.length > 0 ? prepared.text : text;

    try {
      const started = Date.now();
      const result = await deps.provider.synthesize({
        text: spokenText,
        ...(voice ? { voice } : {}),
        ...(format ? { format } : {}),
      });
      const latencyMs = Date.now() - started;

      // Structured voice log. No transcript, no text, no token — only which
      // knobs were in effect and which transformations fired.
      console.log(
        JSON.stringify({
          level: "info",
          event: "voice_speak",
          conversationId: conversationId ?? null,
          traceId,
          voiceEnabled: true,
          ttsProvider: deps.provider.id ?? "unknown",
          selectedVoice: result.voice,
          ttsModel: result.model,
          speakingRate: deps.config.ttsSpeed ?? null,
          responsePreparationApplied: prepared.applied,
          tableSummarised: prepared.tableSummarised,
          originalChars: text.length,
          spokenChars: spokenText.length,
          latencyMs,
        })
      );

      await container.auditLogger.log({
        userId,
        action: "voice.speak",
        result: "success",
        traceId,
        ipAddress: req.ip,
        metadata: {
          model: result.model,
          voice: result.voice,
          format: result.format,
          characterCount: spokenText.length,
          audioBytes: result.audio.length,
          ...(requestId ? { requestId } : {}),
          ...(conversationId ? { conversationId } : {}),
          latencyMs,
        },
      });

      res.status(200).json({
        success: true,
        data: {
          audio: result.audio.toString("base64"),
          mimeType: result.mimeType,
          model: result.model,
          voice: result.voice,
          format: result.format,
          characterCount: spokenText.length,
          latencyMs,
          ...(requestId ? { requestId } : {}),
        },
        traceId,
        timestamp: now(),
      });
    } catch (err) {
      await container.auditLogger.log({
        userId,
        action: "voice.speak",
        result: "failure",
        traceId,
        ipAddress: req.ip,
        metadata: {
          characterCount: text.length,
          ...(requestId ? { requestId } : {}),
          error: err instanceof JarvisError ? err.code : "UNKNOWN",
        },
      });

      const unavailable =
        err instanceof JarvisError &&
        (err.code === "TOOL_UNAVAILABLE" || err.code === "TOOL_RATE_LIMITED");

      return fail(
        res,
        unavailable ? "VOICE_PROVIDER_UNAVAILABLE" : "VOICE_SYNTHESIS_FAILED",
        "Could not generate speech. Please try again.",
        traceId
      );
    }
  });

  return router;
}
