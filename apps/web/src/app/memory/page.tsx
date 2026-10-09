"use client";

// ---------------------------------------------------------------------------
// Phase 14 — the Memory screen.
//
// What JARVIS remembers about the signed-in user, and that user's controls
// over it: see, search, filter by project, pause learning, ask for a memory to
// be corrected or forgotten.
//
// THIS SCREEN CHANGES NOTHING ON ITS OWN. "Forget" and "Correct" ask the
// server for a pending action and show what it would do; the memory changes
// only when the user presses Confirm, which is the same confirmation — and the
// same server-side execution — as typing "yes" in chat. Cancel discards it.
// There is no delete or edit call here, because the API has none.
//
// Everything shown is what the API returns: content, type, a confidence level,
// dates, the project and a provenance summary. The page computes nothing about
// a memory and holds no secret; the server sends no vector and no source id.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react";
import {
  confirmPendingAction,
  createProject,
  getMemoryStatus,
  listMemories,
  listProjects,
  rejectPendingActionApi,
  requestMemoryCorrection,
  requestMemoryForget,
  setMemoryLearning,
  type MemoryConfidenceLevel,
  type MemoryItem,
  type MemoryPage as MemoryPageData,
  type MemoryRequest,
  type MemoryStatus,
  type ProjectItem,
} from "@/lib/api";
import { PageContainer, PageHeader, PanelGrid } from "@/components/dashboard/page-container";
import { Panel, StatPanel } from "@/components/dashboard/panel";
import { EmptyState, ErrorState, LoadingState } from "@/components/dashboard/states";
import { Badge, Button, type Tone } from "@/components/ui/primitives";

const PAGE_SIZE = 20;

const CONFIDENCE: Record<MemoryConfidenceLevel, { label: string; tone: Tone; meaning: string }> = {
  HIGH: { label: "High confidence", tone: "ok", meaning: "You said this directly, in more than one conversation." },
  MEDIUM: { label: "Medium confidence", tone: "info", meaning: "You said this directly once, or agreed to it more than once." },
  LOW: { label: "Low confidence", tone: "warn", meaning: "You agreed to this once, or it is an older memory with no recorded source." },
};

const day = (iso: string) => new Date(iso).toLocaleDateString();
const times = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function provenanceLine(memory: MemoryItem): string {
  const p = memory.provenance;
  if (p.source === "LEGACY") return "An older memory, learned before sources were recorded.";
  const said = `You said this ${times(p.statements, "time")}, in ${times(p.conversations, "conversation")}.`;
  return p.revisions > 0 ? `${said} Its wording was changed ${times(p.revisions, "time")}.` : said;
}

function expiryLine(memory: MemoryItem): string {
  if (!memory.expiresAt) return "Does not expire";
  return memory.expired ? `Expired ${day(memory.expiresAt)}` : `Expires ${day(memory.expiresAt)}`;
}

interface Waiting {
  kind: "forget" | "correct";
  request: MemoryRequest;
}

export default function MemoryPage() {
  const [page, setPage] = useState<MemoryPageData | null>(null);
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [project, setProject] = useState("all");
  const [includeExpired, setIncludeExpired] = useState(false);
  const [offset, setOffset] = useState(0);

  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [newProject, setNewProject] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [memories, memoryStatus, projectList] = await Promise.all([
      listMemories({ limit: PAGE_SIZE, offset, project, q: search, includeExpired }),
      getMemoryStatus(),
      listProjects(),
    ]);
    if (memories.success && memories.data) setPage(memories.data);
    else setError(memories.error?.message ?? "Could not load your memories.");
    if (memoryStatus.success && memoryStatus.data) setStatus(memoryStatus.data);
    if (projectList.success && projectList.data) setProjects(projectList.data.projects);
    setLoading(false);
  }, [offset, project, search, includeExpired]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Runs one request to the server; reports its failure in the server's own words. */
  async function act<T>(run: () => Promise<{ success: boolean; data?: T; error?: { message: string } }>, fallback: string): Promise<T | null> {
    setBusy(true);
    setNotice(null);
    setActionError(null);
    const res = await run();
    setBusy(false);
    if (res.success && res.data !== undefined) return res.data;
    setActionError(res.error?.message ?? fallback);
    return null;
  }

  async function toggleLearning() {
    const next = await act(() => setMemoryLearning(status?.learningPaused ? "resume" : "pause"), "Could not change the learning setting.");
    if (next) {
      setStatus(next);
      setNotice(next.learningPaused ? "Learning is paused. What is already remembered stays." : "Learning is on again.");
    }
  }

  async function askToForget(memory: MemoryItem) {
    const request = await act(() => requestMemoryForget(memory.id), "Could not ask for this memory to be forgotten.");
    if (request) setWaiting({ kind: "forget", request });
  }

  async function askToCorrect() {
    if (!editing) return;
    const request = await act(() => requestMemoryCorrection(editing.id, editing.text), "Could not ask for this memory to be changed.");
    if (request) {
      setWaiting({ kind: "correct", request });
      setEditing(null);
    }
  }

  async function confirm() {
    if (!waiting) return;
    const result = await act(() => confirmPendingAction(waiting.request.pendingAction.id, waiting.request.conversationId), "The change could not be confirmed.");
    if (!result) return;
    const execution = result.executionResult as { status?: string; error?: string; result?: { success?: boolean; error?: string } } | undefined;
    if (execution?.status === "completed" && execution.result?.success) {
      setNotice(waiting.kind === "forget" ? "The memory was forgotten." : "The memory was changed.");
    } else {
      setActionError(execution?.result?.error ?? execution?.error ?? "Nothing was changed.");
    }
    setWaiting(null);
    await load();
  }

  async function cancel() {
    if (!waiting) return;
    await act(() => rejectPendingActionApi(waiting.request.pendingAction.id, waiting.request.conversationId), "Could not cancel the request.");
    setWaiting(null);
    setNotice("Cancelled. Nothing was changed.");
  }

  async function addProject() {
    const created = await act(() => createProject(newProject), "Could not create the project.");
    if (created) {
      setNewProject("");
      setNotice(`Project “${created.project.name}” created. Start a new conversation in it from the Assistant.`);
      await load();
    }
  }

  const memories = page?.memories ?? [];
  const from = page && page.total > 0 ? page.offset + 1 : 0;
  const to = page ? page.offset + memories.length : 0;

  return (
    <PageContainer>
      <PageHeader
        title="Memory"
        description="What JARVIS has learned about you from your own words, and your controls over it. Nothing here changes until you confirm it."
      />

      <div className="space-y-6">
        <PanelGrid columns={4}>
          <StatPanel label="Memories" value={status?.active ?? "—"} hint="In use" loading={loading && !status} />
          <StatPanel
            label="Expired"
            value={status?.expired ?? "—"}
            hint={status ? `Hidden; removed ${status.retention.purgeGraceDays} days after expiry` : undefined}
            loading={loading && !status}
          />
          <StatPanel
            label="Learning"
            value={status ? (status.learningPaused ? "Paused" : "On") : "—"}
            hint={status?.learningPaused ? "Nothing new is being saved" : "From what you tell JARVIS"}
            tone={status?.learningPaused ? "warning" : "default"}
            loading={loading && !status}
          />
          <StatPanel
            label="Retention"
            value={status ? `${status.retention.days} days` : "—"}
            hint="After you last said it"
            loading={loading && !status}
          />
        </PanelGrid>

        {notice && (
          <p role="status" className="rounded border border-sys-ok/35 bg-sys-ok/10 px-3 py-2 text-sm text-sys-text">
            {notice}
          </p>
        )}
        {actionError && <ErrorState title="That did not go through" message={actionError} />}

        {waiting && (
          <Panel
            title={waiting.kind === "forget" ? "Confirm: forget this memory" : "Confirm: change this memory"}
            description="This is the same confirmation as answering “yes” in chat. Until you confirm, nothing has changed."
            tone="warning"
            data-testid="memory-confirmation"
          >
            <p className="whitespace-pre-wrap text-sm text-sys-text">{waiting.request.summary.split("\n\nReply ")[0]}</p>
            <div className="mt-4 flex gap-2">
              <Button variant="danger" onClick={() => void confirm()} disabled={busy}>
                Confirm
              </Button>
              <Button onClick={() => void cancel()} disabled={busy}>
                Cancel
              </Button>
            </div>
          </Panel>
        )}

        <Panel
          title="Your memories"
          description="Each one came from something you said. Personal memories are used in every conversation; a project's memories only in that project."
          action={
            <Button onClick={() => void toggleLearning()} disabled={busy || !status}>
              {status?.learningPaused ? "Resume learning" : "Pause learning"}
            </Button>
          }
        >
          <form
            className="mb-4 flex flex-wrap items-center gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              setOffset(0);
              setSearch(query);
            }}
          >
            <input
              aria-label="Search memories"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search your memories"
              className="sys-focus min-w-48 flex-1 rounded border border-sys-control bg-sys-edge/40 px-3 py-1.5 text-sm text-sys-text"
            />
            <Button type="submit">Search</Button>
            <select
              aria-label="Project"
              value={project}
              onChange={(event) => {
                setOffset(0);
                setProject(event.target.value);
              }}
              className="sys-focus rounded border border-sys-control bg-sys-edge/40 px-2 py-1.5 text-sm text-sys-text"
            >
              <option value="all">All memories</option>
              <option value="personal">Personal</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <label className="inline-flex items-center gap-2 text-sm text-sys-dim">
              <input
                type="checkbox"
                checked={includeExpired}
                onChange={(event) => {
                  setOffset(0);
                  setIncludeExpired(event.target.checked);
                }}
              />
              Show expired
            </label>
          </form>

          {loading && !page && <LoadingState lines={4} />}
          {error && <ErrorState message={error} onRetry={() => void load()} />}
          {!error && page && memories.length === 0 && (
            <EmptyState
              title="No memories here"
              message={
                search || project !== "all"
                  ? "Nothing matches this search or project."
                  : "JARVIS learns lasting preferences, facts about you and ways you work, when you state them yourself."
              }
            />
          )}

          <ul className="space-y-3">
            {memories.map((memory) => (
              <li key={memory.id} data-testid="memory-item" className="rounded border border-sys-line bg-sys-edge/20 p-4">
                <p className="text-sm text-sys-text">{memory.content}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Badge>{memory.type}</Badge>
                  <Badge tone={CONFIDENCE[memory.confidenceLevel].tone} title={CONFIDENCE[memory.confidenceLevel].meaning}>
                    {CONFIDENCE[memory.confidenceLevel].label}
                  </Badge>
                  <Badge tone={memory.projectId ? "info" : "neutral"}>{memory.projectId ? (memory.projectName ?? "Project") : "Personal"}</Badge>
                  {memory.expired && <Badge tone="danger">Expired</Badge>}
                </div>
                <p className="mt-2 text-xs text-sys-dim">{provenanceLine(memory)}</p>
                <p className="mt-1 font-mono text-xs text-sys-dim">
                  Learned {day(memory.createdAt)} · Updated {day(memory.updatedAt)} · {expiryLine(memory)}
                </p>

                {editing?.id === memory.id ? (
                  <div className="mt-3 space-y-2">
                    <textarea
                      aria-label="Corrected memory"
                      value={editing.text}
                      onChange={(event) => setEditing({ id: memory.id, text: event.target.value })}
                      rows={2}
                      maxLength={500}
                      placeholder="Say it in your own words — for example “I prefer short captions”."
                      className="sys-focus w-full rounded border border-sys-control bg-sys-edge/40 px-3 py-2 text-sm text-sys-text"
                    />
                    <div className="flex gap-2">
                      <Button variant="primary" size="sm" onClick={() => void askToCorrect()} disabled={busy || editing.text.trim().length === 0}>
                        Request change
                      </Button>
                      <Button size="sm" onClick={() => setEditing(null)} disabled={busy}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => setEditing({ id: memory.id, text: "" })}
                      disabled={busy || waiting !== null || status?.correctionAvailable === false}
                      title={status?.correctionAvailable === false ? "Correction is not available on this server." : undefined}
                    >
                      Correct
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => void askToForget(memory)} disabled={busy || waiting !== null}>
                      Forget
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>

          {page && page.total > 0 && (
            <div className="mt-4 flex items-center justify-between">
              <span className="font-mono text-xs text-sys-dim">
                Showing {from}–{to} of {page.total}
              </span>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0 || loading}>
                  Previous
                </Button>
                <Button size="sm" onClick={() => setOffset(offset + PAGE_SIZE)} disabled={!page.hasMore || loading}>
                  Next
                </Button>
              </div>
            </div>
          )}
        </Panel>

        <Panel
          title="Projects"
          description="A project keeps its own memories. Start a new conversation in a project from the Assistant; what you say there is remembered in that project only."
        >
          {projects.length === 0 ? (
            <p className="text-sm text-sys-dim">You have no projects. Everything JARVIS learns is personal.</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {projects.map((p) => (
                <li key={p.id}>
                  <Badge tone="info">{p.name}</Badge>
                </li>
              ))}
            </ul>
          )}
          <form
            className="mt-4 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void addProject();
            }}
          >
            <input
              aria-label="New project name"
              value={newProject}
              onChange={(event) => setNewProject(event.target.value)}
              maxLength={80}
              placeholder="New project name"
              className="sys-focus min-w-48 flex-1 rounded border border-sys-control bg-sys-edge/40 px-3 py-1.5 text-sm text-sys-text"
            />
            <Button type="submit" disabled={busy || newProject.trim().length === 0}>
              Add project
            </Button>
          </form>
        </Panel>
      </div>
    </PageContainer>
  );
}
