"use client";

// ---------------------------------------------------------------------------
// Debounced place suggestions.
//
// Autocomplete is billed per request, so the naive version — fire on every
// keystroke — turns "restaurants near me" into thirteen paid calls and a
// results list that flickers between four different answers. Three rules fix
// that, and all three live here rather than in each caller:
//
//   1. DEBOUNCE. Nothing is requested until typing pauses for 300ms.
//
//   2. CANCEL THE STALE ONE. Every new request aborts the previous one, and a
//      response is dropped unless its own request is still the current one.
//      Without the second check a slow "Gond" can still land after a fast
//      "Gondia" and replace the right list with the wrong one.
//
//   3. DON'T ASK TWICE. Selecting a suggestion writes its text back into the
//      input, which is a change like any other and would immediately fetch the
//      same list again. `skip(value)` suppresses exactly that one round trip.
//
// Below two characters nothing is requested at all — the server rejects those
// anyway, and asking is a round trip that can only fail.
//
// The location bias is read from a ref rather than from the dependency list.
// While live tracking is on the position updates every few seconds, and making
// it a dependency would re-fire autocomplete on each update and defeat the
// debounce. A bias only has to be roughly right.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react";
import { autocompletePlaces, type PlaceSuggestion } from "./api";

const DEBOUNCE_MS = 300;
const MIN_CHARS = 2;

export interface PlaceSuggestionsState {
  suggestions: PlaceSuggestion[];
  loading: boolean;
  /** Why there are no suggestions, when the provider said. Never a fabrication. */
  reason: string | null;
  /** Record the value about to be written into the input, so it is not re-queried. */
  skip: (value: string) => void;
  /** Drops the current list, e.g. on blur or after selection. */
  clear: () => void;
}

export function usePlaceSuggestions(
  query: string,
  near?: { latitude: number; longitude: number } | null,
  enabled = true
): PlaceSuggestionsState {
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [reason, setReason] = useState<string | null>(null);

  const controllerRef = useRef<AbortController | null>(null);
  /** The one query value whose fetch is suppressed. Consumed on first match. */
  const skipRef = useRef<string | null>(null);

  const nearRef = useRef(near);
  nearRef.current = near;

  const skip = useCallback((value: string) => {
    skipRef.current = value.trim();
  }, []);

  const clear = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setSuggestions([]);
    setLoading(false);
    setReason(null);
  }, []);

  useEffect(() => {
    const trimmed = query.trim();

    if (!enabled || trimmed.length < MIN_CHARS) {
      setSuggestions([]);
      setReason(null);
      setLoading(false);
      return;
    }

    // The value a selection just wrote back — do not re-query it. Consumed
    // here so retyping the same text by hand still gets suggestions.
    if (skipRef.current === trimmed) {
      skipRef.current = null;
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      setLoading(true);
      void autocompletePlaces(trimmed, nearRef.current ?? undefined, controller.signal)
        .then((res) => {
          // Two guards, not one: `cancelled` covers unmount and a newer effect
          // run, and `aborted` covers a request superseded while in flight.
          if (cancelled || controller.signal.aborted) return;

          if (res.success && res.data?.value) {
            setSuggestions(res.data.value);
            setReason(null);
          } else {
            setSuggestions([]);
            setReason(res.data?.meta.reason ?? res.error?.message ?? null);
          }
        })
        .catch(() => {
          // An aborted fetch is the normal path here, not a failure worth
          // showing. A real network error leaves the list empty and silent —
          // the user is still typing, and a red banner mid-word helps nobody.
          if (!cancelled && !controller.signal.aborted) setSuggestions([]);
        })
        .finally(() => {
          if (!cancelled && !controller.signal.aborted) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, enabled]);

  // Abort whatever is in flight when the consumer goes away.
  useEffect(() => () => controllerRef.current?.abort(), []);

  return { suggestions, loading, reason, skip, clear };
}
