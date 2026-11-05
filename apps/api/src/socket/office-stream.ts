// ---------------------------------------------------------------------------
// VO-2 — the Virtual Office's live stream over the existing socket.
//
// There is no second server, no second token check and no second room model.
// `secureSocketServer` has already authenticated the handshake and placed the
// socket in `userRoom(auth.userId)`; this file adds two read-only events
// (`office:subscribe`, `office:unsubscribe`) and forwards already-projected
// office events to the sockets that asked for them.
//
// WHY EMIT TO SOCKET IDS RATHER THAN THE ROOM.
//
// The room is the transport's guarantee that a user's socket cannot receive
// another user's payload. Subscription is a second, narrower fact: one tab may
// have opted out while another has not. Emitting to each subscribed socket id
// after re-checking that subscription's `userId` is the smallest audience that
// satisfies both. The room is still what the connection joined, and the check
// means a mismatched entry is skipped rather than trusted.
//
// AN EVENT CARRIES NO `userId`. It cannot name a recipient, so the only thing
// deciding an audience is the map below, populated from the server-resolved
// identity on subscribe.
// ---------------------------------------------------------------------------

import type { Server, Socket } from "socket.io";
import {
  OFFICE_STREAM_EVENT,
  OFFICE_SUBSCRIBE_EVENT,
  OFFICE_UNSUBSCRIBE_EVENT,
  type OfficeStreamEvent,
} from "@jarvis/core";

import type { OfficeEventBus } from "../services/office-events.js";
import { socketAuth } from "./socket-auth.js";

interface Subscription {
  socketId: string;
  userId: string;
  since: number;
}

export interface OfficeStreamHandle {
  stop: () => void;
  /** Exposed for tests and diagnostics. */
  subscriberCount: () => number;
}

/**
 * Installs the office stream on an already-authenticated server.
 *
 * Called after `secureSocketServer`, exactly like `installSystemStream`, so the
 * auth middleware and the default-deny event policy both run first.
 */
export function installOfficeStream(io: Server, bus: OfficeEventBus): OfficeStreamHandle {
  const subscriptions = new Map<string, Subscription>();

  function subscribersFor(userId: string): Subscription[] {
    const matching: Subscription[] = [];
    for (const subscription of subscriptions.values()) {
      if (subscription.userId === userId) matching.push(subscription);
    }
    return matching;
  }

  const unsubscribeBus = bus.subscribe((userId, event: OfficeStreamEvent) => {
    const subscribers = subscribersFor(userId);
    if (subscribers.length === 0) return;

    for (const subscriber of subscribers) {
      // Re-check, rather than trusting that the map key and the identity are
      // the same fact. They are today; this is what keeps a later edit to the
      // map from turning into a delivery to the wrong office.
      if (subscriber.userId !== userId) continue;
      io.to(subscriber.socketId).emit(OFFICE_STREAM_EVENT, event);
    }
  });

  io.on("connection", (socket: Socket) => {
    const auth = socketAuth(socket);
    // The auth middleware already rejects an unauthenticated socket. This is
    // the same defence in depth `system-stream.ts` uses for a future namespace
    // that forgets to install it.
    if (!auth) return;

    socket.on(OFFICE_SUBSCRIBE_EVENT, () => {
      subscriptions.set(socket.id, {
        socketId: socket.id,
        userId: auth.userId,
        since: Date.now(),
      });
    });

    socket.on(OFFICE_UNSUBSCRIBE_EVENT, () => {
      subscriptions.delete(socket.id);
    });

    socket.on("disconnect", () => {
      subscriptions.delete(socket.id);
    });
  });

  return {
    stop: () => {
      unsubscribeBus();
      subscriptions.clear();
    },
    subscriberCount: () => subscriptions.size,
  };
}
