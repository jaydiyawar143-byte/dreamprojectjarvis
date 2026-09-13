"use client";

// ---------------------------------------------------------------------------
// The Execute control for an approved Google write.
//
// WHY EXECUTE IS A SEPARATE STEP FROM APPROVE. Approving records a decision;
// executing spends it. Keeping them apart means the user can approve a send and
// still see, in one more deliberate click, exactly what is about to go out —
// and it means an approval that is never executed simply expires rather than
// firing later.
//
// THE BUTTON APPEARS UNDER EXACTLY ONE CONDITION: status APPROVED and not
// expired. Every other state renders a LABEL explaining why there is nothing to
// press, rather than a disabled button with no explanation. A greyed-out button
// tells the user they did something wrong; a sentence tells them what happened.
//
// VERIFICATION IS REPORTED HONESTLY, and this is the part that matters most
// after a write. "Done and confirmed" and "done, we could not confirm it" and
// "done, but the re-read disagreed" are three different outcomes with three
// different follow-ups, and the last one is the reason this component does not
// simply show a green tick on `success: true`.
//
// RETRY IS OFFERED ONLY WHEN `retrySafe`. The server decides that; the UI never
// infers it. An indeterminate write — a timeout on a send — is never retryable
// from here, because the email may already be gone.
// ---------------------------------------------------------------------------

import { useCallback, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, HelpCircle, Loader2, Play, RefreshCw, ShieldAlert } from "lucide-react";
import {
  executeGoogleWrite,
  type GoogleWriteExecuteResult,
  type GoogleWriteVerification,
} from "@/lib/api";
import { Badge, Button } from "@/components/ui/primitives";

/**
 * Human-readable status for every state an approval can be in.
 *
 * One table, so the words are consistent wherever an approval is shown. The
 * distinction the labels carry is that `consumed` means the write ALREADY
 * HAPPENED — a user reading "Consumed" with no further explanation would
 * reasonably think it meant cancelled.
 */
export const APPROVAL_STATUS_LABEL: Record<string, { label: string; help: string }> = {
  pending: { label: "Pending approval", help: "Nothing has happened. Approve or reject it below." },
  approved: {
    label: "Approved — not yet run",
    help: "You approved this. It has not been performed yet; press Execute to perform it.",
  },
  rejected: { label: "Rejected", help: "You declined this. Nothing was performed." },
  expired: {
    label: "Expired",
    help: "The approval window closed before this ran. Nothing was performed; ask again to get a fresh plan.",
  },
  consumed: {
    label: "Already performed",
    help: "This was executed. It cannot be run again — approvals are single-use.",
  },
  failed: { label: "Failed", help: "The attempt did not succeed. See the message below." },
};

/** What each verification value means to a person. */
const VERIFICATION: Record<
  GoogleWriteVerification,
  { label: string; tone: "ok" | "warn" | "danger" | "neutral"; help: string }
> = {
  verified: {
    label: "Verified",
    tone: "ok",
    help: "The change was applied and we read it back from Google to confirm it.",
  },
  provider_reported: {
    label: "Google reported success",
    tone: "neutral",
    help: "Google said it worked. We did not independently re-read it.",
  },
  verification_unavailable: {
    label: "Done, not confirmed",
    tone: "warn",
    help: "The change was applied, but confirming it was not possible with the permissions this connection holds.",
  },
  verification_failed: {
    label: "Applied, but the check disagreed",
    tone: "danger",
    // The important one: the write DID happen. Retrying would be wrong.
    help: "The change was applied, but reading it back found something unexpected. Check it in Google before doing anything else — do not repeat the action.",
  },
  indeterminate: {
    label: "Outcome unknown",
    tone: "danger",
    help: "The request reached Google but the outcome was never established. It may or may not have been applied. Check in Google before retrying.",
  },
  failed: { label: "Not applied", tone: "neutral", help: "The change did not happen." },
};

type Phase = "idle" | "executing" | "done";

export function GoogleWriteExecute({
  approvalId,
  status,
  expiresAt,
  onExecuted,
}: {
  approvalId: string;
  /** The approval's current status, lower-cased. */
  status: string;
  expiresAt: string;
  /** Called after a completed attempt so the parent can re-read the record. */
  onExecuted?: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<GoogleWriteExecuteResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * Double-click guard, in a ref rather than in `phase`.
   *
   * `setPhase("executing")` does not take effect until React re-renders, so two
   * clicks landing in the same tick both read `phase === "idle"` and both fire
   * a request. The server would refuse the second — the approval is CONSUMED
   * atomically — but "refused" is not the same as "not sent": for a Gmail send
   * the user would watch a second attempt go out and get an error back, which
   * is exactly the moment they should not have to wonder whether two emails
   * were delivered. A ref updates synchronously, so the second click never
   * becomes a request.
   */
  const inFlight = useRef(false);

  // Expiry is a fact about the clock, not about the row: an approval can be
  // APPROVED and out of time simultaneously, and offering Execute for it would
  // put the user in front of a button the server will refuse.
  const expired = new Date(expiresAt) <= new Date();
  const executable = status === "approved" && !expired && phase === "idle";

  const run = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;

    setPhase("executing");
    setError(null);

    const res = await executeGoogleWrite(approvalId);
    setPhase("done");

    if (res.success && res.data) {
      setResult(res.data);
    } else {
      // The API returns the envelope in its body even on a non-2xx, because the
      // verification and remedy live there. Fall back to the error message only
      // when there is genuinely no envelope.
      const body = (res as { data?: GoogleWriteExecuteResult }).data;
      if (body && typeof body === "object" && "verification" in body) setResult(body);
      else setError(res.error?.message ?? "The action could not be completed.");
    }

    // Always re-read: the approval is now CONSUMED whatever the provider did,
    // and a stale card showing "Approved" would invite a second attempt.
    onExecuted?.();
  }, [approvalId, onExecuted]);

  // --- after an attempt ----------------------------------------------------
  if (phase === "done" && result) {
    const v = VERIFICATION[result.verification] ?? VERIFICATION.failed;
    const Icon =
      result.verification === "verified"
        ? CheckCircle2
        : result.verification === "verification_failed" || result.verification === "indeterminate"
          ? ShieldAlert
          : result.verification === "verification_unavailable"
            ? HelpCircle
            : AlertTriangle;

    return (
      <div data-testid="write-execute-result" data-verification={result.verification} className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Icon
            size={13}
            aria-hidden
            className={
              v.tone === "ok"
                ? "text-sys-ok"
                : v.tone === "danger"
                  ? "text-sys-danger"
                  : v.tone === "warn"
                    ? "text-amber-300"
                    : "text-sys-dim"
            }
          />
          <span data-testid="write-verification-label" className="text-xs font-medium text-white">
            {v.label}
          </span>
          <Badge tone={v.tone === "ok" ? "ok" : v.tone === "danger" ? "danger" : v.tone === "warn" ? "warn" : "neutral"}>
            {result.success ? "Executed" : "Not executed"}
          </Badge>
        </div>

        <p className="text-xs leading-relaxed text-sys-dim">{v.help}</p>

        {result.message && (
          <p data-testid="write-execute-message" className="text-xs leading-relaxed text-sys-text/85">
            {result.message}
          </p>
        )}

        {result.requiredAction && (
          <p className="text-xs leading-relaxed text-amber-300/90">{result.requiredAction}</p>
        )}

        {/* The audit reference, so a user can cite this. */}
        {result.auditRef && (
          <p data-testid="write-audit-ref" className="font-mono text-[0.7rem] text-sys-dim/70">
            Audit reference {result.auditRef}
          </p>
        )}

        {/*
          Retry ONLY when the server says it is safe. An indeterminate write is
          never retryable from here: the email may already have gone.
        */}
        {result.retrySafe && (
          <Button
            data-testid="write-execute-retry"
            variant="secondary"
            onClick={() => {
              // Released here and only here: the guard must outlive the request
              // itself, or a second click during the result render would fire
              // again. A retry is a new, deliberate decision.
              inFlight.current = false;
              setPhase("idle");
              setResult(null);
            }}
          >
            <RefreshCw size={11} aria-hidden />
            Try again
          </Button>
        )}
      </div>
    );
  }

  if (phase === "executing") {
    return (
      <p
        data-testid="write-executing"
        role="status"
        aria-live="polite"
        className="flex items-center gap-2 text-xs text-sys-cyan"
      >
        <Loader2 size={12} className="animate-spin" aria-hidden />
        Performing the change…
      </p>
    );
  }

  if (error) {
    return (
      <p data-testid="write-execute-error" role="alert" className="text-xs text-red-300">
        {error}
      </p>
    );
  }

  // --- before an attempt ---------------------------------------------------
  if (executable) {
    return (
      <div className="space-y-1.5">
        <Button data-testid="write-execute" onClick={() => void run()}>
          <Play size={11} aria-hidden />
          Execute now
        </Button>
        <p className="text-xs text-sys-dim">
          You approved this; it has not run yet. This performs it.
        </p>
      </div>
    );
  }

  // Not executable: say WHY rather than showing a dead button.
  const reason = expired && status === "approved" ? APPROVAL_STATUS_LABEL.expired : APPROVAL_STATUS_LABEL[status];

  return (
    <p data-testid="write-execute-unavailable" data-reason={expired ? "expired" : status} className="text-xs text-sys-dim">
      {reason?.help ?? "This cannot be performed in its current state."}
    </p>
  );
}
