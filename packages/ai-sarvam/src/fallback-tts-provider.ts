// ---------------------------------------------------------------------------
// A speech provider that tries a second one when the first is down.
//
// WHEN IT FALLS BACK: an outage, a timeout, a rate limit or an unexplained
// failure — the cases where trying again elsewhere can help. It does NOT fall
// back for INVALID_REQUEST, which covers both a bad request (the second vendor
// would refuse it too) and a deliberate cancellation (the user stopped the
// reply; speaking it anyway through another vendor would be exactly the "reply
// arrives after I muted it" bug the voice store works to prevent).
//
// It holds no vendor logic, only delegation, so it cannot drift from either
// provider's behaviour.
// ---------------------------------------------------------------------------

import type { IVoiceProvider, SpeechAudioFormat } from "@jarvis/core";
import { JarvisError } from "@jarvis/core";

export type TtsProvider = Pick<
  IVoiceProvider,
  "synthesize" | "isAvailable" | "ttsModel" | "defaultVoice" | "name"
>;

const FALLBACK_CODES: ReadonlySet<string> = new Set([
  "TOOL_UNAVAILABLE",
  "TOOL_RATE_LIMITED",
  "TOOL_EXECUTION_FAILED",
]);

export class FallbackTtsProvider implements TtsProvider {
  readonly name: string;
  readonly ttsModel: string;
  readonly defaultVoice: string;

  constructor(
    private readonly primary: TtsProvider,
    private readonly secondary: TtsProvider,
    /** Called when the secondary takes over, so an operator can see it happened. */
    private readonly onFallback?: (info: { from: string; to: string; code: string }) => void
  ) {
    this.name = `${primary.name} → ${secondary.name}`;
    this.ttsModel = primary.ttsModel;
    this.defaultVoice = primary.defaultVoice;
  }

  async synthesize(input: {
    text: string;
    voice?: string;
    format?: SpeechAudioFormat;
    signal?: AbortSignal;
  }): ReturnType<TtsProvider["synthesize"]> {
    try {
      return await this.primary.synthesize(input);
    } catch (err) {
      const code = err instanceof JarvisError ? String(err.code) : "UNKNOWN";
      if (!FALLBACK_CODES.has(code) || input.signal?.aborted) throw err;
      this.onFallback?.({ from: this.primary.name, to: this.secondary.name, code });
      // `voice` named a primary-vendor speaker; the secondary uses its own default.
      const { voice: _ignored, ...rest } = input;
      return this.secondary.synthesize(rest);
    }
  }

  /** Available if EITHER can speak: the point of a fallback is that one is enough. */
  async isAvailable(): Promise<boolean> {
    const [a, b] = await Promise.all([
      this.primary.isAvailable().catch(() => false),
      this.secondary.isAvailable().catch(() => false),
    ]);
    return a || b;
  }
}
