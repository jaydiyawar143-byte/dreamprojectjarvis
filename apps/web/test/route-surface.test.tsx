// ---------------------------------------------------------------------------
// Route surface around the map: explicit loading state, map host only when
// ready, and contained construction failure.
//
//   - While the SDK is checking/loading the surface must say "Loading map…"
//     rather than render a blank rectangle.
//   - Once ready, the real `route-map` host mounts and the map is constructed.
//   - A `new google.maps.Map()` failure stays inside the surface: the inline
//     error appears, the route comparison stays visible, Retry is offered, and
//     nothing escapes toward Next.js's error boundary.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import type { Surface } from "@jarvis/core/surface";
import { RouteSurface } from "../src/components/surfaces/route-surface";

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return {
    ...actual,
    getMapsConfig: vi.fn(),
  };
});

import * as api from "../src/lib/api";

const ts = () => new Date().toISOString();
const mocked = vi.mocked(api);

const created = { maps: [] as Array<Record<string, unknown>> };

interface StubOpts {
  /** When true, `new google.maps.Map()` throws. */
  throwingMap?: boolean;
}

function installGoogleStub(opts: StubOpts = {}) {
  created.maps = [];

  class StubMarker {
    setMap = vi.fn();
    constructor(public opts: unknown) {}
  }

  class StubPolyline {
    setMap = vi.fn();
    addListener = vi.fn();
    constructor(public opts: unknown) {}
  }

  class StubBounds {
    extend = vi.fn();
    isEmpty = vi.fn(() => false);
  }

  class StubMap {
    fitBounds = vi.fn();
    panTo = vi.fn();
    setZoom = vi.fn();
    constructor(...args: unknown[]) {
      if (opts.throwingMap) {
        throw new Error("simulated construction failure");
      }
      created.maps.push({ args } as Record<string, unknown>);
    }
  }

  (globalThis as unknown as { google: unknown }).google = {
    maps: {
      Map: StubMap,
      Marker: StubMarker,
      Polyline: StubPolyline,
      LatLngBounds: StubBounds,
      event: { trigger: vi.fn() },
    },
  };

  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

function teardownSdk() {
  delete (globalThis as { google?: unknown }).google;
}

function makeRouteSurface(): Surface {
  return {
    surfaceId: "sfc-route-test-1",
    type: "route",
    mode: "interactive",
    title: "Balaghat → Gondia",
    status: "opening",
    conversationBound: true,
    contextKey: "route:balaghat->gondia",
    autoClose: { enabled: false, idleSeconds: 60 },
    position: { anchor: "map-primary" },
    data: {
      kind: "route",
      origin: { label: "Balaghat", position: { lat: 21.8, lng: 80.18 } },
      destination: { label: "Gondia", position: { lat: 21.46, lng: 80.19 } },
      travelMode: "driving",
      routes: [
        {
          id: "primary",
          summary: "via NH 543",
          distanceMeters: 43_700,
          durationSeconds: 3_660,
          hasTolls: null,
          durationInTrafficSeconds: null,
          geometry: [
            { lat: 21.8, lng: 80.18 },
            { lat: 21.7, lng: 80.19 },
            { lat: 21.46, lng: 80.19 },
          ],
          recommended: true,
          recommendationReason: null,
        },
      ],
      provenance: { source: "Google Maps Platform", freshness: "LIVE" },
    },
    actions: [],
    reason: "test",
  } as unknown as Surface;
}

function configuredKey() {
  mocked.getMapsConfig.mockResolvedValue({
    success: true,
    data: {
      browserKey: "browser-key",
      mapsAvailable: true,
      serverGeoAvailable: true,
      reason: "configured",
    },
    timestamp: ts(),
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  teardownSdk();
});

// ---------------------------------------------------------------------------

describe("RouteSurface map loading UX", () => {
  it("shows an explicit loading state while the SDK is checking", async () => {
    // A config fetch that never resolves keeps the hook in "checking".
    mocked.getMapsConfig.mockImplementation(() => new Promise(() => {}));
    installGoogleStub();

    render(<RouteSurface surface={makeRouteSurface()} />);

    expect(screen.getByTestId("route-map-loading")).toBeInTheDocument();
    expect(screen.getByText("Loading map…")).toBeInTheDocument();
    // No empty rectangle pretending to be a map.
    expect(screen.queryByTestId("route-map")).toBeNull();
    // Route comparison is still readable beneath the loader.
    expect(screen.getByTestId("route-option-primary")).toBeInTheDocument();
  });

  it("replaces the loader with the real map host once ready", async () => {
    configuredKey();
    installGoogleStub();

    render(<RouteSurface surface={makeRouteSurface()} />);

    expect(screen.getByTestId("route-map-loading")).toBeInTheDocument();

    await waitFor(() => expect(created.maps).toHaveLength(1));
    expect(screen.getByTestId("route-map")).toBeInTheDocument();
    expect(screen.queryByTestId("route-map-loading")).toBeNull();
    expect(screen.queryByText("Loading map…")).toBeNull();
  });

  it("keeps the route options visible after the map mounts", async () => {
    configuredKey();
    installGoogleStub();

    render(<RouteSurface surface={makeRouteSurface()} />);
    await waitFor(() => expect(created.maps).toHaveLength(1));

    expect(screen.getByTestId("route-option-primary")).toHaveTextContent("via NH 543");
    expect(screen.getByText(/Balaghat/)).toBeInTheDocument();
    expect(screen.getByText(/Gondia/)).toBeInTheDocument();
  });

  it("contains a construction failure without touching the error boundary", async () => {
    configuredKey();
    installGoogleStub({ throwingMap: true });

    render(<RouteSurface surface={makeRouteSurface()} />);

    // The failure is caught and shown inline; the render itself never threw.
    await waitFor(() =>
      expect(screen.getByText("The map could not be drawn.")).toBeInTheDocument()
    );
    // Route comparison stays up.
    expect(screen.getByTestId("route-option-primary")).toBeInTheDocument();
    expect(screen.getByTestId("route-option-primary")).toHaveTextContent("44 km");
    // Retry is offered.
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    // No map host, no loader left over.
    expect(screen.queryByTestId("route-map")).toBeNull();
    expect(screen.queryByTestId("route-map-loading")).toBeNull();
  });

  it("recovers through Retry once the constructors became healthy", async () => {
    configuredKey();

    // First attempt: throwing Map -> inline error.
    installGoogleStub({ throwingMap: true });
    const { rerender } = render(<RouteSurface surface={makeRouteSurface()} />);
    await waitFor(() =>
      expect(screen.getByText("The map could not be drawn.")).toBeInTheDocument()
    );

    // The production bug this guards: a healthy second load must be allowed.
    const healthy = installGoogleStub({ throwingMap: false });
    void healthy;

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    act(() => {});

    await waitFor(() => expect(created.maps).toHaveLength(1));
    expect(screen.getByTestId("route-map")).toBeInTheDocument();
    expect(screen.queryByText("The map could not be drawn.")).toBeNull();
    rerender(<RouteSurface surface={makeRouteSurface()} />);
  });
});