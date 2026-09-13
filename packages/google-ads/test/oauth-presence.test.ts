// ---------------------------------------------------------------------------
// Two things that cost a real debugging session on this deployment.
//
// FIRST: the OAuth predicate. `isGoogleConfigured` additionally requires
// GOOGLE_ADS_DEVELOPER_TOKEN, because Ads API calls genuinely need one. Gmail,
// Drive, Calendar and the token exchange itself do not. The connection API and
// the Integration Center were both gated on the Ads predicate, so a deployment
// with a complete OAuth client reported "Google OAuth is not configured" — and
// the error text told the user to set the three variables they had already set.
// The message and the code disagreed, and the message was right.
//
// SECOND: the presence diagnostic. `configured: false` cannot distinguish
// "nothing is set" from "one of three is missing" from "the process started
// before the file was saved". Those have completely different remedies. Three
// booleans settle it — and they must stay booleans, because two of the three
// variables are secrets and a diagnostic that leaks a hint about a secret is a
// worse bug than the one it was added to find.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  googleOAuthPresence,
  isGoogleOAuthConfigured,
  isGoogleConfigured,
} from "../src/config.js";

const CLIENT_ID = "1234567890-abcdefghijklmnop.apps.googleusercontent.com";
const CLIENT_SECRET = "GOCSPX-thisIsNotARealSecretValue";
const REDIRECT_URI = "http://localhost:3001/api/v1/google/callback";

const fullOAuth: NodeJS.ProcessEnv = {
  GOOGLE_CLIENT_ID: CLIENT_ID,
  GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
  GOOGLE_REDIRECT_URI: REDIRECT_URI,
};

describe("OAuth configuration does not depend on the Ads developer token", () => {
  it("reports configured with the three OAuth variables alone", () => {
    // The exact state of the deployment that reported the bug.
    expect(isGoogleOAuthConfigured(fullOAuth)).toBe(true);
  });

  it("still refuses the ADS predicate without a developer token", () => {
    // The distinction must survive: Ads really does need one.
    expect(isGoogleConfigured(fullOAuth)).toBe(false);
  });

  it("accepts the Ads predicate once the developer token is present", () => {
    expect(
      isGoogleConfigured({ ...fullOAuth, GOOGLE_ADS_DEVELOPER_TOKEN: "dev-token" })
    ).toBe(true);
  });

  for (const missing of [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REDIRECT_URI",
  ] as const) {
    it(`is not configured when ${missing} is absent`, () => {
      const env = { ...fullOAuth };
      delete env[missing];
      expect(isGoogleOAuthConfigured(env)).toBe(false);
    });
  }
});

describe("the presence diagnostic reports booleans and nothing else", () => {
  it("reports all three present", () => {
    expect(googleOAuthPresence(fullOAuth)).toEqual({
      googleClientIdPresent: true,
      googleClientSecretPresent: true,
      googleRedirectUriPresent: true,
    });
  });

  it("reports all three absent for an empty environment", () => {
    expect(googleOAuthPresence({})).toEqual({
      googleClientIdPresent: false,
      googleClientSecretPresent: false,
      googleRedirectUriPresent: false,
    });
  });

  it("distinguishes exactly which one is missing", () => {
    const env = { ...fullOAuth };
    delete env.GOOGLE_CLIENT_SECRET;

    expect(googleOAuthPresence(env)).toEqual({
      googleClientIdPresent: true,
      googleClientSecretPresent: false,
      googleRedirectUriPresent: true,
    });
  });

  it("treats an empty or whitespace-only value as absent", () => {
    // `GOOGLE_CLIENT_SECRET=` in a .env file is a mistake, not a value.
    // Reporting it present would send the reader looking in the wrong place.
    const presence = googleOAuthPresence({
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "   ",
      GOOGLE_REDIRECT_URI: REDIRECT_URI,
    });

    expect(presence.googleClientIdPresent).toBe(false);
    expect(presence.googleClientSecretPresent).toBe(false);
    expect(presence.googleRedirectUriPresent).toBe(true);
  });

  it("never returns a value, a fragment or a length — only booleans", () => {
    const presence = googleOAuthPresence(fullOAuth);
    const serialized = JSON.stringify(presence);

    for (const value of Object.values(presence)) {
      expect(typeof value).toBe("boolean");
    }

    expect(serialized).not.toContain(CLIENT_SECRET);
    expect(serialized).not.toContain(CLIENT_ID);
    expect(serialized).not.toContain(REDIRECT_URI);
    // Not even a prefix or a character count.
    expect(serialized).not.toMatch(/GOCSPX|apps\.googleusercontent|\d{2,}/);
  });

  it("reports exactly three keys, so a future edit cannot widen it silently", () => {
    expect(Object.keys(googleOAuthPresence(fullOAuth)).sort()).toEqual([
      "googleClientIdPresent",
      "googleClientSecretPresent",
      "googleRedirectUriPresent",
    ]);
  });
});
