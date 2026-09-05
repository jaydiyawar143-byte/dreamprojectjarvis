"use client";

// ---------------------------------------------------------------------------
// Sprint 4.2 — The three states every data surface needs.
//
// One implementation, so a loading panel looks the same everywhere and an
// error is always actionable. Each takes a `label`/`message` rather than
// hard-coding copy, because "no approvals" and "no documents" are different
// sentences and a shared component must not invent either.
// ---------------------------------------------------------------------------

import type { ReactNode } from "react";
import { AlertTriangle, Inbox, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

/**
 * A single shimmering placeholder bar.
 *
 * `animate-pulse` is neutralised under prefers-reduced-motion by the global
 * brake in globals.css, leaving a static block — still a legible placeholder.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      data-testid="skeleton"
      aria-hidden="true"
      className={cn("animate-pulse rounded bg-sys-edge/50", className)}
    />
  );
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Busy state.
 *
 * `role="status"` + `aria-busy` so assistive tech announces the wait instead of
 * reading an empty region. `lines` draws skeleton bars when the eventual shape
 * is list-like; otherwise a single label carries it.
 */
export function LoadingState({
  label = "Loading…",
  lines = 3,
  className,
}: {
  label?: string;
  lines?: number;
  className?: string;
}) {
  return (
    <div
      data-testid="loading-state"
      role="status"
      aria-busy="true"
      aria-live="polite"
      className={cn("space-y-3 py-2", className)}
    >
      <span className="sr-only">{label}</span>
      <p
        aria-hidden="true"
        className="font-mono text-[0.6rem] uppercase tracking-hud text-sys-dim"
      >
        {label}
      </p>
      {Array.from({ length: Math.max(lines, 0) }).map((_, i) => (
        <Skeleton key={i} className={cn("h-3", i === 0 ? "w-2/3" : i === 1 ? "w-full" : "w-4/5")} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/**
 * Failure state.
 *
 * Says what failed and offers the way out. `role="alert"` because a failure
 * that appears after the user acted must interrupt; a silent red line does not.
 */
export function ErrorState({
  title = "Something went wrong",
  message,
  onRetry,
  retryLabel = "Try again",
  className,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}) {
  return (
    <div
      data-testid="error-state"
      role="alert"
      className={cn(
        "flex flex-col items-start gap-3 rounded-md border border-sys-danger/35 bg-sys-danger/[0.06] p-4",
        className
      )}
    >
      <div className="flex items-start gap-3">
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-sys-danger" aria-hidden="true" />
        <div className="space-y-1">
          <p className="font-mono text-[0.62rem] uppercase tracking-hud text-sys-danger">{title}</p>
          <p data-testid="error-message" className="text-sm text-sys-text/85">
            {message}
          </p>
        </div>
      </div>

      {onRetry && (
        <button
          type="button"
          data-testid="error-retry"
          onClick={onRetry}
          className="sys-focus ml-7 inline-flex items-center gap-1.5 rounded border border-sys-edge bg-white/[0.02] px-2.5 py-1.5 font-mono text-[0.58rem] uppercase tracking-hud text-sys-text transition-colors hover:border-sys-cyan/45 hover:text-white"
        >
          <RefreshCw size={11} aria-hidden="true" />
          {retryLabel}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty
// ---------------------------------------------------------------------------

/**
 * Nothing-here state.
 *
 * Distinct from an error on purpose: an empty queue is a healthy outcome, so it
 * is quiet rather than red, and it explains what would put something here.
 */
export function EmptyState({
  title,
  message,
  icon,
  action,
  className,
}: {
  title: string;
  message?: string;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-testid="empty-state"
      className={cn(
        "flex flex-col items-center gap-2 rounded-md border border-dashed border-sys-line px-4 py-8 text-center",
        className
      )}
    >
      <span className="text-sys-dim" aria-hidden="true">
        {icon ?? <Inbox size={18} />}
      </span>
      <p className="font-mono text-[0.62rem] uppercase tracking-hud text-sys-text/80">{title}</p>
      {message && <p className="max-w-sm text-sm text-sys-dim">{message}</p>}
      {action && <div className="pt-1">{action}</div>}
    </div>
  );
}
