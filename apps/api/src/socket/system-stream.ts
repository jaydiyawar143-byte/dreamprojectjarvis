// ---------------------------------------------------------------------------
// V3 — realtime system metrics over the existing authenticated Socket.IO server.
//
// Reuses the socket that is already there, already authenticated, and already
// scoped to a per-user room. A second transport would need its own auth, and
// that is exactly how a second, weaker auth path gets built by accident.
//
// TWO INTERVALS, matching the measured cost of each metric (see
// system-monitor.ts): the fast tier reads OS counters in microseconds and emits
// every second; the slow tier shells out to WMI and takes ~3.4s, so it refreshes
// every 15 and is merged into whatever the fast tier emits next.
//
// ONE TIMER PER PROCESS, not per socket. Ten open tabs would otherwise mean ten
// interval loops all reading the same counters. The subscriber set decides
// whether the timer runs at all, so an idle deployment does no work.
//
// Emission is to the SUBSCRIBER'S OWN ROOM. Host metrics are the same for every
// user of this instance, but routing through the per-user room keeps the "no
// broadcast to everyone" property that the socket layer was built around, so a
// later user-specific payload cannot leak by inheriting a global emit.
// ---------------------------------------------------------------------------

import type { Server, Socket } from "socket.io";
import { refreshSlow, snapshot } from "../services/providers/system-monitor.js";
import { socketAuth, userRoom } from "./socket-auth.js";

/** Fast enough to feel live, slow enough to stay cheap. */
const FAST_INTERVAL_MS = 1000;
/** The WMI tier costs ~3.4s per pass, so it must not run anywhere near 1Hz. */
const SLOW_INTERVAL_MS = 15_000;

/** Stops a forgotten dashboard streaming forever in a background tab. */
const MAX_STREAM_MS = 30 * 60 * 1000;

interface Subscriber {
  socketId: string;
  userId: string;
  since: number;
}

export interface SystemStreamHandle {
  stop: () => void;
  /** Exposed for tests and diagnostics. */
  subscriberCount: () => number;
}

export function installSystemStream(io: Server): SystemStreamHandle {
  const subscribers = new Map<string, Subscriber>();

  let fastTimer: NodeJS.Timeout | null = null;
  let slowTimer: NodeJS.Timeout | null = null;
  /** Discards the first CPU sample, which has no baseline to diff against. */
  let primed = false;

  function emit(): void {
    if (subscribers.size === 0) return;

    // The first tick after starting would report a fabricated 0% CPU, because
    // load is a delta between two samples and there is only one so far.
    if (!primed) {
      snapshot();
      primed = true;
      return;
    }

    const payload = snapshot();
    const rooms = new Set<string>();
    for (const sub of subscribers.values()) rooms.add(userRoom(sub.userId));
    for (const room of rooms) io.to(room).emit("system:metrics", payload);
  }

  function start(): void {
    if (fastTimer) return;
    primed = false;
    void refreshSlow();
    fastTimer = setInterval(emit, FAST_INTERVAL_MS);
    slowTimer = setInterval(() => void refreshSlow(), SLOW_INTERVAL_MS);
    // Timers must not hold the process open during shutdown.
    fastTimer.unref?.();
    slowTimer.unref?.();
  }

  function stopTimers(): void {
    if (fastTimer) clearInterval(fastTimer);
    if (slowTimer) clearInterval(slowTimer);
    fastTimer = null;
    slowTimer = null;
  }

  function removeSubscriber(socketId: string): void {
    subscribers.delete(socketId);
    // No listeners, no work.
    if (subscribers.size === 0) stopTimers();
  }

  // Expiry sweep: a socket that stayed subscribed for half an hour is a tab
  // somebody forgot, not a person watching a graph.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [socketId, sub] of subscribers) {
      if (now - sub.since > MAX_STREAM_MS) {
        io.sockets.sockets.get(socketId)?.emit("system:stopped", { reason: "idle-timeout" });
        removeSubscriber(socketId);
      }
    }
  }, 60_000);
  sweeper.unref?.();

  io.on("connection", (socket: Socket) => {
    const auth = socketAuth(socket);
    // The auth middleware already rejects unauthenticated sockets; this is
    // defence in depth for a future namespace that forgets to install it.
    if (!auth) return;

    socket.on("system:subscribe", () => {
      subscribers.set(socket.id, { socketId: socket.id, userId: auth.userId, since: Date.now() });
      start();
      // An immediate frame so the widget is not blank for a second. It carries
      // whatever the slow tier already knows, which on a cold start is nulls
      // with reasons — never zeros.
      socket.emit("system:metrics", snapshot());
    });

    socket.on("system:unsubscribe", () => removeSubscriber(socket.id));
    socket.on("disconnect", () => removeSubscriber(socket.id));
  });

  return {
    stop: () => {
      clearInterval(sweeper);
      stopTimers();
      subscribers.clear();
    },
    subscriberCount: () => subscribers.size,
  };
}
