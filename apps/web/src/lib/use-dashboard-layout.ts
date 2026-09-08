"use client";

// ---------------------------------------------------------------------------
// V3 — dashboard layout state and persistence.
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
  move as moveWidget,
  moveTo,
  normalizeLayout,
  resize as resizeWidget,
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
  move: (id: WidgetId, direction: -1 | 1) => void;
  dropOn: (sourceId: WidgetId, targetId: WidgetId) => void;
  resize: (id: WidgetId, delta: { w?: number; h?: number }) => void;
  setHidden: (id: WidgetId, hidden: boolean) => void;
  save: () => Promise<void>;
  reset: () => void;
  /** Non-layout preferences (clock mode, weather location) save immediately. */
  updatePreferences: (patch: Partial<CommandCenterPreferences>) => void;
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
        // ids dropped, new widgets appended, sizes re-clamped.
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

  const move = useCallback(
    (id: WidgetId, direction: -1 | 1) => edit((c) => moveWidget(c, id, direction)),
    [edit]
  );

  const dropOn = useCallback(
    (sourceId: WidgetId, targetId: WidgetId) =>
      edit((current) => {
        const visible = current.filter((p) => !p.hidden);
        const targetIndex = visible.findIndex((p) => p.id === targetId);
        return targetIndex === -1 ? current : moveTo(current, sourceId, targetIndex);
      }),
    [edit]
  );

  const resize = useCallback(
    (id: WidgetId, delta: { w?: number; h?: number }) => edit((c) => resizeWidget(c, id, delta)),
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
    move,
    dropOn,
    resize,
    setHidden,
    save,
    reset,
    updatePreferences,
  };
}
