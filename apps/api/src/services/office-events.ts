// ---------------------------------------------------------------------------
// VO-2 — the in-process office event bus.
//
// The writers are a `TaskService` transition and the `AuditLogger`'s post-write
// observer; the reader is the Socket.IO installer in `socket/office-stream.ts`.
// They are built at different moments — the container before the HTTP server,
// the socket layer after it — so a tiny bus between them is what keeps the
// dependency pointing one way.
//
// THREE PROPERTIES, EACH DELIBERATE.
//
//   1. PUBLISHING CANNOT BREAK A WRITE. Every listener call is wrapped: a
//      throwing or slow subscriber is the socket layer's problem, never the
//      audit row's or the task's. There is no `await` on this path.
//
//   2. NO HISTORY, NO REPLAY. An event is delivered to the subscribers that
//      are listening at that moment. The office reloads its three HTTP reads
//      on reconnect, which is where missed events are recovered — from the
//      durable rows, not from a queue here.
//
//   3. NO PAYLOAD IS BUILT HERE. The bus carries an `OfficeStreamEvent` that
//      core already constructed field by field. It never sees an audit record.
// ---------------------------------------------------------------------------

import { officeActivityEvent, officeTaskEvent, type OfficeStreamEvent } from "@jarvis/core";
import type { TaskRecord } from "@jarvis/db";
import type { AuditObserver } from "@jarvis/security";

export type OfficeEventListener = (userId: string, event: OfficeStreamEvent) => void;

export class OfficeEventBus {
  private readonly listeners = new Set<OfficeEventListener>();

  /**
   * Hand one already-projected event to every listener.
   *
   * A missing user id is dropped rather than broadcast: an event with no owner
   * has no room it could be correctly delivered to.
   */
  publish(userId: string, event: OfficeStreamEvent): void {
    if (typeof userId !== "string" || userId.length === 0) return;

    for (const listener of this.listeners) {
      try {
        listener(userId, event);
      } catch {
        // A subscriber never gets to fail the write that produced the event.
      }
    }
  }

  /** Returns the unsubscribe function. */
  subscribe(listener: OfficeEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Exposed for tests and diagnostics. */
  listenerCount(): number {
    return this.listeners.size;
  }
}

/**
 * The `AuditLogger` post-write observer the container installs: project the
 * durable row through core's allowlist, then publish to the row's owner.
 *
 * Named (VO-2.1) rather than written inline in the container, so the
 * end-to-end test drives exactly the wiring production runs.
 */
export function officeAuditObserver(bus: OfficeEventBus): AuditObserver {
  return (entry) => {
    const event = officeActivityEvent(entry);
    if (event) bus.publish(entry.userId, event);
  };
}

/** The `TaskService` change observer the container installs. Same reason. */
export function officeTaskObserver(bus: OfficeEventBus): (task: TaskRecord) => void {
  return (task) => {
    const event = officeTaskEvent(task);
    if (event) bus.publish(task.userId, event);
  };
}
