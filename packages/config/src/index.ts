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

  // Phase 11.7B runtime — how often the outcome measurement worker scans for
  // records whose measurement window has opened. 0 disables the background
  // sweep entirely (tests, or deployments that drive the worker elsewhere).
  // Coerced with a safe default so a typo cannot stop the API booting over an
  // operational tuning knob; the scheduler validates the parsed value itself.
  JARVIS_OUTCOME_WORKER_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(3600000)
    .default(300000),

  // Scheduler V1 — how often the task scheduler sweeps for tasks whose
  // scheduled time has arrived. 0 disables scheduled execution entirely.
  //
  // The default is a minute because the sweep interval is the WORST-CASE
  // LATENESS of a scheduled task: a task due at 10:00:01 runs at 10:01 at the
  // latest. Shorter would mean more empty queries for no user-visible gain,
  // longer would make "at 10 AM" visibly wrong.
  JARVIS_TASK_SCHEDULER_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(3600000)
    .default(60000),

  // Task Engine V2.2 - how old a scheduler claim must be before it is treated
  // as abandoned and re-armed. 0 disables claim recovery.
  //
  // The bound that matters is the PLANNER's 20 s abort, not the ToolExecutor's
  // 30 s deadline: a claimed task is PENDING only between the claim and
  // `startTask`, and the executor is never reached in that window. The default
  // is an order of magnitude above it.
  //
  // THIS DEFAULT IS FOR DEVELOPMENT. A production value is a deliberate
  // choice and should be set explicitly.
  JARVIS_TASK_CLAIM_RECOVERY_AFTER_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(86400000)
    .default(300000),
});

const serverEnvSchema = baseEnvSchema.extend({
  // R-21 — a blank or whitespace-only value means "not set". A `.env` line
  // with nothing after the `=` used to fail the `sk-` check and stop the API
  // from starting over a value that was simply absent.
  OPENAI_API_KEY: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().startsWith("sk-").optional()
  ),
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
  // Delivery direction and rate. Strings here for the same reason as the rest:
  // a malformed speed must not stop the API booting over a disabled feature.
  OPENAI_TTS_INSTRUCTIONS: z.string().optional(),
  OPENAI_TTS_SPEED: z.string().optional(),

  // ElevenLabs speech synthesis. Strings, unvalidated here, for the same
  // reason as the rest: a malformed optional value must not stop the API
  // booting. The provider validates and clamps what it actually uses.
  //
  // ELEVENLABS_API_KEY is deliberately NOT read into any config object that a
  // route could serialise — the provider reads it from the environment itself
  // and keeps it on the instance. Nothing here can hand it to a response.
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_VOICE_ID: z.string().optional(),
  ELEVENLABS_MODEL_ID: z.string().optional(),
  ELEVENLABS_OUTPUT_FORMAT: z.string().optional(),
  ELEVENLABS_STABILITY: z.string().optional(),
  ELEVENLABS_SIMILARITY_BOOST: z.string().optional(),
  ELEVENLABS_STYLE: z.string().optional(),
  ELEVENLABS_SPEAKER_BOOST: z.string().optional(),
  ELEVENLABS_SPEED: z.string().optional(),
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

// ---------------------------------------------------------------------------
// Sprint 9.12 — production strictness
//
// Everything above validates SHAPE. These check whether a value is safe to run
// a production deployment on, which is a different question: the placeholder in
// .env.example is 48 characters long and sails through `min(32)`.
//
// They apply ONLY when NODE_ENV === "production", so development and test keep
// working with defaults. Failures name the FIELD and never the value.
// ---------------------------------------------------------------------------

/**
 * Secrets that are published in this repo or are obvious placeholders.
 *
 * A deployment running on one of these has an authentication system anyone can
 * forge tokens for, so this is refused outright rather than warned about.
 */
const PUBLISHED_SECRETS: readonly string[] = [
  "your-super-secret-jwt-key-min-32-characters-long",
  "change-me",
  "changeme",
  "secret",
  "development",
  "test",
];

/**
 * The OpenAI key placeholder committed in `.env.example`.
 *
 * It starts with "sk-", so the schema accepts it. A production process running
 * on it would start cleanly and then fail every conversation at OpenAI.
 */
const PUBLISHED_OPENAI_KEYS: readonly string[] = ["sk-your-openai-api-key"];

/** Rough entropy check: a long run of one repeated character is not a secret. */
function looksLikePlaceholder(secret: string): boolean {
  const normalized = secret.trim().toLowerCase();
  if (PUBLISHED_SECRETS.includes(normalized)) return true;
  if (PUBLISHED_SECRETS.some((known) => normalized.includes(known))) return true;
  // Fewer than 8 distinct characters over 32+ bytes means something like
  // "aaaa..." or "abababab...".
  return new Set(normalized).size < 8;
}

export interface ProductionConfigProblem {
  field: string;
  problem: string;
}

/**
 * Production-only checks, exported so they can be tested without a real env.
 *
 * Returns the problems rather than throwing, so the caller decides whether a
 * given process should refuse to start.
 */
export function checkProductionConfig(
  env: NodeJS.ProcessEnv = process.env
): ProductionConfigProblem[] {
  if (env.NODE_ENV !== "production") return [];

  const problems: ProductionConfigProblem[] = [];

  const jwtSecret = env.JWT_SECRET ?? "";
  if (looksLikePlaceholder(jwtSecret)) {
    problems.push({
      field: "JWT_SECRET",
      problem: "is a published placeholder or has too little entropy for production",
    });
  }

  // R-21 — every conversation goes through OpenAI. Development may run without
  // the key and answers chat with AI_PROVIDER_NOT_CONFIGURED; production must
  // refuse to start instead, by name, before anything is wired.
  if (!isOpenAIConfigured(env)) {
    problems.push({
      field: "OPENAI_API_KEY",
      problem: "is required in production",
    });
  } else if (PUBLISHED_OPENAI_KEYS.includes(env.OPENAI_API_KEY!.trim())) {
    problems.push({
      field: "OPENAI_API_KEY",
      problem: "is the placeholder from .env.example, not a real key",
    });
  }

  const corsOrigin = env.CORS_ORIGIN;
  // Running the production build on your own machine — in containers, say — is
  // the one case where a localhost origin is CORRECT rather than a mistake, so
  // it is opted into explicitly. Deliberately narrow: it waives this check and
  // nothing else. A weak JWT secret and a missing encryption key stay refused.
  const localOriginAllowed = env.JARVIS_ALLOW_LOCAL_ORIGIN === "true";

  if (!corsOrigin || corsOrigin.trim().length === 0) {
    problems.push({
      field: "CORS_ORIGIN",
      problem: "must be set explicitly in production; it must not fall back to localhost",
    });
  } else if (/localhost|127\.0\.0\.1/i.test(corsOrigin) && !localOriginAllowed) {
    problems.push({
      field: "CORS_ORIGIN",
      problem:
        "points at localhost in production; set JARVIS_ALLOW_LOCAL_ORIGIN=true only when running the production build on this machine",
    });
  } else if (corsOrigin.trim() === "*") {
    problems.push({
      field: "CORS_ORIGIN",
      problem: "must name an origin; '*' with credentials is not a usable policy",
    });
  }

  // Google connections store OAuth refresh tokens. Without the encryption key
  // the routes silently unmount, which in production is a feature that has
  // quietly disappeared rather than a deployment that failed loudly.
  const googleConfigured = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  if (googleConfigured && !env.JARVIS_ENCRYPTION_KEY) {
    problems.push({
      field: "JARVIS_ENCRYPTION_KEY",
      problem: "is required when Google OAuth is configured, so tokens are never stored in plaintext",
    });
  }

  return problems;
}

/**
 * R-21 — whether the server has an OpenAI key at all.
 *
 * Blank and whitespace-only values count as unset, the same rule the schema
 * applies. The composition root reads this to choose between the real chat
 * adapter and the provider that explains chat is off; the production check
 * above reads it to refuse to start.
 */
export function isOpenAIConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.OPENAI_API_KEY?.trim());
}

export function getServerEnv(): ServerEnv {
  if (_serverEnv) return _serverEnv;

  const result = serverEnvSchema.safeParse(process.env);

  if (!result.success) {
    console.error("Invalid server environment variables:");
    console.error(result.error.flatten().fieldErrors);
    throw new Error("Invalid server environment variables");
  }

  // Sprint 9.12 — refuse to boot a production process on unsafe configuration.
  // Doing this here means it happens before `listen()`, at module load, the
  // same way a missing DATABASE_URL already does.
  const problems = checkProductionConfig(process.env);
  if (problems.length > 0) {
    console.error("Unsafe production configuration:");
    for (const { field, problem } of problems) {
      console.error(`  ${field}: ${problem}`);
    }
    throw new Error("Unsafe production configuration");
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

/**
 * Defaults applied when a voice variable is absent.
 *
 * `ttsVoice` is now `ash`. `alloy` reads factual answers tentatively; `onyx`
 * has weight but, paired with the old "measured, unhurried" delivery direction,
 * landed as sleepy — which is exactly what the operator reported. `ash` keeps
 * the professional register with a brighter, more alert articulation. It is
 * paired with the energetic delivery instructions in the provider.
 *
 * `sttModel` deliberately did NOT change. `gpt-4o-mini-transcribe` is faster,
 * but rendered this operator's Hinglish in Devanagari on most fixture runs; the
 * transcription problem was the missing language hint, which the provider now
 * supplies. Overridable by `OPENAI_STT_MODEL` and `OPENAI_TTS_VOICE`.
 */
export const VOICE_DEFAULTS = Object.freeze({
  sttModel: "whisper-1",
  ttsModel: "gpt-4o-mini-tts",
  ttsVoice: "ash",
  /**
   * Only ever sent to models that accept it (`tts-1`, `tts-1-hd`). The default
   * `gpt-4o-mini-tts` rejects `speed`, so pace there comes from the delivery
   * instructions instead.
   */
  ttsSpeed: 1.1,
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
  // Provider-documented bounds. Validated here so a nonsense value is caught
  // at startup rather than as a 400 in front of a waiting user.
  ttsSpeed: z.coerce.number().min(0.25).max(4).optional(),
  // Free text, bounded. It is delivery direction, never content — the provider
  // holds the default and this only replaces it wholesale.
  ttsInstructions: z.string().min(1).max(2000).optional(),
});

export type VoiceConfig = z.infer<typeof voiceConfigSchema>;

export interface VoiceConfigInput {
  enabled?: boolean;
  sttModel?: string;
  ttsModel?: string;
  ttsVoice?: string;
  ttsSpeed?: number;
  ttsInstructions?: string;
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
/**
 * Whether ElevenLabs should be the speech-synthesis provider.
 *
 * Both a key and a voice id: a key with no voice cannot synthesize, and
 * defaulting to some arbitrary ElevenLabs voice would change how JARVIS sounds
 * without anyone choosing it. Absent either, the OpenAI voice stays in place —
 * this is an upgrade, never a hard dependency.
 */
export function isElevenLabsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ELEVENLABS_API_KEY && env.ELEVENLABS_VOICE_ID);
}

export function createVoiceConfig(
  input: VoiceConfigInput = {},
  env: NodeJS.ProcessEnv = process.env
): VoiceConfig {
  const raw = {
    enabled: input.enabled ?? parseBooleanFlag(env.VOICE_ENABLED) ?? false,
    sttModel: input.sttModel ?? env.OPENAI_STT_MODEL ?? VOICE_DEFAULTS.sttModel,
    ttsModel: input.ttsModel ?? env.OPENAI_TTS_MODEL ?? VOICE_DEFAULTS.ttsModel,
    ttsVoice: input.ttsVoice ?? env.OPENAI_TTS_VOICE ?? VOICE_DEFAULTS.ttsVoice,
    ttsSpeed: input.ttsSpeed ?? env.OPENAI_TTS_SPEED ?? VOICE_DEFAULTS.ttsSpeed,
    ...(input.ttsInstructions ?? env.OPENAI_TTS_INSTRUCTIONS
      ? { ttsInstructions: input.ttsInstructions ?? env.OPENAI_TTS_INSTRUCTIONS }
      : {}),
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

// ---------------------------------------------------------------------------
// UI V2 — Google sign-in (OpenID Connect authorization code + PKCE).
//
// Distinct from the Sprint 5.2 Google ADS connection, which links an already
// authenticated JARVIS user to an Ads account. This is identity: it is how a
// browser with no session becomes a logged-in user, so it is deliberately kept
// separate rather than folded into the same config.
//
// Both may reuse the same OAuth client. They are separate redirect URIs.
// ---------------------------------------------------------------------------

export interface GoogleSignInConfig {
  clientId: string;
  clientSecret: string;
  /** Absolute callback URL. MUST be registered in the Google Cloud console. */
  redirectUri: string;
  /** Where the browser is sent once a session exists. */
  webOrigin: string;
}

/**
 * Whether the Google sign-in routes should be mounted.
 *
 * Both halves of the client credential are required. Mounting with only an ID
 * would put a working button in front of the user that fails at the token
 * exchange — strictly worse than showing the channel as unprovisioned, which
 * the login screen already knows how to do.
 */
export function isGoogleSignInConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID) && Boolean(env.GOOGLE_CLIENT_SECRET);
}

/** Why Google sign-in is or is not active, for the startup log line. */
export function describeGoogleSignInStatus(
  env: NodeJS.ProcessEnv = process.env
): { configured: boolean; reason: string } {
  if (!env.GOOGLE_CLIENT_ID) {
    return { configured: false, reason: "GOOGLE_CLIENT_ID is not set" };
  }
  if (!env.GOOGLE_CLIENT_SECRET) {
    return { configured: false, reason: "GOOGLE_CLIENT_SECRET is not set" };
  }
  return { configured: true, reason: "google sign-in enabled" };
}

/**
 * Builds the validated Google sign-in configuration.
 *
 * Call only when `isGoogleSignInConfigured()` is true. The thrown message names
 * FIELDS only, never values, so a misconfiguration cannot leak the secret into
 * a log line.
 */
export function createGoogleSignInConfig(
  env: NodeJS.ProcessEnv = process.env
): GoogleSignInConfig {
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Google sign-in requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET");
  }

  // Derived from the API's own public URL so a standard local setup needs no
  // extra variable, while a real deployment can state it explicitly.
  const apiOrigin = env.API_PUBLIC_URL ?? `http://localhost:${env.API_PORT ?? "3001"}`;
  const redirectUri =
    env.GOOGLE_SIGNIN_REDIRECT_URI ?? `${apiOrigin}/api/v1/auth/google/callback`;

  // The browser is returned to the web app, not the API. CORS_ORIGIN is already
  // the single declaration of where that app lives.
  const webOrigin = env.CORS_ORIGIN ?? "http://localhost:3000";

  return { clientId, clientSecret, redirectUri, webOrigin };
}

// ---------------------------------------------------------------------------
// V3 — Google Maps Platform.
//
// TWO KEYS, because they have genuinely different exposure.
//
//   BROWSER key  loads the Maps JavaScript API. It reaches the browser by
//                necessity — there is no way to render a Google map without it
//                — so it is not a secret. Its real protection is an HTTP
//                referrer restriction in the Google console, and it should be
//                restricted to the Maps JavaScript API alone.
//
//   SERVER key   signs Geocoding and Routes calls made from the API. It never
//                leaves the server, and should be restricted by IP and to those
//                two APIs.
//
// They are deliberately separate variables. Reusing one unrestricted key for
// both is the common mistake, and it turns a referrer-restricted browser key
// into a billable server credential anyone can lift from the page.
//
// The browser key is served from an AUTHENTICATED endpoint rather than inlined
// as NEXT_PUBLIC_*, so it is not sitting in a static JS bundle that anyone can
// fetch without logging in. That is defence in depth, not a replacement for the
// referrer restriction.
// ---------------------------------------------------------------------------

export interface GoogleMapsConfig {
  /** Loads the Maps JavaScript API in the browser. Referrer-restricted. */
  browserKey: string | null;
  /** Geocoding and Routes, server-side only. Never sent to a client. */
  serverKey: string | null;
}

/** Whether the interactive map can be rendered at all. */
export function isGoogleMapsBrowserConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.GOOGLE_MAPS_BROWSER_KEY);
}

/** Whether server-side geocoding and routing can use Google. */
export function isGoogleMapsServerConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.GOOGLE_MAPS_SERVER_KEY);
}

export function createGoogleMapsConfig(env: NodeJS.ProcessEnv = process.env): GoogleMapsConfig {
  return {
    browserKey: env.GOOGLE_MAPS_BROWSER_KEY ?? null,
    serverKey: env.GOOGLE_MAPS_SERVER_KEY ?? null,
  };
}

/** Why the map is or is not available, for the startup log and the UI. */
export function describeGoogleMapsStatus(
  env: NodeJS.ProcessEnv = process.env
): { configured: boolean; reason: string } {
  const browser = isGoogleMapsBrowserConfigured(env);
  const server = isGoogleMapsServerConfigured(env);

  if (!browser && !server) {
    return { configured: false, reason: "No Google Maps keys are set" };
  }
  if (!browser) {
    // Routing would work but nothing could be drawn, which is the worse half to
    // be missing — the widget is a map first.
    return { configured: false, reason: "GOOGLE_MAPS_BROWSER_KEY is not set, so the map cannot render" };
  }
  if (!server) {
    return { configured: true, reason: "Map available; GOOGLE_MAPS_SERVER_KEY is not set, so geocoding and routing fall back to OpenStreetMap" };
  }
  return { configured: true, reason: "google maps enabled" };
}
