import { z } from "zod";
import { config } from "dotenv";

config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "staging", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  JWT_SECRET: z.string().min(32),
  OPENAI_API_KEY: z.string().startsWith("sk-"),

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

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

export function getEnv(): Env {
  if (_env) return _env;

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error("Invalid environment variables:");
    console.error(result.error.flatten().fieldErrors);
    throw new Error("Invalid environment variables");
  }

  _env = result.data;
  return _env;
}
