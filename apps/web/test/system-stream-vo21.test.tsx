// ---------------------------------------------------------------------------
// VO-2.1 (D1) — the system metrics stream renews its session too.
//
// `use-system-stream` had the Virtual Office's defect: it read the access token
// once, so after fifteen minutes a reconnect presented an expired token and
// the metrics stopped until a reload. It now opens its socket through the
// shared `openAuthenticatedSocket`. Pinned here:
//
//   - the token is read for every connection attempt;
//   - a session the server ended is renewed and subscribed again;
//   - its status keeps the widget's vocabulary ("connecting", never
//     "reconnecting");
//   - it unsubscribes and disconnects on unmount, as before.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

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

import { refreshAccessToken, setAccessToken } from "../src/lib/api";
import { useSystemStream } from "../src/lib/use-system-stream";

const lastSocket = () => harness.sockets[harness.sockets.length - 1];
const subscribes = (socket: any) =>
  socket.emitted.filter((entry: { event: string }) => entry.event === "system:subscribe").length;

/** Lets the refresh promise and its continuation settle. */
const settle = () =>
  act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

beforeEach(() => {
  harness.sockets.length = 0;
  harness.options.length = 0;
  setAccessToken("token-1");
  vi.mocked(refreshAccessToken).mockReset();
  vi.mocked(refreshAccessToken).mockImplementation(async () => {
    setAccessToken("token-fresh");
    return true;
  });
});

afterEach(() => {
  setAccessToken(null);
});

describe("VO-2.1 — system stream sessions", () => {
  it("reads the access token for every connection attempt", async () => {
    renderHook(() => useSystemStream(true));
    const authOf = () =>
      new Promise<Record<string, unknown>>((resolve) => harness.options[0].auth(resolve));

    expect(await authOf()).toEqual({ token: "token-1" });
    setAccessToken("token-2");
    expect(await authOf()).toEqual({ token: "token-2" });
  });

  it("keeps its own reconnection settings", () => {
    renderHook(() => useSystemStream(true));

    expect(harness.options[0]).toMatchObject({
      transports: ["websocket"],
      reconnectionAttempts: 5,
      reconnectionDelay: 2000,
    });
  });

  it("renews a session the server ended and subscribes again", async () => {
    const { result } = renderHook(() => useSystemStream(true));
    const socket = lastSocket();
    act(() => socket.trigger("connect"));
    expect(result.current.status).toBe("live");
    expect(subscribes(socket)).toBe(1);

    act(() => {
      socket.connected = false;
      socket.active = false;
      socket.trigger("disconnect", "io server disconnect");
    });
    // The widget has no "reconnecting"; renewing reads as connecting again.
    expect(result.current.status).toBe("connecting");

    await settle();
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(socket.connects).toBe(1);

    act(() => socket.trigger("connect"));
    expect(result.current.status).toBe("live");
    expect(subscribes(socket)).toBe(2);
  });

  it("says unauthenticated without a token, and opens nothing", () => {
    setAccessToken(null);

    const { result } = renderHook(() => useSystemStream(true));

    expect(result.current.status).toBe("unauthenticated");
    expect(harness.sockets).toHaveLength(0);
  });

  it("unsubscribes and disconnects on unmount", () => {
    const { unmount } = renderHook(() => useSystemStream(true));
    const socket = lastSocket();
    act(() => socket.trigger("connect"));

    unmount();

    expect(socket.emitted).toContainEqual({ event: "system:unsubscribe", payload: undefined });
    expect(socket.connected).toBe(false);
  });
});
