export { OpenAIAdapter } from "./openai-adapter.js";
// R-21 — stands in for the adapter when the server has no OpenAI key.
export { NotConfiguredAIProvider } from "./not-configured-provider.js";
export { OpenAIEmbeddingProvider } from "./openai-embedding-provider.js";
export type { OpenAIEmbeddingConfig } from "./openai-embedding-provider.js";
// Sprint 8.1/8.2 — speech-to-text and text-to-speech over the same key.
export { OpenAIVoiceProvider } from "./openai-voice-provider.js";
export type { OpenAIVoiceConfig } from "./openai-voice-provider.js";
export type { OpenAIAdapterConfig, OpenAICompletionResponse } from "./types.js";
export {
  convertMessages,
  convertTools,
  convertToolChoice,
  convertResponse,
} from "./message-converter.js";
export {
  classifyOpenAIError,
  calculateRetryDelay,
  toJarvisError,
  executeWithRetry,
} from "./error-handler.js";

// V3 — image understanding. Produces text for the existing knowledge pipeline.
export {
  OpenAIVisionProvider,
  isSupportedImage,
  SUPPORTED_IMAGE_MIME_TYPES,
  MAX_IMAGE_BYTES,
  type OpenAIVisionConfig,
  type ImageDescription,
} from "./openai-vision-provider.js";
