// ---------------------------------------------------------------------------
// Sprint 9.12 — production configuration strictness.
//
// The zod schemas above these checks validate SHAPE. These validate whether a
// value is safe to run a production deployment on, which is a different
// question: the placeholder committed in .env.example is 48 characters long and
// passes `min(32)` without complaint.
//
// Every case builds its own environment object; nothing reads or mutates the
// real process.env.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { checkProductionConfig } from "../src/index.js";

/** A production environment with nothing wrong with it. */
const SAFE: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  JWT_SECRET: "Zk4pQ7vR2mX9tL6wB3nH8sD5gY1jF0cA",
  CORS_ORIGIN: "https://app.jarvis.example",
  DATABASE_URL: "postgresql://user:pass@db.internal:5432/jarvis",
};

const fieldsIn = (env: NodeJS.ProcessEnv) =>
  checkProductionConfig(env).map((problem) => problem.field);

describe("Sprint 9.12 — the checks apply ONLY in production", () => {
  it.each([
    ["development", "development"],
    ["test", "test"],
    ["unset", undefined],
  ])("passes everything in %s, so local work is unaffected", (_label, nodeEnv) => {
    const env = {
      ...SAFE,
      NODE_ENV: nodeEnv,
      JWT_SECRET: "your-super-secret-jwt-key-min-32-characters-long",
      CORS_ORIGIN: "http://localhost:3000",
    } as NodeJS.ProcessEnv;

    expect(checkProductionConfig(env)).toEqual([]);
  });

  it("accepts a properly configured production environment", () => {
    expect(checkProductionConfig(SAFE)).toEqual([]);
  });
});

describe("Sprint 9.12 — JWT_SECRET", () => {
  it("REFUSES the exact placeholder committed in .env.example", () => {
    // Read from the file rather than retyped, so this test keeps working if
    // the placeholder is ever changed but not removed.
    const example = readFileSync(resolve(__dirname, "../../../.env.example"), "utf8");
    const match = /^JWT_SECRET="?([^"\n]+)"?$/m.exec(example);
    expect(match, ".env.example should still declare JWT_SECRET").toBeTruthy();

    expect(fieldsIn({ ...SAFE, JWT_SECRET: match![1] })).toContain("JWT_SECRET");
  });

  it.each([
    ["a repeated character", "a".repeat(40)],
    ["a two-character alphabet", "ababababababababababababababababab"],
    ["the word change-me padded out", "change-me-change-me-change-me-change-me"],
    ["an empty value", ""],
  ])("REFUSES %s", (_label, secret) => {
    expect(fieldsIn({ ...SAFE, JWT_SECRET: secret })).toContain("JWT_SECRET");
  });

  it("accepts a high-entropy secret", () => {
    expect(fieldsIn({ ...SAFE, JWT_SECRET: "8Kd2Wq7Zx4Rv9Tn1Bm6Hs3Yg5Jc0Pf" })).not.toContain(
      "JWT_SECRET"
    );
  });

  it("never repeats the secret back in the problem text", () => {
    const secret = "your-super-secret-jwt-key-min-32-characters-long";
    const problems = checkProductionConfig({ ...SAFE, JWT_SECRET: secret });
    for (const problem of problems) {
      expect(problem.problem).not.toContain(secret);
      expect(problem.field).not.toContain(secret);
    }
  });
});

describe("Sprint 9.12 — CORS_ORIGIN", () => {
  it.each([
    ["missing", undefined],
    ["blank", "   "],
    ["localhost", "http://localhost:3000"],
    ["a loopback address", "http://127.0.0.1:3000"],
    ["a wildcard", "*"],
  ])("REFUSES %s in production", (_label, origin) => {
    expect(fieldsIn({ ...SAFE, CORS_ORIGIN: origin } as NodeJS.ProcessEnv)).toContain(
      "CORS_ORIGIN"
    );
  });

  it("accepts a real origin", () => {
    expect(fieldsIn({ ...SAFE, CORS_ORIGIN: "https://app.example.com" })).not.toContain(
      "CORS_ORIGIN"
    );
  });

  it("allows localhost ONLY with the explicit opt-in", () => {
    // Running the production build in local containers is the one case where a
    // localhost origin is correct.
    const local = { ...SAFE, CORS_ORIGIN: "http://localhost:3100" };
    expect(fieldsIn(local)).toContain("CORS_ORIGIN");
    expect(fieldsIn({ ...local, JARVIS_ALLOW_LOCAL_ORIGIN: "true" })).not.toContain("CORS_ORIGIN");
  });

  it("the opt-in waives the origin check and NOTHING else", () => {
    // The narrowness is the whole point: it must not become a way to boot
    // production on a published secret.
    const problems = fieldsIn({
      ...SAFE,
      CORS_ORIGIN: "http://localhost:3100",
      JARVIS_ALLOW_LOCAL_ORIGIN: "true",
      JWT_SECRET: "your-super-secret-jwt-key-min-32-characters-long",
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
    });

    expect(problems).not.toContain("CORS_ORIGIN");
    expect(problems).toContain("JWT_SECRET");
    expect(problems).toContain("JARVIS_ENCRYPTION_KEY");
  });

  it.each([["false"], ["1"], ["yes"], ["TRUE"], [""]])(
    "does not accept %s as the opt-in",
    (value) => {
      expect(
        fieldsIn({
          ...SAFE,
          CORS_ORIGIN: "http://localhost:3100",
          JARVIS_ALLOW_LOCAL_ORIGIN: value,
        })
      ).toContain("CORS_ORIGIN");
    }
  );
});

describe("Sprint 9.12 — encryption key when Google OAuth is on", () => {
  const withGoogle = {
    ...SAFE,
    GOOGLE_CLIENT_ID: "client-id",
    GOOGLE_CLIENT_SECRET: "client-secret",
  };

  it("REFUSES Google OAuth without an encryption key", () => {
    // Otherwise the Google routes silently unmount in production: a feature
    // that has quietly vanished rather than a deployment that failed loudly.
    expect(fieldsIn(withGoogle)).toContain("JARVIS_ENCRYPTION_KEY");
  });

  it("accepts it once the key is present", () => {
    expect(
      fieldsIn({ ...withGoogle, JARVIS_ENCRYPTION_KEY: "a".repeat(44) })
    ).not.toContain("JARVIS_ENCRYPTION_KEY");
  });

  it("does not demand the key when Google is not configured", () => {
    expect(fieldsIn(SAFE)).not.toContain("JARVIS_ENCRYPTION_KEY");
  });
});

describe("Sprint 9.12 — problems are reported together", () => {
  it("reports every failing field at once rather than one per boot", () => {
    const problems = checkProductionConfig({
      NODE_ENV: "production",
      JWT_SECRET: "change-me-change-me-change-me-change",
      CORS_ORIGIN: "http://localhost:3000",
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
    } as NodeJS.ProcessEnv);

    expect(problems.map((p) => p.field).sort()).toEqual([
      "CORS_ORIGIN",
      "JARVIS_ENCRYPTION_KEY",
      "JWT_SECRET",
    ]);
  });
});
