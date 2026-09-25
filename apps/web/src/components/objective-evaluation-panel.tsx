"use client";

// ---------------------------------------------------------------------------
// S6 — the objective evaluation of ONE reply.
//
// A PRESENTER for GET /activity/trace/:traceId/evaluation, and nothing more.
// The server splits the request into objectives and applies its fixed rules;
// this component shows what came back. It computes nothing:
//
//   - No count, total, percentage, score, confidence, grade or overall verdict.
//     The contract carries none, and deriving one here would be a second,
//     unreviewed evaluation engine.
//   - Status is a fixed lookup to a label and a tone. An unknown value is shown
//     raw, not guessed at.
//   - `objective.text` is the user's own words and is rendered verbatim.
//
// WHAT IT NEVER SHOWS. Facts, fact refs, approval and task ids, tool ids,
// feedback (the thumbs already own it) and the server's error text. v1 is
// objective-level only.
//
// COST. Closed, it makes no request. Opening mounts the body, which fetches;
// closing unmounts it, so reopening fetches again rather than showing a
// snapshot that may have gone stale — an approval granted in between changes
// what the evidence proves.
// ---------------------------------------------------------------------------

import { useId, useState } from "react";
import { ChevronDown, ChevronRight, ListChecks, RefreshCw } from "lucide-react";

import {
  getObjectiveEvaluation,
  type Objective,
  type ObjectiveAssessment,
  type ObjectiveEvaluation,
  type ObjectiveStatus,
} from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { Badge, StatusDot, type Tone } from "@/components/ui/primitives";
import { EmptyState, ErrorState, LoadingState } from "@/components/dashboard/states";

// ---------------------------------------------------------------------------
// Fixed presentation. A lookup, not a judgement.
// ---------------------------------------------------------------------------

const STATUS_PRESENTATION: Readonly<Record<ObjectiveStatus, { tone: Tone; label: string }>> = {
  EVIDENCED: { tone: "ok", label: "Evidenced" },
  AWAITING_APPROVAL: { tone: "warn", label: "Awaiting approval" },
  BLOCKED: { tone: "danger", label: "Blocked" },
  NOT_ATTEMPTED: { tone: "neutral", label: "Not attempted" },
  NOT_EVALUABLE: { tone: "info", label: "Not evaluable" },
};

/** Own-property check, so a value such as "constructor" is unknown, not a prototype hit. */
function presentStatus(status: string): { tone: Tone; label: string } {
  return Object.prototype.hasOwnProperty.call(STATUS_PRESENTATION, status)
    ? STATUS_PRESENTATION[status as ObjectiveStatus]
    : { tone: "neutral", label: status };
}

/** Frontend-owned wording. The server's error message is never rendered. */
const COPY = {
  notFound: "No evaluation is available for this reply.",
  unbound: "No request text is linked to this trace.",
  noObjectives: "No objectives were read from this request.",
  error: "The evaluation could not be loaded right now.",
} as const;

function formatAsOf(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString([], { dateStyle: "medium", timeStyle: "medium" });
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function ObjectiveEvaluationPanel({ traceId }: { traceId: string }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();

  return (
    <div
      data-testid="objective-evaluation"
      className="mt-2 rounded-lg border border-gray-700 bg-gray-900/40 text-xs"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((value) => !value)}
        className="sys-focus flex w-full items-center gap-1.5 rounded-lg px-3 py-2 text-left text-gray-400 transition-colors hover:text-gray-200"
      >
        {open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
        <ListChecks size={13} aria-hidden="true" />
        <span>Objective evaluation</span>
      </button>

      {open && <EvaluationBody id={bodyId} traceId={traceId} />}
    </div>
  );
}

function EvaluationBody({ id, traceId }: { id: string; traceId: string }) {
  const { data, loading, error, errorCode, reload } = useResource(
    () => getObjectiveEvaluation(traceId),
    [traceId]
  );

  let content: JSX.Element;
  if (error !== null) {
    // `error` is used only as a flag. Its text is the server's and stays unrendered.
    content =
      errorCode === "NOT_FOUND" ? (
        <EmptyState title="No evaluation" message={COPY.notFound} className="py-4" />
      ) : (
        <ErrorState
          title="Evaluation unavailable"
          message={COPY.error}
          onRetry={() => void reload()}
          className="p-3"
        />
      );
  } else if (!data) {
    content = <LoadingState label="Loading evaluation…" lines={2} />;
  } else {
    content = (
      <EvaluationView evaluation={data} refreshing={loading} onRefresh={() => void reload()} />
    );
  }

  return (
    <div id={id} data-testid="objective-evaluation-body" className="border-t border-gray-700 px-3 py-2.5">
      {content}
    </div>
  );
}

function EvaluationView({
  evaluation,
  refreshing,
  onRefresh,
}: {
  evaluation: ObjectiveEvaluation;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const { bound, objectives, assessments, missing, asOf } = evaluation;
  const assessmentFor = new Map(assessments.map((assessment) => [assessment.objectiveId, assessment]));

  let body: JSX.Element;
  if (!bound) {
    body = <EmptyState title="Not linked" message={COPY.unbound} className="py-4" />;
  } else if (objectives.length === 0) {
    body = <EmptyState title="No objectives" message={COPY.noObjectives} className="py-4" />;
  } else {
    body = (
      <ol data-testid="objective-list" className="list-none space-y-2">
        {objectives.map((objective) => (
          <ObjectiveRow
            key={objective.objectiveId}
            objective={objective}
            assessment={assessmentFor.get(objective.objectiveId)}
          />
        ))}
      </ol>
    );
  }

  return (
    <div className="space-y-2.5" aria-busy={refreshing || undefined}>
      {body}

      {missing.length > 0 && (
        <div data-testid="evaluation-missing" className="flex flex-wrap items-center gap-1.5">
          <span className="text-gray-500">Missing</span>
          {missing.map((code, index) => (
            <Badge key={`${code}-${index}`}>
              <span data-testid="missing-code" className="[overflow-wrap:anywhere]">
                {code}
              </span>
            </Badge>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 text-gray-500">
        <p data-testid="evaluation-as-of">
          {asOf && (
            <>
              As of <time dateTime={asOf}>{formatAsOf(asOf)}</time>
            </>
          )}
        </p>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="sys-focus inline-flex items-center gap-1 rounded px-1.5 py-1 text-gray-400 transition-colors hover:bg-gray-700/50 hover:text-gray-200 disabled:opacity-60"
        >
          <RefreshCw size={11} aria-hidden="true" className={refreshing ? "animate-spin" : undefined} />
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>
    </div>
  );
}

/** One label/value pair. Wraps, so a label can sit above its value on a phone. */
const PAIR = "flex min-w-0 flex-wrap items-center gap-1.5";

function ObjectiveRow({
  objective,
  assessment,
}: {
  objective: Objective;
  assessment: ObjectiveAssessment | undefined;
}) {
  const status = assessment ? presentStatus(assessment.status) : null;

  return (
    <li
      data-testid="objective-item"
      className="min-w-0 space-y-1.5 rounded-md border border-gray-700/70 bg-gray-800/60 px-2.5 py-2"
    >
      <p
        data-testid="objective-text"
        className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] text-sm leading-relaxed text-gray-100"
      >
        {objective.text}
      </p>

      {/*
        WRAPPING. Every text and code here uses overflow-wrap:anywhere, not
        break-word. Only "anywhere" also lowers the MIN-CONTENT width, and the
        chat column sizes itself to its content's minimum: with break-word, one
        unbroken URL in a request pushed the column to 800px on a 390px screen.
      */}
      <dl className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className={PAIR}>
          <dt className="text-gray-500">Class</dt>
          <dd className="min-w-0">
            <Badge>
              <span data-testid="objective-class" className="[overflow-wrap:anywhere]">
                {objective.evidenceClass}
              </span>
            </Badge>
          </dd>
        </div>

        {assessment && status && (
          <>
            <div className={PAIR}>
              <dt className="text-gray-500">Status</dt>
              <dd className="min-w-0">
                <StatusDot tone={status.tone} label={status.label} />
              </dd>
            </div>

            <div className={PAIR}>
              <dt className="text-gray-500">Rule</dt>
              <dd className="min-w-0">
                <code
                  data-testid="objective-rule"
                  className="font-mono text-[11px] text-gray-400 [overflow-wrap:anywhere]"
                >
                  {assessment.rule}
                </code>
              </dd>
            </div>

            {assessment.missing && (
              <div className={PAIR}>
                <dt className="text-gray-500">Missing</dt>
                <dd className="min-w-0">
                  <Badge>
                    <span data-testid="objective-missing" className="[overflow-wrap:anywhere]">
                      {assessment.missing}
                    </span>
                  </Badge>
                </dd>
              </div>
            )}
          </>
        )}
      </dl>
    </li>
  );
}
