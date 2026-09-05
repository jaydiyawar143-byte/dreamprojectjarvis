"use client";

// ---------------------------------------------------------------------------
// Sprint 4.2 — Page container and page header.
//
// Every dashboard page sits in the same measure and gutter, so panels line up
// from one route to the next. The header is separate from the top bar: the top
// bar is chrome that never changes, this is the page's own title block.
// ---------------------------------------------------------------------------

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PageContainer({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-testid="page-container"
      className={cn("mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8", className)}
    >
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-testid="page-header"
      className={cn(
        "mb-6 flex flex-col gap-3 border-b border-sys-line/70 pb-5 sm:flex-row sm:items-end sm:justify-between",
        className
      )}
    >
      <div className="min-w-0 space-y-1.5">
        <h1
          data-testid="page-title"
          className="text-balance text-xl font-semibold tracking-tight text-white sm:text-2xl"
        >
          {title}
        </h1>
        {description && <p className="max-w-2xl text-sm text-sys-dim">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * Responsive panel grid.
 *
 * Column counts are chosen so items always fill the row they are on — nothing
 * stretched across dead space, nothing stranded alone.
 */
export function PanelGrid({
  columns = 3,
  children,
  className,
}: {
  columns?: 2 | 3 | 4;
  children: ReactNode;
  className?: string;
}) {
  // A 3-up row goes straight from one column to three, skipping two: at two
  // columns the third item is stranded alone beside dead space. A 4-up row can
  // pass through two, because two rows of two still fill.
  const cols = {
    2: "sm:grid-cols-2",
    3: "sm:grid-cols-3",
    4: "sm:grid-cols-2 lg:grid-cols-4",
  }[columns];

  return (
    <div data-testid="panel-grid" className={cn("grid grid-cols-1 gap-4", cols, className)}>
      {children}
    </div>
  );
}
