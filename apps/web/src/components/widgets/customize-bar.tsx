"use client";

// ---------------------------------------------------------------------------
// V3 — the customise toolbar.
//
// Off by default and almost invisible when off: a single quiet button. The
// premium state of this dashboard is the one where none of this is on screen.
//
// SAVE IS EXPLICIT. Every edit applies immediately so the user sees the result,
// but nothing reaches the server until Save is pressed. That gives Reset an
// honest meaning — discard what I have been doing — and means a user who
// experiments and closes the tab has not silently rewritten their dashboard.
// The unsaved state is shown, so "did that stick?" is never a question.
// ---------------------------------------------------------------------------

import { useState } from "react";
import { Check, LayoutGrid, RotateCcw, Save, Sliders, X } from "lucide-react";
import { CONSTRAINTS, type WidgetId, type WidgetPlacement } from "./layout";

export const WIDGET_LABELS: Record<WidgetId, string> = {
  orb: "JARVIS Orb",
  map: "Location & map",
  system: "System monitor",
  clock: "Clock",
  worldclock: "World clocks",
  weather: "Weather",
  tasks: "Tasks",
  markets: "Markets",
};

export function CustomizeBar({
  customizing,
  dirty,
  saving,
  layout,
  onToggle,
  onSetHidden,
  onSave,
  onReset,
}: {
  customizing: boolean;
  dirty: boolean;
  saving: boolean;
  layout: WidgetPlacement[];
  onToggle: () => void;
  onSetHidden: (id: WidgetId, hidden: boolean) => void;
  onSave: () => void;
  onReset: () => void;
}) {
  const [managing, setManaging] = useState(false);

  if (!customizing) {
    return (
      <div className="relative z-10 mb-3 flex w-full max-w-6xl justify-end">
        <button
          type="button"
          data-testid="customize-toggle"
          onClick={onToggle}
          className="sys-focus flex items-center gap-1.5 rounded-full border border-white/[0.07] bg-white/[0.03] px-2.5 py-1 font-mono text-[0.5rem] uppercase tracking-hud text-sys-dim transition-colors hover:border-sys-cyan/30 hover:text-white"
        >
          <Sliders size={10} aria-hidden="true" />
          Customise
        </button>
      </div>
    );
  }

  const hidden = layout.filter((p) => p.hidden);

  return (
    <div className="relative z-20 mb-4 w-full max-w-6xl">
      <div className="glass-panel glass-edge flex flex-wrap items-center gap-2 rounded-xl px-3 py-2">
        <p className="mr-auto flex items-center gap-1.5 font-mono text-[0.5rem] uppercase tracking-hud text-sys-cyan-soft">
          <Sliders size={10} aria-hidden="true" />
          Customising
          {dirty && (
            <span data-testid="unsaved-indicator" className="text-amber-300/90">
              · unsaved
            </span>
          )}
        </p>

        <button
          type="button"
          data-testid="manage-widgets"
          onClick={() => setManaging((v) => !v)}
          aria-expanded={managing}
          className="sys-focus flex items-center gap-1.5 rounded-md border border-sys-line px-2 py-1 font-mono text-[0.5rem] uppercase tracking-hud text-sys-dim transition-colors hover:text-white"
        >
          <LayoutGrid size={10} aria-hidden="true" />
          Manage widgets
          {hidden.length > 0 && <span className="text-amber-300/90">· {hidden.length} hidden</span>}
        </button>

        <button
          type="button"
          data-testid="reset-layout"
          onClick={onReset}
          className="sys-focus flex items-center gap-1.5 rounded-md border border-sys-line px-2 py-1 font-mono text-[0.5rem] uppercase tracking-hud text-sys-dim transition-colors hover:text-white"
        >
          <RotateCcw size={10} aria-hidden="true" />
          Reset
        </button>

        <button
          type="button"
          data-testid="save-layout"
          onClick={onSave}
          disabled={saving || !dirty}
          className="sys-focus flex items-center gap-1.5 rounded-md border border-sys-cyan/40 bg-sys-cyan/10 px-2 py-1 font-mono text-[0.5rem] uppercase tracking-hud text-sys-cyan transition-colors enabled:hover:bg-sys-cyan/20 disabled:opacity-40"
        >
          <Save size={10} aria-hidden="true" />
          {saving ? "Saving…" : "Save layout"}
        </button>

        <button
          type="button"
          data-testid="customize-done"
          onClick={onToggle}
          aria-label="Finish customising"
          className="sys-focus rounded-md border border-sys-line p-1 text-sys-dim transition-colors hover:text-white"
        >
          <X size={11} aria-hidden="true" />
        </button>
      </div>

      {managing && (
        <div
          data-testid="manage-panel"
          className="glass-panel mt-2 rounded-xl px-3 py-2.5"
          role="group"
          aria-label="Show or hide widgets"
        >
          <ul className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
            {layout.map((placement) => {
              const limits = CONSTRAINTS[placement.id];
              const visible = !placement.hidden;
              return (
                <li key={placement.id}>
                  <label
                    className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-[0.68rem] ${
                      limits.hideable
                        ? "cursor-pointer text-sys-text/85 hover:bg-white/[0.03]"
                        : "cursor-not-allowed text-sys-dim"
                    }`}
                  >
                    <input
                      type="checkbox"
                      data-testid={`toggle-${placement.id}`}
                      checked={visible}
                      // The Orb cannot be switched off: a dashboard without it
                      // is a different product.
                      disabled={!limits.hideable}
                      onChange={(e) => onSetHidden(placement.id, !e.target.checked)}
                      className="sys-focus h-3 w-3 shrink-0 accent-[#3ee0f2]"
                    />
                    <span className="min-w-0 flex-1 truncate">{WIDGET_LABELS[placement.id]}</span>
                    {!limits.hideable && (
                      <span
                        title="Always shown"
                        className="shrink-0 font-mono text-[0.42rem] uppercase tracking-hud text-sys-dim/70"
                      >
                        Always
                      </span>
                    )}
                    {visible && limits.hideable && (
                      <Check size={10} className="shrink-0 text-emerald-300/80" aria-hidden="true" />
                    )}
                  </label>
                </li>
              );
            })}
          </ul>

          <p className="mt-1.5 px-2 text-[0.5rem] leading-relaxed text-sys-dim/70">
            Drag the grip on a widget to reorder it, or use the arrow buttons. The Orb, command bar
            and approval controls are always available.
          </p>
        </div>
      )}
    </div>
  );
}
