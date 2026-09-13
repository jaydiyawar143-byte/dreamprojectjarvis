// ---------------------------------------------------------------------------
// Google does not echo back the scope strings you sent.
//
// Ask for `email` and `profile`; the token response grants
// `https://www.googleapis.com/auth/userinfo.email` and `.../userinfo.profile`.
// `openid` alone comes back verbatim. So every check written as
// `granted.includes("email")` is FALSE against every real consent, and the
// connection is refused for lacking a scope the user definitely granted.
//
// WHY IT SURVIVED SO LONG. Every fixture in this repository hand-writes the
// short form — `scope: "openid email"` — so the mocks agreed with the code and
// both were wrong about Google in the same direction. A green suite said
// nothing about the one thing that mattered. That is the specific failure these
// tests exist to prevent: from here on, the real spelling is asserted directly
// and a fixture cannot vouch for it.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  canonicalScope,
  grantCovers,
  hasIdentityScopes,
  hasRequiredScopes,
  ACCOUNT_IDENTITY_SCOPES,
  GOOGLE_IDENTITY_SCOPES,
  GOOGLE_ADS_SCOPE,
} from "../src/index.js";

const USERINFO_EMAIL = "https://www.googleapis.com/auth/userinfo.email";
const USERINFO_PROFILE = "https://www.googleapis.com/auth/userinfo.profile";
const GMAIL_READ = "https://www.googleapis.com/auth/gmail.readonly";

/** Exactly what Google returns for a Workspace consent. */
const REAL_WORKSPACE_GRANT = [
  "openid",
  USERINFO_EMAIL,
  USERINFO_PROFILE,
  GMAIL_READ,
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
];

/** What the older fixtures use. Both spellings must remain valid. */
const FIXTURE_GRANT = ["openid", "email", "profile", GMAIL_READ];

describe("scope spellings are interchangeable", () => {
  it("maps the short identity scopes onto their canonical URLs", () => {
    expect(canonicalScope("email")).toBe(USERINFO_EMAIL);
    expect(canonicalScope("profile")).toBe(USERINFO_PROFILE);
  });

  it("leaves openid alone, because Google returns it verbatim", () => {
    expect(canonicalScope("openid")).toBe("openid");
  });

  it("leaves an already-canonical scope untouched", () => {
    expect(canonicalScope(GMAIL_READ)).toBe(GMAIL_READ);
    expect(canonicalScope(USERINFO_EMAIL)).toBe(USERINFO_EMAIL);
  });

  it("matches regardless of which side uses which spelling", () => {
    expect(grantCovers([USERINFO_EMAIL], ["email"])).toBe(true);
    expect(grantCovers(["email"], [USERINFO_EMAIL])).toBe(true);
  });
});

describe("identity is recognised in a REAL Google response", () => {
  it("accepts the grant Google actually returns", () => {
    // The exact assertion that would have caught the live failure.
    expect(hasIdentityScopes(REAL_WORKSPACE_GRANT)).toBe(true);
  });

  it("still accepts the short-form fixture spelling", () => {
    expect(hasIdentityScopes(FIXTURE_GRANT)).toBe(true);
  });

  it("refuses a grant with no identity at all", () => {
    expect(hasIdentityScopes([GMAIL_READ])).toBe(false);
  });

  it("refuses a grant carrying openid but no email", () => {
    // Identification reads `email`; without it the connection cannot be named.
    expect(hasIdentityScopes(["openid", GMAIL_READ])).toBe(false);
  });

  it("does not require profile, which nothing reads", () => {
    expect(hasIdentityScopes(["openid", USERINFO_EMAIL])).toBe(true);
  });
});

describe("the Ads check had the same defect and is fixed with it", () => {
  it("accepts a real Ads grant using the canonical email scope", () => {
    expect(hasRequiredScopes(["openid", USERINFO_EMAIL, GOOGLE_ADS_SCOPE])).toBe(true);
  });

  it("still refuses an Ads grant with no adwords scope", () => {
    expect(hasRequiredScopes(["openid", USERINFO_EMAIL])).toBe(false);
  });
});

describe("requested and required scope sets are deliberately different", () => {
  it("requests profile so the consent screen matches the Workspace flow", () => {
    expect(GOOGLE_IDENTITY_SCOPES).toContain("profile");
  });

  it("requires only what account identification reads", () => {
    // Requesting generously and requiring minimally: demanding `profile` back
    // would invent a failure mode for a field `fetchUserInfo` never touches.
    expect([...ACCOUNT_IDENTITY_SCOPES].sort()).toEqual(["email", "openid"]);
  });
});
