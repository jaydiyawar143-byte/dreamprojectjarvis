"use client";

// ---------------------------------------------------------------------------
// Sprint 4.2 — Panel: the dashboard's one container primitive.
//
// Border, fill and radius are spent once, here, so a screen made of panels
// reads as one system. `tone` carries semantic emphasis (a critical panel is
// not the accent colour, it is the danger colour) and stays separate from the
// cyan accent, which belongs to interaction.
// ---------------------------------------------------------------------------

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type PanelTone = "default" | "accent" | "warning" | "danger" | "success";

const TONE_EDGE: Record<PanelTone, string> = {
  default: "border-sys-line",
  accent: "border-sys-cyan/35",
  warning: "border-amber-400/35",
  danger: "border-sys-danger/35",
  success: "border-sys-ok/35",
};

export function Panel({
  title,
  description,
  action,
  footer,
  tone = "default",
  className,
  bodyClassName,
  children,
  ...rest
}: {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  footer?: ReactNode;
  tone?: PanelTone;
  className?: string;
  bodyClassName?: string;
  children?: ReactNode;
} & Omit<React.HTMLAttributes<HTMLElement>, "title">) {
  const hasHeader = Boolean(title || description || action);

  return (
    <section
      data-testid="panel"
      data-tone={tone}
      className={cn(
        "flex flex-col rounded-lg border bg-sys-panel/70 backdrop-blur-[2px]",
        TONE_EDGE[tone],
        className
      )}
      {...rest}
    >
      {hasHeader && (
        <header className="flex items-start justify-between gap-3 border-b border-sys-line/70 px-4 py-3">
          <div className="min-w-0 space-y-0.5">
            {title && (
              <h2
                data-testid="panel-title"
                className="truncate font-mono text-xs uppercase tracking-hud text-sys-text/80"
              >
                {title}
              </h2>
            )}
            {description && <p className="text-sm text-sys-dim">{description}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </header>
      )}

      <div className={cn("flex-1 px-4 py-4", bodyClassName)}>{children}</div>

      {footer && (
        <footer className="border-t border-sys-line/70 px-4 py-2.5 text-xs text-sys-dim">
          {footer}
        </footer>
      )}
    </section>
  );
}

/**
 * A single headline figure.
 *
 * Deliberately not a Panel variant: a stat is a *reading*, and giving it its own
 * component keeps the number, its label and its unit aligned across a row no
 * matter what each panel wraps.
 */
export function StatPanel({
  label,
  value,
  hint,
  tone = "default",
  loading = false,
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: PanelTone;
  loading?: boolean;
  className?: string;
}) {
  return (
    <Panel tone={tone} className={className} bodyClassName="px-4 py-4">
      <div data-testid="stat-panel" className="space-y-1.5">
        <p className="font-mono text-xs uppercase tracking-hud text-sys-dim">{label}</p>
        {loading ? (
          <div data-testid="stat-loading" className="h-8 w-16 animate-pulse rounded bg-sys-edge/50" />
        ) : (
          <p
            data-testid="stat-value"
            className="font-mono text-3xl font-semibold tabular-nums text-white"
          >
            {value}
          </p>
        )}
        {hint && <p className="text-xs text-sys-dim">{hint}</p>}
      </div>
    </Panel>
  );
}
