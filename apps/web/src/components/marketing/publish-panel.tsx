"use client";

// ---------------------------------------------------------------------------
// Phase 15 — publishing one item, from the Marketing page.
//
// THIS PANEL POSTS NOTHING BY ITSELF. It walks the same three steps a publish
// in chat does, with a person in the middle:
//
//   ask       the server checks the saved item and returns an approval bound
//             to the exact text and the exact Page. Nothing has been sent.
//   decide    the person presses "Approve and publish" or "Decline". That is
//             the existing Approvals API — the one decision point every
//             approval in JARVIS goes through.
//   publish   only after an approval: the server posts, reads the post back,
//             and says what happened.
//
// WHAT IT SHOWS IS WHAT THE SERVER SAID. The text and the Page in the
// confirmation are the approval's own parameters, not this screen's copy of
// the item — if the two could differ, a person could approve words they were
// not shown.
//
// "PUBLISHED" APPEARS IN ONE CASE: the reply says `published: true`. A post
// whose outcome is not known is shown as exactly that, in a different colour,
// with the server's own sentence about what to do next. It is never a success
// and never a plain failure.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react";
import type { ContentItemView, PublishTarget } from "@jarvis/core/marketing";
import {
  approveApproval,
  executeMarketingPublish,
  rejectApproval,
  requestMarketingPublish,
  type ApiResponse,
  type MarketingPublishAsk,
  type MarketingPublishError,
  type MarketingPublishReply,
} from "@/lib/api";
import { Panel } from "@/components/dashboard/panel";
import { Button } from "@/components/ui/primitives";
import { LoadingState } from "@/components/dashboard/states";
import { SELECT_CLASS, formatInstant } from "./format";

type Step =
  | { kind: "asking" }
  | { kind: "choose-target"; targets: PublishTarget[]; message: string }
  | { kind: "confirm"; ask: MarketingPublishAsk; error: string | null }
  | { kind: "published"; message: string; url: string | null; alreadyPublished: boolean }
  | { kind: "unconfirmed"; message: string }
  | { kind: "declined" }
  | { kind: "refused"; title: string; message: string };

/** What each refusal is called. The sentence under it is always the server's. */
const REFUSAL_TITLE: Record<string, string> = {
  NOT_READY: "This cannot be published yet",
  DECLINED: "Declined — nothing was posted",
  NOT_FOUND: "Not found",
  FORBIDDEN: "Your role cannot publish",
  UNAVAILABLE: "Publishing is not available here",
  FAILED: "Not published",
};

export function PublishPanel({
  item,
  onClose,
  onChanged,
}: {
  item: ContentItemView;
  /** Dismiss the panel. An approval left undecided simply expires. */
  onClose: () => void;
  /** Something about the item may have changed on the server: read it again. */
  onChanged: () => void;
}) {
  const [step, setStep] = useState<Step>({ kind: "asking" });
  const [busy, setBusy] = useState(false);
  const [targetId, setTargetId] = useState("");
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  /** Turn the server's reply into the one step it describes. */
  const settle = useCallback(
    (response: ApiResponse<MarketingPublishReply>, context: "request" | "execute") => {
      if (!live.current) return;
      const data = response.success ? response.data : undefined;

      if (data?.status === "PUBLISHED" && data.published === true) {
        setStep({ kind: "published", message: data.message, url: data.item?.publication?.url ?? null, alreadyPublished: data.alreadyPublished });
        onChanged();
        return;
      }
      if (data?.status === "APPROVAL_REQUIRED") {
        setStep({
          kind: "confirm",
          ask: data,
          error:
            context === "execute"
              ? data.ask === "EXPIRED"
                ? "The earlier request ran out of time, so nothing was posted. This is a new request, for the item as it is saved now."
                : "This request has not been approved yet, so nothing was posted."
              : null,
        });
        return;
      }

      const error = (response.error ?? { code: "FAILED", message: "" }) as MarketingPublishError;
      const message = error.message || "The publish did not go through. Nothing is marked as published.";

      if (error.code === "UNCONFIRMED") {
        setStep({ kind: "unconfirmed", message });
        onChanged();
        return;
      }
      // More than one place it could go: ask which, rather than guess.
      const targets = error.preparation?.targets ?? [];
      if (context === "request" && error.code === "NOT_READY" && targets.length > 1 && error.preparation?.blockers.length === 1) {
        setTargetId(targets[0]!.id);
        setStep({ kind: "choose-target", targets, message });
        return;
      }
      setStep({ kind: "refused", title: REFUSAL_TITLE[error.code] ?? "Not published", message });
      if (context === "execute") onChanged();
    },
    [onChanged]
  );

  const ask = useCallback(
    async (chosenTarget?: string) => {
      setBusy(true);
      setStep({ kind: "asking" });
      const response = await requestMarketingPublish(item.id, chosenTarget);
      if (live.current) setBusy(false);
      settle(response, "request");
    },
    [item.id, settle]
  );

  // Asking is a read plus an approval row: it sends nothing anywhere.
  const asked = useRef<string | null>(null);
  useEffect(() => {
    if (asked.current === item.id) return;
    asked.current = item.id;
    void ask();
  }, [item.id, ask]);

  async function approveAndPublish(pending: MarketingPublishAsk) {
    setBusy(true);
    const decided = await approveApproval(pending.approvalId);
    if (!live.current) return;
    if (!decided.success) {
      setBusy(false);
      // Not approved, so nothing was run. The request may still be waiting.
      setStep({ kind: "confirm", ask: pending, error: decided.error?.message ?? "The approval could not be recorded, so nothing was posted." });
      return;
    }
    const response = await executeMarketingPublish(item.id, pending.approvalId);
    if (live.current) setBusy(false);
    settle(response, "execute");
  }

  async function decline(pending: MarketingPublishAsk) {
    setBusy(true);
    const decided = await rejectApproval(pending.approvalId);
    if (!live.current) return;
    setBusy(false);
    if (decided.success) {
      setStep({ kind: "declined" });
      return;
    }
    setStep({ kind: "confirm", ask: pending, error: decided.error?.message ?? "The request could not be declined. It may still be waiting." });
  }

  const tone = step.kind === "published" ? "success" : step.kind === "refused" ? "danger" : "warning";

  return (
    <Panel
      title={`Publish: ${item.title}`}
      description="Nothing is posted until you approve the exact text below."
      tone={tone}
      data-testid="publish-panel"
      data-step={step.kind}
    >
      {step.kind === "asking" && <LoadingState label="Checking this item…" lines={2} />}

      {step.kind === "choose-target" && (
        <div className="space-y-3">
          <p className="text-sm text-sys-text">{step.message}</p>
          <label className="flex items-center gap-2 text-sm text-sys-dim">
            <span>Publish to</span>
            <select aria-label="Where to publish" value={targetId} onChange={(event) => setTargetId(event.target.value)} className={SELECT_CLASS}>
              {step.targets.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.name}
                </option>
              ))}
            </select>
          </label>
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => void ask(targetId)} disabled={busy || !targetId}>
              Continue
            </Button>
            <Button onClick={onClose} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {step.kind === "confirm" && (
        <div className="space-y-3" data-testid="publish-confirmation">
          {step.error && (
            <p role="alert" className="rounded border border-amber-400/35 bg-amber-400/10 px-3 py-2 text-sm text-sys-text">
              {step.error}
            </p>
          )}
          <p className="text-sm text-sys-text">{step.ask.summary.actionSummary}</p>
          <dl className="space-y-2">
            {step.ask.summary.detailLines.map((line) => (
              <div key={line.label}>
                <dt className="font-mono text-xs uppercase tracking-hud text-sys-dim">{line.label}</dt>
                <dd className="whitespace-pre-wrap break-words text-sm text-sys-text">{line.value}</dd>
              </div>
            ))}
          </dl>
          <p className="font-mono text-xs text-sys-dim">This request expires {formatInstant(step.ask.expiresAt)}.</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => void approveAndPublish(step.ask)} disabled={busy}>
              Approve and publish
            </Button>
            <Button variant="danger" onClick={() => void decline(step.ask)} disabled={busy}>
              Decline
            </Button>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Not now
            </Button>
          </div>
        </div>
      )}

      {step.kind === "published" && (
        <div className="space-y-3" role="status">
          <p className="text-sm text-sys-text">{step.message}</p>
          {step.url && (
            <p className="break-all font-mono text-xs text-sys-dim">
              <a href={step.url} target="_blank" rel="noopener noreferrer" className="sys-focus underline">
                {step.url}
              </a>
            </p>
          )}
          <Button onClick={onClose}>Done</Button>
        </div>
      )}

      {step.kind === "unconfirmed" && (
        <div className="space-y-3" role="alert" data-testid="publish-unconfirmed">
          <p className="font-mono text-xs uppercase tracking-hud text-amber-300">Not confirmed — do not assume it was posted</p>
          <p className="text-sm text-sys-text">{step.message}</p>
          <Button onClick={onClose}>Close</Button>
        </div>
      )}

      {step.kind === "declined" && (
        <div className="space-y-3" role="status">
          <p className="text-sm text-sys-text">Declined. Nothing was posted.</p>
          <Button onClick={onClose}>Close</Button>
        </div>
      )}

      {step.kind === "refused" && (
        <div className="space-y-3" role="alert">
          <p className="font-mono text-xs uppercase tracking-hud text-sys-danger">{step.title}</p>
          <p className="text-sm text-sys-text">{step.message}</p>
          <Button onClick={onClose}>Close</Button>
        </div>
      )}
    </Panel>
  );
}
