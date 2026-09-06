import { z } from "zod";
import { config } from "dotenv";

config();

const baseEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "staging", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  JWT_SECRET: z.string().min(32),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  // Sprint 5.2 — Google Ads (read-only). The redirect URI must match the value
  // registered in the Google Cloud console EXACTLY; it is never taken from the
  // request, so a tampered redirect cannot redirect the code elsewhere.
  GOOGLE_REDIRECT_URI: z.string().url().optional(),
  GOOGLE_ADS_DEVELOPER_TOKEN: z.string().optional(),
  // Only needed when the authenticated user reaches accounts through a manager
  // (MCC) account; sent as the login-customer-id header.
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: z.string().regex(/^\d{10}$/).optional(),

  // Sprint 5.2 — AES-256-GCM key for third-party credentials at rest.
  // base64 of 32 raw bytes. Absent means Google connections cannot be stored.
  JARVIS_ENCRYPTION_KEY: z.string().optional(),
  JARVIS_ENCRYPTION_KEY_VERSION: z.coerce.number().int().positive().default(1),
  JARVIS_ENCRYPTION_KEY_RETIRED: z.string().optional(),

  META_ACCESS_TOKEN: z.string().optional(),
  META_AD_ACCOUNT_ID: z.string().optional(),
  META_GRAPH_API_VERSION: z.string().optional(),

  // Sprint 5.4 — n8n automation.
  // TWO secrets in OPPOSITE directions: N8N_API_KEY authenticates JARVIS to n8n
  // on outbound triggers; N8N_CALLBACK_SECRET authenticates n8n to JARVIS on
  // inbound result callbacks. The API key must never be accepted inbound —
  // workflow authors can read it.
  N8N_BASE_URL: z.string().url().optional(),
  N8N_API_KEY: z.string().optional(),
  N8N_CALLBACK_SECRET: z.string().optional(),
  N8N_TIMEOUT_MS: z.coerce.number().int().positive().max(120000).optional(),

  // Sprint 5.3 — WhatsApp Business Cloud API.
  // Four DISTINCT secrets: the access token authenticates us to Meta, the app
  // secret verifies Meta to us (webhook HMAC), and the verify token is a
  // one-time handshake string. Never interchange them.
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_API_VERSION: z.string().optional(),

  GITHUB_TOKEN: z.string().optional(),

  REDIS_URL: z.string().optional(),

  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  API_PORT: z.coerce.number().default(3001),

  // Phase 10.6 — bounded graceful-shutdown grace period. When absent the
  // 30s default gives in-flight external writes their full authoritative
  // window to finish; after expiry nothing is cancelled — durable journal
  // state (EXECUTING/UNKNOWN) is left for startup recovery/reconciliation.
  JARVIS_SHUTDOWN_GRACE_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(600000)
    .default(30000),
});

const serverEnvSchema = baseEnvSchema.extend({
  OPENAI_API_KEY: z.string().startsWith("sk-").optional(),
  OPENAI_DEFAULT_MODEL: z.string().default("gpt-4o"),
  OPENAI_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  OPENAI_TIMEOUT_MS: z.coerce.number().default(30000),
  OPENAI_MAX_RETRIES: z.coerce.number().default(2),

  // Sprint 8.0 — voice interaction layer.
  //
  // Registered here as plain optional STRINGS, with no coercion and no bounds.
  // That is deliberate: this schema is parsed at process start, so a coerced
  // numeric field with a typo in it ("4mb") would fail the parse and stop the
  // whole API from booting over a switched-off feature. The real typed
  // validation lives in `createVoiceConfig()`, which only runs once voice is
  // actually enabled — the same split the n8n and WhatsApp integrations use.
  VOICE_ENABLED: z.string().optional(),
  OPENAI_STT_MODEL: z.string().optional(),
  OPENAI_TTS_MODEL: z.string().optional(),
  OPENAI_TTS_VOICE: z.string().optional(),
  VOICE_MAX_AUDIO_BYTES: z.string().optional(),
  VOICE_MAX_TTS_CHARS: z.string().optional(),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;
export type ServerEnv = z.infer<typeof serverEnvSchema>;

let _baseEnv: BaseEnv | null = null;
let _serverEnv: ServerEnv | null = null;

export function getEnv(): BaseEnv {
  if (_baseEnv) return _baseEnv;

  const result = baseEnvSchema.safeParse(process.env);

  if (!result.success) {
    console.error("Invalid environment variables:");
    console.error(result.error.flatten().fieldErrors);
    throw new Error("Invalid environment variables");
  }

  _baseEnv = result.data;
  return _baseEnv;
}

export function getServerEnv(): ServerEnv {
  if (_serverEnv) return _serverEnv;

  const result = serverEnvSchema.safeParse(process.env);

  if (!result.success) {
    console.error("Invalid server environment variables:");
    console.error(result.error.flatten().fieldErrors);
    throw new Error("Invalid server environment variables");
  }

  _serverEnv = result.data;
  return _serverEnv;
}

// ---------------------------------------------------------------------------
// Sprint 8.0 — Voice configuration and feature gate
//
// Mirrors the n8n / WhatsApp / Google shape: a pure `is…Configured()` predicate
// that decides whether the routes mount at all, and a `create…Config()` that
// validates strictly and throws — called only once the predicate has passed.
//
// Both take their environment as an argument rather than reading the memoized
// `getServerEnv()`. The gate has to be answerable for an arbitrary environment
// (tests, a config check, a diagnostics endpoint) without the first call
// freezing the answer for the life of the process.
// ---------------------------------------------------------------------------

/** Defaults applied when a voice variable is absent. */
export const VOICE_DEFAULTS = Object.freeze({
  sttModel: "whisper-1",
  ttsModel: "gpt-4o-mini-tts",
  ttsVoice: "alloy",
  /** 4 MiB of decoded audio — minutes of Opus speech, far past push-to-talk. */
  maxAudioBytes: 4 * 1024 * 1024,
  maxTtsChars: 4000,
} as const);

/**
 * Hard ceiling on configurable upload size.
 *
 * Audio travels as base64 in a JSON body and `express.json` is capped at 10mb.
 * Base64 inflates by about a third, so 6 MiB decoded is roughly 8.4 MB on the
 * wire — still under the parser. Allowing more would mean the body parser
 * rejecting the request with a generic error before any voice code could
 * return a documented 413.
 */
export const VOICE_MAX_AUDIO_BYTES_CEILING = 6 * 1024 * 1024;

/** Smallest sensible upload ceiling; below this nothing useful is recordable. */
export const VOICE_MIN_AUDIO_BYTES = 16 * 1024;

/** The OpenAI speech endpoint refuses input longer than this. */
export const VOICE_MAX_TTS_CHARS_CEILING = 4096;

const voiceConfigSchema = z.object({
  enabled: z.boolean(),
  sttModel: z.string().min(1).max(100),
  ttsModel: z.string().min(1).max(100),
  // Constrained to a safe charset rather than to a fixed list of voice names:
  // providers add voices over time, and pinning the list here would reject a
  // valid one, but an unconstrained string goes straight into a provider call.
  ttsVoice: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be alphanumeric with . _ -"),
  maxAudioBytes: z.coerce
    .number()
    .int()
    .min(VOICE_MIN_AUDIO_BYTES)
    .max(VOICE_MAX_AUDIO_BYTES_CEILING),
  maxTtsChars: z.coerce.number().int().min(1).max(VOICE_MAX_TTS_CHARS_CEILING),
});

export type VoiceConfig = z.infer<typeof voiceConfigSchema>;

export interface VoiceConfigInput {
  enabled?: boolean;
  sttModel?: string;
  ttsModel?: string;
  ttsVoice?: string;
  maxAudioBytes?: number;
  maxTtsChars?: number;
}

const TRUTHY = new Set(["true", "1", "yes", "on"]);
const FALSY = new Set(["false", "0", "no", "off", ""]);

/**
 * Reads a boolean flag from the environment.
 *
 * Returns null for anything it does not recognise, so the caller decides
 * whether an unreadable value means "off" (the gate) or "misconfigured" (the
 * config builder). Treating a typo as `true` is the one outcome never wanted.
 */
export function parseBooleanFlag(raw: unknown): boolean | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  if (TRUTHY.has(value)) return true;
  if (FALSY.has(value)) return false;
  return null;
}

/**
 * Whether the voice routes should be mounted.
 *
 * Voice is OFF unless switched on explicitly. It is not inferred from the
 * presence of an OpenAI key: every existing deployment already has one, and
 * inferring would silently expose two new endpoints on upgrade. "Existing
 * behaviour is unchanged unless an operator opts in" is the property worth
 * having.
 *
 * A speech provider credential is also required, because with `VOICE_ENABLED`
 * on and no key the routes would mount and then fail every request — a worse
 * outcome than not mounting.
 */
export function isVoiceConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBooleanFlag(env.VOICE_ENABLED) === true && Boolean(env.OPENAI_API_KEY);
}

/**
 * Why voice is or is not active, for the startup log line.
 *
 * The integration log lines already print a `reason` when a subsystem stays
 * disabled; without one, "voice_routes_disabled" leaves an operator guessing
 * between a missing flag, a typo in it, and a missing key.
 */
export function describeVoiceConfigStatus(
  env: NodeJS.ProcessEnv = process.env
): { configured: boolean; reason: string } {
  const flag = parseBooleanFlag(env.VOICE_ENABLED);

  if (flag === null && env.VOICE_ENABLED !== undefined) {
    return {
      configured: false,
      reason: "VOICE_ENABLED is set to an unrecognised value; expected true or false",
    };
  }
  if (flag !== true) {
    return { configured: false, reason: "VOICE_ENABLED is not set to true" };
  }
  if (!env.OPENAI_API_KEY) {
    return {
      configured: false,
      reason: "VOICE_ENABLED is true but OPENAI_API_KEY is missing",
    };
  }
  return { configured: true, reason: "voice enabled" };
}

/**
 * Builds the validated voice configuration.
 *
 * Call only when `isVoiceConfigured()` is true. Throws on an invalid value
 * rather than silently falling back to a default: an operator who set
 * `VOICE_MAX_TTS_CHARS=99999` asked for something the provider will reject, and
 * quietly clamping it would turn a config error into a puzzling runtime one.
 *
 * The thrown message names FIELDS only, never values — the same discipline the
 * n8n config builder uses, so this stays safe if a secret is ever added here.
 */
export function createVoiceConfig(
  input: VoiceConfigInput = {},
  env: NodeJS.ProcessEnv = process.env
): VoiceConfig {
  const raw = {
    enabled: input.enabled ?? parseBooleanFlag(env.VOICE_ENABLED) ?? false,
    sttModel: input.sttModel ?? env.OPENAI_STT_MODEL ?? VOICE_DEFAULTS.sttModel,
    ttsModel: input.ttsModel ?? env.OPENAI_TTS_MODEL ?? VOICE_DEFAULTS.ttsModel,
    ttsVoice: input.ttsVoice ?? env.OPENAI_TTS_VOICE ?? VOICE_DEFAULTS.ttsVoice,
    maxAudioBytes:
      input.maxAudioBytes ?? env.VOICE_MAX_AUDIO_BYTES ?? VOICE_DEFAULTS.maxAudioBytes,
    maxTtsChars:
      input.maxTtsChars ?? env.VOICE_MAX_TTS_CHARS ?? VOICE_DEFAULTS.maxTtsChars,
  };

  const result = voiceConfigSchema.safeParse(raw);
  if (!result.success) {
    const errors = result.error.flatten().fieldErrors;
    const messages = Object.entries(errors)
      .map(([field, issues]) => `${field}: ${issues?.join(", ")}`)
      .join("; ");
    throw new Error(`Voice configuration error: ${messages}`);
  }
  return result.data;
}
