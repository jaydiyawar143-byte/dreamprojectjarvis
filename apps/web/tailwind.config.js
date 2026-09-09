/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Existing product palette — used by chat, sidebar, approvals. Untouched.
        jarvis: {
          50: "#eef2ff",
          100: "#e0e7ff",
          200: "#c7d2fe",
          300: "#a5b4fc",
          400: "#818cf8",
          500: "#6366f1",
          600: "#4f46e5",
          700: "#4338ca",
          800: "#3730a3",
          900: "#312e81",
          950: "#1e1b4b",
        },
        // Auth / HUD system palette. Deep-space near-black with a cyan accent.
        sys: {
          void: "#03060b",
          deep: "#05090f",
          panel: "#070d16",
          line: "#14212f",
          edge: "#1d3245",
          // Boundary of an INTERACTIVE control. WCAG 1.4.11 wants 3:1 for
          // anything that identifies a control; `line` and `edge` are 1.25:1
          // and 1.54:1 on `void`, which is fine for a decorative panel seam and
          // not fine for the edge of a button or a field. 3.47:1.
          control: "#456888",
          // Phase A: lifted from #5b7183 (4.00:1 on `void` — below AA for
          // normal text, and worse on every lighter surface). #8fa3b5 measures
          // 7.80:1 on `void`, 7.49:1 on `panel` and 5.06:1 on `edge`, so the
          // quiet register is readable on all three without the type having to
          // grow to "large text" to qualify.
          //
          // The mood is bought back with opacity instead — but only down to
          // /75, which still measures 4.72:1. Below that it fails again, so
          // /70 and lower must not carry informational text.
          dim: "#8fa3b5",
          text: "#c3d3e0",
          cyan: "#3ee0f2",
          "cyan-soft": "#7ceaf7",
          "cyan-deep": "#0d7f92",
          danger: "#ff5d6c",
          ok: "#48e3ad",
        },
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "-apple-system", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      letterSpacing: {
        /**
         * HUD label tracking. Retuned in Phase A, from 0.22em.
         *
         * `em` tracking scales with the type, so lifting every HUD label from
         * 8px to 12px did not just make the glyphs bigger — it made the gaps
         * between them 50% wider in absolute terms, which is what pushed the
         * freshness badge and the CPU readout past their panel edges.
         *
         * 0.22em at the old 8px is 1.76px of air. 0.15em at 12px is 1.8px —
         * so this is the tracking the design was actually drawn with, held
         * constant through the size change rather than scaled up with it.
         */
        hud: "0.15em",
      },
      fontSize: {
        /**
         * Decorative frame chrome. 8px.
         *
         * The ONLY size below the 12px readability floor, and it is spendable
         * only on text that is `aria-hidden`, appears nowhere else, and
         * reports no state: corner registration marks, coordinates, frame
         * labels, build strings.
         *
         * It exists as a named token rather than an arbitrary `text-[0.5rem]`
         * precisely so it is greppable — a reviewer can list every use in one
         * search and ask whether each is genuinely ornament. Informational
         * text starts at `text-xs`.
         */
        chrome: ["0.5rem", { lineHeight: "0.75rem" }],
      },
      boxShadow: {
        console:
          "0 0 0 1px rgba(62,224,242,0.08), 0 30px 80px -20px rgba(0,0,0,0.9), 0 0 60px -20px rgba(62,224,242,0.25)",
        "field-focus": "0 0 0 1px rgba(62,224,242,0.45), 0 0 22px -6px rgba(62,224,242,0.5)",
      },
      keyframes: {
        // Slow drift of the background grid. Transform-only (GPU friendly).
        "grid-drift": {
          "0%": { transform: "translate3d(0,0,0)" },
          "100%": { transform: "translate3d(0,-56px,0)" },
        },
        // Status dot breathing.
        "sys-pulse": {
          "0%,100%": { opacity: "1", transform: "scale(1)" },
          "50%": { opacity: "0.45", transform: "scale(0.82)" },
        },
        // Light sweep across the primary button.
        sweep: {
          "0%": { transform: "translateX(-120%)" },
          "100%": { transform: "translateX(220%)" },
        },
        // Scan line travelling across a focused input.
        "field-scan": {
          "0%": { transform: "translateX(-100%)", opacity: "0" },
          "18%": { opacity: "1" },
          "82%": { opacity: "1" },
          "100%": { transform: "translateX(100%)", opacity: "0" },
        },
        "spin-slow": {
          from: { transform: "rotate(0deg)" },
          to: { transform: "rotate(360deg)" },
        },
        "spin-reverse": {
          from: { transform: "rotate(360deg)" },
          to: { transform: "rotate(0deg)" },
        },
      },
      animation: {
        "grid-drift": "grid-drift 14s linear infinite",
        "sys-pulse": "sys-pulse 2.4s ease-in-out infinite",
        sweep: "sweep 1.1s ease-in-out",
        "field-scan": "field-scan 1.5s ease-in-out infinite",
        "spin-slow": "spin-slow 34s linear infinite",
        "spin-reverse": "spin-reverse 48s linear infinite",
      },
    },
  },
  plugins: [],
};
