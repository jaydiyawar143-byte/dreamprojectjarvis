// ---------------------------------------------------------------------------
// The map widget with a real key: location lifecycle, autocomplete, routing.
//
// The unconfigured states are covered in v3-widgets.test.tsx. This file covers
// what happens once a browser key exists and the SDK is present, which is where
// the behaviours that cost money or leak position actually live:
//
//   - LOCATION IS ONE-SHOT BY DEFAULT. `watchPosition` must not start until the
//     user turns LIVE on. Continuous tracking nobody asked for is the single
//     worst default this widget could ship with.
//
//   - AUTOCOMPLETE IS DEBOUNCED AND CANCELLED. Undebounced, "restaurants" is
//     eleven billed calls; uncancelled, a slow early response overwrites a fast
//     later one and shows the wrong list.
//
//   - WATCHERS ARE CLEANED UP. On toggle-off and on unmount.
//
//   - NOTHING IS FABRICATED. A denied permission says denied. A failed reverse
//     geocode leaves the marker unlabelled rather than naming a city.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  act,
  within,
  configure,
} from "@testing-library/react";

// The map only appears after an authenticated config fetch resolves AND two
// effects run. Testing Library's 1s default is enough on an idle machine and
// intermittently is not when the whole 14-file suite runs at once — which
// showed up as this file passing alone and failing about one run in three.
// Raising the wait changes no assertion; it just stops the timer being the
// thing under test.
configure({ asyncUtilTimeout: 5000 });

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return {
    ...actual,
    getMapsConfig: vi.fn(),
    reverseGeocode: vi.fn(),
    searchPlaces: vi.fn(),
    getRoute: vi.fn(),
    autocompletePlaces: vi.fn(),
    resolvePlace: vi.fn(),
    publishLocation: vi.fn(),
    clearPublishedLocation: vi.fn(),
  };
});

import * as api from "../src/lib/api";
import { MapWidget } from "../src/components/widgets/map-widget";

const mocked = vi.mocked(api);
const ts = () => new Date().toISOString();

const liveMeta = (source = "Google Maps Platform"): api.ProviderMeta => ({
  freshness: "LIVE",
  observedAt: ts(),
  ageSeconds: 2,
  source,
});

// ---------------------------------------------------------------------------
// Google Maps SDK stub
//
// `useGoogleMaps` short-circuits when `window.google.maps` already exists, so
// planting this stub is enough to reach the "ready" branch without jsdom having
// to execute a remote <script>.
// ---------------------------------------------------------------------------

const created = {
  maps: [] as Array<Record<string, unknown>>,
  markers: [] as Array<Record<string, unknown>>,
  polylines: [] as Array<Record<string, unknown>>,
};

function installGoogleStub() {
  created.maps = [];
  created.markers = [];
  created.polylines = [];

  class StubMap {
    setCenter = vi.fn();
    setZoom = vi.fn();
    getZoom = vi.fn(() => 10);
    getCenter = vi.fn(() => ({ lat: () => 0, lng: () => 0 }));
    fitBounds = vi.fn();
    constructor() {
      created.maps.push(this as unknown as Record<string, unknown>);
    }
  }

  class StubMarker {
    setMap = vi.fn();
    setPosition = vi.fn();
    constructor(public opts: unknown) {
      created.markers.push(this as unknown as Record<string, unknown>);
    }
  }

  class StubPolyline {
    setMap = vi.fn();
    constructor(public opts: unknown) {
      created.polylines.push(this as unknown as Record<string, unknown>);
    }
  }

  class StubBounds {
    extend = vi.fn();
  }

  (globalThis as unknown as { google: unknown }).google = {
    maps: {
      Map: StubMap,
      Marker: StubMarker,
      Polyline: StubPolyline,
      LatLngBounds: StubBounds,
      SymbolPath: { CIRCLE: 0 },
      event: {
        trigger: vi.fn(),
        clearInstanceListeners: vi.fn(),
        addListenerOnce: vi.fn(),
      },
    },
  };
}

/** Drives the browser Geolocation API. */
function installGeolocation(behaviour: {
  current?: { coords: { latitude: number; longitude: number; accuracy?: number } };
  error?: { code: number; PERMISSION_DENIED: number };
}) {
  const watchPosition = vi.fn(() => 42);
  const clearWatch = vi.fn();
  const getCurrentPosition = vi.fn(
    (ok: (p: unknown) => void, fail: (e: unknown) => void) => {
      if (behaviour.error) fail(behaviour.error);
      else if (behaviour.current) ok(behaviour.current);
    }
  );

  Object.defineProperty(globalThis.navigator, "geolocation", {
    configurable: true,
    value: { getCurrentPosition, watchPosition, clearWatch },
  });

  return { getCurrentPosition, watchPosition, clearWatch };
}

const NAGPUR = { coords: { latitude: 21.1458, longitude: 79.0882, accuracy: 30 } };

/**
 * ROUTE and FIND are collapsed by default so the map gets the whole cell.
 * Every test that touches a form control has to open it first, exactly as a
 * user would.
 */
async function openPanel(which: "route" | "search") {
  const button = await screen.findByTestId(`map-mode-${which}`);
  fireEvent.click(button);
  await waitFor(() =>
    expect(
      screen.getByTestId(which === "route" ? "map-to" : "map-query")
    ).toBeInTheDocument()
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  installGoogleStub();

  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;

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

  mocked.reverseGeocode.mockResolvedValue({
    success: true,
    data: {
      value: {
        name: "Nagpur, Maharashtra, India",
        latitude: 21.1458,
        longitude: 79.0882,
        attribution: "Map data ©2026 Google",
      },
      meta: liveMeta(),
    },
    timestamp: ts(),
  } as never);

  mocked.publishLocation.mockResolvedValue({ success: true, data: { accepted: true }, timestamp: ts() } as never);
  mocked.clearPublishedLocation.mockResolvedValue({ success: true, data: { cleared: true }, timestamp: ts() } as never);
  mocked.autocompletePlaces.mockResolvedValue({
    success: true,
    data: { value: [], meta: liveMeta() },
    timestamp: ts(),
  } as never);
});

afterEach(() => {
  vi.useRealTimers();
  // The google stub is deliberately NOT deleted here. Testing Library's
  // auto-cleanup unmounts on afterEach too, and the widget's unmount path calls
  // google.maps.event.clearInstanceListeners — removing the global first turns
  // every teardown into a ReferenceError. `beforeEach` replaces it instead.
});

// ---------------------------------------------------------------------------

describe("map initialisation", () => {
  it("creates a real google.maps.Map once a browser key exists", async () => {
    installGeolocation({ current: NAGPUR });
    render(<MapWidget />);

    // Wait on the CONSTRUCTION, not on the container element. The div is in the
    // DOM one render before the effect that builds the map has flushed, so
    // waiting for the div and then asserting the map was a race — it passed
    // alone and failed about one full-suite run in three.
    await waitFor(() => expect(created.maps).toHaveLength(1));
    expect(screen.getByTestId("google-map")).toBeInTheDocument();
  });

  it("centres on a world view, not on a fabricated 'your location'", async () => {
    installGeolocation({ error: { code: 1, PERMISSION_DENIED: 1 } });
    render(<MapWidget />);

    await waitFor(() => expect(created.maps).toHaveLength(1));
    // No location, no invented centre — the map opens on a wide view.
    expect(created.markers).toHaveLength(0);
  });

  it("tears the map down on unmount", async () => {
    installGeolocation({ current: NAGPUR });
    const { unmount } = render(<MapWidget />);
    await waitFor(() => expect(created.maps).toHaveLength(1));

    unmount();

    const google = (globalThis as unknown as { google: { maps: { event: { clearInstanceListeners: ReturnType<typeof vi.fn> } } } }).google;
    expect(google.maps.event.clearInstanceListeners).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("location lifecycle", () => {
  it("asks for a position once and shows the resolved address", async () => {
    const geo = installGeolocation({ current: NAGPUR });
    render(<MapWidget />);

    // The reverse-geocoded label arrives on a SECOND promise, after the state
    // has already flipped to "available". Waiting for the state and then
    // asserting the label is the same race as above, one layer along — so wait
    // for the label itself.
    await waitFor(() =>
      expect(screen.getByTestId("map-location-banner")).toHaveTextContent("Nagpur")
    );
    expect(screen.getByTestId("map-location-banner")).toHaveAttribute(
      "data-geo-state",
      "available"
    );
    expect(geo.getCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it("does NOT start a continuous watcher by default", async () => {
    const geo = installGeolocation({ current: NAGPUR });
    render(<MapWidget />);

    await waitFor(() =>
      expect(screen.getByTestId("map-location-banner")).toHaveAttribute("data-geo-state", "available")
    );
    // The whole privacy posture of this widget reduces to this assertion.
    expect(geo.watchPosition).not.toHaveBeenCalled();
  });

  it("says permission was denied, and offers to try again", async () => {
    installGeolocation({ error: { code: 1, PERMISSION_DENIED: 1 } });
    render(<MapWidget />);

    await waitFor(() =>
      expect(screen.getByTestId("map-location-banner")).toHaveAttribute("data-geo-state", "denied")
    );
    expect(screen.getByTestId("map-location-banner")).toHaveTextContent(/denied/i);
    expect(screen.getByTestId("map-enable-location")).toBeInTheDocument();
  });

  it("distinguishes 'unavailable' from 'denied'", async () => {
    installGeolocation({ error: { code: 2, PERMISSION_DENIED: 1 } });
    render(<MapWidget />);

    await waitFor(() =>
      expect(screen.getByTestId("map-location-banner")).toHaveAttribute("data-geo-state", "unavailable")
    );
  });

  it("does not retry a denied permission in a loop", async () => {
    const geo = installGeolocation({ error: { code: 1, PERMISSION_DENIED: 1 } });
    render(<MapWidget />);

    await waitFor(() =>
      expect(screen.getByTestId("map-location-banner")).toHaveAttribute("data-geo-state", "denied")
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(geo.getCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it("falls back to 'Current location' when reverse geocoding fails", async () => {
    mocked.reverseGeocode.mockResolvedValue({
      success: false,
      error: { code: "UNAVAILABLE", message: "unreachable" },
      timestamp: ts(),
    } as never);
    installGeolocation({ current: NAGPUR });
    render(<MapWidget />);

    await waitFor(() =>
      expect(screen.getByTestId("map-location-banner")).toHaveAttribute("data-geo-state", "available")
    );
    // No address is invented for a failed lookup.
    expect(screen.getByTestId("map-location-banner")).toHaveTextContent(/Current location/i);
  });

  it("publishes the position to the server so chat tools can use it", async () => {
    installGeolocation({ current: NAGPUR });
    render(<MapWidget />);

    await waitFor(() => expect(mocked.publishLocation).toHaveBeenCalled());
    expect(mocked.publishLocation).toHaveBeenCalledWith(
      expect.objectContaining({ latitude: 21.1458, longitude: 79.0882 })
    );
  });

  it("does not publish anything when permission is denied", async () => {
    installGeolocation({ error: { code: 1, PERMISSION_DENIED: 1 } });
    render(<MapWidget />);

    await waitFor(() =>
      expect(screen.getByTestId("map-location-banner")).toHaveAttribute("data-geo-state", "denied")
    );
    expect(mocked.publishLocation).not.toHaveBeenCalled();
  });

  it("re-centres on My Location without asking the browser again", async () => {
    const geo = installGeolocation({ current: NAGPUR });
    render(<MapWidget />);
    await waitFor(() =>
      expect(screen.getByTestId("map-location-banner")).toHaveAttribute("data-geo-state", "available")
    );

    fireEvent.click(screen.getByTestId("map-my-location"));

    // A fix already exists; asking again would re-prompt for nothing.
    expect(geo.getCurrentPosition).toHaveBeenCalledTimes(1);
    expect((created.maps[0] as { setCenter: ReturnType<typeof vi.fn> }).setCenter).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("live tracking", () => {
  it("is offered only once a fix exists", async () => {
    installGeolocation({ error: { code: 1, PERMISSION_DENIED: 1 } });
    render(<MapWidget />);

    await waitFor(() =>
      expect(screen.getByTestId("map-location-banner")).toHaveAttribute("data-geo-state", "denied")
    );
    // The toggle must never be the thing that triggers the permission prompt.
    expect(screen.queryByTestId("map-live-toggle")).toBeNull();
  });

  it("starts a watcher only when switched on", async () => {
    const geo = installGeolocation({ current: NAGPUR });
    render(<MapWidget />);
    await waitFor(() => expect(screen.getByTestId("map-live-toggle")).toBeInTheDocument());

    expect(geo.watchPosition).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("map-live-toggle"));

    await waitFor(() => expect(geo.watchPosition).toHaveBeenCalledTimes(1));
  });

  it("stops the watcher and forgets the position when switched off", async () => {
    const geo = installGeolocation({ current: NAGPUR });
    render(<MapWidget />);
    await waitFor(() => expect(screen.getByTestId("map-live-toggle")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("map-live-toggle"));
    await waitFor(() => expect(geo.watchPosition).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("map-live-toggle"));

    await waitFor(() => expect(geo.clearWatch).toHaveBeenCalled());
    // "Stop sharing" has to reach the server, not just the UI.
    expect(mocked.clearPublishedLocation).toHaveBeenCalled();
  });

  it("clears the watcher on unmount", async () => {
    const geo = installGeolocation({ current: NAGPUR });
    const { unmount } = render(<MapWidget />);
    await waitFor(() => expect(screen.getByTestId("map-live-toggle")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("map-live-toggle"));
    await waitFor(() => expect(geo.watchPosition).toHaveBeenCalled());

    unmount();
    expect(geo.clearWatch).toHaveBeenCalled();
  });

  it("labels the widget LIVE only while tracking", async () => {
    installGeolocation({ current: NAGPUR });
    render(<MapWidget />);
    await waitFor(() => expect(screen.getByTestId("map-live-toggle")).toBeInTheDocument());

    expect(screen.getByTestId("map-live-toggle")).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByTestId("map-live-toggle"));
    await waitFor(() =>
      expect(screen.getByTestId("map-live-toggle")).toHaveAttribute("aria-pressed", "true")
    );
  });
});

// ---------------------------------------------------------------------------

describe("autocomplete", () => {
  const GONDIA_SUGGESTION: api.PlaceSuggestion = {
    placeId: "ChIJgondia",
    description: "Gondia, Maharashtra, India",
    primary: "Gondia",
    secondary: "Maharashtra, India",
  };

  it("does not fire on every keystroke", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installGeolocation({ current: NAGPUR });
    render(<MapWidget />);
    await openPanel("route");

    const input = screen.getByTestId("map-to");
    for (const value of ["G", "Go", "Gon", "Gond", "Gondi", "Gondia"]) {
      fireEvent.change(input, { target: { value } });
      await act(async () => {
        vi.advanceTimersByTime(50);
      });
    }

    // Still inside the debounce window: nothing has been requested yet.
    expect(mocked.autocompletePlaces).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(400);
    });

    // Six keystrokes, one billed call.
    expect(mocked.autocompletePlaces).toHaveBeenCalledTimes(1);
    expect(mocked.autocompletePlaces).toHaveBeenCalledWith(
      "Gondia",
      expect.anything(),
      expect.anything()
    );
  });

  it("does not request anything for a single character", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installGeolocation({ current: NAGPUR });
    render(<MapWidget />);
    await openPanel("route");

    fireEvent.change(screen.getByTestId("map-to"), { target: { value: "G" } });
    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    expect(mocked.autocompletePlaces).not.toHaveBeenCalled();
  });

  it("renders suggestions and lets one be picked", async () => {
    mocked.autocompletePlaces.mockResolvedValue({
      success: true,
      data: { value: [GONDIA_SUGGESTION], meta: liveMeta() },
      timestamp: ts(),
    } as never);
    installGeolocation({ current: NAGPUR });
    render(<MapWidget />);
    await openPanel("route");

    fireEvent.change(screen.getByTestId("map-to"), { target: { value: "Gondia" } });
    await waitFor(() => expect(screen.getByTestId("map-to-suggestions")).toBeInTheDocument());

    fireEvent.mouseDown(screen.getByText("Gondia"));

    await waitFor(() =>
      expect(screen.getByTestId("map-to")).toHaveValue("Gondia, Maharashtra, India")
    );
    // The list closes rather than immediately re-querying the value it wrote.
    expect(screen.queryByTestId("map-to-suggestions")).toBeNull();
  });

  it("sends the picked Place ID when routing", async () => {
    mocked.autocompletePlaces.mockResolvedValue({
      success: true,
      data: { value: [GONDIA_SUGGESTION], meta: liveMeta() },
      timestamp: ts(),
    } as never);
    mocked.getRoute.mockResolvedValue({
      success: true,
      data: {
        value: {
          from: { name: "Balaghat", latitude: 21.8, longitude: 80.18, attribution: "g" },
          to: { name: "Gondia", latitude: 21.46, longitude: 80.19, attribution: "g" },
          distanceKm: 61.2,
          durationMinutes: 70,
          geometry: [
            [80.18, 21.8],
            [80.19, 21.46],
          ],
          attribution: "g",
        },
        meta: liveMeta(),
      },
      timestamp: ts(),
    } as never);

    installGeolocation({ current: NAGPUR });
    render(<MapWidget />);
    await openPanel("route");

    fireEvent.change(screen.getByTestId("map-from"), { target: { value: "Balaghat" } });
    fireEvent.change(screen.getByTestId("map-to"), { target: { value: "Gondia" } });
    await waitFor(() => expect(screen.getByTestId("map-to-suggestions")).toBeInTheDocument());
    // Scoped: both inputs have text, so both suggestion lists are open and a
    // bare getByText would pick whichever rendered first.
    fireEvent.mouseDown(within(screen.getByTestId("map-to-suggestions")).getByText("Gondia"));

    fireEvent.click(screen.getByTestId("map-route-submit"));

    await waitFor(() => expect(mocked.getRoute).toHaveBeenCalled());
    // The id is what stops "Gondia" resolving to the district or the station.
    expect(mocked.getRoute).toHaveBeenCalledWith(
      "Balaghat",
      "Gondia, Maharashtra, India",
      true,
      "driving",
      expect.objectContaining({ toPlaceId: "ChIJgondia" })
    );
  });

  it("drops the Place ID when the field is edited by hand", async () => {
    mocked.autocompletePlaces.mockResolvedValue({
      success: true,
      data: { value: [GONDIA_SUGGESTION], meta: liveMeta() },
      timestamp: ts(),
    } as never);
    mocked.getRoute.mockResolvedValue({
      success: true,
      data: { value: null, meta: { ...liveMeta(), freshness: "UNAVAILABLE", reason: "no route" } },
      timestamp: ts(),
    } as never);

    installGeolocation({ current: NAGPUR });
    render(<MapWidget />);
    await openPanel("route");

    fireEvent.change(screen.getByTestId("map-to"), { target: { value: "Gondia" } });
    await waitFor(() => expect(screen.getByTestId("map-to-suggestions")).toBeInTheDocument());
    fireEvent.mouseDown(within(screen.getByTestId("map-to-suggestions")).getByText("Gondia"));
    await waitFor(() =>
      expect(screen.getByTestId("map-to")).toHaveValue("Gondia, Maharashtra, India")
    );

    // Typing over it makes the stored id name a different place from the text.
    fireEvent.change(screen.getByTestId("map-to"), { target: { value: "Nagpur" } });
    fireEvent.click(screen.getByTestId("map-route-submit"));

    await waitFor(() => expect(mocked.getRoute).toHaveBeenCalled());
    const ids = mocked.getRoute.mock.calls[0]![4];
    expect(ids).not.toHaveProperty("toPlaceId");
  });
});

// ---------------------------------------------------------------------------

describe("routing and search results", () => {
  it("draws the route on the real map and reports distance and duration", async () => {
    mocked.getRoute.mockResolvedValue({
      success: true,
      data: {
        value: {
          from: { name: "Balaghat, MP", latitude: 21.8, longitude: 80.18, attribution: "g" },
          to: { name: "Gondia, MH", latitude: 21.46, longitude: 80.19, attribution: "g" },
          distanceKm: 61.2,
          durationMinutes: 70,
          geometry: [
            [80.18, 21.8],
            [80.185, 21.6],
            [80.19, 21.46],
          ],
          attribution: "g",
        },
        meta: liveMeta(),
      },
      timestamp: ts(),
    } as never);

    installGeolocation({ current: NAGPUR });
    render(<MapWidget />);
    await openPanel("route");

    fireEvent.change(screen.getByTestId("map-from"), { target: { value: "Balaghat" } });
    fireEvent.change(screen.getByTestId("map-to"), { target: { value: "Gondia" } });
    fireEvent.click(screen.getByTestId("map-route-submit"));

    await waitFor(() => expect(screen.getByTestId("route-result")).toBeInTheDocument());
    expect(screen.getByTestId("route-result")).toHaveTextContent("61.2");
    expect(screen.getByTestId("route-result")).toHaveTextContent("1h 10m");
    // Drawn, not just described.
    expect(created.polylines).toHaveLength(1);
  });

  it("draws NO polyline when the provider returned no path", async () => {
    mocked.getRoute.mockResolvedValue({
      success: true,
      data: {
        value: {
          from: { name: "A", latitude: 1, longitude: 1, attribution: "g" },
          to: { name: "B", latitude: 2, longitude: 2, attribution: "g" },
          distanceKm: 10,
          durationMinutes: 10,
          attribution: "g",
        },
        meta: liveMeta(),
      },
      timestamp: ts(),
    } as never);

    installGeolocation({ current: NAGPUR });
    render(<MapWidget />);
    await openPanel("route");

    fireEvent.change(screen.getByTestId("map-from"), { target: { value: "A" } });
    fireEvent.change(screen.getByTestId("map-to"), { target: { value: "B" } });
    fireEvent.click(screen.getByTestId("map-route-submit"));

    await waitFor(() => expect(screen.getByTestId("route-result")).toBeInTheDocument());
    // A straight line between two points would imply a road that isn't there.
    const polyline = created.polylines[0] as { opts: { path: unknown[] } } | undefined;
    expect(polyline?.opts.path).toHaveLength(0);
  });

  it("shows the provider's reason instead of an empty result", async () => {
    mocked.getRoute.mockResolvedValue({
      success: true,
      data: {
        value: null,
        meta: {
          ...liveMeta(),
          freshness: "UNAVAILABLE",
          reason: "The Google Maps quota for this project has been exceeded.",
        },
      },
      timestamp: ts(),
    } as never);

    installGeolocation({ current: NAGPUR });
    render(<MapWidget />);
    await openPanel("route");

    fireEvent.change(screen.getByTestId("map-from"), { target: { value: "A" } });
    fireEvent.change(screen.getByTestId("map-to"), { target: { value: "B" } });
    fireEvent.click(screen.getByTestId("map-route-submit"));

    await waitFor(() => expect(screen.getByText(/quota/i)).toBeInTheDocument());
  });

  it("names the provider that answered", async () => {
    mocked.searchPlaces.mockResolvedValue({
      success: true,
      data: {
        value: [{ name: "Gondia", latitude: 21.46, longitude: 80.19, attribution: "osm" }],
        meta: liveMeta("OpenStreetMap / Nominatim"),
      },
      timestamp: ts(),
    } as never);

    installGeolocation({ current: NAGPUR });
    render(<MapWidget />);
    await openPanel("search");
    fireEvent.change(screen.getByTestId("map-query"), { target: { value: "Gondia" } });
    fireEvent.click(screen.getByTestId("map-search-submit"));

    await waitFor(() => expect(screen.getByTestId("map-attribution")).toBeInTheDocument());
    // An OpenStreetMap result is never labelled as a Google one.
    expect(screen.getByTestId("map-attribution")).toHaveTextContent("OpenStreetMap");
  });

  it("disables non-driving modes when only OpenStreetMap routing is available", async () => {
    mocked.getMapsConfig.mockResolvedValue({
      success: true,
      data: {
        browserKey: "browser-key",
        mapsAvailable: true,
        serverGeoAvailable: false,
        reason: "no server key",
      },
      timestamp: ts(),
    } as never);

    installGeolocation({ current: NAGPUR });
    render(<MapWidget />);
    await openPanel("route");

    // OSRM's public server is driving-only; the control says so rather than
    // silently answering for a different mode.
    expect(screen.getByTestId("map-mode-travel-walking")).toBeDisabled();
    expect(screen.getByTestId("map-mode-travel-driving")).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------

describe("collapsible controls", () => {
  it("shows NEITHER form until a button is pressed", async () => {
    installGeolocation({ current: NAGPUR });
    render(<MapWidget />);
    await waitFor(() => expect(created.maps).toHaveLength(1));

    // The whole reason for this: the widget is two cells tall, and the route
    // form plus travel-mode row left the map around 110px.
    expect(screen.queryByTestId("map-from")).toBeNull();
    expect(screen.queryByTestId("map-to")).toBeNull();
    expect(screen.queryByTestId("map-query")).toBeNull();
    // The map is there from the start regardless.
    expect(screen.getByTestId("google-map")).toBeInTheDocument();
  });

  it("opens the route form on ROUTE and the search box on FIND", async () => {
    installGeolocation({ current: NAGPUR });
    render(<MapWidget />);
    await waitFor(() => expect(created.maps).toHaveLength(1));

    await openPanel("route");
    expect(screen.getByTestId("map-from")).toBeInTheDocument();
    expect(screen.queryByTestId("map-query")).toBeNull();

    await openPanel("search");
    expect(screen.getByTestId("map-query")).toBeInTheDocument();
    // Only one panel at a time — two open forms would leave no map at all.
    expect(screen.queryByTestId("map-from")).toBeNull();
  });

  it("closes the open panel when its own button is pressed again", async () => {
    installGeolocation({ current: NAGPUR });
    render(<MapWidget />);
    await waitFor(() => expect(created.maps).toHaveLength(1));

    await openPanel("route");
    fireEvent.click(screen.getByTestId("map-mode-route"));

    // This is how the map gets its height back; there is no separate close
    // control, so the toggle has to work in both directions.
    await waitFor(() => expect(screen.queryByTestId("map-to")).toBeNull());
    expect(screen.getByTestId("map-mode-route")).toHaveAttribute("aria-pressed", "false");
  });

  it("reports its state to assistive technology", async () => {
    installGeolocation({ current: NAGPUR });
    render(<MapWidget />);
    await waitFor(() => expect(created.maps).toHaveLength(1));

    expect(screen.getByTestId("map-mode-route")).toHaveAttribute("aria-expanded", "false");
    await openPanel("route");
    expect(screen.getByTestId("map-mode-route")).toHaveAttribute("aria-expanded", "true");
  });

  it("closes the form once a route comes back, so the map draws it full height", async () => {
    mocked.getRoute.mockResolvedValue({
      success: true,
      data: {
        value: {
          from: { name: "Balaghat", latitude: 21.8, longitude: 80.18, attribution: "g" },
          to: { name: "Gondia", latitude: 21.46, longitude: 80.19, attribution: "g" },
          distanceKm: 43.7,
          durationMinutes: 64,
          geometry: [
            [80.18, 21.8],
            [80.19, 21.46],
          ],
          attribution: "g",
        },
        meta: liveMeta(),
      },
      timestamp: ts(),
    } as never);

    installGeolocation({ current: NAGPUR });
    render(<MapWidget />);
    await waitFor(() => expect(created.maps).toHaveLength(1));
    await openPanel("route");

    fireEvent.change(screen.getByTestId("map-from"), { target: { value: "Balaghat" } });
    fireEvent.change(screen.getByTestId("map-to"), { target: { value: "Gondia" } });
    fireEvent.click(screen.getByTestId("map-route-submit"));

    await waitFor(() => expect(screen.getByTestId("route-result")).toBeInTheDocument());
    // The answer is a drawn route; the form would be sitting on top of it.
    expect(screen.queryByTestId("map-to")).toBeNull();
    expect(screen.getByTestId("route-result")).toHaveTextContent("43.7");
  });

  it("closes the search box once a place is picked", async () => {
    mocked.autocompletePlaces.mockResolvedValue({
      success: true,
      data: {
        value: [
          {
            placeId: "ChIJgondia",
            description: "Gondia, Maharashtra, India",
            primary: "Gondia",
            secondary: "Maharashtra, India",
          },
        ],
        meta: liveMeta(),
      },
      timestamp: ts(),
    } as never);
    mocked.resolvePlace.mockResolvedValue({
      success: true,
      data: {
        value: { name: "Gondia", latitude: 21.46, longitude: 80.19, attribution: "g" },
        meta: liveMeta(),
      },
      timestamp: ts(),
    } as never);

    installGeolocation({ current: NAGPUR });
    render(<MapWidget />);
    await waitFor(() => expect(created.maps).toHaveLength(1));
    await openPanel("search");

    fireEvent.change(screen.getByTestId("map-query"), { target: { value: "Gondia" } });
    await waitFor(() => expect(screen.getByTestId("map-query-suggestions")).toBeInTheDocument());
    fireEvent.mouseDown(within(screen.getByTestId("map-query-suggestions")).getByText("Gondia"));

    // Picking a place IS the answer — it belongs on a full-height map.
    await waitFor(() => expect(screen.queryByTestId("map-query")).toBeNull());
    expect(created.markers.length).toBeGreaterThan(0);
  });
});
