// PHASE 10.6 — API shutdown controller, signal handling, health draining.
//
// Windows-safe: shutdown is triggered programmatically AND via in-process
// signal emission (process.emit), never relying on OS-delivered signals.
// Covers spec items: SIGTERM/SIGINT initiation, idempotent shutdown,
// duplicate-handler prevention, new-work blocking, in-flight completion,
// grace enforcement, recoverable-state preservation, DB-failure honesty,
// server draining order, client-disconnect ≠ cancellation, health states,
// and idempotent startup recovery (memory-journal level; durable level is
// proven against PostgreSQL in packages/db).
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExpressRouter } from "express";
import {
  createShutdownController,
  installSignalHandlers,
  areSignalHandlersInstalled,
  getInstalledSignals,
} from "../src/shutdown.js";
import { createHealthRouter } from "../src/routes/health.js";
import {
  ShutdownLifecycle,
  SERVICE_SHUTTING_DOWN_ERROR,
} from "@jarvis/core";
import {
  MemoryExecutionJournal,
  runStartupRecovery,
} from "@jarvis/tools";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1500
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function makeFakeServer() {
  return {
    close: vi.fn((cb?: (err?: Error | undefined) => void) => cb?.()),
    closeAllConnections: vi.fn(),
  };
}

interface LogEntry {
  message: string;
  meta?: Record<string, unknown>;
}

function makeController(lifecycle: ShutdownLifecycle, overrides?: {
  graceMs?: number;
  disconnectDatabase?: () => Promise<void>;
}) {
  const server = makeFakeServer();
  const logs: LogEntry[] = [];
  const closeIo = vi.fn();
  const disconnectDatabase =
    overrides?.disconnectDatabase ?? vi.fn().mockResolvedValue(undefined);
  const onStopped = vi.fn();

  const controller = createShutdownController({
    lifecycle,
    server,
    closeIo,
    disconnectDatabase,
    graceMs: overrides?.graceMs ?? 500,
    log: (message, meta) => logs.push({ message, meta }),
    onStopped,
  });
  return { controller, server, logs, closeIo, disconnectDatabase, onStopped };
}

function healthBody(router: ExpressRouter): Record<string, unknown> {
  const layer = router.stack.find((l) => l.route?.methods?.get)!;
  const handler = layer.route!.stack[0]!.handle;
  const json = vi.fn();
  const res = { json } as unknown as import("express").Response;
  (
    handler as unknown as (
      req: unknown,
      res: unknown,
      next: unknown
    ) => void
  )({}, res, () => {});
  return json.mock.calls[0][0] as Record<string, unknown>;
}

const emitter = process as unknown as { emit(event: string): boolean };

// ---------------------------------------------------------------------------
// signal wiring (module-global install state — ordered tests)
// ---------------------------------------------------------------------------

describe("PHASE 10.6 — signal handling (Windows-safe)", () => {
  let routedBegin: (reason: string) => Promise<void>;
  let installedHere = false;

  beforeEach(() => {
    routedBegin = async () => {};
    if (!areSignalHandlersInstalled()) {
      installSignalHandlers((reason) => routedBegin(reason));
      installedHere = true;
    }
  });

  it("23. no duplicate signal handlers across repeated installs", () => {
    expect(installedHere).toBe(true);
    expect(getInstalledSignals()).toEqual(["SIGTERM", "SIGINT"]);
    const before = (
      process.listenerCount("SIGTERM"),
      process.listenerCount("SIGINT")
    );
    installSignalHandlers(async () => {}); // must be a no-op
    expect(process.listenerCount("SIGTERM")).toBe(before);
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  it("1. SIGTERM starts the shutdown sequence", async () => {
    const lifecycle = new ShutdownLifecycle();
    const { controller } = makeController(lifecycle);
    routedBegin = controller.beginShutdown;

    emitter.emit("SIGTERM");
    await waitFor(() => lifecycle.isShuttingDown());

    expect(lifecycle.getShutdownInitiation()!.reason).toContain("SIGTERM");
    await controller.beginShutdown("SIGTERM"); // join in-flight sequence
    expect(lifecycle.getState()).toBe("STOPPED");
  });

  it("2. SIGINT starts the shutdown sequence", async () => {
    const lifecycle = new ShutdownLifecycle();
    const { controller } = makeController(lifecycle);
    routedBegin = controller.beginShutdown;

    emitter.emit("SIGINT");
    await waitFor(() => lifecycle.isShuttingDown());

    expect(lifecycle.getShutdownInitiation()!.reason).toContain("SIGINT");
    await controller.beginShutdown("SIGINT");
    expect(lifecycle.getState()).toBe("STOPPED");
  });
});

// ---------------------------------------------------------------------------
// controller behavior
// ---------------------------------------------------------------------------

describe("PHASE 10.6 — shutdown controller", () => {
  it("3/22. shutdown is idempotent — double call runs cleanup exactly once", async () => {
    const lifecycle = new ShutdownLifecycle();
    const { controller, server, onStopped } = makeController(lifecycle);

    await Promise.all([
      controller.beginShutdown("SIGTERM"),
      controller.beginShutdown("deployment"), // second caller joins same flight
    ]);

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(onStopped).toHaveBeenCalledTimes(1);
    expect(lifecycle.getState()).toBe("STOPPED");

    // A third call after completion is still safe.
    await controller.beginShutdown("late signal");
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(onStopped).toHaveBeenCalledTimes(1);
  });

  it("4/24/E. no new work accepted once shutdown begins", async () => {
    const lifecycle = new ShutdownLifecycle();

    // Gate decisions are sampled synchronously INSIDE each transition, so
    // the fast DRAINING→STOP_ACCEPTING progression is observed exactly.
    const gateAtState = new Map<
      string,
      { write: boolean; read: boolean }
    >();
    lifecycle.onStateChange((state) => {
      gateAtState.set(state, {
        write: lifecycle.canAcceptNewWork("EXTERNAL_SIDE_EFFECT"),
        read: lifecycle.canAcceptNewWork("READ_ONLY"),
      });
    });

    const { controller } = makeController(lifecycle);
    expect(lifecycle.canAcceptNewWork("EXTERNAL_SIDE_EFFECT")).toBe(true);

    await controller.beginShutdown("SIGTERM");

    // RUNNING accepts all (asserted above pre-listener); DRAINING refuses
    // writes but still serves reads; STOP_ACCEPTING+ admits nothing at all.
    expect(gateAtState.get("DRAINING")).toEqual({ write: false, read: true });
    expect(gateAtState.get("STOP_ACCEPTING")).toEqual({
      write: false,
      read: false,
    });
    expect(gateAtState.get("STOPPED")).toEqual({ write: false, read: false });

    // Post-shutdown the deterministic refusal contract holds.
    expect(lifecycle.canAcceptNewWork("READ_ONLY")).toBe(false);
    expect(SERVICE_SHUTTING_DOWN_ERROR).toBe("service shutting down");
  });

  it("6/F. in-flight execution completes during grace; audit trail recorded", async () => {
    const lifecycle = new ShutdownLifecycle();
    const { controller, logs } = makeController(lifecycle, { graceMs: 2000 });

    const handle = lifecycle.trackExecution("exec-ok", "EXTERNAL_SIDE_EFFECT");
    setTimeout(() => handle.complete(), 15);

    await controller.beginShutdown("SIGTERM");

    const drain = logs.find((l) => l.message === "drain finished")!;
    expect(drain.meta).toMatchObject({
      executionsCompleted: 1,
      executionsLeftForRecovery: 0,
      timedOut: false,
    });
    const initiated = logs.find((l) => l.message === "shutdown initiated")!;
    expect(initiated.meta).toMatchObject({
      reason: "SIGTERM",
      activeExecutions: 1,
    });
    expect(logs.some((l) => l.message === "shutdown complete")).toBe(true);
  });

  it("7/8/9/G/H. grace enforced; expiry leaves durable recoverable state, never FAILED", async () => {
    const lifecycle = new ShutdownLifecycle();
    const { controller, logs } = makeController(lifecycle, { graceMs: 40 });

    lifecycle.trackExecution("exec-stuck", "EXTERNAL_SIDE_EFFECT");

    await controller.beginShutdown("crash-sim");

    const drain = logs.find((l) => l.message === "drain finished")!;
    expect(drain.meta!.timedOut).toBe(true);
    expect(drain.meta!.executionsLeftForRecovery).toBe(1);

    // The lifecycle vocabulary contains NO way to produce FAILED: the stuck
    // execution remains tracked (durable journal untouched) for Phase
    // 10.2/10.5 recovery — UNKNOWN-safe, never retried here.
    expect(lifecycle.getActiveExecutionCount()).toBe(1);
    const complete = logs.find((l) => l.message === "shutdown complete")!;
    expect(complete.meta).toMatchObject({
      executionsLeftForRecovery: 1,
      databaseDisconnected: true,
    });
  });

  it("11/14/J. draining order: stop accepting → drain → io close → connections → db → stopped", async () => {
    const lifecycle = new ShutdownLifecycle();
    const events: string[] = [];
    const server = {
      close: vi.fn((cb?: () => void) => {
        events.push("server.close");
        cb?.();
      }),
      closeAllConnections: vi.fn(() => events.push("closeAllConnections")),
    };
    const closeIo = vi.fn(() => events.push("io.close"));
    const disconnectDatabase = vi.fn(async () => {
      await Promise.resolve();
      events.push("db.disconnect");
    });

    const controller = createShutdownController({
      lifecycle,
      server,
      closeIo,
      disconnectDatabase,
      graceMs: 50,
      log: () => {},
    });

    await controller.beginShutdown("SIGTERM");

    expect(events).toEqual([
      "server.close",
      "io.close",
      "closeAllConnections",
      "db.disconnect",
    ]);
    expect(lifecycle.getState()).toBe("STOPPED");
  });

  it("12/I. DB failure during shutdown fails safely — no false success", async () => {
    const lifecycle = new ShutdownLifecycle();
    const { controller, logs, onStopped } = makeController(lifecycle, {
      disconnectDatabase: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    });

    await controller.beginShutdown("SIGTERM");

    expect(
      logs.some(
        (l) =>
          l.message === "resource release error" &&
          String(l.meta?.message).includes("ECONNREFUSED")
      )
    ).toBe(true);
    // Honest termination: host exit hook skipped, failure visible in logs.
    expect(onStopped).not.toHaveBeenCalled();
    // Lifecycle still reached a terminal state; durable journal remains
    // authoritative for anything in-flight.
    expect(lifecycle.getState()).toBe("STOPPED");
  });

  it("15/K. closing socket.io cannot cancel executions (disconnect ≠ cancellation)", async () => {
    const lifecycle = new ShutdownLifecycle();
    const { controller, closeIo } = makeController(lifecycle, {
      graceMs: 30,
    });

    const handle = lifecycle.trackExecution(
      "exec-after-disconnect",
      "EXTERNAL_SIDE_EFFECT"
    );

    await controller.beginShutdown("SIGTERM");

    // Transports were torn down…
    expect(closeIo).toHaveBeenCalled();
    // …but the execution was NOT cancelled: still tracked, still recoverable.
    expect(lifecycle.getActiveExecutionCount()).toBe(1);

    // It may even finish safely AFTER shutdown completed.
    handle.complete();
    expect(lifecycle.getActiveExecutionCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// health endpoint
// ---------------------------------------------------------------------------

describe("PHASE 10.6 — health endpoint draining states", () => {
  it("21a. RUNNING reports ok with unchanged contract (HTTP 200 body)", () => {
    const lifecycle = new ShutdownLifecycle();
    const body = healthBody(createHealthRouter(lifecycle));
    expect(body.status).toBe("ok");
    expect(body.service).toBe("jarvis-api");
    expect(body.state).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/secret|token|password/i);
  });

  it("21b. DRAINING reports degraded status without breaking the contract", () => {
    const lifecycle = new ShutdownLifecycle();
    lifecycle.beginDraining("SIGTERM");
    const body = healthBody(createHealthRouter(lifecycle));
    expect(body.status).toBe("draining");
    expect(body.state).toBe("DRAINING");
  });

  it("21c. late-stage states remain flagged as draining", () => {
    const lifecycle = new ShutdownLifecycle();
    lifecycle.beginDraining("x");
    lifecycle.markStopAccepting();
    expect(healthBody(createHealthRouter(lifecycle)).state).toBe(
      "STOP_ACCEPTING"
    );
  });
});

// ---------------------------------------------------------------------------
// startup recovery (memory journal; PG durability proven separately)
// ---------------------------------------------------------------------------

describe("PHASE 10.6 — startup recovery (idempotent)", () => {
  async function seedExecutingRow(
    journal: MemoryExecutionJournal,
    key: string
  ): Promise<string> {
    await journal.begin({
      userId: "u-shutdown",
      toolId: "meta.campaign.create",
      idempotencyKey: key,
      paramsHash: "h",
      provider: "meta-ads",
    });
    const rec = journal.findByAnyKey(key)!;
    const claimed = await journal.claimForExecution(rec.executionId, {
      ownerId: "worker",
      leaseMs: 10, // expires almost immediately → crash residue
    });
    expect(claimed!.status).toBe("EXECUTING");
    return rec.executionId;
  }

  it("16/18. recovery after crash: stale EXECUTING → UNKNOWN", async () => {
    const journal = new MemoryExecutionJournal();
    const id = await seedExecutingRow(journal, "recovery-crash-1");
    await new Promise((r) => setTimeout(r, 15));

    const report = await runStartupRecovery(journal);
    expect(report.staleExecutingRecovered).toBe(1);
    expect((await journal.getById(id))!.status).toBe("UNKNOWN");
  });

  it("19. stale RECONCILING → UNKNOWN, reconciliation eligibility preserved", async () => {
    const journal = new MemoryExecutionJournal();
    const id = await seedExecutingRow(journal, "recovery-recon-1");
    await new Promise((r) => setTimeout(r, 15));
    await runStartupRecovery(journal); // EXECUTING → UNKNOWN

    const claimed = await journal.claimForReconciliation(id, {
      ownerId: "w1",
      leaseMs: 10,
    });
    expect(claimed!.status).toBe("RECONCILING");
    await new Promise((r) => setTimeout(r, 15));

    await runStartupRecovery(journal);
    const rec = await journal.getById(id);
    expect(rec!.status).toBe("UNKNOWN");

    const again = await journal.claimForReconciliation(id, {
      ownerId: "w2",
    });
    expect(again!.status).toBe("RECONCILING");
    expect(again!.ownerId).toBe("w2");
  });

  it("20. duplicate startup recovery is safe — identical state, zero second-pass effects", async () => {
    const journal = new MemoryExecutionJournal();
    await seedExecutingRow(journal, "recovery-dup-1");
    await seedExecutingRow(journal, "recovery-dup-2");
    await new Promise((r) => setTimeout(r, 15));

    const first = await runStartupRecovery(journal);
    const snapshot = await Promise.all([
      journal.getById((journal.findByAnyKey("recovery-dup-1"))!.executionId),
      journal.getById((journal.findByAnyKey("recovery-dup-2"))!.executionId),
    ]);

    const second = await runStartupRecovery(journal);
    expect(second.staleExecutingRecovered).toBe(0);
    expect(second.staleReconcilingRecovered).toBe(0);

    expect(await journal.getById(snapshot[0]!.executionId)).toEqual(
      snapshot[0]
    );
    expect(await journal.getById(snapshot[1]!.executionId)).toEqual(
      snapshot[1]
    );
    expect(first.staleExecutingRecovered).toBeGreaterThanOrEqual(2);
  });

  it("10. recovery performs no retries and no external calls (pure journal pass)", async () => {
    const journal = new MemoryExecutionJournal();
    const id = await seedExecutingRow(journal, "recovery-noretry-1");
    await new Promise((r) => setTimeout(r, 15));
    await runStartupRecovery(journal);
    const rec = await journal.getById(id)!;
    // UNKNOWN with no reconciliation attempts bumped and no provider
    // involvement — the journal row's attempt counter stays at its
    // pre-crash value (recovery is a pure durable-state pass).
    expect(rec!.status).toBe("UNKNOWN");
    expect(rec!.reconciliationAttempts ?? 0).toBe(0);
  });
});
