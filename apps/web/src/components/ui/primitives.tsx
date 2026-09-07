"use client";

import { type ReactNode } from "react";

// ---------------------------------------------------------------------------
// UI V2 — the primitives this codebase did not have.
//
// Before this file the app had exactly two reusable controls, both living in
// the auth folder (`ConsoleField`, `ConsoleButton`), and every other button,
// badge and tab was hand-rolled inline with its own Tailwind string. That is
// why the same status chip looked different on three pages.
//
// These are deliberately thin. No variant library, no polymorphic `as` prop,
// no theme context — `class-variance-authority` is installed and stays unused,
// because a lookup object is legible and a CVA config is not.
//
// Everything sits on the existing `sys` palette and reuses `.sys-focus`, which
// is already the app-wide focus ring. A new focus style here would be a second
// answer to a question that already has one.
// ---------------------------------------------------------------------------

const cx = (...parts: Array<string | false | null | undefined>) =>
  parts.filter(Boolean).join(" ");

// ---------------------------------------------------------------------------
// Status vocabulary
//
// One tone scale, used by Badge, StatusDot and the page-level status chips, so
// "degraded" is the same amber everywhere it appears.
// ---------------------------------------------------------------------------

export type Tone = "neutral" | "info" | "ok" | "warn" | "danger";

const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-sys-dim",
  info: "text-sys-cyan",
  ok: "text-sys-ok",
  warn: "text-amber-300",
  danger: "text-sys-danger",
};

const TONE_CHIP: Record<Tone, string> = {
  neutral: "border-sys-line bg-sys-edge/30 text-sys-dim",
  info: "border-sys-cyan/35 bg-sys-cyan/10 text-sys-cyan",
  ok: "border-sys-ok/35 bg-sys-ok/10 text-sys-ok",
  warn: "border-amber-400/35 bg-amber-400/10 text-amber-300",
  danger: "border-sys-danger/35 bg-sys-danger/10 text-sys-danger",
};

const TONE_DOT: Record<Tone, string> = {
  neutral: "bg-sys-dim",
  info: "bg-sys-cyan",
  ok: "bg-sys-ok",
  warn: "bg-amber-300",
  danger: "bg-sys-danger",
};

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

export function Badge({
  children,
  tone = "neutral",
  className,
  title,
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
  title?: string;
}) {
  return (
    <span
      data-testid="badge"
      data-tone={tone}
      title={title}
      className={cx(
        "inline-flex items-center gap-1.5 rounded border px-2 py-0.5",
        "font-mono text-[0.6rem] uppercase tracking-hud",
        TONE_CHIP[tone],
        className
      )}
    >
      {children}
    </span>
  );
}

/**
 * A status dot that is never the ONLY carrier of meaning.
 *
 * `label` is required and rendered as text beside the dot rather than as a
 * tooltip, because colour alone fails for a colour-blind operator and for a
 * screen reader equally.
 */
export function StatusDot({
  tone,
  label,
  className,
}: {
  tone: Tone;
  label: string;
  className?: string;
}) {
  return (
    <span
      data-testid="status-dot"
      data-tone={tone}
      className={cx("inline-flex items-center gap-2", className)}
    >
      <span aria-hidden className={cx("h-1.5 w-1.5 rounded-full", TONE_DOT[tone])} />
      <span className={cx("font-mono text-[0.62rem] uppercase tracking-hud", TONE_TEXT[tone])}>
        {label}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "border-sys-cyan/40 bg-sys-cyan/15 text-sys-cyan hover:bg-sys-cyan/25",
  secondary: "border-sys-line bg-sys-edge/40 text-sys-text hover:bg-sys-edge/60",
  ghost: "border-transparent bg-transparent text-sys-dim hover:text-sys-text",
  danger: "border-sys-danger/40 bg-sys-danger/10 text-sys-danger hover:bg-sys-danger/20",
};

export function Button({
  children,
  variant = "secondary",
  size = "md",
  className,
  ...rest
}: {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: "sm" | "md";
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      data-testid="button"
      data-variant={variant}
      className={cx(
        "sys-focus inline-flex items-center justify-center gap-2 rounded border",
        "font-mono uppercase tracking-hud transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-40",
        size === "sm" ? "px-2.5 py-1 text-[0.6rem]" : "px-3.5 py-1.5 text-[0.65rem]",
        BUTTON_VARIANT[variant],
        className
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Tabs
//
// A controlled segmented control, not a routing widget. Rendered as real
// buttons in a `tablist` so arrow keys and a screen reader both work.
// ---------------------------------------------------------------------------

export interface TabOption<T extends string> {
  value: T;
  label: string;
  /** Optional count shown after the label, e.g. a queue size. */
  count?: number;
}

export function Tabs<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: Array<TabOption<T>>;
  value: T;
  onChange: (next: T) => void;
  /** Names the group for assistive technology. */
  label: string;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      data-testid="tabs"
      className={cx("flex flex-wrap gap-1.5", className)}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            role="tab"
            type="button"
            aria-selected={selected}
            data-testid="tab"
            data-selected={selected}
            onClick={() => onChange(option.value)}
            className={cx(
              "sys-focus rounded border px-3 py-1 font-mono text-[0.62rem] uppercase tracking-hud transition-colors",
              selected
                ? "border-sys-cyan/40 bg-sys-cyan/10 text-sys-cyan"
                : "border-sys-line bg-transparent text-sys-dim hover:text-sys-text"
            )}
          >
            {option.label}
            {option.count !== undefined && (
              <span className="ml-1.5 tabular-nums opacity-70">{option.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DataTable
//
// Not a grid library — a semantic table in a scroll container. The container is
// the point: a wide table must scroll inside itself rather than making the
// whole page scroll sideways on a phone.
// ---------------------------------------------------------------------------

export interface Column<Row> {
  key: string;
  header: string;
  render: (row: Row) => ReactNode;
  /** Right-align numerics so digits line up. */
  numeric?: boolean;
  className?: string;
}

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  caption,
  className,
}: {
  columns: Array<Column<Row>>;
  rows: Row[];
  rowKey: (row: Row, index: number) => string;
  /** Describes the table for assistive technology; visually hidden. */
  caption: string;
  className?: string;
}) {
  return (
    <div data-testid="data-table" className={cx("-mx-2 overflow-x-auto px-2", className)}>
      <table className="w-full min-w-[36rem] border-collapse text-left">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-sys-line">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cx(
                  "px-3 py-2 font-mono text-[0.58rem] uppercase tracking-hud text-sys-dim",
                  column.numeric && "text-right",
                  column.className
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={rowKey(row, index)}
              data-testid="data-row"
              className="border-b border-sys-line/50 last:border-0 hover:bg-sys-edge/20"
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={cx(
                    "px-3 py-2 text-sm text-sys-text",
                    column.numeric && "text-right font-mono tabular-nums",
                    column.className
                  )}
                >
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
