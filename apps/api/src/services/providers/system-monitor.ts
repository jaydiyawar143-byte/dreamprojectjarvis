// ---------------------------------------------------------------------------
// V3 — real host metrics.
//
// TWO TIERS, and the split is measured rather than guessed. Profiling
// `systeminformation` on the target machine (Windows, after warm-up) gave:
//
//   currentLoad        0ms     <- CPU, cached delta
//   time              46ms
//   mem              511ms
//   fsSize           517ms
//   cpuTemperature   663ms
//   graphics        3058ms     <- WMI
//   networkStats    3403ms     <- WMI
//
// A one-second stream that called all of them would spend most of every second
// blocked in WMI and would fall progressively further behind. So the fast tier
// (CPU, memory, uptime) streams every second, and the slow tier (network, disk,
// GPU, temperature) refreshes on a much longer interval and is merged in.
//
// NOTHING IS INVENTED. On the target hardware — Intel UHD integrated graphics on
// Windows — CPU temperature, GPU utilisation, GPU memory and GPU temperature all
// come back null, because the OS exposes no sensor for them without a kernel
// driver. Those are reported as `null` with a stated reason, never as 0. A
// zeroed temperature reads as "cold and fine", which is the opposite of "no
// sensor".
//
// SECURITY. This reads counters only. There is no command execution, no process
// list, no file enumeration, and nothing here takes input from the client — so
// there is no argument to inject. It reports the machine the API runs on, which
// in Docker is the CONTAINER, not the host; the route says so.
// ---------------------------------------------------------------------------

import os from "os";

/** A metric that may genuinely not exist on this machine. */
export interface Maybe<T> {
  value: T | null;
  /** Why it is null. Absent when a value is present. */
  reason?: string;
}

export interface SystemSnapshot {
  at: string;
  cpu: {
    /**
     * Null until a second sample exists. Load is a DELTA between two tick
     * readings, so the first one genuinely has no answer — and 0 would read as
     * "idle", which is a different claim entirely.
     */
    loadPct: Maybe<number>;
    cores: number;
    model: string;
    temperatureC: Maybe<number>;
  };
  memory: {
    usedPct: number;
    usedBytes: number;
    totalBytes: number;
    availableBytes: number;
  };
  gpu: {
    model: Maybe<string>;
    utilizationPct: Maybe<number>;
    memoryUsedMB: Maybe<number>;
    temperatureC: Maybe<number>;
  };
  disk: Maybe<{ usedPct: number; usedBytes: number; totalBytes: number; mount: string }>;
  network: Maybe<{ rxBytesPerSec: number; txBytesPerSec: number; iface: string }>;
  uptimeSeconds: number;
  /** True when the metrics describe a container rather than the host. */
  containerized: boolean;
}

const NOT_SUPPORTED = "No sensor is exposed by this system";

/**
 * `systeminformation` is loaded lazily and optionally.
 *
 * It is a native-ish dependency that shells out to WMI on Windows. If it is
 * missing or throws on this platform, the monitor degrades to the Node `os`
 * built-ins (CPU, memory, uptime) rather than taking the API down — those are
 * the metrics most people look at anyway.
 */
type SiModule = typeof import("systeminformation");
let siPromise: Promise<SiModule | null> | null = null;

function loadSi(): Promise<SiModule | null> {
  if (!siPromise) {
    siPromise = import("systeminformation")
      .then((m) => (m as unknown as { default?: SiModule }).default ?? m)
      .catch(() => null);
  }
  return siPromise;
}

/** Docker sets this; used only to label the snapshot honestly. */
function detectContainer(): boolean {
  return process.env.JARVIS_IN_CONTAINER === "true" || process.env.NODE_ENV === "production";
}

// ---------------------------------------------------------------------------
// Fast tier — safe to call every second.
// ---------------------------------------------------------------------------

interface FastMetrics {
  cpuLoadPct: Maybe<number>;
  memory: SystemSnapshot["memory"];
  uptimeSeconds: number;
}

/**
 * CPU load from raw counters.
 *
 * Node's `os.cpus()` reports cumulative ticks, so load is the DELTA between two
 * samples. `os.loadavg()` is not used: it is meaningless on Windows (always 0)
 * and is a run-queue length rather than a utilisation percentage anywhere else.
 */
let previousTicks: { idle: number; total: number } | null = null;

function sampleCpuTicks(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const kind of Object.keys(cpu.times) as Array<keyof typeof cpu.times>) {
      total += cpu.times[kind];
    }
    idle += cpu.times.idle;
  }
  return { idle, total };
}

function cpuLoadPct(): Maybe<number> {
  const now = sampleCpuTicks();
  const prev = previousTicks;
  previousTicks = now;

  // The first sample has no baseline to diff against, and neither does one
  // taken in the same millisecond as the last. Reporting 0 in either case would
  // be a fabricated "idle".
  if (!prev) return { value: null, reason: "Measuring — needs a second sample" };

  const idleDelta = now.idle - prev.idle;
  const totalDelta = now.total - prev.total;
  if (totalDelta <= 0) return { value: null, reason: "Measuring — needs a second sample" };

  return { value: Math.min(100, Math.max(0, Math.round((1 - idleDelta / totalDelta) * 100))) };
}

export function collectFast(): FastMetrics {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;

  return {
    cpuLoadPct: cpuLoadPct(),
    memory: {
      usedPct: total > 0 ? Math.round((used / total) * 100) : 0,
      usedBytes: used,
      totalBytes: total,
      availableBytes: free,
    },
    uptimeSeconds: Math.round(os.uptime()),
  };
}

// ---------------------------------------------------------------------------
// Slow tier — WMI-backed, refreshed on a long interval.
// ---------------------------------------------------------------------------

interface SlowMetrics {
  cpuTemperatureC: Maybe<number>;
  gpu: SystemSnapshot["gpu"];
  disk: SystemSnapshot["disk"];
  network: SystemSnapshot["network"];
}

const EMPTY_SLOW: SlowMetrics = {
  cpuTemperatureC: { value: null, reason: NOT_SUPPORTED },
  gpu: {
    model: { value: null, reason: NOT_SUPPORTED },
    utilizationPct: { value: null, reason: NOT_SUPPORTED },
    memoryUsedMB: { value: null, reason: NOT_SUPPORTED },
    temperatureC: { value: null, reason: NOT_SUPPORTED },
  },
  disk: { value: null, reason: "Disk usage is unavailable" },
  network: { value: null, reason: "Network counters are unavailable" },
};

let slowCache: SlowMetrics = EMPTY_SLOW;
let slowInFlight: Promise<void> | null = null;

/** `null` from the library means "no sensor", which is not the same as 0. */
function maybeNumber(value: unknown, reason = NOT_SUPPORTED): Maybe<number> {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? { value }
    : { value: null, reason };
}

export async function refreshSlow(): Promise<void> {
  // Overlapping refreshes would queue WMI calls behind each other; one at a
  // time is both sufficient and much cheaper.
  if (slowInFlight) return slowInFlight;

  slowInFlight = (async () => {
    const si = await loadSi();
    if (!si) {
      slowCache = { ...EMPTY_SLOW, cpuTemperatureC: { value: null, reason: "Sensor library unavailable" } };
      return;
    }

    // Settled, not all: one failing probe must not blank the others.
    const [temp, gfx, fs, net] = await Promise.allSettled([
      si.cpuTemperature(),
      si.graphics(),
      si.fsSize(),
      si.networkStats(),
    ]);

    const next: SlowMetrics = { ...EMPTY_SLOW };

    if (temp.status === "fulfilled") {
      next.cpuTemperatureC = maybeNumber(temp.value?.main);
    }

    if (gfx.status === "fulfilled") {
      const controller = gfx.value?.controllers?.[0];
      next.gpu = {
        model: controller?.model ? { value: controller.model } : { value: null, reason: NOT_SUPPORTED },
        utilizationPct: maybeNumber(controller?.utilizationGpu),
        memoryUsedMB: maybeNumber(controller?.memoryUsed),
        temperatureC: maybeNumber(controller?.temperatureGpu),
      };
    }

    if (fs.status === "fulfilled" && Array.isArray(fs.value) && fs.value.length > 0) {
      // The largest filesystem is the one a person means by "my disk".
      const biggest = [...fs.value].sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0];
      if (biggest && biggest.size > 0) {
        next.disk = {
          value: {
            usedPct: Math.round(biggest.use ?? 0),
            usedBytes: biggest.used ?? 0,
            totalBytes: biggest.size,
            mount: biggest.mount ?? biggest.fs ?? "/",
          },
        };
      }
    }

    if (net.status === "fulfilled" && Array.isArray(net.value) && net.value.length > 0) {
      const primary = net.value[0];
      if (primary) {
        next.network = {
          value: {
            // The library reports per-second rates already; negative values
            // appear on the first sample and mean "no baseline yet".
            rxBytesPerSec: Math.max(0, Math.round(primary.rx_sec ?? 0)),
            txBytesPerSec: Math.max(0, Math.round(primary.tx_sec ?? 0)),
            iface: primary.iface ?? "unknown",
          },
        };
      }
    }

    slowCache = next;
  })();

  try {
    await slowInFlight;
  } finally {
    slowInFlight = null;
  }
}

// ---------------------------------------------------------------------------

let cpuModel: string | null = null;

// Take a baseline as soon as this module loads, so the first HTTP request a
// second or more later already has two samples to diff and can report a real
// number instead of "measuring".
previousTicks = sampleCpuTicks();

export function snapshot(): SystemSnapshot {
  const fast = collectFast();
  if (cpuModel === null) cpuModel = os.cpus()[0]?.model ?? "Unknown CPU";

  return {
    at: new Date().toISOString(),
    cpu: {
      loadPct: fast.cpuLoadPct,
      cores: os.cpus().length,
      model: cpuModel,
      temperatureC: slowCache.cpuTemperatureC,
    },
    memory: fast.memory,
    gpu: slowCache.gpu,
    disk: slowCache.disk,
    network: slowCache.network,
    uptimeSeconds: fast.uptimeSeconds,
    containerized: detectContainer(),
  };
}

/** Discards the CPU baseline. Tests need a deterministic starting point. */
export function __resetSystemMonitor(): void {
  previousTicks = null;
  slowCache = EMPTY_SLOW;
  cpuModel = null;
}
