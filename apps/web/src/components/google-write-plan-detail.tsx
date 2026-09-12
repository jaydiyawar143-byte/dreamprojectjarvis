"use client";

// ---------------------------------------------------------------------------
// The Google write plan, rendered for a human decision.
//
// WHY THIS EXISTS. `ApprovalCard` already dumps `params` as JSON, which for a
// Google write is the whole plan object — safe, but unreadable. Nobody can
// responsibly approve sending an email by reading a JSON blob, and an approval
// nobody reads is a rubber stamp.
//
// So this renders the plan as prose and a diff: what is being changed, who will
// be emailed, what the content says, what it will cost if wrong, and when the
// approval stops being valid.
//
// IT RENDERS FIELDS, NOT THE RAW OBJECT. Only `target`, `recipients`, `fields`,
// `risk`, `requiredScopes` and `expiresAt` are read. There is no path here that
// prints the object wholesale, so a field added to the plan server-side cannot
// appear on screen without someone deciding it should — which is the control
// that keeps a future token-shaped field off the page.
//
// CONTENT IS TEXT, NEVER MARKUP. Bodies and descriptions render inside a
// `whitespace-pre-wrap` block, never via `dangerouslySetInnerHTML`. A draft
// body may have been composed by a model from an email somebody else sent, so
// treating it as markup would be handing an injection surface to a stranger.
// ---------------------------------------------------------------------------

import { AlertTriangle, Clock, Mail, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/primitives";

/** The subset of the plan this component reads. Nothing else is touched. */
export interface WritePlanView {
  action?: string;
  target?: { kind?: string; id?: string | null; label?: string; location?: string };
  recipients?: string[];
  fields?: Array<{ label?: string; before?: string | null; after?: string }>;
  risk?: {
    level?: string;
    irreversible?: boolean;
    outwardFacing?: boolean;
    requiresStrongConfirmation?: boolean;
    consequence?: string;
  };
  requiredScopes?: string[];
  expiresAt?: string;
  requestId?: string;
}

/** Whether an approval's tool id names a Google write action. */
export function isGoogleWriteApproval(toolId: string): boolean {
  return /^(gmail|drive|calendar)\.(createDraft|updateDraft|sendDraft|createFolder|uploadFile|moveFile|renameFile|createEvent|updateEvent|deleteEvent)$/.test(
    toolId
  );
}

/** Plain-English action name. Never the bare verb for an irreversible one. */
const ACTION_LABEL: Record<string, string> = {
  "gmail.createDraft": "Create a Gmail draft",
  "gmail.updateDraft": "Replace a Gmail draft",
  "gmail.sendDraft": "Send an email",
  "drive.createFolder": "Create a Drive folder",
  "drive.uploadFile": "Upload a file to Drive",
  "drive.moveFile": "Move a Drive file",
  "drive.renameFile": "Rename a Drive file",
  "calendar.createEvent": "Create a calendar event",
  "calendar.updateEvent": "Change a calendar event",
  "calendar.deleteEvent": "Delete a calendar event",
};

/** A scope URL as a short phrase. The full URL is meaningless to most readers. */
function scopeLabel(scope: string): string {
  if (scope.includes("gmail.compose")) return "Create and send mail";
  if (scope.includes("gmail.readonly")) return "Read mail";
  if (scope.includes("drive.file")) return "Manage files it created";
  if (scope.includes("drive.readonly")) return "Read files";
  if (scope.includes("calendar.events")) return "Manage events";
  if (scope.includes("calendar.readonly")) return "Read calendar";
  return scope.replace("https://www.googleapis.com/auth/", "");
}

export function GoogleWritePlanDetail({
  plan,
  toolId,
}: {
  plan: WritePlanView;
  toolId: string;
}) {
  const risk = plan.risk ?? {};
  const recipients = plan.recipients ?? [];
  const fields = plan.fields ?? [];

  const tone =
    risk.level === "HIGH" ? "text-red-300" : risk.level === "MEDIUM" ? "text-amber-300" : "text-sys-dim";

  return (
    <div data-testid="google-write-plan" className="space-y-3 text-xs">
      {/* What, in words. */}
      <div className="flex flex-wrap items-center gap-2">
        <span data-testid="plan-action" className="font-medium text-white">
          {ACTION_LABEL[toolId] ?? toolId}
        </span>
        {risk.level && (
          <Badge tone={risk.level === "HIGH" ? "danger" : risk.level === "MEDIUM" ? "warn" : "neutral"}>
            {risk.level} risk
          </Badge>
        )}
        {risk.irreversible && (
          <Badge tone="danger" data-testid="plan-irreversible">
            <ShieldAlert size={9} aria-hidden />
            Cannot be undone
          </Badge>
        )}
      </div>

      {/* The consequence, stated before anything else the reader might skim. */}
      {risk.consequence && (
        <p data-testid="plan-consequence" className={`leading-relaxed ${tone}`}>
          <AlertTriangle size={11} aria-hidden className="mr-1 inline align-[-2px]" />
          {risk.consequence}
        </p>
      )}

      {/* The target. */}
      {plan.target?.label && (
        <div className="flex items-baseline gap-2">
          <span className="shrink-0 text-sys-dim">Target</span>
          <span data-testid="plan-target" className="ml-auto min-w-0 truncate text-right text-sys-text/85">
            {plan.target.label}
            {plan.target.kind ? ` (${plan.target.kind})` : ""}
          </span>
        </div>
      )}

      {/* Who will be emailed. The fact most easily missed, so it is loud. */}
      {recipients.length > 0 && (
        <div
          data-testid="plan-recipients"
          className="rounded border border-amber-400/30 bg-amber-400/5 p-2"
        >
          <p className="flex items-center gap-1.5 font-medium text-amber-300">
            <Mail size={11} aria-hidden />
            {recipients.length} {recipients.length === 1 ? "person" : "people"} will be emailed
          </p>
          <p className="mt-1 break-words leading-relaxed text-sys-text/85">
            {recipients.join(", ")}
          </p>
        </div>
      )}

      {/* The change, field by field. `before` present = a diff. */}
      {fields.length > 0 && (
        <dl data-testid="plan-fields" className="space-y-1.5">
          {fields.map((f, i) => (
            <div key={`${f.label}-${i}`} className="space-y-0.5">
              <dt className="text-sys-dim">{f.label}</dt>
              <dd>
                {f.before !== null && f.before !== undefined && f.before !== "" && (
                  <p className="break-words text-red-300/80 line-through">{f.before}</p>
                )}
                {/* Plain text, pre-wrapped. Never dangerouslySetInnerHTML: a
                    body may quote an email a stranger sent. */}
                <p className="whitespace-pre-wrap break-words text-sys-text/85">{f.after}</p>
              </dd>
            </div>
          ))}
        </dl>
      )}

      {/* Permissions this will exercise. */}
      {plan.requiredScopes && plan.requiredScopes.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sys-dim">Uses</span>
          {plan.requiredScopes.map((s) => (
            <Badge key={s} tone="neutral">
              {scopeLabel(s)}
            </Badge>
          ))}
        </div>
      )}

      {plan.expiresAt && (
        <p className="flex items-center gap-1.5 text-sys-dim">
          <Clock size={10} aria-hidden />
          Approval valid until {new Date(plan.expiresAt).toLocaleString()}
        </p>
      )}

      {plan.requestId && (
        <p data-testid="plan-request-id" className="font-mono text-[0.7rem] text-sys-dim/70">
          Request {plan.requestId}
        </p>
      )}
    </div>
  );
}
