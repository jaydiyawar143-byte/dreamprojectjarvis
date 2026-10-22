"use client";

// ---------------------------------------------------------------------------
// Phase 18.4 — one workflow draft: what it proposes, how far it is checked,
// and which version this is.
//
// A DRAFT IS NOT A WORKFLOW, and the panel says so where it matters: it is a
// plan saved in JARVIS, it is not in n8n, and nothing here can deploy,
// activate, run, publish or edit a live workflow — there is no such control.
//
// WHAT IS SHOWN IS WHAT THE SERVER SAID. Its status, its checks (passed,
// failed, pending, or not run — and why), what still needs an answer, and the
// version's number and content hash. A draft is "validated" only when every
// check ran and passed; the panel never words it as more.
//
// A REVISION IS A NEW VERSION. Answers are saved from the version shown, as a
// new version; earlier versions stay as they were and can be opened.
// ---------------------------------------------------------------------------

import { useState } from "react";
import type { DraftCheck, DraftStatus, DraftView } from "@jarvis/core/automation-planning";
import { getWorkflowDraft, reviseWorkflowDraft, type ApiError } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { Panel } from "@/components/dashboard/panel";
import { EmptyState, ErrorState, LoadingState } from "@/components/dashboard/states";
import { Badge, Button, type Tone } from "@/components/ui/primitives";

const INPUT_CLASS = "sys-focus w-full rounded border border-sys-control bg-sys-edge/40 px-3 py-1.5 text-sm text-sys-text";
const UNAUTHORIZED = new Set(["NOT_AVAILABLE", "PERMISSION_DENIED"]);

export const DRAFT_STATUS_LABEL: Record<DraftStatus, { label: string; tone: Tone }> = {
  needs_input: { label: "Needs your input", tone: "warn" },
  unverified: { label: "Checked — some checks could not run", tone: "info" },
  validated: { label: "Validated", tone: "ok" },
  stale: { label: "Stale — its source workflow changed", tone: "danger" },
  invalid: { label: "Invalid", tone: "danger" },
};

const CHECK_LABEL: Record<DraftCheck["status"], { label: string; tone: Tone }> = {
  passed: { label: "Passed", tone: "ok" },
  failed: { label: "Failed", tone: "danger" },
  pending: { label: "Needs input", tone: "warn" },
  not_run: { label: "Not run", tone: "neutral" },
};

/** The four things a reader must not confuse, said once. */
export function AutomationLayers() {
  return (
    <dl className="grid gap-2 text-xs text-sys-dim sm:grid-cols-2" data-testid="automation-layers">
      <div>
        <dt className="font-medium text-sys-text">Catalog entry</dt>
        <dd>A workflow seen on your n8n instance. Read-only here.</dd>
      </div>
      <div>
        <dt className="font-medium text-sys-text">On your trigger allow-list</dt>
        <dd>A catalog workflow you may trigger — each time with your approval.</dd>
      </div>
      <div>
        <dt className="font-medium text-sys-text">Draft</dt>
        <dd>A plan saved in JARVIS. It is not in n8n and cannot run.</dd>
      </div>
      <div>
        <dt className="font-medium text-sys-text">Live workflow</dt>
        <dd>What runs in n8n. JARVIS does not deploy, edit, activate or run it from here.</dd>
      </div>
    </dl>
  );
}

function currentAnswers(view: DraftView): Record<string, string> {
  const out: Record<string, string> = {};
  for (const q of view.content.questions) if (q.answer) out[`question.${q.key}`] = q.answer;
  for (const n of view.content.nodes) for (const s of n.settings) if (s.kind === "value" && s.value) out[`${n.key}.${s.key}`] = s.value;
  return out;
}

export function WorkflowDraftPanel({ draftId, onClose }: { draftId: string; onClose: () => void }) {
  const [version, setVersion] = useState<number | undefined>(undefined);
  const draft = useResource(() => getWorkflowDraft(draftId, version), [draftId, version], { fallbackError: "Could not open this draft." });
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const close = (
    <Button size="sm" variant="ghost" onClick={onClose}>
      Close
    </Button>
  );

  if (draft.loading && !draft.loaded) {
    return (
      <Panel title="Workflow draft" action={close} className="mt-4">
        <LoadingState label="Opening the draft…" />
      </Panel>
    );
  }
  if (draft.error) {
    const code = draft.errorCode ?? "";
    return (
      <Panel title="Workflow draft" action={close} className="mt-4">
        {UNAUTHORIZED.has(code) ? (
          <EmptyState title="Not available to your account" message={draft.error} />
        ) : code === "DRAFT_NOT_FOUND" || code === "VERSION_NOT_FOUND" ? (
          <EmptyState title="No such draft" message={draft.error} />
        ) : (
          <ErrorState title="Could not open this draft" message={draft.error} onRetry={() => void draft.reload()} />
        )}
      </Panel>
    );
  }
  const view = draft.data;
  if (!view) return null;

  const status = DRAFT_STATUS_LABEL[view.status];
  const known = currentAnswers(view);
  const changed = Object.fromEntries(Object.entries(answers).filter(([k, v]) => v.trim().length > 0 && v !== known[k]));
  const answerable = view.requirements.filter((r) => r.key && (r.kind === "question" || r.kind === "setting"));

  const save = async () => {
    if (saving || Object.keys(changed).length === 0) return;
    setSaving(true);
    setRefusal(null);
    setNotice(null);
    const res = await reviseWorkflowDraft(view.draftId, view.version.number, changed);
    setSaving(false);
    if (res.success && res.data) {
      setAnswers({});
      setNotice(res.data.unchanged ? "Nothing changed." : `Saved as version ${res.data.draft.version.number}. Earlier versions are unchanged.`);
      setVersion(undefined);
      void draft.reload();
    } else {
      setRefusal(res.error ?? { code: "ERROR", message: "The answers could not be saved." });
    }
  };

  const { diff } = view;
  return (
    <Panel
      title={`Draft — ${view.title}`}
      description={view.kind === "new" ? "A new workflow, planned in JARVIS" : "A customization of a library workflow, planned in JARVIS"}
      action={close}
      className="mt-4"
      data-testid="workflow-draft"
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Badge tone="neutral">Draft — not in n8n</Badge>
        <Badge tone={status.tone}>{status.label}</Badge>
        <span className="font-mono text-xs text-sys-dim" data-testid="draft-version" title={view.version.contentHash}>
          Version {view.version.number} of {view.latestVersion} · {view.version.contentHash.slice(0, 12)}
        </span>
        {!view.version.isLatest && <Badge tone="warn">An earlier version — read-only</Badge>}
      </div>

      {view.source && (
        <p className="mb-3 text-sm text-sys-text" data-testid="draft-source">
          Customizes catalog entry “{view.source.name}” ({view.source.entryId}) at version {view.source.versionId}.
          {view.source.drift !== "none" && (
            <span className="ml-1 text-amber-300">
              {view.source.drift === "changed"
                ? ` It is now at version ${view.source.currentVersionId ?? "unknown"} in n8n — start a new draft from it.`
                : " It is no longer current in the library."}
            </span>
          )}
        </p>
      )}

      <section className="space-y-2 text-sm" data-testid="draft-diff" aria-label="Proposed changes">
        <h3 className="text-xs font-medium uppercase tracking-wide text-sys-dim">Proposed changes</h3>
        {diff.nodesAdded.length === 0 && diff.nodesRemoved.length === 0 && diff.connectionsAdded.length === 0 && diff.configurationChanges.length === 0 ? (
          <p className="text-sys-dim">No change proposed yet.</p>
        ) : (
          <ul className="list-disc space-y-1 pl-5">
            {diff.triggersAdded.map((t) => (
              <li key={`ta-${t.key}`}>Add trigger: {t.label}</li>
            ))}
            {diff.triggersRemoved.map((t) => (
              <li key={`tr-${t.key}`}>Remove trigger: {t.label}</li>
            ))}
            {diff.nodesAdded
              .filter((n) => n.kind !== "trigger")
              .map((n) => (
                <li key={`na-${n.key}`}>
                  Add step: {n.label} <span className="font-mono text-xs text-sys-dim">{n.type}</span>
                </li>
              ))}
            {diff.nodesRemoved
              .filter((n) => !diff.triggersRemoved.some((t) => t.key === n.key))
              .map((n) => (
                <li key={`nr-${n.key}`}>Remove step: {n.label}</li>
              ))}
            {diff.connectionsAdded.map((c) => (
              <li key={`c-${c.from}-${c.to}-${c.output}`}>
                Connect {c.fromLabel}
                {c.outputName ? ` (${c.outputName})` : ""} → {c.toLabel}
              </li>
            ))}
            {diff.configurationChanges.map((c) => (
              <li key={`cfg-${c.nodeKey}-${c.setting}`}>
                Configure {c.nodeLabel}: {c.setting} —{" "}
                {c.state === "answered" ? "answered" : c.state === "needs_input" ? "needs your answer" : "configure in n8n"}
              </li>
            ))}
          </ul>
        )}
        {diff.untouchedSourceTypes.length > 0 && (
          <p className="text-xs text-sys-dim">Untouched in the source: {diff.untouchedSourceTypes.join(", ")}. Their settings and connections are not known here.</p>
        )}
      </section>

      <section className="mt-4 text-sm" data-testid="draft-checks" aria-label="Checks">
        <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-sys-dim">Checks</h3>
        <ul className="space-y-1">
          {view.checks.map((c) => (
            <li key={c.id} className="flex flex-wrap items-start gap-2">
              <Badge tone={CHECK_LABEL[c.status].tone}>{CHECK_LABEL[c.status].label}</Badge>
              <span className="text-sys-dim">{c.message}</span>
            </li>
          ))}
        </ul>
      </section>

      {view.requirements.length > 0 && (
        <section className="mt-4 text-sm" data-testid="draft-requirements" aria-label="What is still open">
          <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-sys-dim">Questions and settings</h3>
          <ul className="space-y-2">
            {view.requirements.map((r, i) => (
              <li key={`${r.key ?? r.label}-${i}`}>
                {r.kind === "credential" || r.kind === "in_n8n" ? (
                  <p>
                    {r.label} — <span className="text-sys-dim">configure in n8n. JARVIS never stores credentials or such values.</span>
                  </p>
                ) : r.kind === "structure" ? (
                  <p className="text-amber-300">{r.label}</p>
                ) : view.canRevise && r.key ? (
                  <label className="block space-y-1 text-xs text-sys-dim">
                    <span>{r.label}</span>
                    <input
                      className={INPUT_CLASS}
                      maxLength={300}
                      value={answers[r.key] ?? known[r.key] ?? ""}
                      onChange={(e) => setAnswers((prev) => ({ ...prev, [r.key!]: e.target.value }))}
                      aria-label={r.label}
                    />
                  </label>
                ) : (
                  <p>
                    {r.label} — <span className="text-sys-dim">{r.state === "answered" ? (r.key ? known[r.key] : "answered") : "not answered"}</span>
                  </p>
                )}
              </li>
            ))}
          </ul>
          {view.canRevise && answerable.length > 0 && (
            <Button className="mt-3" size="sm" variant="primary" disabled={saving || Object.keys(changed).length === 0} onClick={() => void save()}>
              {saving ? "Saving…" : `Save as version ${view.latestVersion + 1}`}
            </Button>
          )}
        </section>
      )}

      {refusal && (
        <div role="alert" className="mt-3 text-sm text-red-300" data-testid="draft-refusal">
          <p>{refusal.message}</p>
          {refusal.issues && refusal.issues.length > 1 && (
            <ul className="mt-1 list-disc pl-5">
              {refusal.issues.map((issue, i) => (
                <li key={`${issue.path}-${i}`}>
                  {issue.path}: {issue.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {notice && (
        <p role="status" className="mt-3 text-sm text-sys-text" data-testid="draft-notice">
          {notice}
        </p>
      )}

      {view.content.notes.length > 0 && (
        <ul className="mt-4 list-disc space-y-1 pl-5 text-xs text-sys-dim" data-testid="draft-notes">
          {view.content.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}

      <section className="mt-4 text-xs text-sys-dim" data-testid="draft-history" aria-label="Versions">
        <h3 className="mb-1 font-medium uppercase tracking-wide">Versions</h3>
        <ul className="space-y-1">
          {view.history.map((h) => (
            <li key={h.version}>
              <button
                type="button"
                className="sys-focus underline-offset-2 hover:underline disabled:no-underline"
                disabled={h.version === view.version.number}
                onClick={() => setVersion(h.version === view.latestVersion ? undefined : h.version)}
              >
                Version {h.version} · <span className="font-mono">{h.contentHash.slice(0, 12)}</span> · {DRAFT_STATUS_LABEL[h.status].label} ·{" "}
                {new Date(h.createdAt).toLocaleString()}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </Panel>
  );
}
