"use client";

import { MotionConfig, motion, useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { getGoogleSignInEnabled, googleSignInStartUrl } from "@/lib/api";
import { SystemBackground } from "./system-background";
import { HUDLayer } from "./hud-layer";
import { JarvisBrand } from "./jarvis-brand";
import { SystemStatus, type SystemState } from "./system-status";
import { SystemTelemetry } from "./system-telemetry";
import { AuthConsole, type AuthMode } from "./auth-console";
import { useAuthSequence } from "./use-auth-sequence";


const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Root of the authentication experience, rendered by both /login and /register.
 *
 * Routing note: switching between the two modes does NOT navigate. A Next
 * app-router navigation would unmount this tree and kill the transition, so the
 * mode is local state and the URL is kept in step with history.replaceState.
 * Deep links still work because each route passes its own `initialMode`.
 *
 * Auth note: this component adds no authentication logic. It calls the existing
 * `useAuth().login` / `.register` exactly as the previous pages did, and routes
 * to /chat only when those resolve without an error.
 */
export function AuthExperience({ initialMode }: { initialMode: AuthMode }) {
  const router = useRouter();
  // Used ONLY for timing side effects (setTimeout durations), never for
  // markup or inline styles — see the hydration note in motion.ts. Framer's own
  // transitions are handled by <MotionConfig reducedMotion="user"> below.
  const reduced = useReducedMotion();
  const { login, register, authenticated, loading } = useAuth();

  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [direction, setDirection] = useState(1);
  const [handoff, setHandoff] = useState(false);

  const { phase, stages, error, run, reset } = useAuthSequence(reduced);

  // ---------------------------------------------------------------------------
  // Google channel.
  //
  // `null` until the server answers. Availability is the API's to decide — it
  // mounts the routes only when it holds OAuth client credentials — so this is
  // asked rather than assumed from a build-time variable that could disagree.
  // ---------------------------------------------------------------------------
  const [googleEnabled, setGoogleEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getGoogleSignInEnabled().then((ok) => {
      if (!cancelled) setGoogleEnabled(ok);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Errors from the OAuth callback arrive as a query parameter, because the
  // callback is a redirect and has no other way to report. Each is mapped to
  // something a person can act on; an unrecognised code is reported plainly
  // rather than echoed back into the page.
  const [channelError, setChannelError] = useState<string | null>(null);

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("error");
    if (!code) return;

    const messages: Record<string, string> = {
      google_cancelled: "Google sign-in was cancelled.",
      google_state_invalid: "That sign-in link expired. Please try again.",
      google_email_unverified:
        "That Google account has no verified email address, so it cannot be linked.",
      google_session_failed: "Signed in with Google, but the session could not be established.",
      google_failed: "Google sign-in failed. Please try again.",
    };
    setChannelError(messages[code] ?? "Sign-in failed. Please try again.");

    // Clear it from the URL so a refresh does not resurrect a stale error.
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  const handleGoogle = useCallback(() => {
    // A FULL-PAGE navigation, not fetch: the browser must follow redirects to
    // Google and back, which a cross-origin fetch cannot do. Re-entry is not
    // guarded here because SocialAuth disables the control while `busy`.
    window.location.href = googleSignInStartUrl("/dashboard");
  }, []);

  // True once we've started our own auth, so the "already signed in" guard
  // below doesn't yank the user to /chat mid-transition.
  const selfInitiated = useRef(false);

  const busy = phase === "authenticating" || handoff;

  // Someone who already has a session shouldn't sit on the login screen.
  useEffect(() => {
    if (!loading && authenticated && !selfInitiated.current) {
      router.replace("/dashboard");
    }
  }, [loading, authenticated, router]);

  const switchMode = useCallback(
    (next: AuthMode) => {
      if (busy) return;
      setDirection(next === "signup" ? 1 : -1);
      setMode(next);
      reset();
      // Keep the address bar honest without a remount.
      window.history.replaceState(null, "", next === "signup" ? "/register" : "/login");
    },
    [busy, reset]
  );

  const finish = useCallback(async () => {
    setHandoff(true);
    // Let the HUD bloom read before handing off to the app.
    await wait(reduced ? 120 : 850);
    router.push("/dashboard");
  }, [reduced, router]);

  const handleLogin = useCallback(
    async (email: string, password: string) => {
      selfInitiated.current = true;
      const ok = await run(() => login(email, password));
      if (ok) void finish();
      else selfInitiated.current = false;
    },
    [run, login, finish]
  );

  const handleSignup = useCallback(
    async (email: string, name: string, password: string) => {
      selfInitiated.current = true;
      const ok = await run(() => register(email, name, password));
      if (ok) void finish();
      else selfInitiated.current = false;
    },
    [run, register, finish]
  );

  const systemState: SystemState =
    phase === "authenticating"
      ? "authenticating"
      : phase === "denied"
        ? "denied"
        : phase === "granted" || handoff
          ? "granted"
          : "online";

  return (
    // reducedMotion="user" makes Framer skip transform/layout animations for
    // users who ask for it, applied at animation time rather than render time —
    // so server and client markup stay identical.
    <MotionConfig reducedMotion="user">
    <main className="relative flex min-h-[100dvh] items-center justify-center overflow-hidden bg-sys-void px-4 py-10 sm:px-6">
      <SystemBackground />
      <HUDLayer intensity={handoff ? 1 : 0} />
      <SystemTelemetry />

      {/* Console column. Fades out as the HUD expands into the dashboard. */}
      <motion.div
        animate={{
          opacity: handoff ? 0 : 1,
          scale: handoff && !reduced ? 1.04 : 1,
          filter: handoff && !reduced ? "blur(6px)" : "blur(0px)",
        }}
        transition={{ duration: 0.6, ease: [0.4, 0, 0.2, 1] }}
        className="relative z-10 w-full max-w-[25rem] sm:max-w-[26.5rem]"
      >
        <JarvisBrand />

        <div className="mt-5 mb-7">
          <SystemStatus state={systemState} />
        </div>

        <AuthConsole
          mode={mode}
          direction={direction}
          busy={busy}
          phase={phase}
          stages={stages}
          error={error ?? channelError ?? undefined}
          onLogin={handleLogin}
          onSignup={handleSignup}
          onSwitch={switchMode}
          onDismissError={() => {
            setChannelError(null);
            reset();
          }}
          googleEnabled={googleEnabled}
          onGoogle={handleGoogle}
        />

        {/* Footer readout */}
        <p
          aria-hidden="true"
          className="mt-6 text-center font-mono text-[0.5rem] uppercase tracking-hud text-sys-dim/45"
        >
          Secure Channel · Encryption Active
        </p>
      </motion.div>
    </main>
    </MotionConfig>
  );
}
