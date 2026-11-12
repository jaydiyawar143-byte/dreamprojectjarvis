"use client";

// ---------------------------------------------------------------------------
// VO-2.1 — the dashboard's authenticated Socket.IO connection.
//
// Both live streams (the Virtual Office and the system metrics) open their
// socket here, so a fix to how a socket proves who it is lands in one place.
//
// WHAT WENT WRONG BEFORE (H1, D1). Each hook read the access token ONCE, when
// the page opened, and handed socket.io that value. Access tokens live fifteen
// minutes. After that, any reconnect — an API restart, a laptop waking, a
// network change — presented the expired token; the server refused it; and
// socket.io-client does not retry a handshake the server refused. The stream
// stayed down until the page was reloaded, and the Refresh button could not
// bring it back. Since VO-2.1 the server also ENDS every socket when its
// token expires, so this path is now taken every fifteen minutes, not only
// after a drop.
//
// WHAT THIS DOES INSTEAD.
//
//   1. THE TOKEN IS READ PER ATTEMPT. `auth` is a function, which socket.io
//      calls for every connection attempt, so it presents the token held now.
//
//   2. A REFUSED OR ENDED SESSION IS RENEWED, THEN RECONNECTED. When the
//      handshake is refused for its credential, or the server ends the
//      session, the token is refreshed through `refreshAccessToken` — the
//      SAME single-flight refresh the HTTP client uses, so a socket and a
//      burst of 401s rotate the refresh cookie once — and the socket connects
//      again. No credential is stored here, and the refresh cookie is never
//      readable from this code.
//
//   3. IT GIVES UP HONESTLY. A failed refresh is "unauthenticated". A
//      throttled handshake is not retried on its own. Renewals that keep being
//      refused stop after `MAX_SOCKET_AUTH_RENEWALS` in a row and report
//      "offline", until someone asks again with `reconnect()` (the page's
//      Refresh button). A successful connection resets the count.
//
// A transport failure (the server is unreachable) is left to socket.io's own
// reconnection, exactly as before.
// ---------------------------------------------------------------------------

import { io, type Socket } from "socket.io-client";

import { getAccessToken, refreshAccessToken } from "./api";
import { SOCKET_URL } from "./socket-url";

export type AuthenticatedSocketStatus =
  | "connecting"
  | "live"
  | "reconnecting"
  | "offline"
  | "unauthenticated";

/**
 * The handshake refusals a fresh token can cure. `socket-auth.ts` on the API
 * answers with these codes; "required" and "malformed" are included because a
 * cleared or replaced token produces them, and a refresh is the answer to both.
 */
const RENEWABLE_REFUSALS = new Set([
  "SOCKET_AUTH_INVALID",
  "SOCKET_AUTH_REQUIRED",
  "SOCKET_AUTH_MALFORMED",
]);

/** Too many failed handshakes from this address. Retrying would only extend it. */
const THROTTLED = "SOCKET_AUTH_THROTTLED";

/** The reason socket.io-client reports when the SERVER ended the session. */
const SERVER_ENDED = "io server disconnect";

/** Renewals tried in a row before giving up until someone asks again. */
export const MAX_SOCKET_AUTH_RENEWALS = 3;

export interface AuthenticatedSocketOptions {
  reconnectionAttempts?: number;
  reconnectionDelay?: number;
  reconnectionDelayMax?: number;
  /** Every change of state. Not called after `close()`. */
  onStatus: (status: AuthenticatedSocketStatus) => void;
  /**
   * Every successful connection. `reconnected` is false only for the first, so
   * a caller can subscribe each time and re-read durable state after a gap.
   */
  onConnect: (socket: Socket, info: { reconnected: boolean }) => void;
}

export interface AuthenticatedSocketHandle {
  socket: Socket;
  /**
   * Connect again now, if the socket is neither connected nor already trying.
   * Starts a fresh renewal budget. Refreshes first when no token is held.
   */
  reconnect: () => void;
  /**
   * Stop for good. `beforeClose` runs only while still connected, so a caller
   * can unsubscribe before the socket drops.
   */
  close: (beforeClose?: (socket: Socket) => void) => void;
}

function refusalCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { data?: { code?: unknown } }).data?.code;
  return typeof code === "string" ? code : null;
}

/**
 * Opens the authenticated socket, or reports "unauthenticated" and returns
 * null when there is no access token to open it with.
 */
export function openAuthenticatedSocket(
  options: AuthenticatedSocketOptions
): AuthenticatedSocketHandle | null {
  if (!getAccessToken()) {
    options.onStatus("unauthenticated");
    return null;
  }

  /** The token the most recent connection attempt presented. */
  let presented: string | null = null;

  const socket = io(SOCKET_URL, {
    // A function, not a value: called for EVERY connection attempt, so a
    // reconnect presents the token held now, not the one the page opened with.
    auth: (cb: (data: Record<string, unknown>) => void) => {
      const token = getAccessToken();
      presented = token;
      cb(token ? { token } : {});
    },
    transports: ["websocket"],
    reconnection: true,
    reconnectionAttempts: options.reconnectionAttempts ?? Infinity,
    reconnectionDelay: options.reconnectionDelay ?? 1000,
    reconnectionDelayMax: options.reconnectionDelayMax ?? 5000,
  });

  let closed = false;
  let renewing = false;
  let renewals = 0;
  let connectedOnce = false;

  const report = (status: AuthenticatedSocketStatus): void => {
    if (!closed) options.onStatus(status);
  };

  function finishRenewal(refreshed: boolean): void {
    renewing = false;
    if (closed) return;
    if (!refreshed || !getAccessToken()) {
      // The session is gone, not merely stale. Nothing is retried: signing in
      // again is what restores it.
      report("unauthenticated");
      return;
    }
    socket.connect();
  }

  function renew(): void {
    if (closed || renewing) return;
    if (renewals >= MAX_SOCKET_AUTH_RENEWALS) {
      // A server that keeps refusing a token it was just given will not be
      // talked round by a fourth attempt. Stop until someone asks.
      report("offline");
      return;
    }
    renewals += 1;
    report("reconnecting");

    // The page's HTTP requests usually refreshed the token already: their
    // 401s arrive at the same expiry. Present that newer token first rather
    // than rotating the refresh cookie again; if it too is refused, the next
    // renewal refreshes.
    const held = getAccessToken();
    if (held !== null && held !== presented) {
      socket.connect();
      return;
    }

    renewing = true;
    refreshAccessToken().then(
      (refreshed) => finishRenewal(refreshed),
      () => finishRenewal(false)
    );
  }

  socket.on("connect", () => {
    renewals = 0;
    report("live");
    options.onConnect(socket, { reconnected: connectedOnce });
    connectedOnce = true;
  });

  socket.on("disconnect", (reason?: string) => {
    if (closed) return;
    if (reason === SERVER_ENDED) {
      // The server ended the session — since VO-2.1, because the token that
      // opened it expired. socket.io-client will not reconnect on its own here.
      renew();
      return;
    }
    // `active` is true while socket.io intends to reconnect by itself.
    report(socket.active ? "reconnecting" : "offline");
  });

  socket.on("connect_error", (error?: unknown) => {
    if (closed) return;
    const code = refusalCode(error);
    if (code !== null && RENEWABLE_REFUSALS.has(code)) {
      renew();
      return;
    }
    if (code === THROTTLED) {
      report("offline");
      return;
    }
    report(socket.active ? "reconnecting" : "offline");
  });

  return {
    socket,
    reconnect() {
      if (closed || renewing || socket.connected || socket.active) return;
      renewals = 0;
      if (!getAccessToken()) {
        renew();
        return;
      }
      report("reconnecting");
      socket.connect();
    },
    close(beforeClose) {
      if (closed) return;
      if (socket.connected) beforeClose?.(socket);
      closed = true;
      socket.removeAllListeners();
      socket.disconnect();
    },
  };
}
