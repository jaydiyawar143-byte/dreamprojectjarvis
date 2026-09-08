// ---------------------------------------------------------------------------
// V3 — the data-honesty contract.
//
// These tests are about ONE product rule: never present a number JARVIS does
// not have, and never present an old number as current. That rule is easy to
// state and easy to erode one widget at a time, so it is pinned here at the
// layer every widget shares.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  classifyAge,
  meta,
  unavailable,
  TtlCache,
} from "../src/services/providers/freshness.js";
import {
  collectFast,
  snapshot,
  __resetSystemMonitor,
} from "../src/services/providers/system-monitor.js";
import {
  isIndicesConfigured,
  createIndicesConfig,
  getIndianIndices,
} from "../src/services/providers/market-provider.js";

// ---------------------------------------------------------------------------

describe("freshness classification", () => {
  const thresholds = { liveWithin: 60, delayedWithin: 600 };

  it("grades by age against the provider's own expectations", () => {
    expect(classifyAge(0, thresholds)).toBe("LIVE");
    expect(classifyAge(60, thresholds)).toBe("LIVE");
    expect(classifyAge(61, thresholds)).toBe("DELAYED");
    expect(classifyAge(600, thresholds)).toBe("DELAYED");
    expect(classifyAge(601, thresholds)).toBe("STALE");
  });

  it("reports the age of the OBSERVATION, not of the fetch", () => {
    // The distinction that makes cached data honest: serving a value from cache
    // must not reset its age, or a ten-minute-old price reads as fresh.
    const observed = new Date(Date.now() - 300_000);
    const m = meta(observed, "Test", thresholds, { cached: true });

    expect(m.ageSeconds).toBeGreaterThanOrEqual(299);
    expect(m.freshness).toBe("DELAYED");
    expect(m.cached).toBe(true);
    expect(m.observedAt).toBe(observed.toISOString());
  });

  it("returns null data — never a zeroed shape — when unavailable", () => {
    const result = unavailable("Test", "No sensor");
    // A caller destructuring a zeroed object is exactly how "0°C" reaches the
    // screen for a missing sensor.
    expect(result.data).toBeNull();
    expect(result.meta.freshness).toBe("UNAVAILABLE");
    expect(result.meta.reason).toBe("No sensor");
  });
});

describe("provider cache", () => {
  it("marks entries expired without discarding them", () => {
    // Expired-but-present is what lets a widget show DELAYED data when upstream
    // is down, instead of going blank.
    const cache = new TtlCache<string>(0);
    cache.set("k", "value");
    const hit = cache.get("k");
    expect(hit?.value).toBe("value");
    expect(hit?.expired).toBe(true);
  });

  it("is bounded, so a long-lived process cannot grow it without limit", () => {
    const cache = new TtlCache<number>(60_000, 3);
    for (let i = 0; i < 10; i++) cache.set(`k${i}`, i);
    // The oldest keys were evicted; the newest survive.
    expect(cache.get("k0")).toBeNull();
    expect(cache.get("k9")?.value).toBe(9);
  });
});

// ---------------------------------------------------------------------------

describe("system monitor", () => {
  beforeEach(() => __resetSystemMonitor());
  afterEach(() => __resetSystemMonitor());

  it("refuses to report a CPU figure before it has two samples", () => {
    // Load is a DELTA. The first reading has no baseline, and 0 would read as
    // "idle" — a different claim from "not measured yet".
    const first = collectFast();
    expect(first.cpuLoadPct.value).toBeNull();
    expect(first.cpuLoadPct.reason).toContain("second sample");
  });

  it("reports a real percentage once a baseline exists", () => {
    collectFast();
    const second = collectFast();
    // Either a number in range, or an honest null — never a fabricated 0.
    if (second.cpuLoadPct.value !== null) {
      expect(second.cpuLoadPct.value).toBeGreaterThanOrEqual(0);
      expect(second.cpuLoadPct.value).toBeLessThanOrEqual(100);
    } else {
      expect(second.cpuLoadPct.reason).toBeTruthy();
    }
  });

  it("always reports memory, which needs no sensor", () => {
    const m = collectFast().memory;
    expect(m.totalBytes).toBeGreaterThan(0);
    expect(m.usedPct).toBeGreaterThanOrEqual(0);
    expect(m.usedPct).toBeLessThanOrEqual(100);
  });

  it("gives every absent metric a REASON rather than a zero", () => {
    const snap = snapshot();

    // On hardware without sensors these are null. Whichever way they come back,
    // the invariant is the same: a null must be explained, and must never be
    // silently substituted with 0.
    for (const [name, metric] of [
      ["cpu temperature", snap.cpu.temperatureC],
      ["gpu utilization", snap.gpu.utilizationPct],
      ["gpu memory", snap.gpu.memoryUsedMB],
      ["gpu temperature", snap.gpu.temperatureC],
    ] as const) {
      if (metric.value === null) {
        expect(metric.reason, `${name} must explain its absence`).toBeTruthy();
      } else {
        expect(typeof metric.value, name).toBe("number");
      }
    }
  });

  it("states whether it is describing a container or the host", () => {
    // Docker reports the CONTAINER. A reader must not mistake container memory
    // for their laptop's.
    expect(typeof snapshot().containerized).toBe("boolean");
  });

  it("exposes no command execution surface", async () => {
    // This module reads counters. If it ever grows a shell, this fails.
    const source = await import("fs").then((fs) =>
      fs.readFileSync(new URL("../src/services/providers/system-monitor.ts", import.meta.url), "utf8")
    );
    expect(source).not.toMatch(/child_process|execSync|spawn\(|exec\(/);
  });
});

// ---------------------------------------------------------------------------

describe("Indian indices", () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  it("is unconfigured unless BOTH the url and the key are present", () => {
    expect(isIndicesConfigured({})).toBe(false);
    expect(isIndicesConfigured({ MARKET_INDICES_API_URL: "https://x" })).toBe(false);
    expect(isIndicesConfigured({ MARKET_INDICES_API_KEY: "k" })).toBe(false);
    expect(
      isIndicesConfigured({ MARKET_INDICES_API_URL: "https://x", MARKET_INDICES_API_KEY: "k" })
    ).toBe(true);
  });

  it("reports UNAVAILABLE with an actionable reason, never a number", async () => {
    // The load-bearing test for this feature. Real-time NIFTY is licensed data;
    // with no provider the only honest answer is "no value", and the reason has
    // to name what would fix it.
    const result = await getIndianIndices(null);

    expect(result.data).toBeNull();
    expect(result.meta.freshness).toBe("UNAVAILABLE");
    expect(result.meta.reason).toMatch(/licensed/i);
    expect(result.meta.reason).toContain("MARKET_INDICES_API_URL");
  });

  it("never falls back to scraping when unconfigured", async () => {
    // A fetch here would mean the provider quietly reached for an unofficial
    // endpoint, which is exactly what was ruled out.
    const spy = vi.spyOn(globalThis, "fetch");
    await getIndianIndices(null);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("builds a config only from server-side environment", () => {
    const config = createIndicesConfig({
      MARKET_INDICES_API_URL: "https://vendor.example/v1/",
      MARKET_INDICES_API_KEY: "secret-key",
    });
    expect(config?.baseUrl).toBe("https://vendor.example/v1");
    expect(config?.apiKey).toBe("secret-key");
  });
});
