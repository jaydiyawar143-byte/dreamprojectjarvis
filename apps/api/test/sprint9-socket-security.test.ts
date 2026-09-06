// ---------------------------------------------------------------------------
// Sprint 9 hotfix — Socket.IO security tests.
//
// The middleware and guards are exercised directly against fake sockets rather
// than through a live server. What is under test is the decision logic — who is
// let in, whose identity is used, which events run — and a real WebSocket adds
// transport timing without adding a single assertion.
//
// No real credentials, no external calls. The token service is a stub whose
// behaviour is stated per test.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Socket } from "socket.io";
import type { AuthContext } from "@jarvis/core";
import {
  SOCKET_AUTH_FAILURE_WINDOW_MS,
  SOCKET_CONNECT_TIMEOUT_MS,
  SOCKET_EVENT_POLICY,
  SOCKET_MAX_AUTH_FAILURES,
  SOCKET_MAX_BUFFER_BYTES,
  SocketAuthThrottle,
  classifySocketEvent,
  createSocketAuthMiddleware,
  extractHandshakeToken,
  hasIdentityOverride,
  isSocketEventAllowed,
  registerSocketConnection,
  socketAuth,
  userRoom,
} from "../src/socket/socket-auth.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const ALICE = { userId: "user-alice", role: "member", email: "alice@test.local" };
const BOB = { userId: "user-bob", role: "member", email: "bob@test.local" };

/** A token service that recognises exactly the tokens it is given. */
function tokenServiceFor(valid: Record<string, typeof ALICE>) {
  return {
    verifyAccessToken: (token: string) => valid[token] ?? null,
  };
}

interface FakeSocket {
  id: string;
  handshake: { address: string; auth: Record<string, unknown>; headers: Record<string, unknown> };
  data: Record<string, unknown>;
  rooms: string[];
  emitted: Array<{ event: string; payload: unknown }>;
  handlers: Map<string, Function>;
  anyHandlers: Function[];
  disconnected: boolean;
  join(room: string): void;
  emit(event: string, payload?: unknown): void;
  on(event: string, handler: Function): void;
  onAny(handler: Function): void;
  disconnect(close?: boolean): void;
  /** Simulates a client emitting an event. */
  clientEmit(event: string, payload?: unknown): void;
}

function fakeSocket(overrides: Partial<FakeSocket["handshake"]> = {}, id = "sock-1"): FakeSocket {
  const socket: FakeSocket = {
    id,
    handshake: { address: "10.0.0.1", auth: {}, headers: {}, ...overrides },
    data: {},
    rooms: [],
    emitted: [],
    handlers: new Map(),
    anyHandlers: [],
    disconnected: false,
    join(room) {
      this.rooms.push(room);
    },
    emit(event, payload) {
      this.emitted.push({ event, payload });
    },
    on(event, handler) {
      this.handlers.set(event, handler);
    },
    onAny(handler) {
      this.anyHandlers.push(handler);
    },
    disconnect() {
      this.disconnected = true;
    },
    clientEmit(event, payload) {
      for (const any of this.anyHandlers) any(event, payload);
      const handler = this.handlers.get(event);
      if (handler) handler(payload);
    },
  };
  return socket;
}

const asSocket = (s: FakeSocket) => s as unknown as Socket;

/** Runs the middleware and reports what it decided. */
async function handshake(
  socket: FakeSocket,
  tokenService: { verifyAccessToken: (t: string) => typeof ALICE | null },
  throttle?: SocketAuthThrottle
): Promise<{ accepted: boolean; code?: string }> {
  const logged: Record<string, unknown>[] = [];
  const middleware = createSocketAuthMiddleware(tokenService, {
    ...(throttle ? { throttle } : {}),
    log: (entry) => logged.push(entry),
  });

  return new Promise((resolve) => {
    middleware(asSocket(socket), (err?: Error) => {
      if (!err) return resolve({ accepted: true });
      const code = (err as { data?: { code?: string } }).data?.code;
      resolve({ accepted: false, ...(code ? { code } : {}) });
    });
  });
}

// ---------------------------------------------------------------------------

describe("Sprint 9 — Socket.IO authentication", () => {
  const tokens = tokenServiceFor({ "alice-token": ALICE, "bob-token": BOB });

  it("rejects a connection with no credentials", async () => {
    const result = await handshake(fakeSocket(), tokens);

    expect(result.accepted).toBe(false);
    expect(result.code).toBe("SOCKET_AUTH_REQUIRED");
  });

  it("rejects an invalid token", async () => {
    const result = await handshake(
      fakeSocket({ auth: { token: "forged-token" } }),
      tokens
    );

    expect(result.accepted).toBe(false);
    expect(result.code).toBe("SOCKET_AUTH_INVALID");
  });

  it("rejects an expired token", async () => {
    // An expired JWT fails verification exactly like a forged one, which is
    // why the service returns null for both.
    const expiring = tokenServiceFor({});
    const result = await handshake(
      fakeSocket({ auth: { token: "expired-token" } }),
      expiring
    );

    expect(result.accepted).toBe(false);
    expect(result.code).toBe("SOCKET_AUTH_INVALID");
  });

  it("does not distinguish expired from forged to the client", async () => {
    const forged = await handshake(fakeSocket({ auth: { token: "nope" } }), tokens);
    const expired = await handshake(
      fakeSocket({ auth: { token: "also-nope" } }),
      tokens
    );

    expect(forged.code).toBe(expired.code);
  });

  it("accepts a valid token", async () => {
    const socket = fakeSocket({ auth: { token: "alice-token" } });
    const result = await handshake(socket, tokens);

    expect(result.accepted).toBe(true);
    expect(socketAuth(asSocket(socket))).toEqual({
      userId: ALICE.userId,
      role: ALICE.role,
      email: ALICE.email,
    });
  });

  it("accepts a Bearer-prefixed token and the Authorization header", async () => {
    const viaAuth = fakeSocket({ auth: { token: "Bearer alice-token" } });
    expect((await handshake(viaAuth, tokens)).accepted).toBe(true);

    const viaHeader = fakeSocket({ headers: { authorization: "Bearer alice-token" } });
    expect((await handshake(viaHeader, tokens)).accepted).toBe(true);
  });

  it("never reads a credential from the query string", () => {
    // Query strings are written down by proxies and browser history in a way
    // headers are not, so accepting one there would invite clients to leak it.
    const extracted = extractHandshakeToken({
      auth: {},
      headers: {},
      // A token placed where it must not be honoured.
      ...({ query: { token: "alice-token" } } as Record<string, unknown>),
    });

    expect(extracted.ok).toBe(false);
  });

  it("does not create a default or anonymous user", async () => {
    const socket = fakeSocket();
    await handshake(socket, tokens);

    expect(socket.data.auth).toBeUndefined();
    expect(socketAuth(asSocket(socket))).toBeNull();
  });

  it("fails closed when the token service throws", async () => {
    const exploding = {
      verifyAccessToken: () => {
        throw new Error("secret misconfigured");
      },
    };
    const result = await handshake(fakeSocket({ auth: { token: "x" } }), exploding);

    expect(result.accepted).toBe(false);
    expect(result.code).toBe("SOCKET_AUTH_INVALID");
  });
});

// ---------------------------------------------------------------------------

describe("Sprint 9 — malformed authentication payloads", () => {
  const tokens = tokenServiceFor({ "alice-token": ALICE });

  it("rejects a non-string token", async () => {
    for (const value of [42, true, {}, [], { token: "nested" }]) {
      const result = await handshake(
        fakeSocket({ auth: { token: value as unknown as string } }),
        tokens
      );
      expect(result.accepted, JSON.stringify(value)).toBe(false);
      expect(result.code).toBe("SOCKET_AUTH_MALFORMED");
    }
  });

  it("rejects an absurdly long token without parsing it", async () => {
    const result = await handshake(
      fakeSocket({ auth: { token: "A".repeat(100_000) } }),
      tokens
    );

    expect(result.accepted).toBe(false);
    expect(result.code).toBe("SOCKET_AUTH_MALFORMED");
  });

  it("rejects an empty or whitespace token", async () => {
    expect((await handshake(fakeSocket({ auth: { token: "" } }), tokens)).code).toBe(
      "SOCKET_AUTH_REQUIRED"
    );
    expect((await handshake(fakeSocket({ auth: { token: "   " } }), tokens)).code).toBe(
      "SOCKET_AUTH_REQUIRED"
    );
  });

  it("rejects an array Authorization header", async () => {
    const result = await handshake(
      fakeSocket({ headers: { authorization: ["Bearer a", "Bearer b"] } }),
      tokens
    );

    expect(result.accepted).toBe(false);
    expect(result.code).toBe("SOCKET_AUTH_MALFORMED");
  });

  it("does not throw on a hostile handshake shape", () => {
    expect(() => extractHandshakeToken({})).not.toThrow();
    expect(() => extractHandshakeToken({ auth: {}, headers: {} })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------

describe("Sprint 9 — handshake throttling", () => {
  it("throttles an address after repeated failures", async () => {
    const throttle = new SocketAuthThrottle();
    const tokens = tokenServiceFor({});

    for (let i = 0; i < SOCKET_MAX_AUTH_FAILURES; i++) {
      await handshake(fakeSocket({ auth: { token: "bad" } }), tokens, throttle);
    }

    const result = await handshake(
      fakeSocket({ auth: { token: "bad" } }),
      tokens,
      throttle
    );
    expect(result.code).toBe("SOCKET_AUTH_THROTTLED");
  });

  it("keeps addresses independent", async () => {
    const throttle = new SocketAuthThrottle();
    const tokens = tokenServiceFor({ good: ALICE });

    for (let i = 0; i < SOCKET_MAX_AUTH_FAILURES; i++) {
      await handshake(
        fakeSocket({ address: "10.0.0.1", auth: { token: "bad" } }),
        tokens,
        throttle
      );
    }

    const other = await handshake(
      fakeSocket({ address: "10.0.0.2", auth: { token: "good" } }),
      tokens,
      throttle
    );
    expect(other.accepted).toBe(true);
  });

  it("clears an address's history on success", async () => {
    const throttle = new SocketAuthThrottle();
    const tokens = tokenServiceFor({ good: ALICE });

    for (let i = 0; i < SOCKET_MAX_AUTH_FAILURES - 1; i++) {
      await handshake(fakeSocket({ auth: { token: "bad" } }), tokens, throttle);
    }
    await handshake(fakeSocket({ auth: { token: "good" } }), tokens, throttle);

    expect(throttle.isThrottled("10.0.0.1")).toBe(false);
  });

  it("forgets failures once the window passes", () => {
    const throttle = new SocketAuthThrottle();
    const start = Date.now();

    for (let i = 0; i < SOCKET_MAX_AUTH_FAILURES; i++) {
      throttle.recordFailure("10.0.0.1", start);
    }
    expect(throttle.isThrottled("10.0.0.1", start)).toBe(true);
    expect(
      throttle.isThrottled("10.0.0.1", start + SOCKET_AUTH_FAILURE_WINDOW_MS + 1)
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("Sprint 9 — server identity is authoritative", () => {
  const tokens = tokenServiceFor({ "alice-token": ALICE });

  async function connected(auth: Record<string, unknown> = { token: "alice-token" }) {
    const socket = fakeSocket({ auth });
    await handshake(socket, tokens);
    registerSocketConnection(asSocket(socket), { log: () => undefined });
    return socket;
  }

  it("uses the token's identity, not the handshake's claims", async () => {
    const socket = fakeSocket({
      auth: { token: "alice-token", userId: BOB.userId, role: "owner", tenantId: "t-evil" },
    });
    await handshake(socket, tokens);

    expect(socketAuth(asSocket(socket))).toEqual({
      userId: ALICE.userId,
      role: ALICE.role,
      email: ALICE.email,
    });
  });

  it("places the socket in its own user room", async () => {
    const socket = await connected();

    expect(socket.rooms).toEqual([userRoom(ALICE.userId)]);
    expect(socket.rooms).not.toContain(userRoom(BOB.userId));
  });

  it("rejects an event claiming another user", async () => {
    const socket = await connected();

    socket.clientEmit("ping", { userId: BOB.userId });

    const error = socket.emitted.find((e) => e.event === "error");
    expect((error?.payload as Record<string, unknown>)?.code).toBe(
      "SOCKET_IDENTITY_OVERRIDE"
    );
  });

  it("rejects an event supplying a tenant or account", async () => {
    for (const payload of [{ tenantId: "t-1" }, { accountId: "act_999" }]) {
      const socket = await connected();
      socket.clientEmit("ping", payload);

      const error = socket.emitted.find((e) => e.event === "error");
      expect((error?.payload as Record<string, unknown>)?.code, JSON.stringify(payload)).toBe(
        "SOCKET_IDENTITY_OVERRIDE"
      );
    }
  });

  it("rejects an attempt to escalate role", async () => {
    const socket = await connected();

    socket.clientEmit("ping", { role: "owner" });

    expect(
      (socket.emitted.find((e) => e.event === "error")?.payload as Record<string, unknown>)
        ?.code
    ).toBe("SOCKET_IDENTITY_OVERRIDE");
  });

  it("allows a payload echoing the caller's own id", async () => {
    const socket = await connected();

    socket.clientEmit("ping", { userId: ALICE.userId });

    expect(socket.emitted.some((e) => e.event === "error")).toBe(false);
    expect(socket.emitted.some((e) => e.event === "pong")).toBe(true);
  });

  it("detects overrides without being confused by odd payloads", () => {
    const auth: AuthContext = { userId: "u1", role: "member", email: "u1@t.local" };

    expect(hasIdentityOverride(null, auth)).toBe(false);
    expect(hasIdentityOverride("string", auth)).toBe(false);
    expect(hasIdentityOverride([1, 2, 3], auth)).toBe(false);
    expect(hasIdentityOverride({ userId: undefined }, auth)).toBe(false);
    expect(hasIdentityOverride({ message: "hello" }, auth)).toBe(false);
    expect(hasIdentityOverride({ userId: "u2" }, auth)).toBe(true);
  });

  it("drops a connection that somehow arrived unauthenticated", () => {
    const socket = fakeSocket();
    registerSocketConnection(asSocket(socket), { log: () => undefined });

    expect(socket.disconnected).toBe(true);
    expect(socket.rooms).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("Sprint 9 — event authorization", () => {
  const tokens = tokenServiceFor({ "alice-token": ALICE });

  async function connected() {
    const socket = fakeSocket({ auth: { token: "alice-token" } });
    await handshake(socket, tokens);
    registerSocketConnection(asSocket(socket), { log: () => undefined });
    return socket;
  }

  it("allows a classified read-only event", async () => {
    const socket = await connected();

    socket.clientEmit("ping");

    expect(socket.emitted.some((e) => e.event === "pong")).toBe(true);
  });

  it("refuses an unknown event rather than ignoring it", async () => {
    const socket = await connected();

    socket.clientEmit("some:new:event", { a: 1 });

    const error = socket.emitted.find((e) => e.event === "error");
    expect((error?.payload as Record<string, unknown>)?.code).toBe("SOCKET_EVENT_UNKNOWN");
  });

  it("refuses tool execution over the socket transport", async () => {
    // ToolExecutor, permissions and approval live on the HTTP routes. A socket
    // event reaching them would be an authorization bypass by construction.
    for (const event of ["tool:execute", "tool:invoke", "agent:execute"]) {
      const socket = await connected();
      socket.clientEmit(event, { toolId: "meta.campaign.pause" });

      const error = socket.emitted.find((e) => e.event === "error");
      expect((error?.payload as Record<string, unknown>)?.code, event).toBe(
        "SOCKET_EVENT_FORBIDDEN"
      );
    }
  });

  it("refuses approval decisions over the socket transport", async () => {
    for (const event of [
      "approval:approve",
      "approval:reject",
      "voice:approve",
      "pending-action:confirm",
    ]) {
      const socket = await connected();
      socket.clientEmit(event, { approvalId: "appr-1" });

      const error = socket.emitted.find((e) => e.event === "error");
      expect((error?.payload as Record<string, unknown>)?.code, event).toBe(
        "SOCKET_EVENT_FORBIDDEN"
      );
    }
  });

  it("classifies every policy entry and defaults everything else to denied", () => {
    for (const [event, classification] of Object.entries(SOCKET_EVENT_POLICY)) {
      expect(classifySocketEvent(event), event).toBe(classification);
    }

    expect(classifySocketEvent("anything-else")).toBeNull();
    expect(isSocketEventAllowed("anything-else")).toBe(false);
    expect(isSocketEventAllowed("tool:execute")).toBe(false);
  });

  it("cannot be tricked by an inherited Object property", () => {
    expect(classifySocketEvent("constructor")).toBeNull();
    expect(classifySocketEvent("toString")).toBeNull();
    expect(classifySocketEvent("__proto__")).toBeNull();
    expect(isSocketEventAllowed("constructor")).toBe(false);
  });

  it("keeps the policy immutable at runtime", () => {
    expect(() => {
      (SOCKET_EVENT_POLICY as Record<string, string>)["tool:execute"] = "READ_ONLY";
    }).toThrow();

    expect(SOCKET_EVENT_POLICY["tool:execute"]).toBe("FORBIDDEN");
  });

  it("exposes no event that could execute a write", () => {
    const allowed = Object.entries(SOCKET_EVENT_POLICY)
      .filter(([, c]) => c === "READ_ONLY" || c === "AUTHENTICATED_OPERATION")
      .map(([event]) => event);

    expect(allowed).toEqual(["ping"]);
  });
});

// ---------------------------------------------------------------------------

describe("Sprint 9 — Voice compatibility and approval safety", () => {
  const tokens = tokenServiceFor({ "alice-token": ALICE });

  it("leaves Voice on HTTP, untouched by this change", () => {
    // Sprint 8 Voice is transcribe/speak/status over HTTP. No socket event
    // exists for it, so securing the socket transport cannot alter it.
    const voiceEvents = Object.keys(SOCKET_EVENT_POLICY).filter((e) =>
      e.startsWith("voice:")
    );

    expect(voiceEvents).toEqual(["voice:approve"]);
    expect(SOCKET_EVENT_POLICY["voice:approve"]).toBe("FORBIDDEN");
  });

  it("refuses a voice approval over the socket, preserving the locked rule", async () => {
    const socket = fakeSocket({ auth: { token: "alice-token" } });
    await handshake(socket, tokens);
    registerSocketConnection(asSocket(socket), { log: () => undefined });

    socket.clientEmit("voice:approve", { approvalId: "appr-1", confirm: true });

    const error = socket.emitted.find((e) => e.event === "error");
    expect((error?.payload as Record<string, unknown>)?.code).toBe(
      "SOCKET_EVENT_FORBIDDEN"
    );
  });

  it("offers no socket path that could confirm a pending action", () => {
    const confirmEvents = Object.entries(SOCKET_EVENT_POLICY)
      .filter(([e]) => /approve|confirm|reject/i.test(e))
      .map(([, c]) => c);

    expect(confirmEvents.length).toBeGreaterThan(0);
    expect(confirmEvents.every((c) => c === "FORBIDDEN")).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("Sprint 9 — secret safety and cleanup", () => {
  const SECRET_TOKEN = "eyJhbGciOiJIUzI1NiJ9.super-secret-value.signature";

  it("never writes a credential to the log, on any path", async () => {
    const logged: Record<string, unknown>[] = [];
    const middleware = createSocketAuthMiddleware(tokenServiceFor({}), {
      log: (entry) => logged.push(entry),
    });

    await new Promise<void>((resolve) => {
      middleware(
        asSocket(fakeSocket({ auth: { token: SECRET_TOKEN } })),
        () => resolve()
      );
    });

    expect(logged.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(logged);
    expect(serialized).not.toContain(SECRET_TOKEN);
    expect(serialized).not.toContain("super-secret-value");
  });

  it("does not log the Authorization header", async () => {
    const logged: Record<string, unknown>[] = [];
    const middleware = createSocketAuthMiddleware(
      tokenServiceFor({ [SECRET_TOKEN]: ALICE }),
      { log: (entry) => logged.push(entry) }
    );

    await new Promise<void>((resolve) => {
      middleware(
        asSocket(fakeSocket({ headers: { authorization: `Bearer ${SECRET_TOKEN}` } })),
        () => resolve()
      );
    });

    expect(JSON.stringify(logged)).not.toContain(SECRET_TOKEN);
  });

  it("does not log a rejected event's payload", async () => {
    const logged: Record<string, unknown>[] = [];
    const socket = fakeSocket({ auth: { token: "alice-token" } });
    await handshake(socket, tokenServiceFor({ "alice-token": ALICE }));
    registerSocketConnection(asSocket(socket), { log: (e) => logged.push(e) });

    socket.clientEmit("tool:execute", { password: "hunter2", apiKey: "sk-live-abc" });

    const serialized = JSON.stringify(logged);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("sk-live-abc");
    // The event NAME is safe and useful.
    expect(serialized).toContain("tool:execute");
  });

  it("clears identity on disconnect", async () => {
    const socket = fakeSocket({ auth: { token: "alice-token" } });
    await handshake(socket, tokenServiceFor({ "alice-token": ALICE }));
    registerSocketConnection(asSocket(socket), { log: () => undefined });

    expect(socket.data.auth).toBeDefined();
    socket.handlers.get("disconnect")?.("transport close");

    expect(socket.data.auth).toBeUndefined();
    expect(socketAuth(asSocket(socket))).toBeNull();
  });

  it("bounds what an unauthenticated peer may hold or send", () => {
    expect(SOCKET_CONNECT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(SOCKET_CONNECT_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
    expect(SOCKET_MAX_BUFFER_BYTES).toBeLessThanOrEqual(1_000_000);
  });
});
