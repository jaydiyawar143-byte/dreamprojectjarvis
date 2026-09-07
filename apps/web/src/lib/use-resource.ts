"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ApiResponse } from "./api";

// ---------------------------------------------------------------------------
// UI V2 — the one data-fetching hook.
//
// Every page in this app repeated the same twelve lines: three useStates, a
// useCallback loader, and a useEffect. That is fine once and a liability eight
// times — it is where a forgotten `setLoading(false)` or a missing error branch
// hides.
//
// Three things it does that the hand-rolled version did not:
//
//   1. IGNORES A STALE RESPONSE. A reload fired while an earlier request is in
//      flight must not have the slower answer overwrite the newer one. Each run
//      carries a sequence number and only the newest may commit.
//
//   2. DOES NOT SET STATE AFTER UNMOUNT. Navigating away mid-request otherwise
//      warns in development and, worse, resurrects state on a fast back.
//
//   3. DISTINGUISHES "not asked yet" FROM "asked and got nothing". `loaded` is
//      what an empty state should key off; `data === null` alone cannot tell
//      the two apart, which is how a page flashes "No documents" before its
//      first request has even returned.
//
// It deliberately does NOT cache, dedupe across components, or revalidate. This
// app has no query library and adding one is not in scope; when it gets one,
// this hook is the single seam to replace.
// ---------------------------------------------------------------------------

export interface ResourceState<T> {
  data: T | null;
  loading: boolean;
  /** True once a request has completed, successfully or not. */
  loaded: boolean;
  error: string | null;
  /**
   * The API's error CODE, not just its message.
   *
   * Needed because some codes are not failures at all: an integration whose
   * router is unmounted answers `NOT_FOUND`, which the UI must render as "not
   * deployed" rather than as something being broken. Matching on the message
   * string would be a guess; the code is the contract.
   */
  errorCode: string | null;
  reload: () => Promise<void>;
  /** Local override, for a page that mutates a list it already holds. */
  setData: (next: T | null) => void;
}

export interface ResourceOptions {
  /** Skip fetching entirely — e.g. a panel behind a feature gate. */
  enabled?: boolean;
  /** Shown when the API returns no message of its own. */
  fallbackError?: string;
}

export function useResource<T>(
  load: () => Promise<ApiResponse<T>>,
  deps: unknown[] = [],
  options: ResourceOptions = {}
): ResourceState<T> {
  const { enabled = true, fallbackError = "Could not load this right now." } = options;

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const mounted = useRef(true);
  const sequence = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // `load` is almost always an inline arrow, so it is a new function every
  // render. Keying off caller-supplied `deps` instead is what stops an infinite
  // fetch loop.
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(async () => {
    if (!enabled) return;

    const run = ++sequence.current;
    setLoading(true);
    setError(null);
    setErrorCode(null);

    const response = await loadRef.current();

    // A newer request started while this one was in flight: its answer wins.
    if (!mounted.current || run !== sequence.current) return;

    if (response.success && response.data !== undefined) {
      setData(response.data);
    } else {
      setError(response.error?.message ?? fallbackError);
      setErrorCode(response.error?.code ?? null);
    }
    setLoading(false);
    setLoaded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, fallbackError, ...deps]);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    void reload();
  }, [enabled, reload]);

  return { data, loading, loaded, error, errorCode, reload, setData };
}
