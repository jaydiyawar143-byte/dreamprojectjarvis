"use client";

// ---------------------------------------------------------------------------
// V4 — dashboard layout state and persistence.
//
// Server-side persistence, reusing the preferences endpoint that already
// exists. A layout follows the user to another device, and — the reason it is
// not localStorage — it is user data the server should own.
//
// EDITS APPLY IMMEDIATELY, SAVES ARE EXPLICIT. Every change is visible at once
// so the user can judge it, but nothing is written until Save. That is what
// makes Reset mean "discard my changes" rather than "overwrite what I had", and
// it stops an experiment in customise mode silently becoming the saved layout.
// `dirty` is exposed so the toolbar can say which state it is in.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react";
import { getPreferences, savePreferences, type CommandCenterPreferences } from "./api";
import {
  DEFAULT_LAYOUT,
  normalizeLayout,
  nudge as nudgeWidget,
  resizeBy as resizeWidgetBy,
  setHidden as setWidgetHidden,
  type WidgetId,
  type WidgetPlacement,
} from "@/components/widgets/layout";

export interface DashboardLayoutState {
  layout: WidgetPlacement[];
  preferences: CommandCenterPreferences;
  loaded: boolean;
  dirty: boolean;
  saving: boolean;
  customizing: boolean;

  setCustomizing: (on: boolean) => void;
  /**
   * The whole arrangement, as the grid now has it.
   *
   * V4 — this is how a drag and a corner-resize both arrive. The grid library
   * owns the interaction and reports the RESULT, already bounded horizontally
   * by the caller. The ROW is taken as given; see the body for why re-clamping
   * it here is what made widgets fall out of the workspace.
   */
  applyLayout: (next: WidgetPlacement[]) => void;
  /** Keyboard equivalents of dragging and corner-resizing. */
  nudge: (id: WidgetId, dx: number, dy: number) => void;
  resizeBy: (id: WidgetId, dw: number, dh: number) => void;
  setHidden: (id: WidgetId, hidden: boolean) => void;
  save: () => Promise<void>;
  reset: () => void;
  /** Non-layout preferences (clock mode, weather location) save immediately. */
  updatePreferences: (patch: Partial<CommandCenterPreferences>) => void;
}

/** Same widgets, same cells — used to tell a real edit from an echo. */
function sameLayout(a: WidgetPlacement[], b: WidgetPlacement[]): boolean {
  if (a.length !== b.length) return false;
  const key = (p: WidgetPlacement) => `${p.id}:${p.x},${p.y},${p.w},${p.h},${p.hidden ? 1 : 0}`;
  const seen = new Set(a.map(key));
  return b.every((p) => seen.has(key(p)));
}

export function useDashboardLayout(): DashboardLayoutState {
  const [layout, setLayout] = useState<WidgetPlacement[]>(DEFAULT_LAYOUT);
  const [preferences, setPreferences] = useState<CommandCenterPreferences>({});
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [customizing, setCustomizing] = useState(false);

  // The last SAVED layout, so Reset restores what the server holds rather than
  // the shipped default when the user has a saved one.
  const savedRef = useRef<WidgetPlacement[]>(DEFAULT_LAYOUT);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await getPreferences();
      if (cancelled) return;

      if (res.success && res.data) {
        const prefs = res.data.preferences ?? {};
        // `normalizeLayout` repairs anything a previous version wrote: unknown
        // ids dropped, new widgets appended, placements re-clamped, and a V3
        // layout migrated to coordinates.
        const restored = normalizeLayout((prefs as { layout?: unknown }).layout);
        setLayout(restored);
        savedRef.current = restored;
        setPreferences(prefs);
      }
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Applies a layout change locally and marks it unsaved. */
  const edit = useCallback((next: (current: WidgetPlacement[]) => WidgetPlacement[]) => {
    setLayout((current) => {
      const updated = next(current);
      // Reference equality means the operation declined to change anything —
      // hiding the Orb, moving past the end — so it is not "unsaved".
      if (updated !== current) setDirty(true);
      return updated;
    });
  }, []);

  const applyLayout = useCallback(
    (next: WidgetPlacement[]) =>
      edit((current) => {
        // Taken as given, NOT re-clamped.
        //
        // The caller has already applied `clampToColumns`. Clamping again here
        // — with the row-bounding `clampPlacement`, as this did — pinned every
        // deep widget to `MAX_ROWS - h` while the grid library went on
        // rendering it where its own compaction had put it. The two disagreed
        // permanently: the row height was computed from this shallower layout
        // and was therefore too tall for what was actually on screen, so the
        // bottom widgets hung out of the workspace. Exactly the symptom the
        // clamp existed to prevent, caused by the clamp.
        //
        // Hidden widgets are not handed to the grid, so they are not in `next`.
        // Their placements are carried across untouched — hiding a widget must
        // not also forget where it was.
        const moved = new Map(next.map((p) => [p.id, p]));
        const merged = current.map((p) => moved.get(p.id) ?? p);

        // The grid fires a change event on mount and at the end of every drag,
        // including one that put the widget back where it started. Treating
        // those as edits would light up "unsaved" for doing nothing.
        return sameLayout(current, merged) ? current : merged;
      }),
    [edit]
  );

  const nudge = useCallback(
    (id: WidgetId, dx: number, dy: number) => edit((c) => nudgeWidget(c, id, dx, dy)),
    [edit]
  );

  const resizeBy = useCallback(
    (id: WidgetId, dw: number, dh: number) => edit((c) => resizeWidgetBy(c, id, dw, dh)),
    [edit]
  );

  const setHidden = useCallback(
    (id: WidgetId, hidden: boolean) => edit((c) => setWidgetHidden(c, id, hidden)),
    [edit]
  );

  const save = useCallback(async () => {
    setSaving(true);
    const next: CommandCenterPreferences = { ...preferences, layout };
    const res = await savePreferences(next);
    setSaving(false);

    if (res.success) {
      savedRef.current = layout;
      setPreferences(next);
      setDirty(false);
    }
    // A failed save deliberately leaves `dirty` true: the work is still only
    // local, and the toolbar must keep saying so.
  }, [layout, preferences]);

  const reset = useCallback(() => {
    // Back to the SHIPPED default — "reset to JARVIS default layout" — and
    // marked dirty, because the user still has to Save to make it permanent.
    setLayout(DEFAULT_LAYOUT);
    setDirty(true);
  }, []);

  const updatePreferences = useCallback((patch: Partial<CommandCenterPreferences>) => {
    // Clock mode and weather location are single toggles, not a layout edit, so
    // they persist on the spot rather than waiting behind Save.
    setPreferences((prev) => {
      const next = { ...prev, ...patch };
      void savePreferences({ ...next, layout: savedRef.current });
      return next;
    });
  }, []);

  return {
    layout,
    preferences,
    loaded,
    dirty,
    saving,
    customizing,
    setCustomizing,
    applyLayout,
    nudge,
    resizeBy,
    setHidden,
    save,
    reset,
    updatePreferences,
  };
}
