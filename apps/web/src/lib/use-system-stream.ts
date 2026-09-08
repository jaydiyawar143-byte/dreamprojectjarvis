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
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { getAccessToken, type SystemSnapshot } from "./api";

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

const SOCKET_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api/v1").replace(
  /\/api\/v1\/?$/,
  ""
);

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

    const token = getAccessToken();
    if (!token) {
      // The socket authenticates with the access token; without one there is
      // nothing to connect with, and retrying would just fail repeatedly.
      setStatus("unauthenticated");
      return;
    }

    const socket = io(SOCKET_URL, {
      auth: { token },
      transports: ["websocket"],
      reconnectionAttempts: 5,
      reconnectionDelay: 2000,
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      setStatus("live");
      socket.emit("system:subscribe");
    });

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

    socket.on("disconnect", () => setStatus("offline"));
    socket.on("connect_error", () => setStatus("offline"));

    // One throttled re-render, rather than one per message.
    const ticker = setInterval(() => {
      setSnapshot(latestRef.current);
      forceRender((n) => n + 1);
    }, RENDER_INTERVAL_MS);

    return () => {
      clearInterval(ticker);
      // Tell the server to stop collecting before dropping the socket, so the
      // interval on that side ends immediately rather than on disconnect.
      if (socket.connected) socket.emit("system:unsubscribe");
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [enabled, push]);

  return { snapshot, history: historyRef.current, status };
}
