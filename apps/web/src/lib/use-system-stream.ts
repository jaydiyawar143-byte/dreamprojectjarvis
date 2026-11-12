"use client";

// ---------------------------------------------------------------------------
// V3 — the system metrics stream.
//
// Reuses the app's existing authenticated Socket.IO connection rather than
// opening a second transport, and subscribes only while a component is actually
// mounted — so no metrics are collected for a dashboard nobody is looking at.
//
// HISTORY LIVES IN A REF, not in state. At 1Hz over five minutes that is 300
// samples; keeping it in state would re-render the whole widget tree every
// second. The component re-renders on a throttled tick instead, and the graph
// reads the ref.
//
// VO-2.1 (D1) — the socket is opened by `openAuthenticatedSocket`, the same
// helper the Virtual Office uses. This hook used to read the access token once,
// so after fifteen minutes any reconnect presented an expired token, the server
// refused it and the metrics stopped until a reload. The helper reads the token
// for every attempt and renews it when the server refuses it or ends the
// session. While it is connecting again the status is "connecting": this
// widget's vocabulary has no separate "reconnecting".
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import type { SystemSnapshot } from "./api";
import { openAuthenticatedSocket, type AuthenticatedSocketStatus } from "./authenticated-socket";

/** 5 minutes at 1Hz — the longest range the UI offers. */
const MAX_SAMPLES = 300;

/** Re-render at this rate regardless of sample rate, to bound the cost. */
const RENDER_INTERVAL_MS = 1000;

export interface MetricHistory {
  cpu: number[];
  memory: number[];
  /** Bytes per second; scaled by the chart, not here. */
  netRx: number[];
  netTx: number[];
}

export type StreamStatus = "connecting" | "live" | "offline" | "unauthenticated";

/** The helper's states in this widget's vocabulary. */
function toStreamStatus(status: AuthenticatedSocketStatus): StreamStatus {
  return status === "reconnecting" ? "connecting" : status;
}

export function useSystemStream(enabled = true): {
  snapshot: SystemSnapshot | null;
  history: MetricHistory;
  status: StreamStatus;
} {
  const [snapshot, setSnapshot] = useState<SystemSnapshot | null>(null);
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [, forceRender] = useState(0);

  const historyRef = useRef<MetricHistory>({ cpu: [], memory: [], netRx: [], netTx: [] });
  const latestRef = useRef<SystemSnapshot | null>(null);
  const socketRef = useRef<Socket | null>(null);

  const push = useCallback((series: number[], value: number) => {
    series.push(value);
    // Bounded from the front, so memory cannot grow while a tab stays open.
    if (series.length > MAX_SAMPLES) series.splice(0, series.length - MAX_SAMPLES);
  }, []);

  useEffect(() => {
    if (!enabled) return;

    // Reports "unauthenticated" and returns null when there is no token to
    // connect with: retrying without one would only fail repeatedly.
    const handle = openAuthenticatedSocket({
      reconnectionAttempts: 5,
      reconnectionDelay: 2000,
      onStatus: (next) => setStatus(toStreamStatus(next)),
      // Every connection subscribes, including one renewed after the server
      // ended the session: a new connection has no subscription of its own.
      onConnect: (connected) => {
        connected.emit("system:subscribe");
      },
    });
    if (!handle) return;
    const { socket } = handle;
    socketRef.current = socket;

    socket.on("system:metrics", (payload: SystemSnapshot) => {
      latestRef.current = payload;

      // Only real measurements enter the history. A null CPU reading (the
      // first sample, before a baseline exists) must not be charted as 0 — the
      // graph would show a dip that never happened.
      if (payload.cpu.loadPct.value !== null) push(historyRef.current.cpu, payload.cpu.loadPct.value);
      push(historyRef.current.memory, payload.memory.usedPct);
      if (payload.network.value) {
        push(historyRef.current.netRx, payload.network.value.rxBytesPerSec);
        push(historyRef.current.netTx, payload.network.value.txBytesPerSec);
      }
    });

    // One throttled re-render, rather than one per message.
    const ticker = setInterval(() => {
      setSnapshot(latestRef.current);
      forceRender((n) => n + 1);
    }, RENDER_INTERVAL_MS);

    return () => {
      clearInterval(ticker);
      // Tell the server to stop collecting before dropping the socket, so the
      // interval on that side ends immediately rather than on disconnect.
      handle.close((connected) => connected.emit("system:unsubscribe"));
      socketRef.current = null;
    };
  }, [enabled, push]);

  return { snapshot, history: historyRef.current, status };
}
