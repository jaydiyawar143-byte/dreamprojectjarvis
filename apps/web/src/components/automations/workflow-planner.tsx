"use client";

// ---------------------------------------------------------------------------
// Phase 18.4 — plan an automation: find what the library already has, and
// keep drafts.
//
// REUSE FIRST. A request is compared with the organization's workflow
// library, and the answer is shown in its own terms — reuse, customize, no
// suitable workflow, or not enough to compare — with each candidate's reasons
// and gaps, as the server worded them. A match is a lead to inspect: it
// compares triggers, apps and names, not what nodes are configured to do.
//
// DRAFTING IS THE SERVER'S TO ALLOW. The draft buttons appear only when the
// server says this reader may draft (`canDraft`); a new draft while a library
// workflow covers the request is offered only as "anyway". There is no
// deploy, activate, run, publish or live-edit control anywhere here.
// ---------------------------------------------------------------------------

import { useState } from "react";
import { LIBRARY_TRIGGER_KINDS, TRIGGER_LABEL, type PlanningMatchView } from "@jarvis/core/automation-planning";
import { createWorkflowDraft, listWorkflowDrafts, matchWorkflows, type ApiError, type PlanningRequestBody } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { Panel } from "@/components/dashboard/panel";
import { EmptyState, ErrorState, LoadingState } from "@/components/dashboard/states";
import { Badge, Button, DataTable, type Tone } from "@/components/ui/primitives";
import { WorkflowInspectionPanel } from "./workflow-inspection";
import { AutomationLayers, WorkflowDraftPanel } from "./workflow-draft";

const INPUT_CLASS = "sys-focus w-full rounded border border-sys-control bg-sys-edge/40 px-3 py-1.5 text-sm text-sys-text";
const LABEL_CLASS = "block space-y-1 text-xs text-sys-dim";
const UNAUTHORIZED = new Set(["NOT_AVAILABLE", "PERMISSION_DENIED"]);

const OUTCOME_LABEL: Record<PlanningMatchView["outcome"], { label: string; tone: Tone }> = {
  reuse: { label: "An existing workflow appears to cover this", tone: "ok" },
  customize: { label: "An existing workflow could be customized", tone: "info" },
  no_match: { label: "No suitable workflow found", tone: "neutral" },
  insufficient_evidence: { label: "Not enough to compare", tone: "warn" },
};

export function WorkflowPlannerSection() {
  const [goal, setGoal] = useState("");
  const [trigger, setTrigger] = useState("");
  const [apps, setApps] = useState("");
  const [outcome, setOutcome] = useState("");
  const [asked, setAsked] = useState<PlanningRequestBody | null>(null);
  const [match, setMatch] = useState<PlanningMatchView | null>(null);
  const [matchError, setMatchError] = useState<ApiError | null>(null);
  const [matching, setMatching] = useState(false);
  const [drafting, setDrafting] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<ApiError | null>(null);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [openDraft, setOpenDraft] = useState<string | null>(null);
  const drafts = useResource(() => listWorkflowDrafts(), [], { fallbackError: "Could not list the drafts." });

  const find = async () => {
    if (matching || goal.trim().length === 0) return;
    const body: PlanningRequestBody = {
      goal: goal.trim(),
      ...(trigger ? { trigger } : {}),
      ...(apps.trim() ? { services: apps.split(",").map((a) => a.trim()).filter(Boolean).slice(0, 8) } : {}),
      ...(outcome.trim() ? { outcome: outcome.trim() } : {}),
    };
    setMatching(true);
    setMatchError(null);
    setDraftError(null);
    const res = await matchWorkflows(body);
    setMatching(false);
    if (res.success && res.data) {
      setAsked(body);
      setMatch(res.data);
    } else {
      setMatch(null);
      setMatchError(res.error ?? { code: "ERROR", message: "Could not compare the library right now." });
    }
  };

  const startDraft = async (key: string, extra: { kind: "new" | "customization"; sourceEntryId?: string; overrideReuse?: boolean }) => {
    if (!asked || drafting) return;
    setDrafting(key);
    setDraftError(null);
    const res = await createWorkflowDraft({ ...asked, ...extra });
    setDrafting(null);
    if (res.success && res.data) {
      setOpenDraft(res.data.draft.draftId);
      void drafts.reload();
    } else {
      setDraftError(res.error ?? { code: "ERROR", message: "The draft could not be saved." });
    }
  };

  return (
    <>
      <Panel
        title="Plan an automation"
        description="Find a workflow you already have before drafting a new one. Drafts are plans saved in JARVIS — nothing here changes n8n."
        className="mt-4"
        data-testid="workflow-planner"
      >
        <AutomationLayers />
        <form
          className="mt-4 grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            void find();
          }}
        >
          <label className={`${LABEL_CLASS} sm:col-span-2`} htmlFor="plan-goal">
            <span>What should it do?</span>
            <textarea id="plan-goal" rows={2} maxLength={500} value={goal} onChange={(e) => setGoal(e.target.value)} className={INPUT_CLASS} />
          </label>
          <label className={LABEL_CLASS} htmlFor="plan-trigger">
            <span>How does it start? (optional)</span>
            <select id="plan-trigger" value={trigger} onChange={(e) => setTrigger(e.target.value)} className={INPUT_CLASS}>
              <option value="">Not said</option>
              {LIBRARY_TRIGGER_KINDS.map((k) => (
                <option key={k} value={k}>
                  {TRIGGER_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <label className={LABEL_CLASS} htmlFor="plan-apps">
            <span>Apps (optional, comma-separated)</span>
            <input id="plan-apps" maxLength={300} value={apps} onChange={(e) => setApps(e.target.value)} className={INPUT_CLASS} />
          </label>
          <label className={`${LABEL_CLASS} sm:col-span-2`} htmlFor="plan-outcome">
            <span>What should have happened at the end? (optional)</span>
            <input id="plan-outcome" maxLength={300} value={outcome} onChange={(e) => setOutcome(e.target.value)} className={INPUT_CLASS} />
          </label>
          <div className="sm:col-span-2">
            <Button type="submit" size="sm" variant="primary" disabled={matching || goal.trim().length === 0}>
              {matching ? "Comparing…" : "Find workflows"}
            </Button>
          </div>
        </form>

        {matching && <LoadingState label="Comparing with your workflow library…" />}
        {matchError &&
          (UNAUTHORIZED.has(matchError.code) ? (
            <EmptyState title="Not available to your account" message={matchError.message} />
          ) : (
            <ErrorState title="Could not compare" message={matchError.message} onRetry={() => void find()} />
          ))}

        {match && !matching && (
          <section className="mt-4 space-y-3" data-testid="plan-result" aria-label="Library match">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={OUTCOME_LABEL[match.outcome].tone}>{OUTCOME_LABEL[match.outcome].label}</Badge>
              <span className="text-xs text-sys-dim">
                Compared {match.searched.compared} of {match.searched.catalogTotal} workflows{match.searched.complete ? "" : " (searched by your words)"}
              </span>
            </div>

            {match.outcome === "no_match" || match.outcome === "insufficient_evidence" ? (
              <EmptyState
                title={OUTCOME_LABEL[match.outcome].label}
                message={match.explanation}
                action={
                  match.canDraft && match.outcome === "no_match" ? (
                    <Button size="sm" variant="secondary" disabled={drafting !== null} onClick={() => void startDraft("new", { kind: "new" })}>
                      {drafting === "new" ? "Saving…" : "Start a new draft"}
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <p className="text-sm text-sys-text">{match.explanation}</p>
            )}

            {match.request.openQuestions.length > 0 && (
              <div data-testid="plan-questions">
                <p className="text-xs font-medium uppercase tracking-wide text-sys-dim">Still open</p>
                <ul className="list-disc pl-5 text-sm">
                  {match.request.openQuestions.map((q) => (
                    <li key={q.key}>{q.question}</li>
                  ))}
                </ul>
              </div>
            )}
            {match.request.notes.length > 0 && (
              <ul className="list-disc pl-5 text-xs text-sys-dim">
                {match.request.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}

            {match.candidates.length > 0 && (
              <ul className="space-y-3" data-testid="plan-candidates">
                {match.candidates.map((c) => (
                  <li key={c.entryId} className="rounded border border-sys-control/60 p-3" data-testid={`candidate-${c.entryId}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-sys-text">{c.name}</span>
                      <Badge tone="neutral">Catalog entry</Badge>
                      <Badge tone={c.fit === "reuse" ? "ok" : "info"}>{c.fit === "reuse" ? "Could be reused" : "Could be customized"}</Badge>
                      <span className="text-xs text-sys-dim">score {c.score}/100</span>
                    </div>
                    <ul className="mt-2 space-y-0.5 text-sm">
                      {c.matches.map((m) => (
                        <li key={m} className="text-sys-text">
                          ✓ {m}
                        </li>
                      ))}
                      {c.gaps.map((g) => (
                        <li key={g} className="text-sys-dim">
                          – {g}
                        </li>
                      ))}
                    </ul>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button size="sm" variant="ghost" onClick={() => setInspecting(c.entryId)} aria-label={`Inspect ${c.name}`}>
                        Inspect
                      </Button>
                      {match.canDraft && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={drafting !== null}
                          onClick={() => void startDraft(c.entryId, { kind: "customization", sourceEntryId: c.entryId })}
                        >
                          {drafting === c.entryId ? "Saving…" : "Draft a customization"}
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {match.canDraft && (match.outcome === "reuse" || match.outcome === "customize") && (
              <Button
                size="sm"
                variant="ghost"
                disabled={drafting !== null}
                onClick={() => void startDraft("anyway", { kind: "new", ...(match.outcome === "reuse" ? { overrideReuse: true } : {}) })}
              >
                {drafting === "anyway" ? "Saving…" : match.outcome === "reuse" ? "Draft a new workflow anyway" : "Draft a new workflow instead"}
              </Button>
            )}
            {draftError && (
              <div role="alert" className="text-sm text-red-300" data-testid="plan-draft-error">
                <p>{draftError.message}</p>
                {draftError.issues && draftError.issues.length > 1 && (
                  <ul className="list-disc pl-5">
                    {draftError.issues.map((i, n) => (
                      <li key={`${i.path}-${n}`}>
                        {i.path}: {i.message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <ul className="space-y-1 text-xs text-sys-dim" data-testid="plan-limitations">
              {match.limitations.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </section>
        )}
      </Panel>

      {inspecting && <WorkflowInspectionPanel key={`inspect-${inspecting}`} entryId={inspecting} onClose={() => setInspecting(null)} />}

      <Panel title="Workflow drafts" description="Plans saved in JARVIS. None of them is in n8n." className="mt-4" data-testid="workflow-drafts">
        {drafts.loading && !drafts.loaded ? (
          <LoadingState label="Loading drafts…" />
        ) : drafts.error ? (
          UNAUTHORIZED.has(drafts.errorCode ?? "") ? (
            <EmptyState title="Not available to your account" message={drafts.error} />
          ) : (
            <ErrorState title="Could not list the drafts" message={drafts.error} onRetry={() => void drafts.reload()} />
          )
        ) : !drafts.data || drafts.data.items.length === 0 ? (
          <EmptyState title="No drafts yet" message="Find workflows above; a draft can be started from the result." />
        ) : (
          <DataTable
            caption="Workflow drafts"
            rows={drafts.data.items}
            rowKey={(row) => row.draftId}
            columns={[
              { key: "title", header: "Draft", render: (row) => <span className="text-sys-text">{row.title}</span> },
              { key: "kind", header: "Kind", render: (row) => (row.kind === "new" ? "New workflow" : "Customization") },
              { key: "version", header: "Version", render: (row) => `v${row.latestVersion}` },
              { key: "updated", header: "Updated", render: (row) => new Date(row.updatedAt).toLocaleString() },
              {
                key: "open",
                header: "",
                render: (row) => (
                  <Button size="sm" variant="ghost" onClick={() => setOpenDraft(row.draftId)} aria-label={`Open ${row.title}`}>
                    Open
                  </Button>
                ),
              },
            ]}
          />
        )}
      </Panel>

      {openDraft && <WorkflowDraftPanel key={openDraft} draftId={openDraft} onClose={() => setOpenDraft(null)} />}
    </>
  );
}
