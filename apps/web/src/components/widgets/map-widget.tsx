"use client";

// ---------------------------------------------------------------------------
// V3 — the live location widget, on a real Google Map.
//
// A genuine google.maps.Map: pan, zoom, markers, a drawn route polyline. Not a
// static image, not an SVG approximation.
//
// WHAT HAPPENS WITHOUT A KEY. There is no way to render a Google map without a
// browser key, and drawing a hand-made substitute inside a widget labelled
// "Google Maps" would be exactly the fake this feature is meant to avoid. So the
// widget stays on the dashboard and shows setup guidance — and says plainly that
// JARVIS can still answer distance and place questions, because the geocoding
// and routing endpoints fall back to OpenStreetMap. Those results are labelled
// with their real source.
//
// LIFECYCLE. Everything this component creates, it destroys: markers, the
// polyline, map event listeners, the geolocation watch and the ResizeObserver.
// The SDK <script> is deliberately NOT removed — it is a page-level singleton
// and another map may still be using it.
//
// PRIVACY. Location is requested through the browser's own permission prompt,
// used only to centre the map and (optionally) to label the marker, and never
// persisted. The reverse-geocode call is authenticated and the coordinates are
// not logged.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react";
import { Crosshair, MapPin, Navigation, Search, Settings } from "lucide-react";
import Link from "next/link";
import {
  getRoute,
  reverseGeocode,
  searchPlaces,
  type Live,
  type Place,
  type RouteResult,
  type TravelMode,
} from "@/lib/api";
import { useGoogleMaps } from "@/lib/use-google-maps";
import { WidgetShell } from "./widget-shell";

type Mode = "route" | "search";

type GeoState =
  | "idle"
  | "locating"
  | "available"
  | "denied"
  | "unavailable"
  | "unsupported";

const TRAVEL_MODES: Array<{ id: TravelMode; label: string }> = [
  { id: "driving", label: "Drive" },
  { id: "walking", label: "Walk" },
  { id: "cycling", label: "Cycle" },
  { id: "transit", label: "Transit" },
];

/** Dark styling, so the map belongs to the JARVIS surface rather than fighting it. */
const MAP_STYLE: google.maps.MapTypeStyle[] = [
  { elementType: "geometry", stylers: [{ color: "#0b1420" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#0b1420" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#6f8296" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#16232f" }] },
  { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#7c93a6" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#071019" }] },
  { featureType: "poi", elementType: "labels.text.fill", stylers: [{ color: "#5d7286" }] },
  { featureType: "poi.park", elementType: "geometry", stylers: [{ color: "#10241c" }] },
  { featureType: "transit", elementType: "geometry", stylers: [{ color: "#182530" }] },
  { featureType: "administrative", elementType: "geometry.stroke", stylers: [{ color: "#243544" }] },
];

export function MapWidget() {
  const { status, config, retry } = useGoogleMaps();

  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const meMarkerRef = useRef<google.maps.Marker | null>(null);
  const resultMarkersRef = useRef<google.maps.Marker[]>([]);
  const polylineRef = useRef<google.maps.Polyline | null>(null);
  const watchIdRef = useRef<number | null>(null);

  const [mode, setMode] = useState<Mode>("route");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [query, setQuery] = useState("");
  const [travelMode, setTravelMode] = useState<TravelMode>("driving");

  const [geoState, setGeoState] = useState<GeoState>("idle");
  const [here, setHere] = useState<{ latitude: number; longitude: number } | null>(null);
  const [hereLabel, setHereLabel] = useState<string | null>(null);

  const [routeResult, setRouteResult] = useState<Live<RouteResult> | null>(null);
  const [places, setPlaces] = useState<Live<Place[]> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // -------------------------------------------------------------------------
  // Map creation
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (status !== "ready" || !hostRef.current || mapRef.current) return;

    const map = new google.maps.Map(hostRef.current, {
      // A world view until a real location or search result arrives. Never a
      // fabricated "your location".
      center: { lat: 20.5937, lng: 78.9629 },
      zoom: 4,
      styles: MAP_STYLE,
      disableDefaultUI: true,
      zoomControl: true,
      gestureHandling: "greedy",
      clickableIcons: false,
      keyboardShortcuts: true,
    });
    mapRef.current = map;

    // A resized grid cell must re-layout the map, or it renders into its old
    // box and leaves grey tiles.
    const observer = new ResizeObserver(() => {
      const current = mapRef.current;
      if (!current) return;
      const centre = current.getCenter();
      google.maps.event.trigger(current, "resize");
      if (centre) current.setCenter(centre);
    });
    observer.observe(hostRef.current);

    return () => {
      observer.disconnect();

      // Tear down everything this component made. The SDK script stays — it is
      // a page-level singleton.
      meMarkerRef.current?.setMap(null);
      meMarkerRef.current = null;
      resultMarkersRef.current.forEach((m) => m.setMap(null));
      resultMarkersRef.current = [];
      polylineRef.current?.setMap(null);
      polylineRef.current = null;

      google.maps.event.clearInstanceListeners(map);
      mapRef.current = null;
    };
  }, [status]);

  // -------------------------------------------------------------------------
  // Geolocation
  // -------------------------------------------------------------------------
  const clearWatch = useCallback(() => {
    if (watchIdRef.current !== null && typeof navigator !== "undefined") {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
  }, []);

  const applyPosition = useCallback(
    (coords: { latitude: number; longitude: number }, recentre: boolean) => {
      setHere(coords);
      setGeoState("available");

      const map = mapRef.current;
      if (!map) return;

      const position = { lat: coords.latitude, lng: coords.longitude };

      if (!meMarkerRef.current) {
        meMarkerRef.current = new google.maps.Marker({
          map,
          position,
          title: "Your current location",
          // A distinct dot rather than a pin, so it cannot be mistaken for a
          // search result.
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 7,
            fillColor: "#3ee0f2",
            fillOpacity: 1,
            strokeColor: "#ffffff",
            strokeWeight: 2,
          },
          zIndex: 999,
        });
      } else {
        meMarkerRef.current.setPosition(position);
      }

      if (recentre) {
        map.setCenter(position);
        map.setZoom(13);
      }
    },
    []
  );

  const locate = useCallback(
    (recentre: boolean) => {
      if (typeof navigator === "undefined" || !navigator.geolocation) {
        setGeoState("unsupported");
        return;
      }

      setGeoState("locating");
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const coords = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
          applyPosition(coords, recentre);

          // Label the marker where the server can reverse-geocode. A failure
          // here is cosmetic: the map is already centred correctly.
          void reverseGeocode(coords.latitude, coords.longitude).then((res) => {
            if (res.success && res.data?.value) setHereLabel(res.data.value.name);
          });

          // Follow the user, but only after an initial fix and with a coarse
          // threshold — a tight watch drains battery for no visible benefit.
          clearWatch();
          watchIdRef.current = navigator.geolocation.watchPosition(
            (next) =>
              applyPosition(
                { latitude: next.coords.latitude, longitude: next.coords.longitude },
                false
              ),
            () => undefined,
            { enableHighAccuracy: false, maximumAge: 60_000, timeout: 30_000 }
          );
        },
        (err) => {
          // PERMISSION_DENIED is a decision, not a fault; the others are.
          setGeoState(err.code === err.PERMISSION_DENIED ? "denied" : "unavailable");
        },
        { timeout: 10_000, maximumAge: 5 * 60_000 }
      );
    },
    [applyPosition, clearWatch]
  );

  // Ask once, automatically, when the map is ready. The browser shows its own
  // prompt; a refusal is handled and never retried in a loop.
  useEffect(() => {
    if (status === "ready" && geoState === "idle") locate(true);
  }, [status, geoState, locate]);

  useEffect(() => clearWatch, [clearWatch]);

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------
  const clearOverlays = useCallback(() => {
    resultMarkersRef.current.forEach((m) => m.setMap(null));
    resultMarkersRef.current = [];
    polylineRef.current?.setMap(null);
    polylineRef.current = null;
  }, []);

  const drawRoute = useCallback((result: RouteResult) => {
    const map = mapRef.current;
    if (!map) return;

    clearOverlays();

    const origin = { lat: result.from.latitude, lng: result.from.longitude };
    const destination = { lat: result.to.latitude, lng: result.to.longitude };

    resultMarkersRef.current.push(
      new google.maps.Marker({ map, position: origin, label: "A", title: result.from.name }),
      new google.maps.Marker({ map, position: destination, label: "B", title: result.to.name })
    );

    // Geometry is [lng, lat] throughout the geo layer; Maps wants {lat, lng}.
    const path = (result.geometry ?? []).map(([lng, lat]) => ({ lat, lng }));

    polylineRef.current = new google.maps.Polyline({
      map,
      // With no polyline from the provider, a straight line between the two
      // points would imply a road that does not exist — so only the markers
      // are drawn in that case.
      path: path.length > 1 ? path : [],
      strokeColor: "#3ee0f2",
      strokeOpacity: 0.9,
      strokeWeight: 4,
    });

    const bounds = new google.maps.LatLngBounds();
    (path.length > 1 ? path : [origin, destination]).forEach((p) => bounds.extend(p));
    map.fitBounds(bounds, 32);
  }, [clearOverlays]);

  const drawPlaces = useCallback((found: Place[]) => {
    const map = mapRef.current;
    if (!map || found.length === 0) return;

    clearOverlays();
    const bounds = new google.maps.LatLngBounds();

    found.slice(0, 8).forEach((place) => {
      const position = { lat: place.latitude, lng: place.longitude };
      resultMarkersRef.current.push(
        new google.maps.Marker({ map, position, title: place.name })
      );
      bounds.extend(position);
    });

    map.fitBounds(bounds, 48);
    // fitBounds on a single marker zooms to the maximum, which is disorienting.
    if (found.length === 1) {
      google.maps.event.addListenerOnce(map, "idle", () => {
        if ((map.getZoom() ?? 0) > 15) map.setZoom(15);
      });
    }
  }, [clearOverlays]);

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------
  const runRoute = useCallback(async () => {
    // "Current location" as an origin is only offered when a real fix exists —
    // it is never guessed.
    const origin = from.trim() || (here ? `${here.latitude},${here.longitude}` : "");
    if (!origin || !to.trim()) return;

    setBusy(true);
    setError(null);
    setPlaces(null);

    const res = await getRoute(origin, to.trim(), true, travelMode);
    setBusy(false);

    if (res.success && res.data) {
      setRouteResult(res.data);
      if (res.data.value) drawRoute(res.data.value);
    } else {
      setError(res.error?.message ?? "Could not calculate the route.");
    }
  }, [from, to, here, travelMode, drawRoute]);

  const runSearch = useCallback(async () => {
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    setRouteResult(null);

    const res = await searchPlaces(query.trim(), here ?? undefined);
    setBusy(false);

    if (res.success && res.data) {
      setPlaces(res.data);
      if (res.data.value) drawPlaces(res.data.value);
    } else {
      setError(res.error?.message ?? "Could not search for that place.");
    }
  }, [query, here, drawPlaces]);

  const active = mode === "route" ? routeResult : places;
  const r = routeResult?.value;

  // -------------------------------------------------------------------------
  // Location banner — one line, always truthful about which state we are in.
  // -------------------------------------------------------------------------
  const locationBanner = (() => {
    switch (geoState) {
      case "locating":
        return { text: "Detecting current location…", action: null, tone: "text-sys-dim" };
      case "available":
        return {
          text: hereLabel ?? "Current location",
          action: null,
          tone: "text-sys-cyan-soft",
        };
      case "denied":
        return { text: "Location permission denied.", action: "Try again", tone: "text-amber-300/90" };
      case "unavailable":
        return { text: "Current location unavailable.", action: "Try again", tone: "text-amber-300/90" };
      case "unsupported":
        return { text: "This browser cannot report a location.", action: null, tone: "text-sys-dim" };
      default:
        return { text: "Location access is disabled.", action: "Enable location", tone: "text-sys-dim" };
    }
  })();

  return (
    <WidgetShell
      testId="widget-map"
      title="Location"
      icon={<MapPin size={13} />}
      {...(active?.meta ? { meta: active.meta } : {})}
      error={error}
      action={
        <div className="flex shrink-0 gap-0.5" role="group" aria-label="Location mode">
          {(["route", "search"] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              data-testid={`map-mode-${m}`}
              onClick={() => setMode(m)}
              aria-pressed={mode === m}
              className={`sys-focus rounded border px-1 py-0.5 font-mono text-xs uppercase tracking-hud transition-colors ${
                mode === m
                  ? "border-sys-cyan/40 bg-sys-cyan/10 text-sys-cyan"
                  : "border-sys-line text-sys-dim hover:text-white"
              }`}
            >
              {m === "route" ? "Route" : "Find"}
            </button>
          ))}
        </div>
      }
    >
      {/* ---- No key: the widget STAYS, with setup guidance ---------------- */}
      {status === "unconfigured" && (
        <div data-testid="map-config-required" className="space-y-2">
          <p className="font-mono text-xs uppercase tracking-hud text-amber-300/90">
            Google Maps · configuration required
          </p>
          <p className="text-xs leading-relaxed text-sys-dim">
            An interactive map needs a Google Maps browser key. Add{" "}
            <code className="text-sys-text/80">GOOGLE_MAPS_BROWSER_KEY</code> (restricted to the
            Maps JavaScript API and to this origin) and{" "}
            <code className="text-sys-text/80">GOOGLE_MAPS_SERVER_KEY</code> on the server, then
            restart.
          </p>
          <Link
            href="/settings/connections"
            className="sys-focus inline-flex items-center gap-1.5 rounded border border-sys-cyan/40 bg-sys-cyan/[0.08] px-2 py-1 font-mono text-xs uppercase tracking-hud text-sys-cyan-soft transition-colors hover:border-sys-cyan/80"
          >
            <Settings size={9} aria-hidden="true" />
            Settings → Connections
          </Link>
          <p className="pt-1 text-xs leading-relaxed text-sys-dim/80">
            JARVIS can still answer distance and place questions meanwhile — those run through
            OpenStreetMap, and results say so.
          </p>
        </div>
      )}

      {status === "error" && (
        <div data-testid="map-load-error" className="space-y-2">
          <p className="text-xs leading-relaxed text-red-300/90">
            Google Maps could not be loaded. The key may be invalid or restricted to a different
            origin.
          </p>
          <button
            type="button"
            onClick={retry}
            className="sys-focus rounded border border-sys-line px-2 py-1 font-mono text-xs uppercase tracking-hud text-sys-dim transition-colors hover:text-white"
          >
            Retry
          </button>
        </div>
      )}

      {(status === "checking" || status === "loading") && (
        <p data-testid="map-loading" className="text-xs text-sys-dim">
          Loading map…
        </p>
      )}

      {/* ---- The real map ------------------------------------------------- */}
      {status === "ready" && (
        <div className="flex h-full min-h-0 flex-col gap-2">
          <div className="flex items-center gap-1.5">
            <p
              data-testid="map-location-banner"
              data-geo-state={geoState}
              className={`min-w-0 flex-1 truncate text-xs ${locationBanner.tone}`}
            >
              {geoState === "available" && "📍 "}
              {locationBanner.text}
            </p>

            {locationBanner.action && (
              <button
                type="button"
                data-testid="map-enable-location"
                onClick={() => locate(true)}
                className="sys-focus shrink-0 rounded border border-sys-line px-1.5 py-0.5 font-mono text-xs uppercase tracking-hud text-sys-dim transition-colors hover:text-white"
              >
                {locationBanner.action}
              </button>
            )}

            <button
              type="button"
              data-testid="map-my-location"
              onClick={() => (here ? applyPosition(here, true) : locate(true))}
              title="Centre on my location"
              aria-label="Centre the map on my location"
              className="sys-focus shrink-0 rounded border border-sys-line p-1 text-sys-dim transition-colors hover:text-sys-cyan"
            >
              <Crosshair size={10} aria-hidden="true" />
            </button>
          </div>

          {/* Controls */}
          {mode === "route" ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void runRoute();
              }}
              className="space-y-1"
            >
              <label htmlFor="map-from" className="sr-only">
                From
              </label>
              <input
                id="map-from"
                data-testid="map-from"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                placeholder={here ? "From — blank uses my location" : "From — e.g. Balaghat"}
                className="sys-focus w-full rounded-md border border-sys-control bg-black/40 px-2 py-1 text-sm text-white placeholder:text-sys-dim"
              />
              <div className="flex gap-1">
                <label htmlFor="map-to" className="sr-only">
                  To
                </label>
                <input
                  id="map-to"
                  data-testid="map-to"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  placeholder="To — e.g. Gondia"
                  className="sys-focus min-w-0 flex-1 rounded-md border border-sys-control bg-black/40 px-2 py-1 text-sm text-white placeholder:text-sys-dim"
                />
                <button
                  type="submit"
                  data-testid="map-route-submit"
                  disabled={(!from.trim() && !here) || !to.trim() || busy}
                  className="sys-focus flex items-center gap-1 rounded-md border border-sys-cyan/40 bg-sys-cyan/10 px-2 font-mono text-xs uppercase tracking-hud text-sys-cyan transition-colors enabled:hover:bg-sys-cyan/20 disabled:opacity-40"
                >
                  <Navigation size={8} aria-hidden="true" />
                  Go
                </button>
              </div>

              {/* Travel mode. Only Google supports all four; with the
                  OpenStreetMap fallback the request is driving-only, and the
                  control says so rather than silently substituting. */}
              <div className="flex gap-0.5" role="group" aria-label="Travel mode">
                {TRAVEL_MODES.map((m) => {
                  const supported = config?.serverGeoAvailable !== false || m.id === "driving";
                  return (
                    <button
                      key={m.id}
                      type="button"
                      data-testid={`map-mode-travel-${m.id}`}
                      onClick={() => setTravelMode(m.id)}
                      disabled={!supported}
                      aria-pressed={travelMode === m.id}
                      title={supported ? undefined : "Needs a Google Maps server key"}
                      className={`sys-focus flex-1 rounded border px-1 py-0.5 font-mono text-xs uppercase tracking-hud transition-colors disabled:opacity-30 ${
                        travelMode === m.id
                          ? "border-sys-cyan/40 bg-sys-cyan/10 text-sys-cyan"
                          : "border-sys-line text-sys-dim enabled:hover:text-white"
                      }`}
                    >
                      {m.label}
                    </button>
                  );
                })}
              </div>
            </form>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void runSearch();
              }}
              className="flex gap-1"
            >
              <label htmlFor="map-query" className="sr-only">
                Search the map
              </label>
              <input
                id="map-query"
                data-testid="map-query"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search places…"
                className="sys-focus min-w-0 flex-1 rounded-md border border-sys-control bg-black/40 px-2 py-1 text-sm text-white placeholder:text-sys-dim"
              />
              <button
                type="submit"
                data-testid="map-search-submit"
                disabled={!query.trim() || busy}
                className="sys-focus flex items-center rounded-md border border-sys-cyan/40 bg-sys-cyan/10 px-2 text-sys-cyan transition-colors enabled:hover:bg-sys-cyan/20 disabled:opacity-40"
              >
                <Search size={10} aria-hidden="true" />
              </button>
            </form>
          )}

          {/* The map itself. `flex-1 min-h-0` lets it take the remaining cell
              height without overflowing a resized grid cell. */}
          <div
            ref={hostRef}
            data-testid="google-map"
            className="min-h-[7rem] w-full flex-1 overflow-hidden rounded-md border border-white/[0.07]"
            role="application"
            aria-label="Interactive map"
          />

          {/* Result summary, under the map rather than instead of it. */}
          {mode === "route" && r && (
            <div data-testid="route-result" className="flex items-baseline gap-2">
              <span className="font-mono text-sm leading-none text-white [font-variant-numeric:tabular-nums]">
                {r.distanceKm}
                <span className="ml-0.5 text-xs text-sys-dim">km</span>
              </span>
              <span className="text-xs text-sys-text/80">
                {Math.floor(r.durationMinutes / 60) > 0
                  ? `${Math.floor(r.durationMinutes / 60)}h `
                  : ""}
                {r.durationMinutes % 60}m
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-sys-dim">
                {r.from.name.split(",")[0]} → {r.to.name.split(",")[0]}
              </span>
            </div>
          )}

          {mode === "search" && places?.value && places.value.length > 0 && (
            <p data-testid="place-results" className="truncate text-xs text-sys-dim">
              {places.value.length} result{places.value.length === 1 ? "" : "s"} ·{" "}
              {places.value[0]!.name}
            </p>
          )}

          {/* Attribution for whichever provider actually answered. */}
          {active?.value != null && (
            <p data-testid="map-attribution" className="text-xs text-sys-dim">
              {active.meta.source}
            </p>
          )}
        </div>
      )}
    </WidgetShell>
  );
}
