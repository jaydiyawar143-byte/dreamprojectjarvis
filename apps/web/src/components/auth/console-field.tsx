"use client";

import { Eye, EyeOff } from "lucide-react";
import { useId, useState, forwardRef } from "react";
import { motion } from "framer-motion";

type Props = {
  /** Stable, human field name. Also the accessible name — never changes. */
  label: string;
  type?: "text" | "email" | "password";
  value: string;
  onChange: (v: string) => void;
  autoComplete?: string;
  required?: boolean;
  minLength?: number;
  /** Field-level validation message. Rendered and wired via aria-describedby. */
  error?: string;
  hint?: string;
  disabled?: boolean;
};

/**
 * A single console input.
 *
 * Accessibility notes, because this is where a "futuristic" design most often
 * breaks things:
 *  - The <label> keeps a STABLE accessible name (sr-only). Only the decorative
 *    half swaps to "INPUT CHANNEL ACTIVE" on focus, and that half is
 *    aria-hidden — a screen reader never hears the label change under it.
 *  - Errors are real text tied by aria-describedby + aria-invalid, not colour.
 *  - The password toggle is a real button with aria-pressed, reachable by
 *    keyboard, and never traps focus.
 */
export const ConsoleField = forwardRef<HTMLInputElement, Props>(function ConsoleField(
  {
    label,
    type = "text",
    value,
    onChange,
    autoComplete,
    required,
    minLength,
    error,
    hint,
    disabled,
  },
  ref
) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;

  const [focused, setFocused] = useState(false);
  const [revealed, setRevealed] = useState(false);

  const isPassword = type === "password";
  const inputType = isPassword && revealed ? "text" : type;

  const describedBy = [error ? errorId : null, hint ? hintId : null]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="w-full">
      {/* ---- Label row ---- */}
      <label
        htmlFor={id}
        className="mb-2 flex items-center gap-1.5 font-mono text-xs uppercase tracking-hud"
      >
        <span className="sr-only">{label}</span>
        <span
          aria-hidden="true"
          className={`transition-colors duration-200 ${
            error ? "text-sys-danger" : focused ? "text-sys-cyan" : "text-sys-dim"
          }`}
        >
          {focused ? "◉ Input Channel Active" : `○ ${label}`}
        </span>
      </label>

      {/* ---- Field shell ---- */}
      <div
        className={`relative overflow-hidden rounded-md border bg-[#050a11]/90 transition-all duration-200 ${
          error
            ? "border-sys-danger/70 shadow-[0_0_18px_-6px_rgba(255,93,108,0.5)]"
            : focused
              ? "border-sys-cyan/70 shadow-field-focus"
              : "border-sys-control hover:border-sys-control/80"
        } ${disabled ? "opacity-60" : ""}`}
      >
        {/* Left activity bar */}
        <span
          aria-hidden="true"
          className={`absolute left-0 top-0 h-full w-[2px] transition-all duration-300 ${
            error ? "bg-sys-danger" : focused ? "bg-sys-cyan" : "bg-transparent"
          }`}
        />

        {/* Scanning line while focused. Always rendered when focused; the
            reduced-motion block in globals.css stops the keyframes. */}
        {focused && !error && (
          <span
            aria-hidden="true"
            className="sys-scanline animate-field-scan pointer-events-none absolute inset-y-0 left-0 w-1/3"
            style={{
              background:
                "linear-gradient(90deg, transparent, rgba(62,224,242,0.10), transparent)",
            }}
          />
        )}

        <input
          ref={ref}
          id={id}
          type={inputType}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          autoComplete={autoComplete}
          required={required}
          minLength={minLength}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          className={`sys-input sys-focus w-full bg-transparent px-4 py-3 text-[0.9rem] text-white caret-sys-cyan placeholder-sys-dim/40 outline-none disabled:cursor-not-allowed ${
            isPassword ? "pr-12" : ""
          }`}
        />

        {isPassword && (
          <button
            type="button"
            onClick={() => setRevealed((v) => !v)}
            aria-label={revealed ? "Hide access key" : "Show access key"}
            aria-pressed={revealed}
            disabled={disabled}
            className="sys-focus absolute right-1 top-1/2 -translate-y-1/2 rounded p-2.5 text-sys-dim transition-colors hover:text-sys-cyan"
          >
            {revealed ? (
              <EyeOff className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Eye className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        )}

        {/* Corner ticks */}
        <span
          aria-hidden="true"
          className={`absolute right-0 top-0 h-1.5 w-1.5 border-r border-t transition-colors duration-200 ${
            focused ? "border-sys-cyan/80" : "border-sys-edge"
          }`}
        />
        <span
          aria-hidden="true"
          className={`absolute bottom-0 left-0 h-1.5 w-1.5 border-b border-l transition-colors duration-200 ${
            focused ? "border-sys-cyan/80" : "border-sys-edge"
          }`}
        />
      </div>

      {hint && !error && (
        <p id={hintId} className="mt-1.5 font-mono text-xs tracking-wide text-sys-dim">
          {hint}
        </p>
      )}

      {error && (
        <motion.p
          id={errorId}
          initial={{ opacity: 0, y: -3 }}
          animate={{ opacity: 1, y: 0 }}
          className="mt-1.5 font-mono text-xs uppercase tracking-wide text-sys-danger"
        >
          {error}
        </motion.p>
      )}
    </div>
  );
});
