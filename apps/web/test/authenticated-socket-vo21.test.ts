// ---------------------------------------------------------------------------
// VO-2.1 (H1, D1) — the dashboard's authenticated socket.
//
// Both live streams opened their socket with the access token read ONCE. After
// fifteen minutes any reconnect presented an expired token, the server refused
// it, socket.io-client gave up, and only a page reload brought the stream
// back. Since VO-2.1 the server also ends every socket when its token expires.
//
// What is pinned here, against a stand-in for socket.io-client (the real
// library's behaviour on refusal and on a server-ended session is pinned
// against a real server in apps/api's office-stream-e2e-vo21 test):
//
//   - the token is read for every connection attempt;
//   - a refused credential or a server-ended session is renewed through the
//     shared refresh, then connected again — once at a time;
//   - a failed refresh is "unauthenticated"; a throttled handshake is not
//     retried; refusals of fresh tokens stop after a fixed number in a row;
//   - transport failures are left to socket.io's own reconnection;
//   - `reconnect()` brings back a stream that gave up, with a fresh budget;
//   - nothing happens after `close()`.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const harness = vi.hoisted(() => ({ sockets: [] as any[], options: [] as any[] }));

vi.mock("socket.io-client", () => ({
  io: vi.fn((_url: string, options: any) => {
    harness.options.push(options);
    const handlers = new Map<string, Function[]>();
    // Like the real client, every connection attempt asks the `auth` callback
    // for its credential: once on creation, once per `connect()`.
    const attempt = () => options?.auth?.(() => undefined);
    const socket: any = {
      connected: false,
      active: true,
      connects: 0,
      disconnected: false,
      emitted: [] as Array<{ event: string; payload: unknown }>,
      emit(event: string, payload?: unknown) {
        this.emitted.push({ event, payload });
      },
      on(event: string, handler: Function) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      removeAllListeners() {
        handlers.clear();
      },
      connect() {
        this.connects += 1;
        this.active = true;
        attempt();
        return this;
      },
      disconnect() {
        this.disconnected = true;
        this.connected = false;
        this.active = false;
      },
      trigger(event: string, payload?: unknown) {
        if (event === "connect") {
          this.connected = true;
          this.active = true;
        }
        for (const handler of handlers.get(event) ?? []) handler(payload);
      },
    };
    harness.sockets.push(socket);
    attempt();
    return socket;
  }),
}));

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return { ...actual, refreshAccessToken: vi.fn() };
});

import * as api from "../src/lib/api";
import {
  MAX_SOCKET_AUTH_RENEWALS,
  openAuthenticatedSocket,
  type AuthenticatedSocketStatus,
} from "../src/lib/authenticated-socket";

const refresh = vi.mocked(api.refreshAccessToken);

/** Lets the refresh promise and its continuation settle. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** The server's answer to a handshake whose credential it did not accept. */
const refusal = (code: string) => ({ message: "refused", data: { code } });

function open() {
  const statuses: AuthenticatedSocketStatus[] = [];
  const connects: Array<{ reconnected: boolean }> = [];
  const handle = openAuthenticatedSocket({
    onStatus: (status) => statuses.push(status),
    onConnect: (_socket, info) => connects.push(info),
  });
  const socket = harness.sockets[harness.sockets.length - 1];
  const authOf = () =>
    new Promise<Record<string, unknown>>((resolve) =>
      harness.options[harness.options.length - 1].auth(resolve)
    );
  return { handle, socket, statuses, connects, authOf, last: () => statuses[statuses.length - 1] };
}

/** What socket.io-client does when the server refuses a handshake: stops. */
function refuse(socket: any, code = "SOCKET_AUTH_INVALID"): void {
  socket.connected = false;
  socket.active = false;
  socket.trigger("connect_error", refusal(code));
}

beforeEach(() => {
  harness.sockets.length = 0;
  harness.options.length = 0;
  api.setAccessToken("token-1");
  refresh.mockReset();
  refresh.mockImplementation(async () => {
    api.setAccessToken("token-fresh");
    return true;
  });
});

afterEach(() => {
  api.setAccessToken(null);
});

// ---------------------------------------------------------------------------

describe("VO-2.1 — opening", () => {
  it("opens nothing and says so when there is no access token", () => {
    api.setAccessToken(null);
    const statuses: AuthenticatedSocketStatus[] = [];

    const handle = openAuthenticatedSocket({ onStatus: (s) => statuses.push(s), onConnect: () => {} });

    expect(handle).toBeNull();
    expect(statuses).toEqual(["unauthenticated"]);
    expect(harness.sockets).toHaveLength(0);
  });

  it("reads the access token for every connection attempt, never once", async () => {
    const { authOf } = open();

    expect(await authOf()).toEqual({ token: "token-1" });
    api.setAccessToken("token-2");
    expect(await authOf()).toEqual({ token: "token-2" });
    api.setAccessToken(null);
    expect(await authOf()).toEqual({});
  });

  it("is live on connect, and tells the caller which connections are reconnects", () => {
    const { socket, connects, last } = open();

    socket.trigger("connect");
    expect(last()).toBe("live");
    socket.trigger("connect");

    expect(connects).toEqual([{ reconnected: false }, { reconnected: true }]);
  });
});

describe("VO-2.1 — renewing a refused or ended session", () => {
  it("refreshes the token and connects again when the handshake is refused", async () => {
    const { socket, last, authOf } = open();
    socket.trigger("connect");

    refuse(socket);
    expect(last()).toBe("reconnecting");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(socket.connects).toBe(0);

    await settle();
    expect(socket.connects).toBe(1);
    // The new attempt presents the refreshed token.
    expect(await authOf()).toEqual({ token: "token-fresh" });

    socket.trigger("connect");
    expect(last()).toBe("live");
  });

  it("renews when the server ends the session, as it does at token expiry", async () => {
    const { socket, last } = open();
    socket.trigger("connect");

    socket.connected = false;
    socket.active = false;
    socket.trigger("disconnect", "io server disconnect");

    expect(last()).toBe("reconnecting");
    expect(refresh).toHaveBeenCalledTimes(1);
    await settle();
    expect(socket.connects).toBe(1);
  });

  it("presents a token the page already refreshed before rotating the cookie again", async () => {
    const { socket, authOf } = open();
    socket.trigger("connect");
    // The page's HTTP requests met the same expiry and refreshed already.
    api.setAccessToken("token-from-http");

    socket.connected = false;
    socket.active = false;
    socket.trigger("disconnect", "io server disconnect");

    expect(refresh).not.toHaveBeenCalled();
    expect(socket.connects).toBe(1);
    expect(await authOf()).toEqual({ token: "token-from-http" });

    // Refused too: now the renewal refreshes.
    refuse(socket);
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(socket.connects).toBe(2);
  });

  it.each(["SOCKET_AUTH_REQUIRED", "SOCKET_AUTH_MALFORMED"])(
    "renews on %s too, which a cleared or replaced token produces",
    async (code) => {
      const { socket } = open();

      refuse(socket, code);
      await settle();

      expect(refresh).toHaveBeenCalledTimes(1);
      expect(socket.connects).toBe(1);
    }
  );

  it("says unauthenticated, and stops, when the session cannot be refreshed", async () => {
    refresh.mockResolvedValue(false);
    const { socket, last } = open();

    refuse(socket);
    await settle();

    expect(last()).toBe("unauthenticated");
    expect(socket.connects).toBe(0);
  });

  it("treats a refresh that throws as a session that cannot be refreshed", async () => {
    refresh.mockRejectedValue(new Error("network"));
    const { socket, last } = open();

    refuse(socket);
    await settle();

    expect(last()).toBe("unauthenticated");
    expect(socket.connects).toBe(0);
  });

  it("runs one renewal at a time", async () => {
    const { socket } = open();

    refuse(socket);
    refuse(socket);
    socket.trigger("disconnect", "io server disconnect");
    await settle();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(socket.connects).toBe(1);
  });

  it(`gives up after ${MAX_SOCKET_AUTH_RENEWALS} refusals of a fresh token in a row`, async () => {
    const { socket, last } = open();

    for (let i = 0; i < MAX_SOCKET_AUTH_RENEWALS; i += 1) {
      refuse(socket);
      await settle();
    }
    expect(refresh).toHaveBeenCalledTimes(MAX_SOCKET_AUTH_RENEWALS);

    refuse(socket);
    await settle();

    expect(last()).toBe("offline");
    expect(refresh).toHaveBeenCalledTimes(MAX_SOCKET_AUTH_RENEWALS);
    expect(socket.connects).toBe(MAX_SOCKET_AUTH_RENEWALS);
  });

  it("starts a fresh budget after every successful connection", async () => {
    const { socket, last } = open();

    for (let round = 0; round < MAX_SOCKET_AUTH_RENEWALS + 2; round += 1) {
      refuse(socket);
      await settle();
      socket.trigger("connect");
    }

    expect(last()).toBe("live");
    expect(refresh).toHaveBeenCalledTimes(MAX_SOCKET_AUTH_RENEWALS + 2);
  });
});

describe("VO-2.1 — what is not renewed", () => {
  it("does not retry a throttled handshake on its own", async () => {
    const { socket, last } = open();

    refuse(socket, "SOCKET_AUTH_THROTTLED");
    await settle();

    expect(last()).toBe("offline");
    expect(refresh).not.toHaveBeenCalled();
    expect(socket.connects).toBe(0);
  });

  it("leaves a transport failure to socket.io's own reconnection", async () => {
    const { socket, last } = open();
    socket.trigger("connect");

    socket.connected = false;
    socket.active = true;
    socket.trigger("disconnect", "transport close");
    expect(last()).toBe("reconnecting");

    socket.trigger("connect_error", new Error("websocket error"));
    expect(last()).toBe("reconnecting");

    socket.active = false;
    socket.trigger("connect_error", new Error("websocket error"));
    expect(last()).toBe("offline");

    await settle();
    expect(refresh).not.toHaveBeenCalled();
    expect(socket.connects).toBe(0);
  });
});

describe("VO-2.1 — reconnect()", () => {
  it("connects a stream that stopped", () => {
    const { handle, socket, last } = open();
    socket.active = false;

    handle!.reconnect();

    expect(socket.connects).toBe(1);
    expect(last()).toBe("reconnecting");
  });

  it("does nothing while connected or while socket.io is already trying", () => {
    const { handle, socket } = open();

    socket.trigger("connect");
    handle!.reconnect();
    socket.connected = false;
    socket.active = true;
    handle!.reconnect();

    expect(socket.connects).toBe(0);
  });

  it("refreshes first when no token is held", async () => {
    const { handle, socket } = open();
    socket.active = false;
    api.setAccessToken(null);

    handle!.reconnect();
    await settle();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(socket.connects).toBe(1);
  });

  it("brings back a stream that gave up, with a fresh budget", async () => {
    const { handle, socket, last } = open();
    for (let i = 0; i <= MAX_SOCKET_AUTH_RENEWALS; i += 1) {
      refuse(socket);
      await settle();
    }
    expect(last()).toBe("offline");
    const connectsBefore = socket.connects;

    handle!.reconnect();
    expect(socket.connects).toBe(connectsBefore + 1);

    refuse(socket);
    await settle();
    expect(refresh).toHaveBeenCalledTimes(MAX_SOCKET_AUTH_RENEWALS + 1);
    expect(socket.connects).toBe(connectsBefore + 2);
  });
});

describe("VO-2.1 — close()", () => {
  it("lets the caller unsubscribe first, then removes every listener and disconnects", () => {
    const { handle, socket } = open();
    socket.trigger("connect");

    handle!.close((connected) => connected.emit("office:unsubscribe"));

    expect(socket.emitted).toContainEqual({ event: "office:unsubscribe", payload: undefined });
    expect(socket.disconnected).toBe(true);
  });

  it("does not run the unsubscribe on a socket that is not connected", () => {
    const { handle, socket } = open();
    const beforeClose = vi.fn();

    handle!.close(beforeClose);

    expect(beforeClose).not.toHaveBeenCalled();
    expect(socket.disconnected).toBe(true);
  });

  it("never connects or reports after close, even when a refresh lands later", async () => {
    const { handle, socket, statuses } = open();
    refuse(socket);
    const reported = statuses.length;

    handle!.close();
    await settle();
    handle!.reconnect();

    expect(socket.connects).toBe(0);
    expect(statuses).toHaveLength(reported);
  });
});
