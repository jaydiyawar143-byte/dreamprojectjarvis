"use client";

// ---------------------------------------------------------------------------
// UI V2 — landing point for a completed Google sign-in.
//
// The API has already established the session by the time this renders: the
// browser is holding an HttpOnly refresh cookie set during the callback. This
// page carries NO token — the redirect URL contains only a status, deliberately,
// because query strings end up in history, in the Referer header and in server
// logs.
//
// So all this does is redeem the cookie for an access token (adoptSession) and
// move on. It is a handoff, not an authentication step.
// ---------------------------------------------------------------------------

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth";

/** Only a path on this app is an acceptable destination — never an absolute URL. */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/dashboard";
  return raw;
}

function GoogleHandoff() {
  const router = useRouter();
  const params = useSearchParams();
  const { adoptSession } = useAuth();
  const [failed, setFailed] = useState<string | null>(null);

  // React 18 StrictMode mounts effects twice in development. Adopting twice
  // would rotate the refresh token twice, and the second rotation invalidates
  // the first — signing the user straight back out.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const next = safeNext(params.get("next"));

    (async () => {
      const result = await adoptSession();
      if (result.error) {
        setFailed(result.error);
        router.replace("/login?error=google_session_failed");
        return;
      }
      router.replace(next);
    })();
  }, [adoptSession, params, router]);

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-sys-void px-6">
      <div className="text-center">
        <div
          aria-hidden="true"
          className="mx-auto mb-4 h-2 w-2 animate-pulse rounded-full bg-sys-cyan shadow-[0_0_12px_3px_rgba(62,224,242,0.5)]"
        />
        <p
          role="status"
          aria-live="polite"
          className="font-mono text-xs uppercase tracking-hud text-sys-dim"
        >
          {failed ? "Sign-in could not be completed" : "Establishing secure session…"}
        </p>
      </div>
    </main>
  );
}

export default function GoogleAuthLandingPage() {
  // useSearchParams requires a Suspense boundary to avoid opting the whole
  // route into client-side rendering at build time.
  return (
    <Suspense fallback={null}>
      <GoogleHandoff />
    </Suspense>
  );
}
