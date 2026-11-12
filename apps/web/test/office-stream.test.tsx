// ---------------------------------------------------------------------------
// VO-2 — the office stream hook.
//
// What is pinned here:
//
//   * it subscribes only after the socket is connected, and unsubscribes before
//     dropping it;
//   * every payload is parsed through the allowlist and a duplicate id is
//     dropped;
//   * a burst is flushed on a timer rather than once per message;
//   * the status tells the truth about connecting, live, reconnecting and
//     offline, and a reconnect asks the page to re-read durable state;
//   * an unmount removes the listeners and disconnects.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const socketHarness = vi.hoisted(() => ({ sockets: [] as any[] }));

vi.mock("socket.io-client", () => ({
  io: vi.fn((_url: string, options: any) => {
    const handlers = new Map<string, Function[]>();
    // Like the real client, every connection attempt asks the `auth` callback
    // for its credential: once on creation, once per `connect()`.
    const attempt = () => options?.auth?.(() => undefined);
    const socket: any = {
      connected: false,
      active: true,
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
      // VO-2.1 — what the authenticated socket calls to connect again after it
      // renewed the token.
      connects: 0,
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
    socketHarness.sockets.push(socket);
    attempt();
    return socket;
  }),
}));

// VO-2.1 — the shared refresh is the only thing stubbed in the API client.
vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return { ...actual, refreshAccessToken: vi.fn() };
});

import { refreshAccessToken, setAccessToken } from "../src/lib/api";
import {
  OFFICE_STREAM_FLUSH_MS,
  useOfficeStream,
} from "../src/lib/use-office-stream";
import { OFFICE_STREAM_EVENT, OFFICE_SUBSCRIBE_EVENT, OFFICE_UNSUBSCRIBE_EVENT } from "@jarvis/core/office-stream";

const lastSocket = () => socketHarness.sockets[socketHarness.sockets.length - 1];

const activity = (over: Record<string, unknown> = {}) => ({
  kind: "activity",
  id: "live-1",
  at: "2026-11-05T12:00:00.000Z",
  action: "tool.execute",
  result: "success",
  ...over,
});

beforeEach(() => {
  socketHarness.sockets.length = 0;
  setAccessToken("test-token");
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  setAccessToken(null);
  vi.clearAllMocks();
});

describe("VO-2 — office stream hook", () => {
  it("subscribes after connecting and reports live", () => {
    const { result } = renderHook(() => useOfficeStream());
    const socket = lastSocket();

    expect(result.current.status).toBe("connecting");

    act(() => {
      socket.trigger("connect");
    });

    expect(result.current.status).toBe("live");
    expect(socket.emitted).toContainEqual({ event: OFFICE_SUBSCRIBE_EVENT, payload: undefined });
  });

  it("does not open a socket without an access token", () => {
    setAccessToken(null);

    const { result } = renderHook(() => useOfficeStream());

    expect(result.current.status).toBe("unauthenticated");
    expect(socketHarness.sockets).toHaveLength(0);
  });

  it("accepts one copy of an event and ignores duplicates", () => {
    const { result } = renderHook(() => useOfficeStream());
    const socket = lastSocket();
    act(() => socket.trigger("connect"));

    act(() => {
      socket.trigger(OFFICE_STREAM_EVENT, activity());
      socket.trigger(OFFICE_STREAM_EVENT, activity());
      vi.advanceTimersByTime(OFFICE_STREAM_FLUSH_MS);
    });

    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0]).toMatchObject({ id: "live-1" });
  });

  it("batches a burst into one state update", () => {
    const { result } = renderHook(() => useOfficeStream());
    const socket = lastSocket();
    act(() => socket.trigger("connect"));

    act(() => {
      for (let i = 0; i < 5; i += 1) {
        socket.trigger(OFFICE_STREAM_EVENT, activity({ id: `live-${i}` }));
      }
      // Not yet flushed.
      expect(result.current.events).toHaveLength(0);
      vi.advanceTimersByTime(OFFICE_STREAM_FLUSH_MS);
    });

    expect(result.current.events).toHaveLength(5);
  });

  it("ignores an unknown or malformed payload", () => {
    const { result } = renderHook(() => useOfficeStream());
    const socket = lastSocket();
    act(() => socket.trigger("connect"));

    act(() => {
      socket.trigger(OFFICE_STREAM_EVENT, { kind: "activity", id: "missing-fields" });
      socket.trigger(OFFICE_STREAM_EVENT, { kind: "unknown" });
      socket.trigger(OFFICE_STREAM_EVENT, null);
      vi.advanceTimersByTime(OFFICE_STREAM_FLUSH_MS);
    });

    expect(result.current.events).toHaveLength(0);
  });

  it("keeps only the newest transition per task and advances the revision", () => {
    const { result } = renderHook(() => useOfficeStream());
    const socket = lastSocket();
    act(() => socket.trigger("connect"));

    const taskEvent = (id: string, status: string, at: string) => ({
      kind: "task",
      id,
      at,
      taskId: "task-1",
      status,
    });

    act(() => {
      socket.trigger(
        OFFICE_STREAM_EVENT,
        taskEvent("task:task-1:RUNNING:a", "RUNNING", "2026-11-05T12:00:00.000Z")
      );
      socket.trigger(
        OFFICE_STREAM_EVENT,
        taskEvent("task:task-1:COMPLETED:b", "COMPLETED", "2026-11-05T12:01:00.000Z")
      );
      vi.advanceTimersByTime(OFFICE_STREAM_FLUSH_MS);
    });

    expect(result.current.taskUpdates.get("task-1")?.status).toBe("COMPLETED");
    expect(result.current.taskRevision).toBe(2);
    expect(result.current.events).toHaveLength(2);
  });

  it("reports reconnecting while retrying and offline once stopped", () => {
    const { result } = renderHook(() => useOfficeStream());
    const socket = lastSocket();
    act(() => socket.trigger("connect"));

    act(() => {
      socket.active = true;
      socket.trigger("disconnect");
    });
    expect(result.current.status).toBe("reconnecting");

    act(() => {
      socket.active = false;
      socket.trigger("connect_error");
    });
    expect(result.current.status).toBe("offline");
  });

  it("asks the page to re-read on a reconnect, not on the first connect", () => {
    const onReconnect = vi.fn();
    renderHook(() => useOfficeStream({ onReconnect }));
    const socket = lastSocket();

    act(() => socket.trigger("connect"));
    expect(onReconnect).not.toHaveBeenCalled();

    act(() => socket.trigger("connect"));
    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(socket.emitted.filter((entry) => entry.event === OFFICE_SUBSCRIBE_EVENT)).toHaveLength(2);
  });

  it("unsubscribes, removes listeners and disconnects on unmount", () => {
    const { unmount } = renderHook(() => useOfficeStream());
    const socket = lastSocket();
    act(() => socket.trigger("connect"));

    unmount();

    expect(socket.emitted).toContainEqual({ event: OFFICE_UNSUBSCRIBE_EVENT, payload: undefined });
    expect(socket.connected).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// VO-2.1 (H1) — an ended or refused session is renewed, and the page told
// ---------------------------------------------------------------------------

describe("VO-2.1 — office stream renewal", () => {
  /** Lets the refresh promise and its continuation settle under fake timers. */
  const settle = () =>
    act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

  it("renews a session the server ended, subscribes again and asks the page to re-read", async () => {
    vi.mocked(refreshAccessToken).mockImplementation(async () => {
      setAccessToken("fresh-token");
      return true;
    });
    const onReconnect = vi.fn();
    const { result } = renderHook(() => useOfficeStream({ onReconnect }));
    const socket = lastSocket();
    act(() => socket.trigger("connect"));

    act(() => {
      socket.connected = false;
      socket.active = false;
      socket.trigger("disconnect", "io server disconnect");
    });
    expect(result.current.status).toBe("reconnecting");

    await settle();
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(socket.connects).toBe(1);

    act(() => socket.trigger("connect"));
    expect(result.current.status).toBe("live");
    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(socket.emitted.filter((entry: { event: string }) => entry.event === OFFICE_SUBSCRIBE_EVENT)).toHaveLength(2);
  });

  it("says not signed in when the refused session cannot be refreshed", async () => {
    vi.mocked(refreshAccessToken).mockResolvedValue(false);
    const { result } = renderHook(() => useOfficeStream());
    const socket = lastSocket();

    act(() => {
      socket.active = false;
      socket.trigger("connect_error", { message: "refused", data: { code: "SOCKET_AUTH_INVALID" } });
    });
    await settle();

    expect(result.current.status).toBe("unauthenticated");
    expect(socket.connects).toBe(0);
  });

  it("exposes reconnect(), which brings back a stream that stopped", () => {
    const { result } = renderHook(() => useOfficeStream());
    const socket = lastSocket();
    act(() => {
      socket.active = false;
      socket.trigger("connect_error");
    });
    expect(result.current.status).toBe("offline");

    act(() => result.current.reconnect());

    expect(socket.connects).toBe(1);
    expect(result.current.status).toBe("reconnecting");
  });
});
