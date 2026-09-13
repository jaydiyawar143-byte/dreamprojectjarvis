// ---------------------------------------------------------------------------
// Layout history and undo.
//
// The property that matters is EXACTNESS. Undo exists so a user can accept an
// optimization without committing to it, and that promise only holds if what
// comes back is byte-for-byte what they had. A history that shares object
// references with live state quietly rewrites itself as the user drags things,
// and by the time they press undo it restores the arrangement they were trying
// to escape.
//
// So the copying is tested directly, in both directions: nothing the caller
// mutates afterwards can reach into the history, and nothing the history hands
// back can be mutated into it.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { LayoutHistory, MAX_HISTORY } from "../src/lib/dashboard/layout-history";
import type { WidgetPlacement } from "../src/components/widgets/layout";

const A: WidgetPlacement[] = [
  { id: "orb", x: 0, y: 0, w: 4, h: 7 },
  { id: "markets", x: 4, y: 0, w: 8, h: 4 },
];
const B: WidgetPlacement[] = [
  { id: "orb", x: 0, y: 0, w: 4, h: 12 },
  { id: "markets", x: 4, y: 0, w: 8, h: 4 },
];

describe("recording and undoing", () => {
  it("starts with nothing to undo", () => {
    const h = new LayoutHistory();
    expect(h.canUndo).toBe(false);
    expect(h.undo()).toBeNull();
  });

  it("restores the layout as it was before the change", () => {
    const h = new LayoutHistory();
    h.push(A, "optimization");

    const entry = h.undo();

    expect(entry).not.toBeNull();
    expect(entry!.layout).toEqual(A);
    expect(entry!.reason).toBe("optimization");
  });

  it("walks back one step at a time, most recent first", () => {
    const h = new LayoutHistory();
    h.push(A, "first");
    h.push(B, "second");

    expect(h.undo()!.reason).toBe("second");
    expect(h.undo()!.reason).toBe("first");
    expect(h.canUndo).toBe(false);
  });

  it("reports what the next undo would restore, without consuming it", () => {
    const h = new LayoutHistory();
    h.push(A, "optimization");

    expect(h.peek()!.reason).toBe("optimization");
    expect(h.canUndo).toBe(true);
    expect(h.depth).toBe(1);
  });

  it("records when the change happened", () => {
    const h = new LayoutHistory();
    h.push(A, "optimization", new Date("2026-09-13T10:00:00Z"));

    expect(h.peek()!.at).toBe("2026-09-13T10:00:00.000Z");
  });
});

describe("the history cannot be corrupted by the live layout", () => {
  it("is unaffected by the caller mutating the array afterwards", () => {
    const live: WidgetPlacement[] = A.map((p) => ({ ...p }));
    const h = new LayoutHistory();
    h.push(live, "optimization");

    // The user drags something after the snapshot was taken.
    live[0]!.h = 99;
    live.push({ id: "clock", x: 0, y: 7, w: 2, h: 5 });

    const restored = h.undo()!.layout;
    expect(restored).toHaveLength(2);
    expect(restored[0]!.h).toBe(7);
  });

  it("hands back a copy, so mutating the result cannot rewrite the history", () => {
    const h = new LayoutHistory();
    h.push(A, "one");
    h.push(A, "two");

    const first = h.undo()!.layout;
    first[0]!.h = 42;

    expect(h.undo()!.layout[0]!.h).toBe(7);
  });
});

describe("the history is bounded", () => {
  it(`keeps at most ${MAX_HISTORY} entries`, () => {
    const h = new LayoutHistory();
    for (let i = 0; i < MAX_HISTORY + 5; i++) h.push(A, `change-${i}`);

    expect(h.depth).toBe(MAX_HISTORY);
  });

  it("discards the OLDEST when full, so recent undos still work", () => {
    const h = new LayoutHistory();
    for (let i = 0; i < MAX_HISTORY + 3; i++) h.push(A, `change-${i}`);

    expect(h.peek()!.reason).toBe(`change-${MAX_HISTORY + 2}`);
  });

  it("clears completely on request", () => {
    const h = new LayoutHistory();
    h.push(A, "one");
    h.clear();

    expect(h.canUndo).toBe(false);
    expect(h.depth).toBe(0);
  });
});
