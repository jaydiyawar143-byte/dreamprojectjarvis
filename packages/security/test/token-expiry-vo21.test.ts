// ---------------------------------------------------------------------------
// VO-2.1 (M1) — a verified access token says when it stops being valid.
//
// A socket is authorized once, at its handshake, and must end when its token
// does. That instant is read from the VERIFIED token (`exp`), never from
// anything the client sends, so `verifyAccessToken` now reports it.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, afterEach } from "vitest";
import { TokenService } from "../src/tokens.js";

const SECRET = "vo21-test-secret-that-is-long-enough-for-hs256";
const USER = { userId: "user-alice", role: "member", email: "alice@test.local" };

afterEach(() => {
  vi.useRealTimers();
});

describe("VO-2.1 — verifyAccessToken reports the token's expiry", () => {
  it("is the signed exp, fifteen minutes after issue", () => {
    const issuedAt = Date.parse("2026-11-12T09:00:00.000Z");
    vi.useFakeTimers({ now: issuedAt });
    const tokens = new TokenService(SECRET);

    const verified = tokens.verifyAccessToken(tokens.generateAccessToken(USER));

    expect(verified).toEqual({ ...USER, expiresAt: issuedAt + 15 * 60_000 });
  });

  it("still refuses a token past that instant", () => {
    const issuedAt = Date.parse("2026-11-12T09:00:00.000Z");
    vi.useFakeTimers({ now: issuedAt });
    const tokens = new TokenService(SECRET);
    const token = tokens.generateAccessToken(USER);

    vi.setSystemTime(issuedAt + 15 * 60_000 + 1_000);

    expect(tokens.verifyAccessToken(token)).toBeNull();
  });

  it("refuses a token signed with another secret", () => {
    const token = new TokenService("another-secret-entirely-for-this-test").generateAccessToken(USER);

    expect(new TokenService(SECRET).verifyAccessToken(token)).toBeNull();
  });
});
