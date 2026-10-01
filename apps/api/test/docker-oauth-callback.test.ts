// The Docker stack's Google OAuth callbacks — browser-facing, not internal.
//
// In docker-compose the API listens on 3001 INSIDE its container and is
// published on the host as 3101; the web app calls it there directly (there is
// no /api proxy in apps/web). Google sends the user's BROWSER back to the
// OAuth callback, so a callback naming the in-container port — or the local
// dev stack's 3001, which `env_file: .env` would otherwise carry in — sends the
// browser to a port nothing on the host listens on: ERR_CONNECTION_REFUSED.
//
// Asserted through the real config builders, fed exactly what compose gives
// the API container, so this fails if either callback drifts off the port the
// API is actually published on.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGoogleSignInConfig } from "@jarvis/config";
import { buildAuthUrl, createGoogleOAuthConfig } from "@jarvis/google-ads";

const compose = readFileSync(new URL("../../../docker-compose.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const api = compose.slice(compose.indexOf("\n  api:\n"), compose.indexOf("\n  web:\n"));
const web = compose.slice(compose.indexOf("\n  web:\n"), compose.indexOf("\nvolumes:"));

/** One `NAME: value` line of the api service's environment. */
const apiEnv = (name: string): string | undefined => api.match(new RegExp(`^ +${name}: (.+)$`, "m"))?.[1]?.trim();

/** The host port the api service publishes its in-container 3001 on. */
const published = api.match(/- "(\d+):3001"/)?.[1];

afterEach(() => vi.unstubAllEnvs());

describe("docker-compose — the API's browser-facing URLs", () => {
  it("keeps 3001 inside the container and publishes it on the host", () => {
    expect(apiEnv("API_PORT")).toBe("3001");
    expect(published).toBe("3101");
    // The web bundle already calls the API on the published port.
    expect(web).toContain(`NEXT_PUBLIC_API_URL: http://localhost:${published}/api/v1`);
  });

  it("states the published port as the API's public URL and as the Connect-Google callback", () => {
    expect(apiEnv("API_PUBLIC_URL")).toBe(`http://localhost:${published}`);
    expect(apiEnv("GOOGLE_REDIRECT_URI")).toBe(`http://localhost:${published}/api/v1/google/callback`);
  });

  it("is the redirect_uri the Connect-Google flow actually sends to Google", () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "test-client-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-client-secret");
    vi.stubEnv("GOOGLE_REDIRECT_URI", apiEnv("GOOGLE_REDIRECT_URI"));
    const config = createGoogleOAuthConfig();
    const authUrl = new URL(buildAuthUrl({ config, state: "test-state", codeChallenge: "test-challenge" }));
    expect(authUrl.searchParams.get("redirect_uri")).toBe(`http://localhost:${published}/api/v1/google/callback`);
  });

  it("is the callback the Google sign-in flow derives — and it returns the browser to the published web app", () => {
    const signIn = createGoogleSignInConfig({
      GOOGLE_CLIENT_ID: "test-client-id",
      GOOGLE_CLIENT_SECRET: "test-client-secret",
      API_PORT: apiEnv("API_PORT"),
      API_PUBLIC_URL: apiEnv("API_PUBLIC_URL"),
      CORS_ORIGIN: apiEnv("CORS_ORIGIN"),
    });
    expect(signIn.redirectUri).toBe(`http://localhost:${published}/api/v1/auth/google/callback`);
    expect(signIn.webOrigin).toBe("http://localhost:3100");
  });
});
