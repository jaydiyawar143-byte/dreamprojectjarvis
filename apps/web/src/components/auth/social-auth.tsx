"use client";

import { motion } from "framer-motion";
import { riseIn } from "./motion";

/**
 * Secondary authentication channel.
 *
 * IMPORTANT — this deployment has no Google flow. There is no `[...nextauth]`
 * route handler in the web app and no `/auth/google` endpoint on the API
 * (apps/api/src/routes/auth.ts exposes register, login, refresh, logout, me
 * only). Rather than render a button that silently does nothing — or worse,
 * fakes a session — the control reports the channel as unprovisioned.
 *
 * To enable it later: implement the provider callback, then set
 * NEXT_PUBLIC_GOOGLE_AUTH_ENABLED=true and pass `onGoogle`.
 */
const GOOGLE_ENABLED = process.env.NEXT_PUBLIC_GOOGLE_AUTH_ENABLED === "true";

function GoogleMark({ muted }: { muted: boolean }) {
  if (muted) {
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true" fill="currentColor">
        <path d="M12.24 10.28v3.54h4.98c-.2 1.29-1.5 3.79-4.98 3.79-3 0-5.44-2.48-5.44-5.54s2.44-5.54 5.44-5.54c1.7 0 2.85.73 3.5 1.35l2.39-2.3C16.6 3.9 14.6 3 12.24 3 7.7 3 4 6.7 4 11.24s3.7 8.24 8.24 8.24c4.76 0 7.91-3.35 7.91-8.06 0-.54-.06-.95-.13-1.36l-7.78.22z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.65l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.11a6.6 6.6 0 0 1 0-4.22V7.05H2.18a11 11 0 0 0 0 9.9l3.66-2.84z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1a11 11 0 0 0-9.82 6.05l3.66 2.84C6.71 7.29 9.14 5.38 12 5.38z"
      />
    </svg>
  );
}

export function SocialAuth({
  busy,
  onGoogle,
}: {
  busy: boolean;
  onGoogle?: () => void;
}) {
  const available = GOOGLE_ENABLED && typeof onGoogle === "function";

  return (
    <motion.div variants={riseIn()} className="space-y-3">
      {/* Divider */}
      <div className="flex items-center gap-3" aria-hidden="true">
        <span className="h-px flex-1 bg-gradient-to-r from-transparent to-sys-edge" />
        <span className="font-mono text-[0.5rem] uppercase tracking-hud text-sys-dim/70">
          Alt Channel
        </span>
        <span className="h-px flex-1 bg-gradient-to-l from-transparent to-sys-edge" />
      </div>

      <button
        type="button"
        onClick={available ? onGoogle : undefined}
        disabled={!available || busy}
        aria-disabled={!available}
        aria-describedby={available ? undefined : "google-channel-note"}
        className="sys-focus group relative flex w-full items-center justify-center gap-2.5 rounded-md border border-sys-edge bg-white/[0.02] py-3 font-mono text-[0.62rem] uppercase tracking-hud text-sys-text transition-all duration-200 enabled:hover:border-sys-cyan/40 enabled:hover:bg-white/[0.05] enabled:hover:text-white disabled:cursor-not-allowed disabled:opacity-45"
      >
        <GoogleMark muted={!available} />
        Continue with Google
      </button>

      {!available && (
        <p
          id="google-channel-note"
          className="text-center font-mono text-[0.5rem] uppercase tracking-hud text-sys-dim/70"
        >
          Channel not provisioned — use Operator ID
        </p>
      )}
    </motion.div>
  );
}
