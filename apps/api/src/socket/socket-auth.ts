// ---------------------------------------------------------------------------
// Sprint 9 hotfix — Socket.IO authentication and event authorization.
//
// The Socket.IO server has accepted every connection since it was introduced,
// with no identity attached to any of them. Today that is close to harmless —
// no client connects and no custom event is registered — but "close to
// harmless" is a property of the current event list, not of the transport. The
// moment anyone adds a socket event it inherits an unauthenticated channel, and
// that is exactly the trap to close before the Browser Agent widens the
// surface.
//
// The fix reuses the EXISTING `TokenService` the HTTP middleware uses. There is
// deliberately no second authentication mechanism, no socket-specific token and
// no separate session store: one identity model, two transports.
//
// Two properties are enforced here, both fail-closed:
//
//   1. A socket that cannot prove who it is never reaches `connection`.
//   2. An event that has not been explicitly classified is refused, so the
//      authorized surface cannot grow by accident.
// ---------------------------------------------------------------------------

import type { Server, Socket } from "socket.io";
import type { AuthContext, Role } from "@jarvis/core";
import type { TokenService } from "@jarvis/security";

// ---------------------------------------------------------------------------
// Connection limits
// ---------------------------------------------------------------------------

/** A client that has not authenticated within this window is dropped. */
export const SOCKET_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Largest frame accepted from a client.
 *
 * Socket.IO's own default, pinned explicitly: an unauthenticated peer can send
 * a frame before the handshake completes, so the ceiling is a denial-of-service
 * control and should not silently change with a dependency bump.
 */
export const SOCKET_MAX_BUFFER_BYTES = 1_000_000;

/** Longest credential string worth parsing. Anything larger is not a JWT. */
const MAX_TOKEN_LENGTH = 4096;

/** Failed handshakes tolerated from one address inside the window. */
export const SOCKET_MAX_AUTH_FAILURES = 10;
export const SOCKET_AUTH_FAILURE_WINDOW_MS = 60_000;

// ---------------------------------------------------------------------------
// Failure reasons
// ---------------------------------------------------------------------------

/**
 * Stable codes handed to the client on a rejected handshake.
 *
 * Deliberately coarse. "Which of the token's claims was wrong" is useful to an
 * attacker enumerating tokens and useless to a legitimate client, whose only
 * available response to any of these is to re-authenticate.
 */
export type SocketAuthFailure =
  | "SOCKET_AUTH_REQUIRED"
  | "SOCKET_AUTH_INVALID"
  | "SOCKET_AUTH_MALFORMED"
  | "SOCKET_AUTH_THROTTLED";

export class SocketAuthError extends Error {
  readonly data: { code: SocketAuthFailure };

  constructor(code: SocketAuthFailure, message: string) {
    super(message);
    this.name = "SocketAuthError";
    // Socket.IO forwards `err.data` to the client's connect_error handler.
    this.data = { code };
  }
}

// ---------------------------------------------------------------------------
// Event policy
// ---------------------------------------------------------------------------

/**
 * What a socket event is allowed to be.
 *
 * `APPROVAL_REQUIRED` and `FORBIDDEN` both currently mean "not over this
 * transport". They are kept apart because they say different things to whoever
 * reads this next: one is a capability that could exist over Socket.IO once
 * approval is modelled on it, the other must never exist here at all.
 */
export type SocketEventClass =
  | "READ_ONLY"
  | "AUTHENTICATED_OPERATION"
  | "APPROVAL_REQUIRED"
  | "FORBIDDEN";

/**
 * The complete set of client-emitted events the server will act on.
 *
 * Default-deny: anything absent is refused. That is the whole point — a new
 * event has to be added here, which forces someone to decide what class it is,
 * rather than arriving with the ambient permissions of the transport.
 *
 * The FORBIDDEN entries are not dead weight. They are a standing statement that
 * tool execution and approval decisions do not happen over a socket: those go
 * through the HTTP routes where ToolExecutor, the permission service and the
 * approval boundary already live. Naming them here means a future attempt to
 * add one fails a test instead of quietly shipping.
 */
export const SOCKET_EVENT_POLICY: Readonly<Record<string, SocketEventClass>> =
  Object.freeze({
    /** Liveness check on an authenticated channel. Carries no data. */
    ping: "READ_ONLY",

    // Never over this transport — see above.
    "tool:execute": "FORBIDDEN",
    "tool:invoke": "FORBIDDEN",
    "agent:execute": "FORBIDDEN",
    "approval:approve": "FORBIDDEN",
    "approval:reject": "FORBIDDEN",
    "voice:approve": "FORBIDDEN",
    "pending-action:confirm": "FORBIDDEN",
  });

/** Socket.IO's own lifecycle events, which are not client capabilities. */
const RESERVED_EVENTS = new Set(["disconnect", "disconnecting", "error", "newListener", "removeListener"]);

export function classifySocketEvent(event: string): SocketEventClass | null {
  if (!Object.prototype.hasOwnProperty.call(SOCKET_EVENT_POLICY, event)) return null;
  return SOCKET_EVENT_POLICY[event] ?? null;
}

/** Whether a client-emitted event may run at all. */
export function isSocketEventAllowed(event: string): boolean {
  const classification = classifySocketEvent(event);
  return classification === "READ_ONLY" || classification === "AUTHENTICATED_OPERATION";
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Keys a client must never be able to set for itself. */
const IDENTITY_KEYS = ["userId", "tenantId", "accountId", "role", "email", "sub"] as const;

/**
 * Whether a payload tries to assert an identity of its own.
 *
 * Server-resolved identity is used regardless, so an override would be ignored
 * either way. It is rejected rather than ignored so the attempt is visible: a
 * client sending someone else's userId is a fact worth surfacing, not a field
 * worth quietly dropping.
 */
export function hasIdentityOverride(payload: unknown, auth: AuthContext): boolean {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return false;
  }
  const record = payload as Record<string, unknown>;

  for (const key of IDENTITY_KEYS) {
    if (!(key in record)) continue;
    const value = record[key];
    if (value === undefined || value === null) continue;

    // Echoing your own id back is harmless; claiming another is not.
    if (key === "userId" || key === "sub") {
      if (String(value) !== auth.userId) return true;
      continue;
    }
    if (key === "role" && String(value) !== auth.role) return true;
    if (key === "email" && String(value) !== auth.email) return true;
    // Tenant and account scoping is server-side only; any value is an override.
    if (key === "tenantId" || key === "accountId") return true;
  }
  return false;
}

/** The room a socket is placed in, so server emits are scoped to one user. */
export function userRoom(userId: string): string {
  return `user:${userId}`;
}

// ---------------------------------------------------------------------------
// Credential extraction
// ---------------------------------------------------------------------------

/**
 * Pulls the bearer token off a handshake.
 *
 * Accepts `auth.token` (the Socket.IO-native channel) and the Authorization
 * header. The query string is deliberately NOT read: query strings are logged
 * by proxies, load balancers and browser history in a way headers and the auth
 * payload are not, and accepting one there would invite clients to put a
 * credential somewhere it gets written down.
 */
export function extractHandshakeToken(handshake: {
  auth?: Record<string, unknown>;
  headers?: Record<string, unknown>;
}): { ok: true; token: string } | { ok: false; reason: SocketAuthFailure } {
  const raw = handshake.auth?.token;

  if (raw !== undefined && raw !== null) {
    if (typeof raw !== "string") return { ok: false, reason: "SOCKET_AUTH_MALFORMED" };
    const token = raw.startsWith("Bearer ") ? raw.slice(7).trim() : raw.trim();
    if (token.length === 0) return { ok: false, reason: "SOCKET_AUTH_REQUIRED" };
    if (token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "SOCKET_AUTH_MALFORMED" };
    return { ok: true, token };
  }

  const header = handshake.headers?.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    const token = header.slice(7).trim();
    if (token.length === 0) return { ok: false, reason: "SOCKET_AUTH_REQUIRED" };
    if (token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "SOCKET_AUTH_MALFORMED" };
    return { ok: true, token };
  }

  // An array header, or anything else non-string, is malformed rather than absent.
  if (header !== undefined && typeof header !== "string") {
    return { ok: false, reason: "SOCKET_AUTH_MALFORMED" };
  }

  return { ok: false, reason: "SOCKET_AUTH_REQUIRED" };
}

// ---------------------------------------------------------------------------
// Handshake throttle
// ---------------------------------------------------------------------------

/**
 * Bounds repeated failed handshakes from one address.
 *
 * In-process and per-address on purpose. The durable, per-user limiter cannot
 * help here: it keys on an authenticated identity, and a socket that fails
 * authentication has none. This is a transport guard in front of that, not a
 * replacement for it.
 */
export class SocketAuthThrottle {
  private failures = new Map<string, number[]>();

  constructor(
    private readonly maxFailures = SOCKET_MAX_AUTH_FAILURES,
    private readonly windowMs = SOCKET_AUTH_FAILURE_WINDOW_MS
  ) {}

  private recent(key: string, now: number): number[] {
    const cutoff = now - this.windowMs;
    const kept = (this.failures.get(key) ?? []).filter((at) => at > cutoff);
    if (kept.length === 0) this.failures.delete(key);
    else this.failures.set(key, kept);
    return kept;
  }

  isThrottled(key: string, now: number = Date.now()): boolean {
    return this.recent(key, now).length >= this.maxFailures;
  }

  recordFailure(key: string, now: number = Date.now()): void {
    const kept = this.recent(key, now);
    kept.push(now);
    this.failures.set(key, kept);
  }

  /** A successful handshake clears the address's history. */
  recordSuccess(key: string): void {
    this.failures.delete(key);
  }

  reset(): void {
    this.failures.clear();
  }
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export interface SocketAuthLogger {
  (entry: Record<string, unknown>): void;
}

const defaultLogger: SocketAuthLogger = (entry) => {
  console.log(JSON.stringify(entry));
};

/**
 * Socket.IO middleware that authenticates a handshake.
 *
 * Runs before `connection` fires, so a rejected socket never becomes a
 * connected socket and never reaches an event handler. On success the
 * SERVER-RESOLVED identity is attached to `socket.data.auth`; nothing the
 * client sent contributes to it.
 */
export function createSocketAuthMiddleware(
  tokenService: Pick<TokenService, "verifyAccessToken">,
  options: { throttle?: SocketAuthThrottle; log?: SocketAuthLogger } = {}
) {
  const throttle = options.throttle ?? new SocketAuthThrottle();
  const log = options.log ?? defaultLogger;

  return (socket: Socket, next: (err?: Error) => void): void => {
    const address = socket.handshake.address ?? "unknown";

    const reject = (reason: SocketAuthFailure, message: string) => {
      if (reason !== "SOCKET_AUTH_THROTTLED") throttle.recordFailure(address);
      // The token is never logged, on any path — a rejected credential is
      // still a credential.
      log({
        level: "warn",
        event: "socket_auth_rejected",
        reason,
        socketId: socket.id,
      });
      next(new SocketAuthError(reason, message));
    };

    if (throttle.isThrottled(address)) {
      reject("SOCKET_AUTH_THROTTLED", "Too many failed connection attempts");
      return;
    }

    const extracted = extractHandshakeToken(socket.handshake);
    if (!extracted.ok) {
      reject(
        extracted.reason,
        extracted.reason === "SOCKET_AUTH_MALFORMED"
          ? "Malformed authentication payload"
          : "Authentication required"
      );
      return;
    }

    let identity: { userId: string; role: string; email: string } | null;
    try {
      identity = tokenService.verifyAccessToken(extracted.token);
    } catch {
      // verifyAccessToken already swallows jwt errors, but a bad secret or a
      // future implementation could throw. Fail closed either way.
      identity = null;
    }

    if (!identity) {
      // Expired and forged tokens are indistinguishable to the client on
      // purpose; both mean "authenticate again".
      reject("SOCKET_AUTH_INVALID", "Invalid or expired credentials");
      return;
    }

    const auth: AuthContext = {
      userId: identity.userId,
      role: identity.role as Role,
      email: identity.email,
    };

    socket.data.auth = auth;
    throttle.recordSuccess(address);

    log({
      level: "info",
      event: "socket_authenticated",
      socketId: socket.id,
      userId: auth.userId,
      role: auth.role,
    });

    next();
  };
}

// ---------------------------------------------------------------------------
// Connection wiring
// ---------------------------------------------------------------------------

/** The authenticated identity on a connected socket, or null if absent. */
export function socketAuth(socket: Socket): AuthContext | null {
  const auth = socket.data?.auth;
  if (!auth || typeof auth !== "object") return null;
  const candidate = auth as Partial<AuthContext>;
  if (!candidate.userId || !candidate.role || !candidate.email) return null;
  return candidate as AuthContext;
}

/**
 * Installs the per-connection guards.
 *
 * `onAny` is the default-deny gate: it sees every client-emitted event,
 * including ones no handler was registered for, so an unclassified event is
 * refused rather than silently ignored. Refusing loudly matters — a silently
 * dropped event looks identical to a bug, and would hide someone probing for
 * an unguarded capability.
 */
export function registerSocketConnection(
  socket: Socket,
  options: { log?: SocketAuthLogger } = {}
): void {
  const log = options.log ?? defaultLogger;
  const auth = socketAuth(socket);

  // Defense in depth: the middleware cannot be bypassed, but a future refactor
  // could register this handler on a namespace that lacks it.
  if (!auth) {
    log({ level: "warn", event: "socket_unauthenticated_connection", socketId: socket.id });
    socket.disconnect(true);
    return;
  }

  // Scopes every server-to-client emit to one user. Without this a future
  // broadcast reaches every connected socket regardless of tenant.
  void socket.join(userRoom(auth.userId));

  log({
    level: "info",
    event: "socket_connected",
    socketId: socket.id,
    userId: auth.userId,
  });

  socket.onAny((event: string, ...args: unknown[]) => {
    if (RESERVED_EVENTS.has(event)) return;

    const classification = classifySocketEvent(event);

    if (classification === null || classification === "FORBIDDEN" || classification === "APPROVAL_REQUIRED") {
      log({
        level: "warn",
        event: "socket_event_rejected",
        socketId: socket.id,
        userId: auth.userId,
        // The event NAME is safe to log; its payload is not, and is never read
        // into the log.
        rejectedEvent: event,
        classification: classification ?? "UNKNOWN",
      });
      socket.emit("error", {
        code: classification === null ? "SOCKET_EVENT_UNKNOWN" : "SOCKET_EVENT_FORBIDDEN",
        message: `Event "${event}" is not available over this transport`,
      });
      return;
    }

    if (hasIdentityOverride(args[0], auth)) {
      log({
        level: "warn",
        event: "socket_identity_override_rejected",
        socketId: socket.id,
        userId: auth.userId,
        rejectedEvent: event,
      });
      socket.emit("error", {
        code: "SOCKET_IDENTITY_OVERRIDE",
        message: "Identity is resolved server-side and cannot be supplied by the client",
      });
      return;
    }
  });

  socket.on("ping", () => {
    socket.emit("pong", { at: new Date().toISOString() });
  });

  socket.on("disconnect", (reason: string) => {
    // Phase 10.4 decision preserved: CLIENT DISCONNECT != EXECUTION
    // CANCELLATION. Executions are journal-backed; nothing is aborted here.
    socket.data.auth = undefined;
    log({
      level: "info",
      event: "socket_disconnected",
      socketId: socket.id,
      userId: auth.userId,
      reason,
    });
  });
}

/** Applies authentication and connection guards to a Socket.IO server. */
export function secureSocketServer(
  io: Server,
  tokenService: Pick<TokenService, "verifyAccessToken">,
  options: { throttle?: SocketAuthThrottle; log?: SocketAuthLogger } = {}
): void {
  io.use(createSocketAuthMiddleware(tokenService, options));
  io.on("connection", (socket) => registerSocketConnection(socket, options));
}
