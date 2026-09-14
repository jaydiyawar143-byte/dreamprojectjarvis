import { config } from "dotenv";
import { resolve } from "path";
import { getServerEnv } from "@jarvis/config";

// ONE environment file: `.env` at the repository root.
//
// It is resolved from the working directory, which is `apps/api` under
// `pnpm dev` and `pnpm --filter`. When the process starts from the repository
// root instead (`node apps/api/dist/index.js`, as the Dockerfile does),
// `@jarvis/config` has already loaded `./.env` from there on import — so both
// launch styles read the same file. In containers the values arrive through
// compose `env_file`, and dotenv never overrides a variable that is already set.
config({ path: resolve(process.cwd(), "../../.env") });

export function loadEnvironment() {
  const env = getServerEnv();

  return {
    NODE_ENV: env.NODE_ENV,
    PORT: parseInt(process.env.API_PORT || process.env.PORT || "3001", 10),
    DATABASE_URL: env.DATABASE_URL,
    JWT_SECRET: env.JWT_SECRET,
    OPENAI_API_KEY: env.OPENAI_API_KEY,
    CORS_ORIGIN: env.CORS_ORIGIN,
    // Phase 10.6 — validated bounded grace period (safe default when the
    // variable is absent; .env is never modified by application code).
    SHUTDOWN_GRACE_MS: env.JARVIS_SHUTDOWN_GRACE_MS,
  };
}
