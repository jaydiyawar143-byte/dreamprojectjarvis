"use client";

// ---------------------------------------------------------------------------
// VO-2 — the Virtual Office's live stream.
//
// It reuses the app's authenticated Socket.IO connection pattern (the same one
// `use-system-stream` uses), subscribes only while the office page is mounted,
// and hands the page a small, already-validated set of events.
//
// THREE THINGS THIS HOOK REFUSES TO DO:
//
//   1. TRUST THE WIRE. Every payload goes through core's
//      `parseOfficeStreamEvent`, which rebuilds it from an allowlist. An
//      unknown field is dropped, a malformed event is ignored.
//   2. SHOW A DUPLICATE. The socket may deliver the same durable transition
//      twice (a reconnect, a re-emit); events are keyed by their id and the
//      second copy is dropped.
//   3. CLAIM LIVE WHEN IT IS NOT. The status is `live` only while the socket
//      reports connected. A drop is `reconnecting` while the client is still
//      retrying and `offline` when it has stopped; either way the page says so
//      rather than presenting the last readings as current.
//
// UI updates are flushed on a 500ms tick rather than per message, so a burst of
// audit rows cannot re-render the floor plan once per row.
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import {
  OFFICE_STREAM_EVENT,
  OFFICE_SUBSCRIBE_EVENT,
  OFFICE_UNSUBSCRIBE_EVENT,
  parseOfficeStreamEvent,
  type OfficeStreamEvent,
  type OfficeTaskEvent,
} from "@jarvis/core/office-stream";

import { getAccessToken } from "./api";
import { SOCKET_URL } from "./socket-url";

export type OfficeStreamStatus =
  | "connecting"
  | "live"
  | "reconnecting"
  | "offline"
  | "unauthenticated";

/** Bound on the events the page is given, and on the ids remembered. */
const MAX_EVENTS = 200;
const MAX_SEEN_IDS = 500;

/** Batch window for state updates. */
export const OFFICE_STREAM_FLUSH_MS = 500;

export interface OfficeStreamState {
  status: OfficeStreamStatus;
  /** Newest first. Both activity and task events. */
  events: OfficeStreamEvent[];
  /** The newest lifecycle event seen for each task. */
  taskUpdates: ReadonlyMap<string, OfficeTaskEvent>;
  /**
   * Increments for each new task event. A page uses it to reload the task list
   * (which is where titles live) without reloading on every activity row.
   */
  taskRevision: number;
}

export interface UseOfficeStreamOptions {
  enabled?: boolean;
  /** Called after a successful reconnect, so the page can re-read durable state. */
  onReconnect?: () => void;
}

export function useOfficeStream(options: UseOfficeStreamOptions = {}): OfficeStreamState {
  const { enabled = true } = options;

  const [status, setStatus] = useState<OfficeStreamStatus>("connecting");
  const [state, setState] = useState<Omit<OfficeStreamState, "status">>(() => ({
    events: [],
    taskUpdates: new Map(),
    taskRevision: 0,
  }));

  // Accumulators live in refs so a message never triggers a render by itself.
  const eventsRef = useRef<OfficeStreamEvent[]>([]);
  const taskMapRef = useRef<Map<string, OfficeTaskEvent>>(new Map());
  const seenRef = useRef<Set<string>>(new Set());
  const revisionRef = useRef(0);
  const dirtyRef = useRef(false);

  // The page may pass a new arrow on every render; only the newest is used.
  const onReconnectRef = useRef(options.onReconnect);
  onReconnectRef.current = options.onReconnect;

  useEffect(() => {
    if (!enabled) return;

    const token = getAccessToken();
    if (!token) {
      // The socket authenticates with the access token. Without one there is
      // nothing to connect with, and retrying would just fail repeatedly.
      setStatus("unauthenticated");
      return;
    }

    const socket = io(SOCKET_URL, {
      auth: { token },
      transports: ["websocket"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    let connectedOnce = false;

    socket.on("connect", () => {
      setStatus("live");
      socket.emit(OFFICE_SUBSCRIBE_EVENT);
      // A reconnect means events may have been missed while the socket was
      // down. The page re-reads the durable rows; nothing is replayed here.
      if (connectedOnce) onReconnectRef.current?.();
      connectedOnce = true;
    });

    socket.on("disconnect", () => {
      // `active` is true while the client intends to reconnect.
      setStatus(socket.active ? "reconnecting" : "offline");
    });

    socket.on("connect_error", () => {
      setStatus(socket.active ? "reconnecting" : "offline");
    });

    socket.on(OFFICE_STREAM_EVENT, (payload: unknown) => {
      const event = parseOfficeStreamEvent(payload);
      if (!event) return;

      if (seenRef.current.has(event.id)) return;
      seenRef.current.add(event.id);
      if (seenRef.current.size > MAX_SEEN_IDS) {
        const oldest = seenRef.current.values().next().value;
        if (oldest !== undefined) seenRef.current.delete(oldest);
      }

      const next = [event, ...eventsRef.current];
      eventsRef.current = next.length > MAX_EVENTS ? next.slice(0, MAX_EVENTS) : next;

      if (event.kind === "task") {
        const existing = taskMapRef.current.get(event.taskId);
        // Only a newer durable transition replaces an older one.
        if (
          !existing ||
          (Date.parse(event.at) || 0) >= (Date.parse(existing.at) || 0)
        ) {
          taskMapRef.current.set(event.taskId, event);
          revisionRef.current += 1;
        }
      }

      dirtyRef.current = true;
    });

    const flush = setInterval(() => {
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      setState({
        events: eventsRef.current.slice(),
        taskUpdates: new Map(taskMapRef.current),
        taskRevision: revisionRef.current,
      });
    }, OFFICE_STREAM_FLUSH_MS);

    return () => {
      clearInterval(flush);
      // Tell the server to stop before dropping the socket, so the subscription
      // ends immediately rather than only on disconnect.
      if (socket.connected) socket.emit(OFFICE_UNSUBSCRIBE_EVENT);
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [enabled]);

  return { status, ...state };
}
