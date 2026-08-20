import { z } from "zod";
import { config } from "dotenv";

config();

const baseEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "staging", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  JWT_SECRET: z.string().min(32),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  META_ACCESS_TOKEN: z.string().optional(),
  META_AD_ACCOUNT_ID: z.string().optional(),

  N8N_BASE_URL: z.string().min(1).optional(),
  N8N_API_KEY: z.string().optional(),

  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),

  GITHUB_TOKEN: z.string().optional(),

  REDIS_URL: z.string().optional(),

  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  API_PORT: z.coerce.number().default(3001),
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
