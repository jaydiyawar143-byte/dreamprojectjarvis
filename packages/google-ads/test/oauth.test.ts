import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  createPkcePair,
  createState,
  buildAuthUrl,
  exchangeCode,
  refreshAccessToken,
  revokeToken,
  fetchUserInfo,
  hasRequiredScopes,
  GoogleOAuthError,
  type FetchLike,
} from "../src/oauth.js";
import { createGoogleConfig, GOOGLE_ADS_SCOPE, isGoogleConfigured } from "../src/config.js";

// No real credentials anywhere in this file: the config is synthetic and every
// network call goes through an injected fetch double.
const config = createGoogleConfig({
  clientId: "test-client-id.apps.googleusercontent.com",
  clientSecret: "test-client-secret",
  redirectUri: "https://jarvis.test/api/v1/google/callback",
  developerToken: "test-developer-token",
  timeoutMs: 1000,
});

/** Builds a fetch double returning one canned response. */
function fetchOnce(status: number, body: unknown): { impl: FetchLike; calls: any[] } {
  const calls: any[] = [];
  const impl: FetchLike = async (input, init) => {
    calls.push({ input, init });
    return { status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
  };
  return { impl, calls };
}

const GRANTED_SCOPES = `${GOOGLE_ADS_SCOPE} openid email`;

describe("Sprint 5.2 — Google OAuth", () => {
  describe("PKCE", () => {
    it("derives the challenge as base64url(SHA-256(verifier))", () => {
      const { codeVerifier, codeChallenge } = createPkcePair();
      const expected = createHash("sha256").update(codeVerifier).digest("base64url");
      expect(codeChallenge).toBe(expected);
    });

    it("produces a fresh verifier every time", () => {
      const seen = new Set(Array.from({ length: 50 }, () => createPkcePair().codeVerifier));
      expect(seen.size).toBe(50);
    });

    it("produces verifiers within the RFC 7636 length bounds", () => {
      const { codeVerifier } = createPkcePair();
      expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
      expect(codeVerifier.length).toBeLessThanOrEqual(128);
    });

    it("produces unpredictable state values", () => {
      const seen = new Set(Array.from({ length: 50 }, () => createState()));
      expect(seen.size).toBe(50);
    });
  });

  describe("buildAuthUrl", () => {
    const url = () =>
      new URL(buildAuthUrl({ config, state: "state-123", codeChallenge: "challenge-abc" }));

    it("requests offline access with forced consent so a refresh token is returned", () => {
      const u = url();
      expect(u.searchParams.get("access_type")).toBe("offline");
      expect(u.searchParams.get("prompt")).toBe("consent");
    });

    it("uses S256, never plain", () => {
      const u = url();
      expect(u.searchParams.get("code_challenge_method")).toBe("S256");
      expect(u.searchParams.get("code_challenge")).toBe("challenge-abc");
    });

    it("carries the state and the configured redirect URI", () => {
      const u = url();
      expect(u.searchParams.get("state")).toBe("state-123");
      expect(u.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    });

    it("requests the Google Ads scope", () => {
      expect(url().searchParams.get("scope")).toContain(GOOGLE_ADS_SCOPE);
    });

    it("NEVER puts the client secret or the verifier in the URL", () => {
      const raw = buildAuthUrl({ config, state: "s", codeChallenge: "c" });
      expect(raw).not.toContain(config.clientSecret);
      expect(raw).not.toContain("code_verifier");
      expect(raw).not.toContain(config.developerToken);
    });
  });

  describe("exchangeCode", () => {
    it("returns tokens and sends the PKCE verifier", async () => {
      const { impl, calls } = fetchOnce(200, {
        access_token: "ya29.test-access",
        refresh_token: "1//test-refresh",
        expires_in: 3600,
        scope: GRANTED_SCOPES,
      });

      const tokens = await exchangeCode(config, "auth-code", "verifier-xyz", impl);

      expect(tokens.accessToken).toBe("ya29.test-access");
      expect(tokens.refreshToken).toBe("1//test-refresh");
      expect(tokens.scopes).toContain(GOOGLE_ADS_SCOPE);
      expect(tokens.expiresAt.getTime()).toBeGreaterThan(Date.now());

      const body = new URLSearchParams(calls[0].init.body as string);
      expect(body.get("code_verifier")).toBe("verifier-xyz");
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("redirect_uri")).toBe(config.redirectUri);
    });

    it("rejects a grant with no refresh token rather than storing a doomed connection", async () => {
      const { impl } = fetchOnce(200, {
        access_token: "ya29.only-access",
        expires_in: 3600,
        scope: GRANTED_SCOPES,
      });
      await expect(exchangeCode(config, "c", "v", impl)).rejects.toThrow(/refresh token/i);
    });

    it("maps invalid_grant to AUTHENTICATION_REQUIRED (reconnect, do not retry)", async () => {
      const { impl } = fetchOnce(400, {
        error: "invalid_grant",
        error_description: "Bad Request",
      });
      try {
        await exchangeCode(config, "used-code", "v", impl);
        throw new Error("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(GoogleOAuthError);
        expect((e as GoogleOAuthError).classified.code).toBe("AUTHENTICATION_REQUIRED");
        expect((e as GoogleOAuthError).classified.retryable).toBe(false);
      }
    });

    it("maps invalid_client to AUTHENTICATION_REQUIRED", async () => {
      const { impl } = fetchOnce(401, { error: "invalid_client" });
      await expect(exchangeCode(config, "c", "v", impl)).rejects.toThrow(GoogleOAuthError);
    });

    it("treats a 5xx as retryable", async () => {
      const { impl } = fetchOnce(503, { error: { status: "UNAVAILABLE", message: "try later" } });
      try {
        await exchangeCode(config, "c", "v", impl);
        throw new Error("should have thrown");
      } catch (e) {
        expect((e as GoogleOAuthError).classified.retryable).toBe(true);
      }
    });

    it("rejects a 200 with no access token", async () => {
      const { impl } = fetchOnce(200, { token_type: "Bearer" });
      await expect(exchangeCode(config, "c", "v", impl)).rejects.toThrow(GoogleOAuthError);
    });
  });

  describe("refreshAccessToken", () => {
    it("exchanges a refresh token for a new access token", async () => {
      const { impl, calls } = fetchOnce(200, { access_token: "ya29.fresh", expires_in: 3600 });
      const result = await refreshAccessToken(config, "1//stored-refresh", impl);

      expect(result.accessToken).toBe("ya29.fresh");
      expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());

      const body = new URLSearchParams(calls[0].init.body as string);
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("1//stored-refresh");
    });

    it("surfaces a revoked refresh token as AUTHENTICATION_REQUIRED", async () => {
      const { impl } = fetchOnce(400, {
        error: "invalid_grant",
        error_description: "Token has been expired or revoked.",
      });
      try {
        await refreshAccessToken(config, "1//revoked", impl);
        throw new Error("should have thrown");
      } catch (e) {
        expect((e as GoogleOAuthError).classified.code).toBe("AUTHENTICATION_REQUIRED");
      }
    });
  });

  describe("revokeToken", () => {
    it("reports success on a 200", async () => {
      const { impl } = fetchOnce(200, {});
      expect(await revokeToken(config, "1//token", impl)).toBe(true);
    });

    it("reports failure without throwing, so local revocation still proceeds", async () => {
      const impl: FetchLike = async () => {
        throw new Error("network down");
      };
      expect(await revokeToken(config, "1//token", impl)).toBe(false);
    });
  });

  describe("fetchUserInfo", () => {
    it("returns the connected account email and sends a bearer header", async () => {
      const { impl, calls } = fetchOnce(200, { email: "ads-owner@example.com" });
      const info = await fetchUserInfo(config, "ya29.access", impl);
      expect(info.email).toBe("ads-owner@example.com");
      expect(calls[0].init.headers.Authorization).toBe("Bearer ya29.access");
    });

    it("throws when the profile carries no email", async () => {
      const { impl } = fetchOnce(200, { sub: "123" });
      await expect(fetchUserInfo(config, "ya29.access", impl)).rejects.toThrow(GoogleOAuthError);
    });

    it("throws on a 401", async () => {
      const { impl } = fetchOnce(401, { error: { status: "UNAUTHENTICATED" } });
      await expect(fetchUserInfo(config, "expired", impl)).rejects.toThrow(GoogleOAuthError);
    });
  });

  describe("hasRequiredScopes", () => {
    it("accepts a full grant", () => {
      expect(hasRequiredScopes([GOOGLE_ADS_SCOPE, "openid", "email"])).toBe(true);
    });

    it("rejects a grant missing the Ads scope", () => {
      expect(hasRequiredScopes(["openid", "email"])).toBe(false);
    });

    it("rejects an empty grant", () => {
      expect(hasRequiredScopes([])).toBe(false);
    });
  });

  describe("config", () => {
    it("reports unconfigured when required env vars are missing", () => {
      expect(isGoogleConfigured({} as NodeJS.ProcessEnv)).toBe(false);
      expect(
        isGoogleConfigured({
          GOOGLE_CLIENT_ID: "a",
          GOOGLE_CLIENT_SECRET: "b",
          GOOGLE_REDIRECT_URI: "https://x.test/cb",
          GOOGLE_ADS_DEVELOPER_TOKEN: "d",
        } as NodeJS.ProcessEnv)
      ).toBe(true);
    });

    it("names missing fields without echoing secret values", () => {
      try {
        createGoogleConfig({ clientId: "only-id" });
        throw new Error("should have thrown");
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).toMatch(/clientSecret|redirectUri|developerToken/);
        expect(msg).not.toContain("only-id");
      }
    });
  });
});
