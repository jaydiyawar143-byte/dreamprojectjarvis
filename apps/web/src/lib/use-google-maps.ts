"use client";

// ---------------------------------------------------------------------------
// V3 — loading the Google Maps JavaScript API.
//
// The key is fetched from an AUTHENTICATED endpoint rather than baked in as a
// NEXT_PUBLIC_* value, so it is not sitting in a static bundle anyone can pull
// without logging in. That is defence in depth; the real control is the HTTP
// referrer restriction on the key itself.
//
// THE SCRIPT TAG IS A SINGLETON. Google's loader attaches `window.google` and
// refuses to be initialised twice — a second <script> logs an error and can
// leave the API in a broken state. So the promise is module-scoped: every
// component that asks gets the same load, and unmounting a map does NOT remove
// the script, because another map may still be using it.
//
// What DOES get cleaned up is everything a component created: markers,
// listeners, the geolocation watch and the map instance itself. See the widget.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { getMapsConfig, type MapsConfig } from "./api";

export type MapsStatus =
  /** Asking the server whether a key exists. */
  | "checking"
  /** No browser key — the map cannot render and the UI must say so. */
  | "unconfigured"
  /** Key present, SDK downloading. */
  | "loading"
  | "ready"
  /** The SDK failed to load: bad key, blocked network, quota. */
  | "error";

declare global {
  interface Window {
    google?: typeof google;
    __jarvisMapsInit?: () => void;
  }
}

/** Shared across every consumer; see the singleton note above. */
let loaderPromise: Promise<void> | null = null;

/**
 * The libraries whose globals the map consumers construct synchronously —
 * `Map` (maps), `Marker` (marker), `Polyline` (geometry).
 */
const REQUIRED_MAP_LIBRARIES = ["maps", "marker", "geometry"] as const;

/**
 * The constructors, not the libraries: "ready" is only meaningful if calling
 * them will not throw. A library can be announced without its constructor
 * being attachable yet, which is the exact gap this polls shut.
 */
const REQUIRED_MAP_CONSTRUCTORS = ["Map", "Marker", "Polyline"] as const;

/** Bound on how long a consumer is prepared to wait for the constructors. */
const CONSTRUCTOR_TIMEOUT_MS = 15_000;
/** Poll cadence. Bounded, not a busy loop. */
const CONSTRUCTOR_POLL_MS = 100;

/** `google.maps.Map`, `Marker` and `Polyline` all callable right now? */
function mapConstructorsAvailable(): boolean {
  const gmaps = window.google?.maps;
  if (!gmaps) return false;
  return REQUIRED_MAP_CONSTRUCTORS.every((name) => typeof gmaps[name] === "function");
}

/**
 * Resolves once every required constructor is actually usable. Falls back to a
 * bounded poll so that readiness never depends on the bootstrap callback
 * having finished attaching `importLibrary` — it can fire before the JSON-runtime
 * libraries are imported, and at that instant an early return would let a
 * consumer call `new google.maps.Map()` into a TypeError.
 */
function waitForMapConstructors(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (mapConstructorsAvailable()) {
      resolve();
      return;
    }
    const started = Date.now();
    const poll = () => {
      if (mapConstructorsAvailable()) {
        window.clearInterval(id);
        resolve();
        return;
      }
      if (Date.now() - started >= CONSTRUCTOR_TIMEOUT_MS) {
        window.clearInterval(id);
        reject(new Error("Google Maps loaded, but Map/Marker/Polyline never became available"));
      }
    };
    const id = window.setInterval(poll, CONSTRUCTOR_POLL_MS);
    poll();
  });
}

async function ensureMapLibraries(): Promise<void> {
  const gmaps = window.google?.maps;
  // Pull in whichever libraries the dynamic loader can load directly. This is
  // the PREFERRED mechanism — but not the gate: at the instant the bootstrap
  // callback fires, `importLibrary` may not be callable yet, so readiness is
  // decided separately by `waitForMapConstructors` below.
  if (gmaps && typeof gmaps.importLibrary === "function") {
    await Promise.all(REQUIRED_MAP_LIBRARIES.map((name) => gmaps.importLibrary(name)));
  }
  await waitForMapConstructors();
}

function loadSdk(browserKey: string): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  // Already loaded — by us, or by a previous mount. The SDK may still be
  // pulling its libraries, so "ready" waits for them rather than trusting the
  // namespace to be complete.
  if (window.google?.maps) return ensureMapLibraries();
  if (loaderPromise) return loaderPromise;

  loaderPromise = new Promise<void>((resolve, reject) => {
    const callback = "__jarvisMapsInit";

    const script = document.createElement("script");
    // `loading=async` is Google's current recommendation and silences the
    // performance warning; `libraries=places` is needed for text search.
    script.src =
      `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(browserKey)}` +
      `&libraries=places&loading=async&callback=${callback}`;
    script.async = true;
    script.defer = true;

    window[callback] = () => {
      delete window.__jarvisMapsInit;
      // The dynamic loader fires this callback before `Map`/`Marker`/`Polyline`
      // exist; resolve only once the libraries that define them are present.
      void ensureMapLibraries()
        .then(resolve)
        .catch((err) => {
          // Let a later mount retry rather than caching the failure forever.
          loaderPromise = null;
          reject(err);
        });
    };

    script.onerror = () => {
      // Let a later mount retry rather than caching the failure forever — the
      // usual cause is a transient network problem or an ad blocker.
      loaderPromise = null;
      delete window.__jarvisMapsInit;
      reject(new Error("Google Maps failed to load"));
    };

    document.head.appendChild(script);
  });

  return loaderPromise;
}

export function useGoogleMaps(): {
  status: MapsStatus;
  config: MapsConfig | null;
  retry: () => void;
} {
  const [status, setStatus] = useState<MapsStatus>("checking");
  const [config, setConfig] = useState<MapsConfig | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const res = await getMapsConfig();
      if (cancelled) return;

      if (!res.success || !res.data) {
        setStatus("error");
        return;
      }

      setConfig(res.data);

      if (!res.data.browserKey) {
        // Not an error — a deployment without a key is a normal state, and the
        // widget shows setup guidance rather than a failure.
        setStatus("unconfigured");
        return;
      }

      setStatus("loading");
      try {
        await loadSdk(res.data.browserKey);
        if (!cancelled) setStatus("ready");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return { status, config, retry: () => setAttempt((n) => n + 1) };
}
