"use client";

// ---------------------------------------------------------------------------
// The Auto Optimize preview.
//
// NOTHING IS APPLIED UNTIL THE USER SAYS SO. The panel renders a plan the
// engine computed and holds it; `onApply` is the only path by which a placement
// changes, and it runs on a click. That ordering is the whole feature — an
// optimizer that rearranges first and asks afterwards is a worse experience
// than no optimizer, because the user has to reconstruct what they had.
//
// BEFORE AND AFTER, IN GRID UNITS. Not pixels: pixels depend on the viewport
// and on whether this toolbar is open, so "5×12 → 6×12" is the only comparison
// that means the same thing on every screen. It is also what the user
// manipulates when they drag a handle, so it is the vocabulary they already
// have.
//
// LOW CONFIDENCE RENDERS AS ADVICE. When the engine found problems it cannot
// place a fix for, the Apply button is not shown at all — a disabled button
// invites the user to hunt for the condition that would enable it, when the
// honest answer is that there is nothing to apply.
// ---------------------------------------------------------------------------

import { Check, Sparkles, Undo2, X } from "lucide-react";
import type { OptimizationPlan } from "@/lib/dashboard/optimizer";

export function OptimizePanel({
  plan,
  canUndo,
  applying,
  onApply,
  onDismiss,
  onUndo,
}: {
  plan: OptimizationPlan;
  canUndo: boolean;
  applying: boolean;
  onApply: () => void;
  onDismiss: () => void;
  onUndo: () => void;
}) {
  const hasChanges = plan.changes.length > 0 && plan.confidence === "high";

  return (
    <div
      data-testid="optimize-panel"
      data-confidence={plan.confidence}
      role="dialog"
      aria-label="Dashboard optimization suggestions"
      className="glass-panel glass-edge mt-2 space-y-3 rounded-xl p-3"
    >
      <div className="flex items-center gap-2">
        <Sparkles size={13} className="text-sys-cyan" aria-hidden="true" />
        <h2 className="font-mono text-xs uppercase tracking-hud text-sys-cyan">
          Layout suggestions
        </h2>
      </div>

      {/* The issues, in the engine's own words. */}
      {plan.issues.length === 0 ? (
        <p data-testid="optimize-none" className="text-xs text-sys-dim">
          Your dashboard looks well arranged. I did not find anything worth moving.
        </p>
      ) : (
        <ol data-testid="optimize-issues" className="space-y-1.5">
          {plan.issues.map((issue, i) => (
            <li key={issue.id} className="flex gap-2 text-xs leading-relaxed text-sys-text/85">
              <span className="shrink-0 font-mono text-sys-dim">{i + 1}.</span>
              <span>{issue.title}</span>
            </li>
          ))}
        </ol>
      )}

      {/* Before and after, in grid units — the same units the drag handles use. */}
      {hasChanges && (
        <div data-testid="optimize-preview" className="space-y-1 rounded border border-sys-line/70 bg-black/20 p-2">
          {plan.changes.map((c) => (
            <div
              key={c.widgetId}
              data-testid={`optimize-change-${c.widgetId}`}
              className="flex flex-wrap items-baseline gap-x-2 text-xs"
            >
              <span className="text-sys-text/85">{c.reason}</span>
              <span className="font-mono text-sys-dim">
                {c.from.w}×{c.from.h}
                {" → "}
                <span className="text-sys-cyan">
                  {c.to.w}×{c.to.h}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}

      {plan.confidence === "low" && plan.issues.length > 0 && (
        <p data-testid="optimize-low-confidence" className="text-xs leading-relaxed text-amber-300/90">
          I can see the problem but not a clean way to fix it without moving things you
          arranged yourself, so I have not proposed any changes.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        {hasChanges && (
          <button
            type="button"
            data-testid="optimize-apply"
            onClick={onApply}
            disabled={applying}
            className="sys-focus flex items-center gap-1.5 rounded-md border border-sys-cyan/40 bg-sys-cyan/10 px-2 py-1 font-mono text-xs uppercase tracking-hud text-sys-cyan transition-colors enabled:hover:bg-sys-cyan/20 disabled:opacity-40"
          >
            <Check size={10} aria-hidden="true" />
            {applying ? "Applying…" : "Apply optimization"}
          </button>
        )}

        <button
          type="button"
          data-testid="optimize-dismiss"
          onClick={onDismiss}
          className="sys-focus flex items-center gap-1.5 rounded-md border border-sys-line px-2 py-1 font-mono text-xs uppercase tracking-hud text-sys-dim transition-colors hover:text-white"
        >
          <X size={10} aria-hidden="true" />
          Keep current layout
        </button>

        {/* Undo is offered whenever there is history, not only right after an
            apply: the user may dismiss the panel, look at the result, and want
            it back a minute later. */}
        {canUndo && (
          <button
            type="button"
            data-testid="optimize-undo"
            onClick={onUndo}
            className="sys-focus flex items-center gap-1.5 rounded-md border border-sys-line px-2 py-1 font-mono text-xs uppercase tracking-hud text-sys-dim transition-colors hover:text-white"
          >
            <Undo2 size={10} aria-hidden="true" />
            Undo
          </button>
        )}
      </div>
    </div>
  );
}
