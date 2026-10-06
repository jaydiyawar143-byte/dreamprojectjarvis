// Phase 13 — what an uptime monitor and a container orchestrator can rely on.
//
// The probes themselves date from Sprint 9.10 and are tested one by one in
// sprint9-security.test.ts. This file pins the CONTRACT they add up to — the
// table in docs/DEPLOYMENT.md — over real HTTP, the way a monitor meets it:
//
//   /live    is the process up?            never depends on anything
//   /ready   should it receive traffic?    the database, and not while draining
//   /        the original probe            200 always; the body says "draining"
//
// A monitor is unauthenticated, so the probes must answer without credentials
// and say nothing a stranger should not read.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHealthRouter } from "../src/routes/health.js";

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

type Database = "up" | "down" | "hung";

async function probes(state: string, database: Database) {
  const pingDatabase = vi.fn(async () => {
    if (database === "down") throw new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2");
    if (database === "hung") await new Promise(() => undefined);
    return [{ "?column?": 1 }];
  });

  const app = express();
  app.use(
    "/api/v1/health",
    createHealthRouter({ getState: () => state }, { pingDatabase, timeoutMs: 100 })
  );
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/health`;

  // No Authorization header, no cookie: exactly what a monitor sends.
  const ask = async (path: string) => {
    const response = await fetch(`${base}${path}`);
    const text = await response.text();
    return {
      status: response.status,
      type: response.headers.get("content-type") ?? "",
      text,
      body: JSON.parse(text) as Record<string, unknown>,
    };
  };

  return { ask, pingDatabase };
}

describe("Phase 13 — the health contract", () => {
  it.each([
    // state       database   live  ready  ready says     original says
    ["RUNNING", "up", 200, 200, "ready", "ok"],
    ["RUNNING", "down", 200, 503, "not_ready", "ok"],
    ["RUNNING", "hung", 200, 503, "not_ready", "ok"],
    ["DRAINING", "up", 200, 503, "draining", "draining"],
    ["STOP_ACCEPTING", "up", 200, 503, "draining", "draining"],
  ] as const)(
    "%s with the database %s: live %i, ready %i (%s)",
    async (state, database, liveStatus, readyStatus, readySays, originalSays) => {
      const { ask } = await probes(state, database);

      const live = await ask("/live");
      expect(live.status).toBe(liveStatus);
      expect(live.body.status).toBe("alive");

      const ready = await ask("/ready");
      expect(ready.status).toBe(readyStatus);
      expect(ready.body.status).toBe(readySays);

      const original = await ask("/");
      expect(original.status).toBe(200);
      expect(original.body.status).toBe(originalSays);
    }
  );

  it("liveness never asks the database; readiness asks it once", async () => {
    const { ask, pingDatabase } = await probes("RUNNING", "up");

    await ask("/live");
    await ask("/");
    expect(pingDatabase).not.toHaveBeenCalled();

    await ask("/ready");
    expect(pingDatabase).toHaveBeenCalledTimes(1);
  });

  it("readiness does not ask the database at all while draining", async () => {
    const { ask, pingDatabase } = await probes("DRAINING", "up");
    await ask("/ready");
    expect(pingDatabase).not.toHaveBeenCalled();
  });

  it("answers in JSON, without credentials, and tells a stranger nothing", async () => {
    const allowed = new Set(["status", "service", "timestamp", "uptime", "checks", "state"]);

    for (const [state, database] of [
      ["RUNNING", "up"],
      ["RUNNING", "down"],
      ["DRAINING", "up"],
    ] as const) {
      const { ask } = await probes(state, database);
      for (const path of ["/live", "/ready", "/"]) {
        const answer = await ask(path);
        expect(answer.type).toContain("application/json");
        expect(answer.body.service).toBe("jarvis-api");
        for (const key of Object.keys(answer.body)) {
          expect(allowed.has(key), `${path} returned "${key}"`).toBe(true);
        }
        // The driver's error names a host, a port and a password. None of it.
        expect(answer.text).not.toContain("ECONNREFUSED");
        expect(answer.text).not.toContain("10.0.0.5");
        expect(answer.text).not.toContain("hunter2");
      }
    }
  });

  it("says which dependency failed, by name only", async () => {
    const { ask } = await probes("RUNNING", "down");
    expect((await ask("/ready")).body.checks).toEqual({ database: "failed" });
  });
});
