// ---------------------------------------------------------------------------
// VO-2.1 (M1) — a socket ends when the token that opened it does.
//
// The socket is authorized once, at the handshake. Before VO-2.1 nothing ended
// it, so a connection kept receiving its user's office events after the access
// token had expired — through a logout elsewhere, and for as long as a stolen
// token's holder kept it open. These tests pin the server half of the fix:
//
//   - the handshake records the token's expiry, and refuses one already past;
//   - the connection is disconnected AT that instant, not before;
//   - a socket whose token states no expiry is bounded by the maximum session;
//   - a socket that disconnects first leaves no timer behind;
//   - a far-off expiry does not overflow `setTimeout` into an immediate end.
//
// The same behaviour over a real Socket.IO server and client is in
// `office-stream-e2e-vo21.test.ts`.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, afterEach } from "vitest";
import type { Socket } from "socket.io";

import {
  SOCKET_MAX_SESSION_MS,
  createSocketAuthMiddleware,
  registerSocketConnection,
  socketSessionExpiry,
} from "../src/socket/socket-auth.js";

const T0 = Date.parse("2026-11-12T09:00:00.000Z");
const ALICE = { userId: "user-alice", role: "member", email: "alice@test.local" };

afterEach(() => {
  vi.useRealTimers();
});

interface FakeSocket {
  id: string;
  handshake: { address: string; auth: Record<string, unknown>; headers: Record<string, unknown> };
  data: Record<string, unknown>;
  handlers: Map<string, Function>;
  disconnects: boolean[];
  join(room: string): void;
  emit(event: string, payload?: unknown): void;
  on(event: string, handler: Function): void;
  onAny(handler: Function): void;
  disconnect(close?: boolean): void;
}

function fakeSocket(data: Record<string, unknown> = {}, token = "token-alice"): FakeSocket {
  return {
    id: "sock-1",
    handshake: { address: "127.0.0.1", auth: { token }, headers: {} },
    data,
    handlers: new Map(),
    disconnects: [],
    join() {},
    emit() {},
    on(event, handler) {
      this.handlers.set(event, handler);
    },
    onAny() {},
    disconnect(close) {
      this.disconnects.push(Boolean(close));
    },
  };
}

const asSocket = (socket: FakeSocket) => socket as unknown as Socket;

function connectWith(expiresAt?: number) {
  const logged: Array<Record<string, unknown>> = [];
  const socket = fakeSocket({
    auth: ALICE,
    ...(expiresAt !== undefined ? { authExpiresAt: expiresAt } : {}),
  });
  registerSocketConnection(asSocket(socket), { log: (entry) => logged.push(entry) });
  return { socket, logged };
}

const expiredLog = (logged: Array<Record<string, unknown>>) =>
  logged.filter((entry) => entry.event === "socket_session_expired");

// ---------------------------------------------------------------------------

describe("VO-2.1 — socketSessionExpiry", () => {
  it("is the token's own expiry when it states one", () => {
    expect(socketSessionExpiry({ expiresAt: T0 + 60_000 }, T0)).toBe(T0 + 60_000);
  });

  it("is bounded by the maximum session when the token states none", () => {
    expect(socketSessionExpiry({}, T0)).toBe(T0 + SOCKET_MAX_SESSION_MS);
    expect(socketSessionExpiry({ expiresAt: Number.NaN }, T0)).toBe(T0 + SOCKET_MAX_SESSION_MS);
  });

  it("is never longer than an access token lives", () => {
    expect(SOCKET_MAX_SESSION_MS).toBe(15 * 60_000);
  });
});

describe("VO-2.1 — the handshake records when the session ends", () => {
  it("stores the token's expiry beside the identity", () => {
    vi.useFakeTimers({ now: T0 });
    const middleware = createSocketAuthMiddleware(
      { verifyAccessToken: () => ({ ...ALICE, expiresAt: T0 + 90_000 }) },
      { log: () => undefined }
    );
    const socket = fakeSocket();
    const next = vi.fn();

    middleware(asSocket(socket), next);

    expect(next).toHaveBeenCalledWith();
    expect(socket.data.authExpiresAt).toBe(T0 + 90_000);
  });

  it("refuses a token already past its expiry, and attaches no identity", () => {
    vi.useFakeTimers({ now: T0 });
    const middleware = createSocketAuthMiddleware(
      { verifyAccessToken: () => ({ ...ALICE, expiresAt: T0 - 1 }) },
      { log: () => undefined }
    );
    const socket = fakeSocket();
    const next = vi.fn();

    middleware(asSocket(socket), next);

    const error = next.mock.calls[0]?.[0] as { data?: { code?: string } } | undefined;
    expect(error?.data?.code).toBe("SOCKET_AUTH_INVALID");
    expect(socket.data.auth).toBeUndefined();
    expect(socket.data.authExpiresAt).toBeUndefined();
  });
});

describe("VO-2.1 — the connection ends with its token", () => {
  it("disconnects at the token's expiry, and not a moment before", () => {
    vi.useFakeTimers({ now: T0 });
    const { socket, logged } = connectWith(T0 + 60_000);

    vi.advanceTimersByTime(59_999);
    expect(socket.disconnects).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(socket.disconnects).toEqual([true]);
    expect(expiredLog(logged)).toHaveLength(1);
    expect(expiredLog(logged)[0]).toMatchObject({ userId: ALICE.userId, socketId: "sock-1" });
  });

  it("ends a socket with no recorded expiry after the maximum session", () => {
    vi.useFakeTimers({ now: T0 });
    const { socket } = connectWith(undefined);

    vi.advanceTimersByTime(SOCKET_MAX_SESSION_MS - 1);
    expect(socket.disconnects).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(socket.disconnects).toEqual([true]);
  });

  it("leaves nothing behind when the socket disconnects first", () => {
    vi.useFakeTimers({ now: T0 });
    const { socket, logged } = connectWith(T0 + 60_000);

    socket.handlers.get("disconnect")?.("client namespace disconnect");
    vi.advanceTimersByTime(120_000);

    expect(socket.disconnects).toEqual([]);
    expect(expiredLog(logged)).toHaveLength(0);
    expect(socket.data.auth).toBeUndefined();
    expect(socket.data.authExpiresAt).toBeUndefined();
  });

  it("does not overflow a far-off expiry into an immediate end", () => {
    vi.useFakeTimers({ now: T0 });
    const thirtyDays = 30 * 24 * 60 * 60_000;
    const { socket } = connectWith(T0 + thirtyDays);

    vi.advanceTimersByTime(25 * 24 * 60 * 60_000);
    expect(socket.disconnects).toEqual([]);

    vi.advanceTimersByTime(5 * 24 * 60 * 60_000);
    expect(socket.disconnects).toEqual([true]);
  });

  it("logs neither the token nor anything but identifiers when it ends", () => {
    vi.useFakeTimers({ now: T0 });
    const { logged } = connectWith(T0 + 1_000);

    vi.advanceTimersByTime(1_000);

    const entry = expiredLog(logged)[0]!;
    expect(Object.keys(entry).sort()).toEqual(["event", "level", "socketId", "userId"]);
    expect(JSON.stringify(entry)).not.toContain("token");
  });
});
