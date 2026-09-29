// ---------------------------------------------------------------------------
// The map loader's readiness guarantee.
//
// Regression: the loading=async bootstrap callback can fire before the JSON
// runtime has attached google.maps.Map/Marker/Polyline (and before
// importLibrary is callable). The old gate trusted the callback and could
// report "ready" into a `new google.maps.Map()` TypeError. These tests assert
// the invariant the S7 fix reintroduces:
//
//   READY === Map, Marker and Polyline are ALL callable.
//
// The loader is a module-scoped singleton, so every test resets the module and
// drives a fresh instance. jsdom never executes the remote <script>, which is
// exactly what lets each test simulate the bootstrap callback firing at a
// chosen moment and then watch what happens to readiness.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return {
    ...actual,
    getMapsConfig: vi.fn(),
  };
});

const ts = () => new Date().toISOString();
const configured = (overrides: Record<string, unknown> = {}) => ({
  success: true,
  data: {
    browserKey: "browser-key",
    mapsAvailable: true,
    serverGeoAvailable: true,
    reason: "configured",
    ...overrides,
  },
  timestamp: ts(),
});

/** Plant a (partial) SDK on window.google. No constructors by default. */
function sdkWithMaps(names: ("Map" | "Marker" | "Polyline")[]) {
  const maps: Record<string, unknown> = {};
  if (names.includes("Map")) maps.Map = class Map {};
  if (names.includes("Marker")) maps.Marker = class Marker {};
  if (names.includes("Polyline")) maps.Polyline = class Polyline {};
  (globalThis as unknown as { google: unknown }).google = { maps };
}

/** Remove everything the loader or a test could leave behind. */
function teardownSdk() {
  delete (globalThis as { google?: unknown }).google;
  delete (window as unknown as { __jarvisMapsInit?: unknown }).__jarvisMapsInit;
  for (const s of Array.from(document.head.querySelectorAll('script[src*="maps.googleapis.com"]'))) {
    s.remove();
  }
}

async function freshLoader() {
  const api = await import("../src/lib/api");
  const { useGoogleMaps } = await import("../src/lib/use-google-maps");
  return { api, useGoogleMaps };
}

/** Drain microtask turns so the hook's async chain settles. */
async function flush() {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
}

/** Advance simulated time through the poll interval. */
async function passTime(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 10 });
  teardownSdk();
});

afterEach(() => {
  vi.useRealTimers();
  teardownSdk();
});

/**
 * Fire the loader's bootstrap callback the way the real async runtime does,
 * without jsdom actually running the remote script.
 */
function fireBootstrapCallback() {
  const cb = (window as unknown as { __jarvisMapsInit?: () => void }).__jarvisMapsInit;
  expect(cb).toBeTypeOf("function");
  cb?.();
}

// ---------------------------------------------------------------------------

describe("useGoogleMaps readiness", () => {
  it("is NOT ready while google.maps.Map is missing", async () => {
    const { api, useGoogleMaps } = await freshLoader();
    vi.mocked(api.getMapsConfig).mockResolvedValue(configured() as never);

    // google absent at mount -> loader appends its script and callback.
    const { result } = renderHook(() => useGoogleMaps());
    await flush();
    expect(result.current.status).toBe("loading");

    // Bootstrap callback fires before the maps library has arrived: only
    // Marker and Polyline are present.
    sdkWithMaps(["Marker", "Polyline"]);
    fireBootstrapCallback();
    await passTime(300);
    expect(result.current.status).toBe("loading");

    // Map arrives later -> ready at last.
    sdkWithMaps(["Map", "Marker", "Polyline"]);
    await passTime(300);
    expect(result.current.status).toBe("ready");
  });

  it("is NOT ready while google.maps.Marker is missing", async () => {
    const { api, useGoogleMaps } = await freshLoader();
    vi.mocked(api.getMapsConfig).mockResolvedValue(configured() as never);

    const { result } = renderHook(() => useGoogleMaps());
    await flush();
    sdkWithMaps(["Map", "Polyline"]);
    fireBootstrapCallback();

    await passTime(300);
    expect(result.current.status).toBe("loading");

    sdkWithMaps(["Map", "Marker", "Polyline"]);
    await passTime(300);
    expect(result.current.status).toBe("ready");
  });

  it("is NOT ready while google.maps.Polyline is missing", async () => {
    const { api, useGoogleMaps } = await freshLoader();
    vi.mocked(api.getMapsConfig).mockResolvedValue(configured() as never);

    const { result } = renderHook(() => useGoogleMaps());
    await flush();
    sdkWithMaps(["Map", "Marker"]);
    fireBootstrapCallback();

    await passTime(300);
    expect(result.current.status).toBe("loading");

    sdkWithMaps(["Map", "Marker", "Polyline"]);
    await passTime(300);
    expect(result.current.status).toBe("ready");
  });

  it("requires the constructor to be a FUNCTION, not merely a present key", async () => {
    const { api, useGoogleMaps } = await freshLoader();
    vi.mocked(api.getMapsConfig).mockResolvedValue(configured() as never);

    const { result } = renderHook(() => useGoogleMaps());
    await flush();
    // Map is "present" but is not callable — exactly what the async runtime can do.
    (globalThis as unknown as { google: unknown }).google = {
      maps: { Map: { placeholder: true }, Marker: class Marker {}, Polyline: class Polyline {} },
    };
    fireBootstrapCallback();

    await passTime(300);
    expect(result.current.status).toBe("loading");

    sdkWithMaps(["Map", "Marker", "Polyline"]);
    await passTime(300);
    expect(result.current.status).toBe("ready");
  });

  it("rejects when a partial SDK never grows the missing constructor", async () => {
    const { api, useGoogleMaps } = await freshLoader();
    vi.mocked(api.getMapsConfig).mockResolvedValue(configured() as never);

    const { result } = renderHook(() => useGoogleMaps());
    await flush();
    // Map never arrives.
    sdkWithMaps(["Marker", "Polyline"]);
    fireBootstrapCallback();
    expect(result.current.status).toBe("loading");

    // Beyond the 15s bound (plus slack for the 100ms poll cadence) it must
    // give up into the error state rather than stay "ready forever".
    await act(async () => {
      await passTime(16_000);
    });
    expect(result.current.status).toBe("error");
  });

  it("recovers via retry once the missing constructors finally appear", async () => {
    const { api, useGoogleMaps } = await freshLoader();
    vi.mocked(api.getMapsConfig).mockResolvedValue(configured() as never);

    const { result } = renderHook(() => useGoogleMaps());
    await flush();
    // Neither Map nor Polyline arrive.
    sdkWithMaps(["Marker"]);
    fireBootstrapCallback();
    await passTime(16_000);
    expect(result.current.status).toBe("error");

    // The SDK finally arrives in full.
    sdkWithMaps(["Map", "Marker", "Polyline"]);
    act(() => result.current.retry());
    await passTime(400);
    expect(result.current.status).toBe("ready");
  });

  it("is ready immediately on the classic runtime (constructors present, no callback)", async () => {
    const { api, useGoogleMaps } = await freshLoader();
    vi.mocked(api.getMapsConfig).mockResolvedValue(configured() as never);
    sdkWithMaps(["Map", "Marker", "Polyline"]);

    const { result } = renderHook(() => useGoogleMaps());
    await flush();
    expect(result.current.status).toBe("ready");
  });
});