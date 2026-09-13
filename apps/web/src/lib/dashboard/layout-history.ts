// ---------------------------------------------------------------------------
// Layout history, so an optimization can always be taken back.
//
// WHY THIS EXISTS SEPARATELY FROM THE OPTIMIZER. The optimizer proposes; this
// remembers. Keeping them apart means the undo path does not depend on the
// analysis being correct — a bad recommendation the user accepted is undone by
// exactly the same mechanism as a good one they changed their mind about.
//
// THE ENTRY IS THE LAYOUT BEFORE THE CHANGE, not a diff. Replaying an inverse
// diff would have to re-derive placements and could drift from what was
// actually on screen; storing the whole array is a few hundred bytes and
// restores byte-for-byte what the user had. For a structure this small, exact
// beats clever.
//
// BOUNDED, because this lives in memory for the length of a session and an
// unbounded stack of layouts is a slow leak with no upper limit on how many
// times someone presses Optimize.
// ---------------------------------------------------------------------------

import type { WidgetPlacement } from "@/components/widgets/layout";

export interface LayoutHistoryEntry {
  /** The layout as it was BEFORE the change that this entry can undo. */
  layout: WidgetPlacement[];
  /** What produced the change. Shown in the undo affordance. */
  reason: string;
  at: string;
}

/** Enough to walk back a session's worth of experimenting; small enough to hold. */
export const MAX_HISTORY = 10;

export class LayoutHistory {
  private entries: LayoutHistoryEntry[] = [];

  /**
   * Record the layout that is about to be replaced.
   *
   * Deep-copied on the way in: the caller usually goes on to mutate its own
   * state, and a history that shares references would quietly rewrite itself.
   */
  push(layout: WidgetPlacement[], reason: string, at: Date = new Date()): void {
    this.entries.push({
      layout: layout.map((p) => ({ ...p })),
      reason,
      at: at.toISOString(),
    });
    if (this.entries.length > MAX_HISTORY) this.entries.shift();
  }

  /** True when there is something to go back to. */
  get canUndo(): boolean {
    return this.entries.length > 0;
  }

  get depth(): number {
    return this.entries.length;
  }

  /** What the next undo would restore, without consuming it. */
  peek(): LayoutHistoryEntry | null {
    return this.entries.length > 0 ? this.entries[this.entries.length - 1]! : null;
  }

  /**
   * Take back the most recent change.
   *
   * Returns a fresh copy, so the caller can hand it straight to state without
   * the history and the live layout becoming the same object.
   */
  undo(): LayoutHistoryEntry | null {
    const entry = this.entries.pop();
    if (!entry) return null;
    return { ...entry, layout: entry.layout.map((p) => ({ ...p })) };
  }

  clear(): void {
    this.entries = [];
  }
}
