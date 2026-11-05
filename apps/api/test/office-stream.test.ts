// ---------------------------------------------------------------------------
// VO-2 — the Virtual Office's live stream.
//
// These tests pin the four things that make the stream safe and honest:
//
//   1. The projection is an ALLOWLIST. An audit row's parameters, error text
//      and any other metadata have nowhere to go, and a task's title is not an
//      argument to its projection at all.
//   2. One user's events never reach another user's office, and unsubscribing
//      stops delivery.
//   3. The socket policy classifies both new events READ_ONLY, so they cannot
//      widen what a socket may do.
//   4. Every task lifecycle state can be carried, so a later state cannot
//      silently go missing from the office.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  OFFICE_STREAM_EVENT,
  OFFICE_SUBSCRIBE_EVENT,
  OFFICE_UNSUBSCRIBE_EVENT,
  TaskStatusSchema,
  officeActivityEvent,
  officeTaskEvent,
  parseOfficeStreamEvent,
  type AuditEntry,
  type OfficeActivityEvent,
  type OfficeStreamEvent,
} from "@jarvis/core";

import { isSocketEventAllowed } from "../src/socket/socket-auth.js";

import { OfficeEventBus } from "../src/services/office-events.js";
import { installOfficeStream } from "../src/socket/office-stream.js";

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

const auditRow: AuditEntry = {
  id: "audit-1",
  timestamp: new Date("2026-11-01T10:00:00.000Z"),
  userId: "user-alice",
  agentId: "agent-meta-ads",
  toolId: "meta.get.campaigns",
  action: "tool.execute",
  result: "success",
  traceId: "trace-1",
  ipAddress: "10.0.0.9",
  parameters: {
    accessToken: "EAAB-secret",
    prompt: "the user's private words",
  },
  metadata: {
    executionId: "exec-1",
    durationMs: 1234,
    error: "provider said something private",
    rawRequest: { body: "secret" },
  },
};

describe("VO-2 — office activity projection", () => {
  it("carries only the allowlisted fields", () => {
    const event = officeActivityEvent(auditRow);
    expect(event).not.toBeNull();

    expect(Object.keys(event!).sort()).toEqual(
      ["action", "agentId", "at", "durationMs", "executionId", "id", "kind", "result", "toolId", "traceId"].sort()
    );
    const serialised = JSON.stringify(event);
    expect(serialised).not.toContain("EAAB-secret");
    expect(serialised).not.toContain("private words");
    expect(serialised).not.toContain("provider said");
    expect(serialised).not.toContain("ipAddress");
    expect(serialised).not.toContain("parameters");
    expect(serialised).not.toContain("metadata");
    expect(serialised).not.toContain("userId");
  });

  it("omits an agent id the row did not genuinely name", () => {
    const event = officeActivityEvent({ ...auditRow, agentId: undefined });
    expect(event).not.toBeNull();
    expect("agentId" in event!).toBe(false);
  });

  it("refuses a malformed row rather than inventing one", () => {
    expect(officeActivityEvent({ ...auditRow, id: "" })).toBeNull();
    expect(officeActivityEvent({ ...auditRow, timestamp: new Date("nope") })).toBeNull();
    expect(officeActivityEvent({ ...auditRow, action: "   " })).toBeNull();
    expect(
      officeActivityEvent({ ...auditRow, result: "something-else" as AuditEntry["result"] })
    ).toBeNull();
  });

  it("reads only executionId and durationMs from metadata", () => {
    const event = officeActivityEvent(auditRow)!;
    expect(event.executionId).toBe("exec-1");
    expect(event.durationMs).toBe(1234);
    expect(JSON.stringify(event)).not.toContain("error");
  });

  it("decodes its own output without adding anything", () => {
    const event = officeActivityEvent(auditRow)!;
    expect(parseOfficeStreamEvent(JSON.parse(JSON.stringify(event)))).toEqual(event);
  });
});

describe("VO-2 — office task projection", () => {
  const row = {
    id: "task-1",
    status: "RUNNING" as const,
    updatedAt: new Date("2026-11-01T10:00:00.000Z"),
    executionId: "exec-1",
    // Deliberately present on the row and deliberately absent from the type:
    // the projection has no parameter that could carry it.
    title: "Pause the campaign",
    error: "something went wrong",
  };

  it("carries no title, description or error", () => {
    const event = officeTaskEvent(row)!;
    expect(event).toEqual({
      kind: "task",
      id: "task:task-1:RUNNING:2026-11-01T10:00:00.000Z",
      at: "2026-11-01T10:00:00.000Z",
      taskId: "task-1",
      status: "RUNNING",
      executionId: "exec-1",
    });
    expect(JSON.stringify(event)).not.toContain("Pause the campaign");
    expect(JSON.stringify(event)).not.toContain("something went wrong");
  });

  it("has a deterministic id for the same durable transition", () => {
    expect(officeTaskEvent(row)!.id).toBe(officeTaskEvent({ ...row })!.id);
  });

  it("carries every lifecycle state core allows", () => {
    for (const status of TaskStatusSchema.options) {
      const event = officeTaskEvent({ ...row, status });
      expect(event, status).not.toBeNull();
      expect(event!.status).toBe(status);
    }
  });

  it("refuses an unknown state rather than relaying it", () => {
    expect(
      officeTaskEvent({ ...row, status: "PAUSED" as unknown as typeof row.status })
    ).toBeNull();
  });
});

describe("VO-2 — the wire reader", () => {
  it("drops unknown fields from an activity event", () => {
    const parsed = parseOfficeStreamEvent({
      kind: "activity",
      id: "a-1",
      at: "2026-11-01T10:00:00.000Z",
      action: "tool.execute",
      result: "success",
      agentId: "agent-1",
      parameters: { token: "secret" },
      metadata: { error: "private" },
      userId: "someone-else",
    });

    expect(parsed).toEqual({
      kind: "activity",
      id: "a-1",
      at: "2026-11-01T10:00:00.000Z",
      action: "tool.execute",
      result: "success",
      agentId: "agent-1",
    });
    expect(JSON.stringify(parsed)).not.toContain("secret");
    expect(JSON.stringify(parsed)).not.toContain("someone-else");
  });

  it("recomputes a task event's id instead of trusting it", () => {
    const parsed = parseOfficeStreamEvent({
      kind: "task",
      id: "not-the-real-id",
      at: "2026-11-01T10:00:00.000Z",
      taskId: "task-1",
      status: "COMPLETED",
    });

    expect(parsed).toEqual({
      kind: "task",
      id: "task:task-1:COMPLETED:2026-11-01T10:00:00.000Z",
      at: "2026-11-01T10:00:00.000Z",
      taskId: "task-1",
      status: "COMPLETED",
    });
  });

  it("ignores anything that is not a well-formed office event", () => {
    expect(parseOfficeStreamEvent(null)).toBeNull();
    expect(parseOfficeStreamEvent([])).toBeNull();
    expect(parseOfficeStreamEvent("activity")).toBeNull();
    expect(parseOfficeStreamEvent({ kind: "other" })).toBeNull();
    expect(parseOfficeStreamEvent({ kind: "activity", id: "a" })).toBeNull();
    expect(parseOfficeStreamEvent({ kind: "task", taskId: "t", status: "PAUSED" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Bus
// ---------------------------------------------------------------------------

describe("VO-2 — office event bus", () => {
  const event: OfficeActivityEvent = {
    kind: "activity",
    id: "a-1",
    at: "2026-11-01T10:00:00.000Z",
    action: "tool.execute",
    result: "success",
  };

  it("delivers to every subscriber with the target user", () => {
    const bus = new OfficeEventBus();
    const seen: Array<{ userId: string; event: OfficeStreamEvent }> = [];
    bus.subscribe((userId, payload) => seen.push({ userId, event: payload }));

    bus.publish("user-alice", event);

    expect(seen).toEqual([{ userId: "user-alice", event }]);
  });

  it("stops delivering after unsubscribe", () => {
    const bus = new OfficeEventBus();
    let count = 0;
    const unsubscribe = bus.subscribe(() => {
      count += 1;
    });

    bus.publish("user-alice", event);
    unsubscribe();
    bus.publish("user-alice", event);

    expect(count).toBe(1);
    expect(bus.listenerCount()).toBe(0);
  });

  it("never lets a throwing subscriber fail the write", () => {
    const bus = new OfficeEventBus();
    let delivered = 0;
    bus.subscribe(() => {
      throw new Error("subscriber failed");
    });
    bus.subscribe(() => {
      delivered += 1;
    });

    expect(() => bus.publish("user-alice", event)).not.toThrow();
    expect(delivered).toBe(1);
  });

  it("drops an event with no owner rather than broadcasting it", () => {
    const bus = new OfficeEventBus();
    let count = 0;
    bus.subscribe(() => {
      count += 1;
    });

    bus.publish("", event);

    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Socket delivery
// ---------------------------------------------------------------------------

const ALICE = { userId: "user-alice", role: "member", email: "alice@test.local" };
const BOB = { userId: "user-bob", role: "member", email: "bob@test.local" };

interface FakeSocket {
  id: string;
  data: Record<string, unknown>;
  handlers: Map<string, Function>;
  on(event: string, handler: Function): void;
  clientEmit(event: string): void;
}

function fakeSocket(id: string, auth: typeof ALICE | null): FakeSocket {
  return {
    id,
    data: auth ? { auth } : {},
    handlers: new Map(),
    on(event, handler) {
      this.handlers.set(event, handler);
    },
    clientEmit(event) {
      this.handlers.get(event)?.();
    },
  };
}

interface FakeIo {
  connectionHandler: ((socket: FakeSocket) => void) | null;
  emitted: Array<{ to: string; event: string; payload: unknown }>;
  on(event: string, handler: (socket: FakeSocket) => void): void;
  to(target: string): { emit(event: string, payload: unknown): void };
}

function fakeIo(): FakeIo {
  return {
    connectionHandler: null,
    emitted: [],
    on(event, handler) {
      if (event === "connection") this.connectionHandler = handler;
    },
    to(target) {
      return {
        emit: (event, payload) => {
          this.emitted.push({ to: target, event, payload });
        },
      };
    },
  };
}

const connect = (io: FakeIo, socket: FakeSocket) => io.connectionHandler!(socket);

const activity = (id: string): OfficeActivityEvent => ({
  kind: "activity",
  id,
  at: "2026-11-01T10:00:00.000Z",
  action: "tool.execute",
  result: "success",
});

describe("VO-2 — office socket delivery", () => {
  it("delivers only to subscribed sockets of the named user", () => {
    const bus = new OfficeEventBus();
    const io = fakeIo();
    installOfficeStream(io as unknown as Parameters<typeof installOfficeStream>[0], bus);

    const alice = fakeSocket("alice-1", ALICE);
    const bob = fakeSocket("bob-1", BOB);
    connect(io, alice);
    connect(io, bob);
    alice.clientEmit(OFFICE_SUBSCRIBE_EVENT);
    bob.clientEmit(OFFICE_SUBSCRIBE_EVENT);

    bus.publish(ALICE.userId, activity("a-1"));

    expect(io.emitted).toHaveLength(1);
    expect(io.emitted[0]).toMatchObject({ to: "alice-1", event: OFFICE_STREAM_EVENT });
    expect(io.emitted.some((entry) => entry.to === "bob-1")).toBe(false);
  });

  it("delivers nothing when the user has no subscribed socket", () => {
    const bus = new OfficeEventBus();
    const io = fakeIo();
    installOfficeStream(io as unknown as Parameters<typeof installOfficeStream>[0], bus);

    connect(io, fakeSocket("alice-1", ALICE));
    bus.publish(ALICE.userId, activity("a-1"));

    expect(io.emitted).toHaveLength(0);
  });

  it("stops delivery after unsubscribe and after disconnect", () => {
    const bus = new OfficeEventBus();
    const io = fakeIo();
    installOfficeStream(io as unknown as Parameters<typeof installOfficeStream>[0], bus);

    const alice = fakeSocket("alice-1", ALICE);
    connect(io, alice);
    alice.clientEmit(OFFICE_SUBSCRIBE_EVENT);
    bus.publish(ALICE.userId, activity("a-1"));
    expect(io.emitted).toHaveLength(1);

    alice.clientEmit(OFFICE_UNSUBSCRIBE_EVENT);
    bus.publish(ALICE.userId, activity("a-2"));
    expect(io.emitted).toHaveLength(1);

    alice.clientEmit(OFFICE_SUBSCRIBE_EVENT);
    alice.clientEmit("disconnect");
    bus.publish(ALICE.userId, activity("a-3"));
    expect(io.emitted).toHaveLength(1);
  });

  it("ignores a socket with no authenticated identity", () => {
    const bus = new OfficeEventBus();
    const io = fakeIo();
    const handle = installOfficeStream(
      io as unknown as Parameters<typeof installOfficeStream>[0],
      bus
    );

    const anonymous = fakeSocket("anon", null);
    connect(io, anonymous);
    // Even if it somehow names a subscription, there is no identity to deliver
    // to, so the installer never registered a handler.
    expect(anonymous.handlers.size).toBe(0);
    expect(handle.subscriberCount()).toBe(0);
  });

  it("tears down its delivery on stop", () => {
    const bus = new OfficeEventBus();
    const io = fakeIo();
    const handle = installOfficeStream(
      io as unknown as Parameters<typeof installOfficeStream>[0],
      bus
    );

    const alice = fakeSocket("alice-1", ALICE);
    connect(io, alice);
    alice.clientEmit(OFFICE_SUBSCRIBE_EVENT);
    expect(handle.subscriberCount()).toBe(1);

    handle.stop();
    bus.publish(ALICE.userId, activity("a-1"));

    expect(handle.subscriberCount()).toBe(0);
    expect(io.emitted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

describe("VO-2 — socket policy", () => {
  it("classifies both office events as allowed read-only events", () => {
    expect(isSocketEventAllowed(OFFICE_SUBSCRIBE_EVENT)).toBe(true);
    expect(isSocketEventAllowed(OFFICE_UNSUBSCRIBE_EVENT)).toBe(true);
  });

  it("leaves every write and approval event forbidden", () => {
    for (const event of [
      "tool:execute",
      "agent:execute",
      "approval:approve",
      "pending-action:confirm",
    ]) {
      expect(isSocketEventAllowed(event), event).toBe(false);
    }
  });
});
