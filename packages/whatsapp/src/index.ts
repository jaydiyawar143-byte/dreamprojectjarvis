export {
  createWhatsAppConfig,
  isWhatsAppConfigured,
  normalizePhoneNumber,
  buildBaseUrl,
  WHATSAPP_API_HOST,
  WHATSAPP_DEFAULT_API_VERSION,
  WHATSAPP_MAX_TEXT_LENGTH,
  type WhatsAppConfig,
  type WhatsAppConfigInput,
} from "./config.js";

export {
  verifyWebhookSignature,
  verifyWebhookChallenge,
  signPayload,
  type SignatureResult,
  type SignatureFailureReason,
  type VerificationQuery,
  type VerificationResult,
} from "./signature.js";

export { parseWebhookPayload, parseTimestamp, isFresh } from "./webhook-parser.js";

export {
  createWhatsAppHttpClient,
  isSuccessResponse,
  extractError,
  WhatsAppRequestAbortedError,
  type WhatsAppHttpClient,
  type WhatsAppHttpRequest,
  type WhatsAppHttpResponse,
  type WhatsAppAbortPhase,
} from "./client.js";

export {
  classifyWhatsAppError,
  toJarvisError,
  redactSensitiveInfo,
  maskPhoneNumber,
  type ClassifiedWhatsAppError,
  type WhatsAppErrorCode,
} from "./error-handler.js";

export {
  WhatsAppCloudProvider,
  createWhatsAppProvider,
  type WhatsAppSendProvider,
  type WhatsAppCloudProviderConfig,
  type WhatsAppProviderCallOptions,
} from "./provider.js";
