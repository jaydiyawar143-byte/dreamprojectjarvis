// ---------------------------------------------------------------------------
// One `IVoiceProvider`, two vendors: ElevenLabs speaks, whisper-1 listens.
//
// WHY NOT JUST SWAP THE PROVIDER. `IVoiceProvider` bundles transcription and
// synthesis, so replacing it wholesale to change the voice would also replace
// the recognizer — and the recognizer was chosen by measurement, not default.
// The operator speaks Hinglish; a faster model wrote it in Devanagari on 10 of
// 18 fixture runs, where whisper-1 with an explicit language hint managed 18 of
// 18 in Latin script. Every intent rule downstream matches Latin text, so a
// regression there does not degrade voice — it silently misroutes requests.
//
// So the two directions are chosen independently. This class is the seam, and
// it is deliberately dumb: it holds no logic of its own, just delegation, so
// there is nothing here that can drift from either provider's behaviour.
//
// FAILURE IS PER-DIRECTION. A synthesis outage does not stop dictation, and a
// transcription outage does not stop playback. Bundling them would make one
// vendor's bad afternoon look like "voice is broken".
// ---------------------------------------------------------------------------

import type {
  IVoiceProvider,
  SpeechAudioFormat,
  TranscriptionResult,
} from "@jarvis/core";

export interface CompositeVoiceDeps {
  /** Handles `synthesize`. */
  tts: Pick<IVoiceProvider, "synthesize" | "isAvailable" | "ttsModel" | "defaultVoice" | "name">;
  /** Handles `transcribe`. */
  stt: Pick<IVoiceProvider, "transcribe" | "isAvailable" | "sttModel">;
}

export class CompositeVoiceProvider implements IVoiceProvider {
  readonly id = "composite-voice";
  readonly name: string;
  readonly sttModel: string;
  readonly ttsModel: string;
  readonly defaultVoice: string;

  constructor(private readonly deps: CompositeVoiceDeps) {
    // Names both vendors, because "which voice is this" is the first question
    // asked when the assistant suddenly sounds different.
    this.name = `${deps.tts.name} + whisper`;
    this.sttModel = deps.stt.sttModel;
    this.ttsModel = deps.tts.ttsModel;
    this.defaultVoice = deps.tts.defaultVoice;
  }

  transcribe(input: {
    audio: Buffer;
    mimeType: string;
    fileName?: string;
    language?: string;
    signal?: AbortSignal;
  }): Promise<TranscriptionResult> {
    return this.deps.stt.transcribe(input);
  }

  synthesize(input: {
    text: string;
    voice?: string;
    format?: SpeechAudioFormat;
    signal?: AbortSignal;
  }): Promise<{
    audio: Buffer;
    mimeType: string;
    model: string;
    voice: string;
    format: SpeechAudioFormat;
  }> {
    return this.deps.tts.synthesize(input);
  }

  /**
   * Available only when BOTH directions are.
   *
   * The voice UI offers a microphone and playback together; reporting the pair
   * as healthy when half of it is down would put a dead button on screen.
   */
  async isAvailable(): Promise<boolean> {
    const [tts, stt] = await Promise.all([
      this.deps.tts.isAvailable().catch(() => false),
      this.deps.stt.isAvailable().catch(() => false),
    ]);
    return tts && stt;
  }
}
