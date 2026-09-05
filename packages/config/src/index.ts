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
