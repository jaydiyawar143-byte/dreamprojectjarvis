// ---------------------------------------------------------------------------
// UI V2 — Orb state resolution and audio analysis.
//
// The renderers are WebGL and 2D canvas, neither of which jsdom can run, so
// what is tested here is the part that decides WHAT they draw: the mapping from
// system state to Orb state, and the audio plumbing's refusal to break voice.
//
// That split is deliberate. `resolveOrbState` is a pure function precisely so
// the interesting behaviour — priority between competing states — is testable
// without a GPU.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ORB_APPEARANCE,
  ORB_CAPTION,
  resolveOrbState,
  type OrbState,
} from "../src/components/orb/orb-state";
import { particleBudget, LAYERS } from "../src/components/orb/webgl-orb";

const ALL_STATES: OrbState[] = [
  "idle",
  "listening",
  "processing",
  "executing",
  "speaking",
  "awaiting-approval",
  "success",
  "error",
  "offline",
];

describe("orb state resolution", () => {
  it("maps each voice state to a visible orb state", () => {
    expect(resolveOrbState({ voice: "idle" })).toBe("idle");
    expect(resolveOrbState({ voice: "requesting-permission" })).toBe("listening");
    expect(resolveOrbState({ voice: "listening" })).toBe("listening");
    expect(resolveOrbState({ voice: "transcribing" })).toBe("processing");
    expect(resolveOrbState({ voice: "processing" })).toBe("processing");
    expect(resolveOrbState({ voice: "speaking" })).toBe("speaking");
    expect(resolveOrbState({ voice: "error" })).toBe("error");
  });

  it("covers the whole mic → listening → thinking → speaking → idle turn", () => {
    // The sequence a real voice turn walks, in order. Every step must be
    // visually distinct, or the Orb stops being a status display.
    const turn = (
      ["requesting-permission", "listening", "transcribing", "processing", "speaking", "idle"] as const
    ).map((voice) => resolveOrbState({ voice }));

    expect(turn).toEqual([
      "listening",
      "listening",
      "processing",
      "processing",
      "speaking",
      "idle",
    ]);
  });

  it("does NOT show an error when voice is merely unavailable", () => {
    // A browser that cannot record, or a refused microphone, is not a fault in
    // JARVIS — typing still works. Showing the error state would misreport it.
    expect(resolveOrbState({ voice: "permission-denied" })).toBe("idle");
    expect(resolveOrbState({ voice: "unsupported" })).toBe("idle");
    expect(resolveOrbState({ voice: "unsupported", thinking: true })).toBe("processing");
  });

  it("puts a pending approval above any activity", () => {
    // The one state blocked on a human must never be buried under a spinner.
    expect(
      resolveOrbState({ voice: "processing", thinking: true, awaitingApproval: true })
    ).toBe("awaiting-approval");
    expect(resolveOrbState({ voice: "speaking", awaitingApproval: true })).toBe(
      "awaiting-approval"
    );
    expect(resolveOrbState({ voice: "idle", executing: true, awaitingApproval: true })).toBe(
      "awaiting-approval"
    );
  });

  it("puts offline above everything, including a pending approval", () => {
    // Nothing else is true if the app cannot reach the server; claiming to be
    // "thinking" over a dead connection is a lie.
    expect(
      resolveOrbState({ voice: "processing", thinking: true, awaitingApproval: true, offline: true })
    ).toBe("offline");
  });

  it("prefers executing over generic thinking", () => {
    expect(resolveOrbState({ voice: "idle", thinking: true })).toBe("processing");
    expect(resolveOrbState({ voice: "idle", thinking: true, executing: true })).toBe("executing");
    expect(resolveOrbState({ voice: "processing", executing: true })).toBe("executing");
  });

  it("reports typed-chat failures as the error state", () => {
    expect(resolveOrbState({ voice: "idle", failed: true })).toBe("error");
  });

  it("gives every state an appearance and a plain-language caption", () => {
    for (const state of ALL_STATES) {
      const look = ORB_APPEARANCE[state];
      expect(look, state).toBeDefined();
      // Ranges the shaders assume. A value outside them would render, but
      // wrongly — turbulence above 1 tears the shell apart.
      expect(look.intensity).toBeGreaterThanOrEqual(0);
      expect(look.intensity).toBeLessThanOrEqual(1);
      expect(look.turbulence).toBeGreaterThanOrEqual(0);
      expect(look.turbulence).toBeLessThanOrEqual(1);
      expect(look.audioResponse).toBeGreaterThanOrEqual(0);
      expect(look.audioResponse).toBeLessThanOrEqual(1);
      expect(look.hue).toBeGreaterThanOrEqual(0);
      expect(look.hue).toBeLessThan(360);

      expect(ORB_CAPTION[state], state).toBeTruthy();
    }
  });

  it("only lets the two audio-driven states react strongly to audio", () => {
    // If idle reacted at full gain, room noise would keep the Orb permanently
    // lit and the state would stop meaning anything.
    expect(ORB_APPEARANCE.listening.audioResponse).toBe(1);
    expect(ORB_APPEARANCE.speaking.audioResponse).toBe(1);
    for (const state of ALL_STATES) {
      if (state === "listening" || state === "speaking") continue;
      expect(ORB_APPEARANCE[state].audioResponse, state).toBeLessThanOrEqual(0.15);
    }
  });

  it("makes offline visibly quieter than every active state", () => {
    for (const state of ALL_STATES) {
      if (state === "offline") continue;
      expect(ORB_APPEARANCE.offline.intensity, state).toBeLessThan(
        ORB_APPEARANCE[state].intensity
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Audio analysis
// ---------------------------------------------------------------------------

describe("audio analyser", () => {
  const realAudioContext = (globalThis as { AudioContext?: unknown }).AudioContext;

  afterEach(() => {
    (globalThis as { AudioContext?: unknown }).AudioContext = realAudioContext;
    vi.resetModules();
  });

  beforeEach(() => {
    vi.resetModules();
  });

  it("reports no support when the browser has no AudioContext", async () => {
    delete (globalThis as { AudioContext?: unknown }).AudioContext;
    delete (globalThis as { webkitAudioContext?: unknown }).webkitAudioContext;
    const mod = await import("../src/lib/voice/audio-analyser");
    expect(mod.isAnalysisSupported()).toBe(false);
  });

  it("refuses to tap a paused element, which would silence the reply", async () => {
    // The load-bearing rule: createMediaElementSource is irreversible and
    // re-routes the element away from the speakers. Tapping audio that is not
    // already playing on a running context would mute JARVIS outright.
    const createMediaElementSource = vi.fn();
    (globalThis as { AudioContext?: unknown }).AudioContext = class {
      state = "running";
      createMediaElementSource = createMediaElementSource;
      createAnalyser = vi.fn();
      destination = {};
    };

    const mod = await import("../src/lib/voice/audio-analyser");
    const paused = { paused: true } as unknown as HTMLMediaElement;

    expect(mod.tapElement(paused)).toBeNull();
    expect(createMediaElementSource).not.toHaveBeenCalled();
  });

  it("refuses to tap when the context is not running", async () => {
    const createMediaElementSource = vi.fn();
    (globalThis as { AudioContext?: unknown }).AudioContext = class {
      state = "suspended";
      createMediaElementSource = createMediaElementSource;
      createAnalyser = vi.fn();
      destination = {};
    };

    const mod = await import("../src/lib/voice/audio-analyser");
    const playing = { paused: false } as unknown as HTMLMediaElement;

    expect(mod.tapElement(playing)).toBeNull();
    expect(createMediaElementSource).not.toHaveBeenCalled();
  });

  it("keeps the reply audible by wiring the source to the destination", async () => {
    const connect = vi.fn();
    const destination = { id: "speakers" };
    const analyser = { fftSize: 0, smoothingTimeConstant: 0, frequencyBinCount: 128, disconnect: vi.fn() };

    (globalThis as { AudioContext?: unknown }).AudioContext = class {
      state = "running";
      destination = destination;
      createMediaElementSource = vi.fn(() => ({ connect, disconnect: vi.fn() }));
      createAnalyser = vi.fn(() => analyser);
    };

    const mod = await import("../src/lib/voice/audio-analyser");
    const playing = { paused: false } as unknown as HTMLMediaElement;

    const tap = mod.tapElement(playing);
    expect(tap).not.toBeNull();
    // Straight to the speakers, not chained through the analyser: the audio
    // path must not depend on the analyser surviving.
    expect(connect).toHaveBeenCalledWith(destination);
  });

  it("returns silence rather than throwing when Web Audio fails", async () => {
    (globalThis as { AudioContext?: unknown }).AudioContext = class {
      constructor() {
        throw new Error("no audio thread available");
      }
    };

    const mod = await import("../src/lib/voice/audio-analyser");
    const stream = {} as MediaStream;
    // Degrades to "no reactivity", never to a crash that takes the page down.
    expect(mod.tapStream(stream)).toBeNull();
    expect(mod.SILENT).toEqual({ level: 0, bass: 0, mid: 0, treble: 0 });
  });
});


// ---------------------------------------------------------------------------
// Particle budget
// ---------------------------------------------------------------------------

describe("particle budget", () => {
  it("gives a capable desktop the full field", () => {
    // Regression guard. An earlier heuristic stepped down whenever
    // hardwareConcurrency <= 4, which handed a 4-core/16GB desktop 45% of the
    // particles and made the orb look like thin dust on good hardware.
    // Drawing points is GPU work; core count is close to irrelevant to it.
    expect(particleBudget({ hardwareConcurrency: 4, deviceMemory: 16 }, 1440)).toBe(1);
    expect(particleBudget({ hardwareConcurrency: 16, deviceMemory: 32 }, 2560)).toBe(1);
  });

  it("steps down for a phone-sized viewport", () => {
    expect(particleBudget({ hardwareConcurrency: 8, deviceMemory: 8 }, 390)).toBe(0.45);
  });

  it("steps down for genuinely low-end hardware", () => {
    expect(particleBudget({ deviceMemory: 2 }, 1440)).toBe(0.45);
    expect(particleBudget({ hardwareConcurrency: 2 }, 1440)).toBe(0.45);
    expect(particleBudget({ deviceMemory: 4 }, 1440)).toBe(0.7);
  });

  it("does not punish a browser that reports nothing", () => {
    // Every signal is optional. The unconditional safety nets are the pixel
    // ratio cap and the visibility pause, not this.
    expect(particleBudget({}, 1440)).toBe(1);
    expect(particleBudget(undefined, 1440)).toBe(0.8);
  });

  it("builds a layered orb rather than one cloud", () => {
    // Depth comes from parallax between layers; a single cloud reads flat no
    // matter how dense it is.
    expect(LAYERS.length).toBeGreaterThanOrEqual(3);

    const names = LAYERS.map((l) => l.name);
    expect(names).toContain("core");
    expect(names).toContain("shell");

    // At least one layer must counter-rotate, and one must be a flattened
    // band - those are what read as orbit rather than as a spinning ball.
    expect(LAYERS.some((l) => l.spinMul < 0)).toBe(true);
    expect(LAYERS.some((l) => (l.flatten ?? 1) < 0.5)).toBe(true);

    // The core has to be the brightest thing, or there is no "core".
    const core = LAYERS.find((l) => l.name === "core")!;
    for (const other of LAYERS) {
      if (other.name === "core") continue;
      expect(core.intensityMul).toBeGreaterThan(other.intensityMul);
    }
  });
});
