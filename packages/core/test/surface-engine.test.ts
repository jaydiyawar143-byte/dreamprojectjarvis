// ---------------------------------------------------------------------------
// Contextual surface engine.
//
// Three things are worth defending here, and they are not equally important.
//
//   1. THE ENGINE NEVER INVENTS DATA. By far the most important. A surface is
//      built from tool output or it is not built. Most of this file is that
//      one property, approached from several directions.
//   2. The intent rules pick the right panel, including in Hinglish, and
//      decline for questions that do not need one at all.
//   3. Reuse and topic change resolve to the same panel or a different one.
//
// The schema is exercised throughout rather than in one place: every surface
// this file produces has been through `SurfaceSchema`, because `decideSurface`
// refuses to emit one that has not.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import type { ToolExecutionResult } from "../src/types/execution.js";
import { decideSurface } from "../src/surface-decision.js";
import { detectVisualIntent, isFollowUp } from "../src/surface-intent.js";
import { MAX_ACTIVE_SURFACES, SURFACE_REGISTRY } from "../src/surface-registry.js";
import { SURFACE_TYPES, parseSurfaceDirective } from "../src/types/surface.js";

// A completed tool execution carrying `data`.
const ok = (toolId: string, data: unknown, metadata?: Record<string, unknown>): ToolExecutionResult => ({
  executionId: `x-${toolId}`,
  toolId,
  status: "completed",
  result: { success: true, data, ...(metadata ? { metadata } : {}) },
  startedAt: new Date(),
  completedAt: new Date(),
});

// A tool that ran and failed — distinct from one that never ran.
const failed = (toolId: string, error: string): ToolExecutionResult => ({
  executionId: `x-${toolId}`,
  toolId,
  status: "failed",
  result: { success: false, error },
  startedAt: new Date(),
});

const ROUTE_TOOL_OUTPUT = {
  route: {
    from: { name: "Balaghat", latitude: 21.8, longitude: 80.18 },
    to: { name: "Gondia", latitude: 21.46, longitude: 80.19 },
    distanceKm: 62.4,
    durationMinutes: 84,
    summary: "via NH 543",
    geometry: [
      [21.8, 80.18],
      [21.6, 80.2],
      [21.46, 80.19],
    ],
    attribution: "Google Maps",
    alternatives: [
      { distanceKm: 58.1, durationMinutes: 97, summary: "via SH 26", geometry: [[21.8, 80.18], [21.46, 80.19]] },
    ],
  },
};

const decide = (message: string, toolResults: ToolExecutionResult[] = [], activeContextKeys: string[] = []) =>
  decideSurface({
    message,
    toolResults,
    activeContextKeys,
    idFactory: () => "sfc-test",
    now: new Date("2026-09-10T12:00:00Z"),
  });

// ---------------------------------------------------------------------------
// The rule that matters
// ---------------------------------------------------------------------------

describe("the engine never invents data", () => {
  it("opens NO route surface when the route tool did not run", () => {
    // The single most important assertion in this file. The user clearly asked
    // for a route; there is no route data; the correct output is a spoken
    // answer and no map, NOT a map with a plausible line drawn on it.
    const { directive } = decide("Balaghat se Gondia jaane ka best route kya hai?");
    expect(directive).toBeNull();
  });

  it("opens an HONEST failure surface when the provider failed", () => {
    const { directive } = decide(
      "Balaghat se Gondia ka route batao",
      [failed("maps.route", "Google Maps could not be reached.")]
    );
    expect(directive?.op).toBe("open");
    if (directive?.op !== "open") throw new Error("expected open");
    expect(directive.surface.type).toBe("unavailable");
    expect(directive.surface.data).toMatchObject({
      kind: "unavailable",
      reason: "Google Maps could not be reached.",
    });
  });

  it("opens no market surface without a market tool result", () => {
    expect(decide("aaj Solana ka kya price hai?").directive).toBeNull();
  });

  it("reports the provider that actually answered, not a guess", () => {
    const { directive } = decide(
      "solana price",
      [ok("market.quote", { quotes: [{ symbol: "SOL", name: "Solana", price: 101.7, currency: "USD", changePct24h: -2.5 }] }, { source: "CoinGecko", observedAt: "2026-09-10T11:59:00.000Z" })]
    );
    if (directive?.op !== "open") throw new Error("expected open");
    expect(directive.surface.data).toMatchObject({
      provenance: { source: "CoinGecko", observedAt: "2026-09-10T11:59:00.000Z" },
    });
  });

  it("keeps an absent sensor as null rather than zero", () => {
    // A zero is a measurement. "No sensor is exposed by this system" is not,
    // and collapsing the two is how a user comes to believe their GPU is idle.
    const { directive } = decide("mera system kaisa chal raha hai", [
      ok("system.status", {
        system: {
          model: "Test CPU",
          uptimeSeconds: 100,
          metrics: [
            { label: "CPU", value: 42, unit: "%", reason: null },
            { label: "GPU", value: null, unit: "%", reason: "No sensor is exposed by this system" },
          ],
        },
      }),
    ]);
    if (directive?.op !== "open") throw new Error("expected open");
    const data = directive.surface.data as { kind: string; metrics: Array<{ label: string; value: number | null }> };
    expect(data.metrics.find((m) => m.label === "GPU")?.value).toBeNull();
  });

  it("never claims tolls the provider did not report", () => {
    // The route provider does not return toll information. "Unknown" is the
    // only honest value; `false` would be a claim.
    const { directive } = decide("Balaghat se Gondia route", [ok("maps.route", ROUTE_TOOL_OUTPUT)]);
    if (directive?.op !== "open") throw new Error("expected open");
    const data = directive.surface.data as { kind: string; routes: Array<{ hasTolls: boolean | null }> };
    for (const r of data.routes) expect(r.hasTolls).toBeNull();
  });

  it("justifies a recommendation only in time and distance", () => {
    // Anything about safety, road quality or "traffic later" is not derivable
    // from what the provider returned, so it must never appear.
    const { directive } = decide("Balaghat se Gondia route", [ok("maps.route", ROUTE_TOOL_OUTPUT)]);
    if (directive?.op !== "open") throw new Error("expected open");
    const data = directive.surface.data as { routes: Array<{ recommendationReason: string | null }> };
    const reasons = data.routes.map((r) => r.recommendationReason).filter(Boolean).join(" ");

    expect(reasons).toMatch(/fastest|shortest|min/i);
    expect(reasons).not.toMatch(/safe|safer|better road|scenic|traffic later|smoother/i);
  });
});

// ---------------------------------------------------------------------------
// Choosing the surface
// ---------------------------------------------------------------------------

describe("visual intent", () => {
  it("recognises the Hinglish the product is actually spoken to", () => {
    expect(detectVisualIntent("JARVIS, abhi kya time hua hai?").intent).toBe("TIME");
    expect(detectVisualIntent("Balaghat se Gondia jaane ka best route kya hai?").intent).toBe("ROUTE");
    expect(detectVisualIntent("aaj Solana ka kya price hai?").intent).toBe("MARKET_PRICE");
    expect(detectVisualIntent("Solana mein invest karna chahiye?").intent).toBe("MARKET_ANALYSIS");
    expect(detectVisualIntent("aaj mausam kaisa hai?").intent).toBe("WEATHER");
  });

  it("opens NOTHING for a question a panel cannot improve", () => {
    // The discipline the whole feature depends on. A dashboard that throws a
    // panel at every reply is worse than one that never does.
    for (const q of ["2 + 2 kitna hota hai?", "who wrote Hamlet", "thanks", "explain recursion"]) {
      expect(detectVisualIntent(q).intent).toBe("NONE");
      expect(decide(q).directive).toBeNull();
    }
  });

  it("does not mistake 'how much time will the route take' for a clock", () => {
    // Both sentences contain "time". Only one of them is about a clock, and
    // covering a map with a clock would be a visible bug.
    expect(detectVisualIntent("Gondia pahunchne mein kitna time lagega?").intent).not.toBe("TIME");
    expect(detectVisualIntent("route mein kitna samay lagega").intent).not.toBe("TIME");
  });

  it("prefers analysis over price when the user asks whether to buy", () => {
    expect(detectVisualIntent("Solana mein invest karna chahiye?").intent).toBe("MARKET_ANALYSIS");
    expect(detectVisualIntent("bitcoin buy karna chahiye kya").intent).toBe("MARKET_ANALYSIS");
  });

  it("does not open a price card for 'should I invest time in this'", () => {
    expect(detectVisualIntent("should I invest time in learning rust").intent).toBe("NONE");
  });

  it("recognises an explicit dismissal", () => {
    for (const q of ["close the map", "band karo", "close it"]) {
      expect(detectVisualIntent(q).intent).toBe("CLOSE_SURFACE");
    }
  });
});

describe("follow-ups", () => {
  it("treats a bare continuation as belonging to what is on screen", () => {
    for (const q of ["London ka?", "Tokyo bhi", "alternative route dikhao", "isme toll hai?", "compare dono"]) {
      expect(isFollowUp(q)).toBe(true);
    }
  });

  it("does not treat a fresh, complete question as a follow-up", () => {
    expect(isFollowUp("Balaghat se Gondia jaane ka sabse accha route kaunsa hai bhai")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

describe("clock", () => {
  it("opens on a time question with no tool at all", () => {
    // The only surface that needs no provider: the client owns the clock.
    const { directive } = decide("abhi kya time hua hai?");
    if (directive?.op !== "open") throw new Error("expected open");
    expect(directive.surface.type).toBe("clock");
    expect(directive.surface.data).toMatchObject({ kind: "clock" });
  });

  it("ships ZONES, never a timestamp", () => {
    // A time serialised on the server is stale on arrival and visibly wrong
    // within a minute. The client renders from its own clock.
    const { directive } = decide("what time is it");
    if (directive?.op !== "open") throw new Error("expected open");
    const data = directive.surface.data as { kind: string; zones: Array<{ timeZone: string; offsetMinutes: number }> };
    expect(data.zones.length).toBeGreaterThan(0);
    expect(JSON.stringify(directive.surface)).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it("becomes a world clock when more than one city is named", () => {
    const { directive } = decide("London aur Tokyo ka time?");
    if (directive?.op !== "open") throw new Error("expected open");
    expect(directive.surface.type).toBe("world-clock");
    const data = directive.surface.data as { zones: Array<{ label: string }> };
    expect(data.zones.length).toBeGreaterThanOrEqual(2);
  });

  it("closes itself after a short idle, because a clock is read at a glance", () => {
    const { directive } = decide("what time is it");
    if (directive?.op !== "open") throw new Error("expected open");
    expect(directive.surface.autoClose).toEqual({ enabled: true, idleSeconds: 5 });
  });
});

// ---------------------------------------------------------------------------
// Reuse, replacement and topic change
// ---------------------------------------------------------------------------

describe("surface reuse", () => {
  it("UPDATES rather than opening a second panel on the same subject", () => {
    // "Bitcoin ka bhi" must widen the market card, not stack a second one.
    const first = decide("solana price", [ok("market.quote", { quotes: [{ symbol: "SOL", name: "Solana", price: 101, currency: "USD", changePct24h: 1 }] })]);
    if (first.directive?.op !== "open") throw new Error("expected open");

    const second = decide(
      "bitcoin ka bhi price batao",
      [ok("market.quote", { quotes: [
        { symbol: "SOL", name: "Solana", price: 101, currency: "USD", changePct24h: 1 },
        { symbol: "BTC", name: "Bitcoin", price: 78000, currency: "USD", changePct24h: -1 },
      ] })],
      [first.directive.surface.contextKey]
    );
    expect(second.directive?.op).toBe("update");
  });

  it("keys a route on the JOURNEY, so a follow-up lands on the same map", () => {
    const a = decide("Balaghat se Gondia route", [ok("maps.route", ROUTE_TOOL_OUTPUT)]);
    const b = decide("alternative route dikhao", [ok("maps.route", ROUTE_TOOL_OUTPUT)]);
    if (a.directive?.op !== "open" || b.directive?.op !== "open") throw new Error("expected opens");
    expect(a.directive.surface.contextKey).toBe(b.directive.surface.contextKey);
  });

  it("treats a different subject as a different surface", () => {
    // The topic-change case: a clock while a market card is up is not a reuse.
    const market = decide("solana price", [ok("market.quote", { quotes: [{ symbol: "SOL", name: "Solana", price: 101, currency: "USD", changePct24h: 1 }] })]);
    if (market.directive?.op !== "open") throw new Error("expected open");

    const clock = decide("abhi kya time hai?", [], [market.directive.surface.contextKey]);
    expect(clock.directive?.op).toBe("open");
    if (clock.directive?.op !== "open") throw new Error("expected open");
    expect(clock.directive.surface.contextKey).not.toBe(market.directive.surface.contextKey);
  });

  it("closes on request, without needing to know what is open", () => {
    const { directive } = decide("close the map");
    expect(directive?.op).toBe("close");
  });
});

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

describe("investment analysis", () => {
  const quote = ok("market.quote", {
    quotes: [{ symbol: "SOL", name: "Solana", price: 101.7, currency: "USD", changePct24h: -2.5 }],
  });

  it("does not auto-close a body of reasoning", () => {
    // Reading is not inactivity. A five-second timer on an analysis panel
    // closes it in the middle of the bear case.
    const { directive } = decide("Solana mein invest karna chahiye?", [quote]);
    if (directive?.op !== "open") throw new Error("expected open");
    expect(directive.surface.autoClose.enabled).toBe(false);
    expect(directive.surface.mode).toBe("analysis");
  });

  it("still carries the real price and its source", () => {
    const { directive } = decide("Solana mein invest karna chahiye?", [quote]);
    if (directive?.op !== "open") throw new Error("expected open");
    const data = directive.surface.data as { quotes: Array<{ price: number | null }>; provenance: { source: string } };
    expect(data.quotes[0]?.price).toBe(101.7);
    expect(data.provenance.source).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

describe("security", () => {
  it("rejects a directive carrying markup", () => {
    // The boundary. There is no field for HTML, so a payload that smuggles one
    // fails `.strict()` rather than reaching a renderer.
    const attempt = {
      op: "open",
      surface: {
        surfaceId: "x",
        type: "clock",
        mode: "glance",
        title: "Clock",
        contextKey: "clock",
        autoClose: { enabled: true, idleSeconds: 5 },
        position: { anchor: "center" },
        data: { kind: "clock", zones: [{ label: "UTC", timeZone: "UTC", offsetMinutes: 0 }] },
        reason: "test",
        html: "<img src=x onerror=alert(1)>",
      },
    };
    const parsed = parseSurfaceDirective(attempt);
    expect(parsed.ok).toBe(false);
  });

  it("rejects an unknown surface type", () => {
    const parsed = parseSurfaceDirective({
      op: "open",
      surface: {
        surfaceId: "x",
        type: "arbitrary-iframe",
        mode: "glance",
        title: "x",
        contextKey: "x",
        autoClose: { enabled: true, idleSeconds: 5 },
        position: { anchor: "center" },
        data: { kind: "clock", zones: [{ label: "UTC", timeZone: "UTC", offsetMinutes: 0 }] },
        reason: "x",
      },
    });
    expect(parsed.ok).toBe(false);
  });

  it("rejects a surface whose data does not match its declared type", () => {
    const parsed = parseSurfaceDirective({
      op: "open",
      surface: {
        surfaceId: "x",
        type: "route",
        mode: "interactive",
        title: "x",
        contextKey: "x",
        autoClose: { enabled: false, idleSeconds: 60 },
        position: { anchor: "center" },
        data: { kind: "nonsense" },
        reason: "x",
      },
    });
    expect(parsed.ok).toBe(false);
  });

  it("never lets an absurd idle timeout through", () => {
    const parsed = parseSurfaceDirective({
      op: "open",
      surface: {
        surfaceId: "x",
        type: "clock",
        mode: "glance",
        title: "x",
        contextKey: "x",
        autoClose: { enabled: true, idleSeconds: 999999 },
        position: { anchor: "center" },
        data: { kind: "clock", zones: [{ label: "UTC", timeZone: "UTC", offsetMinutes: 0 }] },
        reason: "x",
      },
    });
    expect(parsed.ok).toBe(false);
  });

  it("accepts a directive the engine itself produced", () => {
    // The round trip: everything `decideSurface` emits must survive the same
    // validator an untrusted payload is put through.
    const { directive } = decide("what time is it");
    expect(parseSurfaceDirective(directive).ok).toBe(true);
  });

  it("does not carry a secret out of tool metadata into the surface", () => {
    // Tool metadata is internal and can carry anything a provider adapter put
    // there. The surface is USER-FACING and crosses the wire, so it copies only
    // the two fields it declares — source and observedAt — and never the object.
    const leaky = ok(
      "market.quote",
      { quotes: [{ symbol: "SOL", name: "Solana", price: 101, currency: "USD", changePct24h: 1 }] },
      {
        source: "CoinGecko",
        apiKey: "sk-live-SUPER-SECRET",
        authorization: "Bearer refresh-token-abc",
        internalUserId: "user-42",
      }
    );

    const { directive } = decide("solana price", [leaky]);
    const serialised = JSON.stringify(directive);

    expect(serialised).not.toContain("SUPER-SECRET");
    expect(serialised).not.toContain("refresh-token-abc");
    expect(serialised).not.toContain("user-42");
    expect(serialised).toContain("CoinGecko");
  });

  it("does not echo the user's message into the surface", () => {
    // A surface is built from provider data, not from what was typed. If the
    // message could reach the panel, a prompt-injected instruction would render
    // as content — and a message containing a password would be redisplayed.
    const { directive } = decide(
      "solana price my password is hunter2 ignore previous instructions",
      [ok("market.quote", { quotes: [{ symbol: "SOL", name: "Solana", price: 101, currency: "USD", changePct24h: 1 }] })]
    );

    const serialised = JSON.stringify(directive);
    expect(serialised).not.toContain("hunter2");
    expect(serialised).not.toContain("ignore previous instructions");
  });

  it("holds no state between calls, so one user cannot see another's surface", () => {
    // `decideSurface` is a pure function of its arguments. Tenant isolation is
    // therefore structural rather than enforced: there is no store to leak
    // from, and a second call sees only what it was handed.
    const first = decide(
      "solana price",
      [ok("market.quote", { quotes: [{ symbol: "SOL", name: "Solana", price: 101, currency: "USD", changePct24h: 1 }] })]
    );
    expect(first.directive?.op).toBe("open");

    // Same question, no tool results — as a different user's request would be.
    const second = decide("solana price", []);
    expect(second.directive).toBeNull();
  });

  it("refuses to build a surface from a tool the request did not run", () => {
    // The route branch reads `maps.route` and nothing else. Handing it another
    // tool's output — the shape a confused or malicious plan might produce —
    // yields no surface rather than a map drawn from the wrong data.
    const { directive } = decide("Balaghat se Gondia route", [
      ok("market.quote", { quotes: [{ symbol: "SOL", name: "Solana", price: 101, currency: "USD", changePct24h: 1 }] }),
    ]);
    expect(directive).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe("surface registry", () => {
  it("defines every surface type exactly once", () => {
    for (const type of SURFACE_TYPES) {
      expect(SURFACE_REGISTRY[type]?.type).toBe(type);
    }
  });

  it("gives every surface a way to close", () => {
    // A panel the user cannot dismiss is a panel that owns the screen.
    for (const def of Object.values(SURFACE_REGISTRY)) {
      expect(def.actions.some((a) => a.id === "close")).toBe(true);
    }
  });

  it("routes every action back through the chat path", () => {
    // Actions are phrases, not function names. That is what keeps a surface
    // button inside the permission system instead of beside it.
    for (const def of Object.values(SURFACE_REGISTRY)) {
      for (const action of def.actions) {
        expect(typeof action.intent).toBe("string");
        expect(action.intent.length).toBeGreaterThan(0);
      }
    }
  });

  it("gives reading surfaces longer than glancing ones", () => {
    expect(SURFACE_REGISTRY.knowledge.idleSeconds).toBeGreaterThan(SURFACE_REGISTRY.clock.idleSeconds);
    expect(SURFACE_REGISTRY.clock.idleSeconds).toBe(5);
  });

  it("never auto-closes a surface the user works inside", () => {
    expect(SURFACE_REGISTRY.map.autoClose).toBe(false);
    expect(SURFACE_REGISTRY.route.autoClose).toBe(false);
  });

  it("caps the screen at two contextual surfaces", () => {
    expect(MAX_ACTIVE_SURFACES).toBe(2);
  });
});
