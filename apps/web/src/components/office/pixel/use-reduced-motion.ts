"use client";

// ---------------------------------------------------------------------------
// VO-2.2 Stage 2 — the person's motion preference.
//
// The office's animations are CSS, and the stylesheet already stops them under
// `prefers-reduced-motion`. This hook exists so the scene can also SAY so (a
// `data-motion` attribute a test can read, and a note in the legend), and so
// the preference is followed when it changes while the page is open. The
// listener is removed on unmount.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function currentPreference(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia(REDUCED_MOTION_QUERY).matches;
  } catch {
    return false;
  }
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => currentPreference());

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    let query: MediaQueryList;
    try {
      query = window.matchMedia(REDUCED_MOTION_QUERY);
    } catch {
      return;
    }
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return reduced;
}
