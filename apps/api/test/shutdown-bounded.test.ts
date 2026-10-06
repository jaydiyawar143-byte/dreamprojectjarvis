// Phase 13 — shutdown always finishes.
//
// `http.Server.close(callback)` calls back only once EVERY connection has
// ended. The shutdown controller used to wait for that callback before doing
// anything else, so one connection that never ended — a request stuck on a
// slow provider, or simply the dashboard's open WebSocket — held the whole
// sequence at its first step: nothing drained, the database was never
// disconnected, and the process stayed up until its supervisor killed it.
//
// These use a REAL server and REAL sockets, because a fake `close()` that
// calls back at once is exactly what hid the problem.
import { createServer, request, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShutdownLifecycle } from "@jarvis/core";
import { createShutdownController } from "../src/shutdown.js";

const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

/** Resolves with how long `work` took, or rejects if it outlives `limitMs`. */
async function within(limitMs: number, work: Promise<unknown>): Promise<number> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      work,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`still running after ${limitMs}ms`)), limitMs);
      }),
    ]);
    return Date.now() - started;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("Phase 13 — shutdown is bounded", () => {
  it("finishes even when a request never does", async () => {
    // A handler that never answers: a provider call that hangs.
    const server = createServer(() => undefined);
    const port = await listen(server);
    const stuck = request({ host: "127.0.0.1", port, path: "/stuck" });
    stuck.on("error", () => undefined);
    stuck.end();
    await new Promise<void>((resolve) => server.once("request", () => resolve()));

    const lifecycle = new ShutdownLifecycle();
    const disconnectDatabase = vi.fn().mockResolvedValue(undefined);
    const onStopped = vi.fn();
    const controller = createShutdownController({
      lifecycle,
      server,
      disconnectDatabase,
      graceMs: 200,
      log: () => undefined,
      onStopped,
    });

    const took = await within(3000, controller.beginShutdown("SIGTERM"));

    // It waited the grace out for the request, then moved on regardless.
    expect(took).toBeGreaterThanOrEqual(150);
    expect(lifecycle.getState()).toBe("STOPPED");
    expect(disconnectDatabase).toHaveBeenCalledTimes(1);
    expect(onStopped).toHaveBeenCalledTimes(1);
  });

  it("is not held open by an idle upgraded connection once that transport is closed", async () => {
    // An upgraded socket, kept open with nothing in flight: the dashboard.
    const server = createServer();
    const upgraded: Socket[] = [];
    server.on("upgrade", (_req, socket) => {
      upgraded.push(socket as Socket);
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    });
    const port = await listen(server);

    const client = connect(port, "127.0.0.1");
    sockets.push(client);
    client.on("error", () => undefined);
    client.write("GET /socket.io/ HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    await new Promise<void>((resolve) => client.once("data", () => resolve()));

    const lifecycle = new ShutdownLifecycle();
    const controller = createShutdownController({
      lifecycle,
      server,
      // What `io.close()` does: it ends the sockets it owns.
      closeIo: () => upgraded.forEach((socket) => socket.destroy()),
      graceMs: 5000,
      log: () => undefined,
    });

    // Nothing is in flight, so this must not sit out the five-second grace.
    const took = await within(3000, controller.beginShutdown("SIGTERM"));

    expect(took).toBeLessThan(2000);
    expect(lifecycle.getState()).toBe("STOPPED");
  });

  it("lets a request that is already running finish, inside the grace", async () => {
    const server = createServer((_req, res) => {
      setTimeout(() => res.end("done"), 150);
    });
    const port = await listen(server);

    const answered = new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      const inFlight = request({ host: "127.0.0.1", port, path: "/slow" }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += String(chunk)));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      });
      inFlight.on("error", reject);
      inFlight.end();
    });
    await new Promise<void>((resolve) => server.once("request", () => resolve()));

    const lifecycle = new ShutdownLifecycle();
    const logs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const controller = createShutdownController({
      lifecycle,
      server,
      graceMs: 3000,
      log: (message, meta) => logs.push({ message, ...(meta ? { meta } : {}) }),
    });

    const took = await within(4000, controller.beginShutdown("SIGTERM"));

    // The caller got its whole answer; it was not cut off...
    await expect(answered).resolves.toEqual({ status: 200, body: "done" });
    // ...and shutdown did not then wait for the rest of the grace.
    expect(took).toBeLessThan(2000);
    expect(lifecycle.getState()).toBe("STOPPED");
    // Nothing had to be cut: every connection ended by itself.
    expect(logs.find((entry) => entry.message === "connections closed")?.meta).toMatchObject({
      forced: false,
    });
  });

  it("says how many connections it had to close", async () => {
    const server = createServer(() => undefined);
    const port = await listen(server);
    const stuck = request({ host: "127.0.0.1", port, path: "/stuck" });
    stuck.on("error", () => undefined);
    stuck.end();
    await new Promise<void>((resolve) => server.once("request", () => resolve()));

    const logs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const controller = createShutdownController({
      lifecycle: new ShutdownLifecycle(),
      server,
      graceMs: 100,
      log: (message, meta) => logs.push({ message, ...(meta ? { meta } : {}) }),
    });

    await within(3000, controller.beginShutdown("SIGTERM"));

    const forced = logs.find((entry) => entry.message === "connections closed");
    expect(forced?.meta).toMatchObject({ forced: true });
  });
});
