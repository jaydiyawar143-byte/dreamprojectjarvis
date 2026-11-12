// ---------------------------------------------------------------------------
// VO-2.1 (M4) — the Virtual Office stream over a REAL Socket.IO server.
//
// The VO-2 delivery tests used a fake `io` and fake sockets, so nothing proved
// that the pieces work together on the wire: the handshake, the default-deny
// event policy, the office installer, and the container's own wiring from an
// audit write or a task move to a socket. That gap is how H1 shipped. Here:
//
//   - a real HTTP server on 127.0.0.1, a real Socket.IO server, real
//     socket.io-client sockets, real JWTs from the real TokenService;
//   - `secureSocketServer` then `installOfficeStream`, in index.ts's order;
//   - `officeAuditObserver` / `officeTaskObserver` — the exact functions the
//     container installs — behind a real AuditLogger and a real TaskService
//     (each over an in-memory store; storage is not what is under test).
//
// It also pins, against the real client library, the two facts the web's
// `openAuthenticatedSocket` is built on: after a refused handshake or a
// server-ended session socket.io-client does NOT reconnect by itself, and
// `socket.connect()` reads the `auth` callback again, so a fresh token works.
//
// No port is opened beyond the loopback listener each test starts and closes.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "socket.io";
import { io as connectClient, type Socket as ClientSocket } from "socket.io-client";
import {
  JARVIS_TASK_CREATOR,
  OFFICE_STREAM_EVENT,
  OFFICE_SUBSCRIBE_EVENT,
  OFFICE_UNSUBSCRIBE_EVENT,
  type AuditEntry,
  type IAuditRepository,
  type OfficeStreamEvent,
  type TaskStatus,
  type VerifiedAccessToken,
} from "@jarvis/core";
import { AuditLogger, TokenService } from "@jarvis/security";
import type { TaskRecord } from "@jarvis/db";

import {
  SOCKET_CONNECT_TIMEOUT_MS,
  SOCKET_MAX_BUFFER_BYTES,
  secureSocketServer,
} from "../src/socket/socket-auth.js";
import { installOfficeStream, type OfficeStreamHandle } from "../src/socket/office-stream.js";
import {
  OfficeEventBus,
  officeAuditObserver,
  officeTaskObserver,
} from "../src/services/office-events.js";
import { TaskService } from "../src/services/tasks/task-service.js";
import { countTaskRows } from "./helpers/count-task-rows.js";

const SECRET = "vo21-e2e-secret-long-enough-for-hs256-signing";
const ALICE = { userId: "user-alice", role: "member", email: "alice@test.local" };
const BOB = { userId: "user-bob", role: "member", email: "bob@test.local" };

// ---------------------------------------------------------------------------
// In-memory stores behind the real AuditLogger and TaskService
// ---------------------------------------------------------------------------

class MemoryAuditRepository implements IAuditRepository {
  private seq = 0;
  async create(entry: Omit<AuditEntry, "id" | "timestamp">): Promise<AuditEntry> {
    this.seq += 1;
    return { ...entry, id: `audit-${this.seq}`, timestamp: new Date() };
  }
  async query(): Promise<AuditEntry[]> {
    return [];
  }
}

function memoryTasks() {
  const rows = new Map<string, TaskRecord>();
  let seq = 0;
  return {
    async create(userId: string, input: { title: string; description?: string | null; createdBy?: string | null }) {
      const now = new Date();
      const row: TaskRecord = {
        id: `task-${++seq}`,
        userId,
        title: input.title,
        description: input.description ?? null,
        dueAt: null,
        priority: "NORMAL",
        status: "PENDING",
        startedAt: null,
        completedAt: null,
        error: null,
        scheduledAt: null,
        claimedAt: null,
        executionId: null,
        remindedAt: null,
        createdBy: input.createdBy ?? null,
        createdAt: now,
        updatedAt: now,
      };
      rows.set(row.id, row);
      return row;
    },
    async list(userId: string) {
      return [...rows.values()].filter((r) => r.userId === userId);
    },
    async listByStatus(userId: string, status: TaskStatus) {
      return [...rows.values()].filter((r) => r.userId === userId && r.status === status);
    },
    async countByStatus(userId: string, options: { createdBy?: string } = {}) {
      return countTaskRows(rows.values(), userId, options);
    },
    async findOwned(userId: string, taskId: string) {
      const row = rows.get(taskId);
      return row && row.userId === userId ? row : null;
    },
    async transitionOwned(
      userId: string,
      taskId: string,
      expectedFrom: TaskStatus,
      to: TaskStatus,
      options: { error?: string | null; executionId?: string } = {}
    ) {
      const row = rows.get(taskId);
      if (!row || row.userId !== userId) {
        return { ok: false as const, reason: "not_found" as const, current: null };
      }
      if (row.status !== expectedFrom) {
        return { ok: false as const, reason: "state_changed" as const, current: row.status };
      }
      row.status = to;
      if (to === "RUNNING") row.startedAt = new Date();
      if (to === "FAILED") row.error = options.error ?? null;
      if (options.executionId !== undefined) row.executionId = options.executionId;
      row.updatedAt = new Date();
      return { ok: true as const, task: row };
    },
  };
}

// ---------------------------------------------------------------------------
// Server and client harness
// ---------------------------------------------------------------------------

interface Harness {
  url: string;
  io: Server;
  office: OfficeStreamHandle;
  audit: AuditLogger;
  tasks: TaskService;
  tokens: TokenService;
  clients: ClientSocket[];
}

const running: Harness[] = [];

async function start(
  verify?: (token: string, tokens: TokenService) => VerifiedAccessToken | null
): Promise<Harness> {
  const tokens = new TokenService(SECRET);
  const http = createServer();
  const io = new Server(http, {
    connectTimeout: SOCKET_CONNECT_TIMEOUT_MS,
    maxHttpBufferSize: SOCKET_MAX_BUFFER_BYTES,
  });

  // index.ts's order: authenticate and police first, then the office stream.
  secureSocketServer(
    io,
    { verifyAccessToken: (token) => (verify ? verify(token, tokens) : tokens.verifyAccessToken(token)) },
    { log: () => undefined }
  );
  const bus = new OfficeEventBus();
  const office = installOfficeStream(io, bus);

  // The container's own wiring.
  const audit = new AuditLogger(new MemoryAuditRepository(), officeAuditObserver(bus));
  const tasks = new TaskService({ tasks: memoryTasks(), onTaskChanged: officeTaskObserver(bus) });

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;

  const harness: Harness = { url: `http://127.0.0.1:${port}`, io, office, audit, tasks, tokens, clients: [] };
  running.push(harness);
  return harness;
}

function client(
  h: Harness,
  token: () => string | null,
  options: { reconnection?: boolean } = {}
): ClientSocket {
  const socket = connectClient(h.url, {
    // A function, as the web's `openAuthenticatedSocket` passes it.
    auth: (cb: (data: Record<string, unknown>) => void) => {
      const current = token();
      cb(current ? { token: current } : {});
    },
    transports: ["websocket"],
    reconnection: options.reconnection ?? false,
    forceNew: true,
  });
  h.clients.push(socket);
  return socket;
}

function once<T = unknown>(socket: ClientSocket, event: string, timeoutMs = 5_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
    socket.once(event, (value: T) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

async function connected(socket: ClientSocket): Promise<void> {
  if (!socket.connected) await once(socket, "connect");
}

/**
 * A round trip through the server. Socket.IO handles one socket's packets in
 * order, so once `pong` arrives every event emitted before `ping` has been
 * handled — a subscription is in place, an unsubscription is gone.
 */
async function barrier(socket: ClientSocket): Promise<void> {
  const pong = once(socket, "pong");
  socket.emit("ping");
  await pong;
}

async function subscribe(socket: ClientSocket): Promise<void> {
  await connected(socket);
  socket.emit(OFFICE_SUBSCRIBE_EVENT);
  await barrier(socket);
}

function collect(socket: ClientSocket): OfficeStreamEvent[] {
  const received: OfficeStreamEvent[] = [];
  socket.on(OFFICE_STREAM_EVENT, (event: OfficeStreamEvent) => received.push(event));
  return received;
}

const nextEvent = (socket: ClientSocket) => once<OfficeStreamEvent>(socket, OFFICE_STREAM_EVENT);

const signal = (userId: string, action: string) =>
  ({ userId, action, result: "success" as const });

/** A token the real TokenService signed twenty minutes ago: past its 15. */
function expiredToken(tokens: TokenService): string {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() - 20 * 60_000 });
  try {
    return tokens.generateAccessToken(ALICE);
  } finally {
    vi.useRealTimers();
  }
}

beforeEach(() => {
  // AuditLogger writes a structured line per row; keep the run quiet.
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  while (running.length > 0) {
    const h = running.pop()!;
    for (const socket of h.clients) socket.disconnect();
    h.office.stop();
    await new Promise<void>((resolve) => h.io.close(() => resolve()));
  }
});

// ---------------------------------------------------------------------------

describe("VO-2.1 — office events on the wire", () => {
  it("delivers a real audit row to its owner only, with only the allowlisted fields", async () => {
    const h = await start();
    const alice = client(h, () => h.tokens.generateAccessToken(ALICE));
    const bob = client(h, () => h.tokens.generateAccessToken(BOB));
    await subscribe(alice);
    await subscribe(bob);
    const bobReceived = collect(bob);

    const aliceEvent = nextEvent(alice);
    await h.audit.log({
      userId: ALICE.userId,
      agentId: "knowledge-agent",
      toolId: "meta.adsets",
      action: "tool.execute",
      parameters: { apiKey: "sk-live-0123456789abcdef", query: "private words" },
      result: "success",
      traceId: "trace-1",
      metadata: { executionId: "exec-1", durationMs: 42, error: "provider said something private" },
    });

    const event = await aliceEvent;
    expect(event).toEqual({
      kind: "activity",
      id: "audit-1",
      at: expect.any(String),
      action: "tool.execute",
      result: "success",
      agentId: "knowledge-agent",
      toolId: "meta.adsets",
      traceId: "trace-1",
      executionId: "exec-1",
      durationMs: 42,
    });
    const wire = JSON.stringify(event);
    expect(wire).not.toContain("sk-live");
    expect(wire).not.toContain("private");

    // Bob's own row is the sentinel: delivered after Alice's, so had Alice's
    // been sent to Bob it would already be here.
    const bobSentinel = nextEvent(bob);
    await h.audit.log(signal(BOB.userId, "orchestrator.process"));
    await bobSentinel;
    expect(bobReceived.map((e) => (e.kind === "activity" ? e.action : e.kind))).toEqual([
      "orchestrator.process",
    ]);
  });

  it("delivers a real task move without its title", async () => {
    const h = await start();
    const alice = client(h, () => h.tokens.generateAccessToken(ALICE));
    await subscribe(alice);

    const created = nextEvent(alice);
    const result = await h.tasks.createTask(ALICE.userId, {
      title: "Confidential launch plan",
      createdBy: JARVIS_TASK_CREATOR,
    });
    expect(result.ok).toBe(true);
    const taskId = result.ok ? result.task.id : "";
    expect(await created).toMatchObject({ kind: "task", taskId, status: "PENDING" });

    const started = nextEvent(alice);
    await h.tasks.startTask(ALICE.userId, taskId, { executionId: "exec-7" });
    const event = await started;

    expect(event).toMatchObject({ kind: "task", taskId, status: "RUNNING", executionId: "exec-7" });
    expect(JSON.stringify(event)).not.toContain("Confidential");
  });

  it("sends nothing to a socket of the same user that did not subscribe, or unsubscribed", async () => {
    const h = await start();
    const token = () => h.tokens.generateAccessToken(ALICE);
    const subscribed = client(h, token);
    const neverSubscribed = client(h, token);
    const unsubscribed = client(h, token);
    await subscribe(subscribed);
    await connected(neverSubscribed);
    await subscribe(unsubscribed);
    unsubscribed.emit(OFFICE_UNSUBSCRIBE_EVENT);
    await barrier(unsubscribed);
    const quiet = [collect(neverSubscribed), collect(unsubscribed)];

    const first = nextEvent(subscribed);
    await h.audit.log(signal(ALICE.userId, "first.event"));
    await first;

    // Now subscribe both and send a second: each must see ONLY the second.
    await subscribe(neverSubscribed);
    await subscribe(unsubscribed);
    const seconds = [nextEvent(neverSubscribed), nextEvent(unsubscribed)];
    await h.audit.log(signal(ALICE.userId, "second.event"));
    await Promise.all(seconds);

    for (const received of quiet) {
      expect(received.map((e) => (e.kind === "activity" ? e.action : e.kind))).toEqual([
        "second.event",
      ]);
    }
  });

  it("keeps writes and approvals off the transport, and a payload cannot name another user", async () => {
    const h = await start();
    const alice = client(h, () => h.tokens.generateAccessToken(ALICE));
    await connected(alice);

    for (const event of ["tool:execute", "approval:approve", "pending-action:confirm"]) {
      const refusal = once<{ code: string }>(alice, "error");
      alice.emit(event, { toolId: "meta.campaigns.pause" });
      expect((await refusal).code).toBe("SOCKET_EVENT_FORBIDDEN");
    }

    // Subscribing "as Bob" is refused loudly, and the subscription that does
    // exist is Alice's own, from the server-resolved identity.
    const override = once<{ code: string }>(alice, "error");
    alice.emit(OFFICE_SUBSCRIBE_EVENT, { userId: BOB.userId });
    expect((await override).code).toBe("SOCKET_IDENTITY_OVERRIDE");
    await barrier(alice);
    const received = collect(alice);

    await h.audit.log(signal(BOB.userId, "bob.private"));
    const sentinel = nextEvent(alice);
    await h.audit.log(signal(ALICE.userId, "alice.own"));
    await sentinel;

    expect(received.map((e) => (e.kind === "activity" ? e.action : e.kind))).toEqual(["alice.own"]);
  });
});

describe("VO-2.1 — handshakes the server refuses", () => {
  it("refuses a real expired token with the code the client renews on, and the client then stops", async () => {
    const h = await start();
    const socket = client(h, () => expiredToken(h.tokens), { reconnection: true });

    const error = await once<{ data?: { code?: string } }>(socket, "connect_error");

    expect(error.data?.code).toBe("SOCKET_AUTH_INVALID");
    // socket.io-client does not retry a refused handshake on its own: the
    // reason the web client renews the token and calls connect() itself.
    expect(socket.active).toBe(false);
    expect(socket.connected).toBe(false);
  });

  it("refuses a socket that presents no token", async () => {
    const h = await start();
    const socket = client(h, () => null);

    const error = await once<{ data?: { code?: string } }>(socket, "connect_error");

    expect(error.data?.code).toBe("SOCKET_AUTH_REQUIRED");
  });

  it("connects a refused socket again with a fresh token when asked", async () => {
    const h = await start();
    let current = expiredToken(h.tokens);
    const socket = client(h, () => current, { reconnection: true });
    await once(socket, "connect_error");

    current = h.tokens.generateAccessToken(ALICE);
    socket.connect();
    await subscribe(socket);

    const delivered = nextEvent(socket);
    await h.audit.log(signal(ALICE.userId, "after.renewal"));
    expect(await delivered).toMatchObject({ kind: "activity", action: "after.renewal" });
  });
});

describe("VO-2.1 — a session ends with its token", () => {
  const SESSION_MS = 700;

  it("is ended by the server at expiry, loses its subscription, and reconnects with a fresh token", async () => {
    // The real TokenService verifies the JWT; its expiry is brought forward so
    // the test does not wait fifteen minutes.
    const h = await start((token, tokens) => {
      const verified = tokens.verifyAccessToken(token);
      return verified ? { ...verified, expiresAt: Date.now() + SESSION_MS } : null;
    });
    const alice = client(h, () => h.tokens.generateAccessToken(ALICE), { reconnection: true });
    await subscribe(alice);
    const connectedAt = Date.now();
    expect(h.office.subscriberCount()).toBe(1);

    const reason = await once<string>(alice, "disconnect", 5_000);
    const lasted = Date.now() - connectedAt;

    expect(reason).toBe("io server disconnect");
    // Not before its time (timer resolution on Windows is ~15 ms).
    expect(lasted).toBeGreaterThanOrEqual(SESSION_MS - 100);
    // socket.io-client does not reconnect a session the server ended.
    expect(alice.active).toBe(false);
    await vi.waitFor(() => expect(h.office.subscriberCount()).toBe(0));

    // A new handshake, with a token read afresh, is a new session.
    alice.connect();
    await subscribe(alice);
    const delivered = nextEvent(alice);
    await h.audit.log(signal(ALICE.userId, "after.expiry"));
    expect(await delivered).toMatchObject({ kind: "activity", action: "after.expiry" });
  });

  it("sends nothing to an ended session", async () => {
    const h = await start((token, tokens) => {
      const verified = tokens.verifyAccessToken(token);
      return verified ? { ...verified, expiresAt: Date.now() + SESSION_MS } : null;
    });
    const alice = client(h, () => h.tokens.generateAccessToken(ALICE));
    await subscribe(alice);
    const received = collect(alice);

    await once(alice, "disconnect", 5_000);
    await vi.waitFor(() => expect(h.office.subscriberCount()).toBe(0));
    await h.audit.log(signal(ALICE.userId, "while.ended"));

    expect(received).toEqual([]);
  });
});
