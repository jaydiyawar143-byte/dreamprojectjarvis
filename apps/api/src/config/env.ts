import { config } from "dotenv";
import { resolve } from "path";

const envFile =
  process.env.NODE_ENV === "production"
    ? ".env.production"
    : process.env.NODE_ENV === "staging"
      ? ".env.staging"
      : ".env.development";

config({ path: resolve(process.cwd(), envFile) });
config({ path: resolve(process.cwd(), ".env.local") });

export function loadEnvironment() {
  const required = [
    "DATABASE_URL",
    "JWT_SECRET",
    "OPENAI_API_KEY",
  ];

  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`
    );
  }

  return {
    NODE_ENV: process.env.NODE_ENV || "development",
    PORT: parseInt(process.env.API_PORT || process.env.PORT || "3001", 10),
    DATABASE_URL: process.env.DATABASE_URL!,
    JWT_SECRET: process.env.JWT_SECRET!,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY!,
    CORS_ORIGIN: process.env.CORS_ORIGIN || "http://localhost:3000",
  };
}
