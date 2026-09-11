"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Surface } from "@jarvis/core/surface";
import { useGoogleMaps } from "@/lib/use-google-maps";
import { useSurfaceStore } from "@/lib/surface-store";

// ---------------------------------------------------------------------------
// The route surface — a REAL Google map with the provider's own path drawn on
// it, and the comparison beneath.
//
// It uses `useGoogleMaps`, the same loader the dashboard's map widget uses, so
// there is one key, one SDK download and one place where "no key configured"
// is decided. Nothing here re-implements map loading.
//
// WHAT IS AND IS NOT CLAIMED.
//
// Distance and duration come from the routing provider. So does each route's
// label ("via NH 543") and, when the provider modelled it, the traffic-aware
// duration. Tolls are shown as unknown because this provider does not report
// them — not as "none". Nothing about road quality, safety or how busy a road
// will be later appears anywhere, because none of it is in the data.
// ---------------------------------------------------------------------------

type RouteData = Extract<Surface["data"], { kind: "route" }>;
type MapData = Extract<Surface["data"], { kind: "map" }>;

const km = (m: number) => `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`;

const mins = (s: number) => {
  const total = Math.round(s / 60);
  if (total < 60) return `${total} min`;
  return `${Math.floor(total / 60)} h ${total % 60} min`;
};

/** Route colours: the recommended one leads, the rest recede. */
const ACTIVE = "#3ee0f2";
const MUTED = "#5b7386";

function RouteMap({
  data,
  selectedId,
  onSelect,
  surfaceId,
}: {
  data: RouteData;
  selectedId: string;
  onSelect: (id: string) => void;
  surfaceId: string;
}) {
  const { status, retry } = useGoogleMaps();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const drawnRef = useRef<google.maps.Polyline[]>([]);
  const markersRef = useRef<google.maps.Marker[]>([]);
  const setLoading = useSurfaceStore((s) => s.setLoading);

  // The map is loading; the idle timer must not run while it is.
  useEffect(() => {
    setLoading(surfaceId, status === "checking" || status === "loading");
  }, [status, surfaceId, setLoading]);

  // ---- create once -------------------------------------------------------
  useEffect(() => {
    if (status !== "ready" || !hostRef.current || mapRef.current) return;

    mapRef.current = new google.maps.Map(hostRef.current, {
      // Chrome bars and drag handles inside a transient panel are clutter; the
      // route is the content, and the user can expand for the full map.
      disableDefaultUI: true,
      zoomControl: true,
      gestureHandling: "greedy",
      backgroundColor: "#0a0f16",
      styles: [
        { elementType: "geometry", stylers: [{ color: "#0d1520" }] },
        { elementType: "labels.text.fill", stylers: [{ color: "#6f8296" }] },
        { elementType: "labels.text.stroke", stylers: [{ color: "#0a0f16" }] },
        { featureType: "water", elementType: "geometry", stylers: [{ color: "#0a1622" }] },
        { featureType: "road", elementType: "geometry", stylers: [{ color: "#182633" }] },
        { featureType: "poi", stylers: [{ visibility: "off" }] },
      ],
    });
  }, [status]);

  // ---- draw / redraw -----------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (status !== "ready" || !map) return;

    for (const line of drawnRef.current) line.setMap(null);
    for (const marker of markersRef.current) marker.setMap(null);
    drawnRef.current = [];
    markersRef.current = [];

    const bounds = new google.maps.LatLngBounds();

    // Non-selected first, so the selected route is drawn ON TOP rather than
    // being crossed by the others.
    const ordered = [...data.routes].sort((a, b) =>
      a.id === selectedId ? 1 : b.id === selectedId ? -1 : 0
    );

    for (const leg of ordered) {
      if (leg.geometry.length < 2) continue;
      const selected = leg.id === selectedId;

      const line = new google.maps.Polyline({
        path: leg.geometry,
        strokeColor: selected ? ACTIVE : MUTED,
        strokeOpacity: selected ? 0.95 : 0.5,
        strokeWeight: selected ? 5 : 3,
        zIndex: selected ? 10 : 1,
        map,
        clickable: true,
      });
      line.addListener("click", () => onSelect(leg.id));
      drawnRef.current.push(line);

      for (const point of leg.geometry) bounds.extend(point);
    }

    for (const [label, place] of [
      ["A", data.origin],
      ["B", data.destination],
    ] as const) {
      if (!place.position) continue;
      markersRef.current.push(
        new google.maps.Marker({
          position: place.position,
          map,
          label: { text: label, color: "#04121a", fontSize: "11px", fontWeight: "700" },
          title: place.label,
        })
      );
      bounds.extend(place.position);
    }

    if (!bounds.isEmpty()) map.fitBounds(bounds, 28);
  }, [status, data, selectedId, onSelect]);

  // ---- resize ------------------------------------------------------------
  //
  // The panel changes size when the surface is expanded or the viewport
  // changes, and Google Maps renders into the size it last measured. Without
  // this the map keeps its old box and shows grey where the panel grew.
  useEffect(() => {
    const host = hostRef.current;
    const map = mapRef.current;
    if (!host || !map || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      google.maps.event.trigger(map, "resize");
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [status]);

  useEffect(
    () => () => {
      for (const line of drawnRef.current) line.setMap(null);
      for (const marker of markersRef.current) marker.setMap(null);
      drawnRef.current = [];
      markersRef.current = [];
      mapRef.current = null;
    },
    []
  );

  if (status === "unconfigured" || status === "error") {
    // Honest, and NOT a blank grey box pretending to be a map.
    return (
      <div className="flex h-40 items-center justify-center rounded-lg border border-white/[0.07] bg-white/[0.02] px-4 text-center">
        <div>
          <p className="text-xs leading-relaxed text-sys-dim">
            {status === "unconfigured"
              ? "No Google Maps key is configured, so the route cannot be drawn."
              : "Google Maps could not be loaded."}
          </p>
          {status === "error" && (
            <button
              type="button"
              onClick={retry}
              className="sys-focus mt-2 rounded border border-sys-line px-2 py-1 font-mono text-xs uppercase tracking-hud text-sys-dim hover:text-white"
            >
              Retry
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={hostRef}
      data-testid="route-map"
      className="h-[min(38vh,18rem)] w-full overflow-hidden rounded-lg border border-white/[0.07]"
      // The map handles its own gestures; the surface must not treat a pan as
      // a reason to do anything except stay open.
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}

// ---------------------------------------------------------------------------
// Places — a search result, on the map
// ---------------------------------------------------------------------------

function PlacesSurface({ data, surfaceId }: { data: MapData; surfaceId: string }) {
  const { status, retry } = useGoogleMaps();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<google.maps.Marker[]>([]);
  const setLoading = useSurfaceStore((s) => s.setLoading);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    setLoading(surfaceId, status === "checking" || status === "loading");
  }, [status, surfaceId, setLoading]);

  useEffect(() => {
    if (status !== "ready" || !hostRef.current || mapRef.current) return;
    mapRef.current = new google.maps.Map(hostRef.current, {
      disableDefaultUI: true,
      zoomControl: true,
      gestureHandling: "greedy",
      backgroundColor: "#0a0f16",
      styles: [
        { elementType: "geometry", stylers: [{ color: "#0d1520" }] },
        { elementType: "labels.text.fill", stylers: [{ color: "#6f8296" }] },
        { elementType: "labels.text.stroke", stylers: [{ color: "#0a0f16" }] },
        { featureType: "water", elementType: "geometry", stylers: [{ color: "#0a1622" }] },
        { featureType: "road", elementType: "geometry", stylers: [{ color: "#182633" }] },
      ],
    });
  }, [status]);

  useEffect(() => {
    const map = mapRef.current;
    if (status !== "ready" || !map) return;

    for (const marker of markersRef.current) marker.setMap(null);
    markersRef.current = [];

    const bounds = new google.maps.LatLngBounds();
    let located = 0;

    data.places.forEach((place, i) => {
      if (!place.position) return;
      located++;
      const marker = new google.maps.Marker({
        position: place.position,
        map,
        // Numbered to match the list beneath, so "the third one" is findable.
        label: { text: String(i + 1), color: "#04121a", fontSize: "11px", fontWeight: "700" },
        title: place.name,
      });
      marker.addListener("click", () => setSelectedId(place.id));
      markersRef.current.push(marker);
      bounds.extend(place.position);
    });

    if (located === 0) return;
    if (located === 1) {
      map.setCenter(bounds.getCenter());
      map.setZoom(data.zoom);
    } else {
      map.fitBounds(bounds, 36);
    }
  }, [status, data]);

  useEffect(() => {
    const host = hostRef.current;
    const map = mapRef.current;
    if (!host || !map || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => google.maps.event.trigger(map, "resize"));
    observer.observe(host);
    return () => observer.disconnect();
  }, [status]);

  useEffect(
    () => () => {
      for (const marker of markersRef.current) marker.setMap(null);
      markersRef.current = [];
      mapRef.current = null;
    },
    []
  );

  const anyLocated = data.places.some((p) => p.position);

  return (
    <div data-testid="places-body">
      {/* The map is skipped entirely when nothing has coordinates. An empty
          map beside a list of addresses is decoration, and a grey rectangle
          reads as "broken" rather than "these results have no position". */}
      {anyLocated &&
        (status === "unconfigured" || status === "error" ? (
          <div className="flex h-28 items-center justify-center rounded-lg border border-white/[0.07] bg-white/[0.02] px-4 text-center">
            <div>
              <p className="text-xs leading-relaxed text-sys-dim">
                {status === "unconfigured"
                  ? "No Google Maps key is configured, so these cannot be plotted."
                  : "Google Maps could not be loaded."}
              </p>
              {status === "error" && (
                <button
                  type="button"
                  onClick={retry}
                  className="sys-focus mt-2 rounded border border-sys-line px-2 py-1 font-mono text-xs uppercase tracking-hud text-sys-dim hover:text-white"
                >
                  Retry
                </button>
              )}
            </div>
          </div>
        ) : (
          <div
            ref={hostRef}
            data-testid="places-map"
            className="h-[min(32vh,15rem)] w-full overflow-hidden rounded-lg border border-white/[0.07]"
            onPointerDown={(e) => e.stopPropagation()}
          />
        ))}

      <ol data-testid="places-list" className={anyLocated ? "mt-3 space-y-1.5" : "space-y-1.5"}>
        {data.places.map((place, i) => (
          <li key={`${place.id}-${i}`}>
            <button
              type="button"
              data-testid={`place-${i}`}
              onClick={() => {
                setSelectedId(place.id);
                const map = mapRef.current;
                if (map && place.position) {
                  map.panTo(place.position);
                  map.setZoom(15);
                }
              }}
              aria-pressed={selectedId === place.id}
              className={`sys-focus flex w-full items-start gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors ${
                selectedId === place.id
                  ? "border-sys-cyan/40 bg-sys-cyan/10"
                  : "border-white/[0.07] bg-white/[0.02] hover:border-white/[0.14]"
              }`}
            >
              <span className="mt-0.5 shrink-0 font-mono text-xs tabular-nums text-sys-dim">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-white/90">{place.name}</span>
                {place.address && (
                  <span className="block truncate text-xs text-sys-dim">{place.address}</span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ol>

      <p
        data-testid="surface-provenance"
        className="mt-3 border-t border-white/[0.06] pt-2 font-mono text-xs uppercase tracking-hud text-sys-dim"
      >
        {data.provenance.source}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function RouteSurface({ surface }: { surface: Surface }) {
  const data = surface.data as RouteData | MapData;

  // A `map` surface has no routes; it is places on a map. Only the route
  // variant has a comparison to render.
  const routeData = data.kind === "route" ? data : null;

  const recommended = useMemo(
    () => routeData?.routes.find((r) => r.recommended)?.id ?? routeData?.routes[0]?.id ?? "",
    [routeData]
  );
  const [selectedId, setSelectedId] = useState(recommended);

  // Follow the server when it changes its recommendation (a new travel mode,
  // a re-query), but never fight a choice the user has made since.
  const lastRecommended = useRef(recommended);
  useEffect(() => {
    if (lastRecommended.current !== recommended) {
      lastRecommended.current = recommended;
      setSelectedId(recommended);
    }
  }, [recommended]);

  // A `map` surface is places, not a journey. Same loader, same styling, same
  // resize handling — a different thing drawn on it.
  if (!routeData) return <PlacesSurface data={data as MapData} surfaceId={surface.surfaceId} />;

  const selected = routeData.routes.find((r) => r.id === selectedId) ?? routeData.routes[0]!;

  return (
    <div data-testid="route-body">
      <RouteMap
        data={routeData}
        selectedId={selectedId}
        onSelect={setSelectedId}
        surfaceId={surface.surfaceId}
      />

      {/* ---- the comparison ------------------------------------------------
          Every row is provider output. The reason line under the recommended
          route is arithmetic on those two numbers and nothing else. */}
      <ul data-testid="route-options" className="mt-3 space-y-1.5">
        {routeData.routes.map((leg) => {
          const isSelected = leg.id === selectedId;
          return (
            <li key={leg.id}>
              <button
                type="button"
                data-testid={`route-option-${leg.id}`}
                aria-pressed={isSelected}
                onClick={() => setSelectedId(leg.id)}
                className={`sys-focus w-full rounded-lg border px-2.5 py-2 text-left transition-colors ${
                  isSelected
                    ? "border-sys-cyan/40 bg-sys-cyan/10"
                    : "border-white/[0.07] bg-white/[0.02] hover:border-white/[0.14]"
                }`}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-sm text-white/90">
                    {leg.summary}
                    {leg.recommended && (
                      <span className="ml-1.5 font-mono text-xs uppercase tracking-hud text-sys-cyan">
                        best
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 font-mono text-sm tabular-nums text-white">
                    {mins(leg.durationSeconds)}
                  </span>
                </div>

                <div className="mt-0.5 flex items-baseline justify-between gap-3">
                  <span className="font-mono text-xs uppercase tracking-hud text-sys-dim">
                    {km(leg.distanceMeters)}
                    {/* Unknown, not "none". The provider does not report tolls. */}
                    {leg.hasTolls === null ? " · tolls unknown" : leg.hasTolls ? " · tolls" : " · no tolls"}
                  </span>
                  {leg.durationInTrafficSeconds !== null && (
                    <span className="shrink-0 font-mono text-xs tabular-nums text-amber-300/85">
                      {mins(leg.durationInTrafficSeconds)} in traffic
                    </span>
                  )}
                </div>

                {leg.recommendationReason && (
                  <p className="mt-1 text-xs leading-relaxed text-sys-text/70">
                    {leg.recommendationReason}
                  </p>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      <p className="mt-2 font-mono text-xs uppercase tracking-hud text-sys-dim">
        {routeData.origin.label} → {routeData.destination.label} · {routeData.travelMode}
      </p>
      <p
        data-testid="surface-provenance"
        className="mt-1 border-t border-white/[0.06] pt-2 font-mono text-xs uppercase tracking-hud text-sys-dim"
      >
        {routeData.provenance.source}
      </p>

      <span className="sr-only" role="status">
        {`${selected.summary}: ${km(selected.distanceMeters)}, ${mins(selected.durationSeconds)}.`}
      </span>
    </div>
  );
}
