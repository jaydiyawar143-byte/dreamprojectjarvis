import { config } from "dotenv";
import { resolve } from "path";
import { getServerEnv } from "@jarvis/config";

const envFile =
  process.env.NODE_ENV === "production"
    ? ".env.production"
    : process.env.NODE_ENV === "staging"
      ? ".env.staging"
      : ".env.development";

config({ path: resolve(process.cwd(), envFile) });
config({ path: resolve(process.cwd(), ".env.local") });

export function loadEnvironment() {
  const env = getServerEnv();

  return {
    NODE_ENV: env.NODE_ENV,
    PORT: parseInt(process.env.API_PORT || process.env.PORT || "3001", 10),
    DATABASE_URL: env.DATABASE_URL,
    JWT_SECRET: env.JWT_SECRET,
    OPENAI_API_KEY: env.OPENAI_API_KEY,
    CORS_ORIGIN: env.CORS_ORIGIN,
  };
}
