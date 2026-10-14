"use client";

// ---------------------------------------------------------------------------
// Phase 15 — the content calendar.
//
// A PLAN, NOT A SCHEDULER. A date on an item says when it is meant to go out.
// Nothing on this screen — and nothing on the server — publishes an item
// because its date arrived. An item goes out when a person presses Publish on
// it and approves the exact text, or when they post it themselves and say so.
//
// SAVING IS NOT PUBLISHING. "Add to calendar" and "Save" write a draft to
// JARVIS's own store. "Mark ready" says the words are final. Only "Publish"
// reaches a Page, and it opens a confirmation first.
//
// A control is drawn only where it can do something: no editing for a role
// that cannot write, no Publish for a channel this server has no publisher
// for, nothing but a link on an item that is already out.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react";
import { MARKETING_CHANNELS, channelLabel, type ContentItemView, type MarketingCampaignView, type MarketingChannel } from "@jarvis/core/marketing";
import {
  getMarketingCalendar,
  getMarketingContent,
  markMarketingContentPublished,
  planMarketingContent,
  resolveUnconfirmedPublish,
  updateMarketingContent,
  type MarketingCalendar,
  type MarketingStatus,
} from "@/lib/api";
import { Panel } from "@/components/dashboard/panel";
import { EmptyState, ErrorState, LoadingState } from "@/components/dashboard/states";
import { Badge, Button } from "@/components/ui/primitives";
import { PublishPanel } from "./publish-panel";
import {
  CONTENT_STATUS_LABEL,
  CONTENT_STATUS_TONE,
  INPUT_CLASS,
  LABEL_CLASS,
  SELECT_CLASS,
  addDays,
  failureOf,
  formatDay,
  publicationOf,
  todayDate,
} from "./format";

const WINDOW_DAYS = 30;

interface Draft {
  title: string;
  channel: MarketingChannel;
  body: string;
  link: string;
  scheduledDate: string;
  scheduledTime: string;
}

const EMPTY_DRAFT: Draft = { title: "", channel: "FACEBOOK", body: "", link: "", scheduledDate: "", scheduledTime: "" };

export function CalendarTab({
  status,
  projectId,
  campaigns,
}: {
  status: MarketingStatus;
  projectId: string | null;
  campaigns: MarketingCampaignView[];
}) {
  const canEdit = status.caller.canEdit;
  const [from, setFrom] = useState(todayDate);
  const [campaign, setCampaign] = useState("");
  const [calendar, setCalendar] = useState<MarketingCalendar | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editing, setEditing] = useState<{ id: string; draft: Draft } | null>(null);
  const [reporting, setReporting] = useState<{ id: string; url: string } | null>(null);
  /** The item whose unconfirmed publish the user is about to declare not published. */
  const [settling, setSettling] = useState<string | null>(null);
  const [publishing, setPublishing] = useState<ContentItemView | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const to = addDays(from, WINDOW_DAYS - 1);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const response = await getMarketingCalendar({ from, to, projectId, ...(campaign ? { campaign } : {}), limit: 100 });
    if (response.success && response.data) setCalendar(response.data);
    else setError(failureOf(response, "The calendar could not be loaded."));
    setLoading(false);
  }, [from, to, projectId, campaign]);

  useEffect(() => {
    void load();
  }, [load]);

  /** One write to JARVIS's own store. Reports a refusal in the server's words. */
  async function act(run: () => Promise<{ success: boolean; error?: { message?: string } }>, done: string, fallback: string): Promise<boolean> {
    setBusy(true);
    setNotice(null);
    setActionError(null);
    const response = await run();
    setBusy(false);
    if (!response.success) {
      setActionError(failureOf(response, fallback));
      return false;
    }
    setNotice(done);
    await load();
    return true;
  }

  async function add() {
    const saved = await act(
      () =>
        planMarketingContent(
          {
            ...(campaign ? { campaign } : {}),
            items: [
              {
                title: draft.title.trim(),
                channel: draft.channel,
                ...(draft.body.trim() ? { body: draft.body } : {}),
                ...(draft.link.trim() ? { link: draft.link.trim() } : {}),
                ...(draft.scheduledDate ? { scheduledDate: draft.scheduledDate } : {}),
                ...(draft.scheduledDate && draft.scheduledTime ? { scheduledTime: draft.scheduledTime } : {}),
              },
            ],
          },
          projectId
        ),
      "Saved to the calendar as a draft. Nothing was published.",
      "The item could not be saved."
    );
    if (saved) setDraft(EMPTY_DRAFT);
  }

  /**
   * Open an item for editing — from the WHOLE item, read again by its id.
   *
   * The calendar lists previews: a long post arrives cut short. Filling the
   * form from a preview and saving it would replace the saved words with the
   * shortened ones, so the form is only ever filled from the full item.
   */
  async function startEdit(item: ContentItemView) {
    setBusy(true);
    setNotice(null);
    setActionError(null);
    const response = await getMarketingContent(item.id);
    setBusy(false);
    const whole = response.success ? response.data?.item : null;
    if (!whole) {
      setActionError(failureOf(response, "The item could not be opened for editing."));
      return;
    }
    setEditing({
      id: whole.id,
      draft: {
        title: whole.title,
        channel: whole.channel,
        body: whole.body,
        link: whole.link ?? "",
        scheduledDate: whole.scheduledDate ?? "",
        scheduledTime: whole.scheduledTime ?? "",
      },
    });
  }

  async function saveEdit() {
    if (!editing) return;
    const { id, draft: next } = editing;
    const saved = await act(
      () =>
        updateMarketingContent(id, {
          title: next.title.trim(),
          channel: next.channel,
          body: next.body,
          link: next.link.trim() ? next.link.trim() : null,
          scheduledDate: next.scheduledDate || null,
          scheduledTime: next.scheduledDate && next.scheduledTime ? next.scheduledTime : null,
        }),
      "Saved. Nothing was published.",
      "The change could not be saved."
    );
    if (saved) setEditing(null);
  }

  async function reportPosted() {
    if (!reporting) return;
    const { id, url } = reporting;
    const saved = await act(
      () => markMarketingContentPublished(id, url.trim() ? { url: url.trim() } : {}),
      "Recorded as posted by you. JARVIS did not publish it and has not checked that it is live.",
      "That could not be recorded."
    );
    if (saved) setReporting(null);
  }

  const setStatus = (item: ContentItemView, next: "DRAFT" | "READY" | "ARCHIVED", done: string) =>
    act(() => updateMarketingContent(item.id, { status: next }), done, "The status could not be changed.");

  /**
   * The user says an unconfirmed publish did NOT happen. The server looks once
   * more and answers in its own words — which may be that the post IS there.
   */
  async function settleNotPublished(id: string) {
    setBusy(true);
    setNotice(null);
    setActionError(null);
    const response = await resolveUnconfirmedPublish(id);
    setBusy(false);
    if (!response.success || !response.data) {
      setActionError(failureOf(response, "That could not be settled."));
    } else {
      setNotice(response.data.message);
      setSettling(null);
    }
    await load();
  }

  function renderItem(item: ContentItemView) {
    const publication = publicationOf(item);
    const isOut = item.status === "PUBLISHED";
    const publishable = status.publishing.available && status.caller.canPublish && status.publishing.channels.includes(item.channel);
    const isEditing = editing?.id === item.id;
    const isReporting = reporting?.id === item.id;
    const isSettling = settling === item.id;
    // An earlier publish's outcome is not known. The item cannot be changed
    // until that is settled, so none of the controls that change it are drawn.
    const unconfirmed = item.publishUnconfirmed;
    const attempt = unconfirmed ? item.publishAttempt : null;

    return (
      <li key={item.id} data-testid="content-item" data-status={item.status} className="rounded border border-sys-line bg-sys-edge/20 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <p className="mr-auto text-sm font-medium text-sys-text">{item.title}</p>
          {item.scheduledTime && <span className="font-mono text-xs text-sys-dim">{item.scheduledTime}</span>}
          <Badge>{channelLabel(item.channel)}</Badge>
          {publication ? (
            <Badge tone={publication.tone} title={publication.detail}>
              {publication.label}
            </Badge>
          ) : (
            <Badge tone={CONTENT_STATUS_TONE[item.status]}>{CONTENT_STATUS_LABEL[item.status]}</Badge>
          )}
        </div>

        {item.body && <p className="mt-2 whitespace-pre-wrap break-words text-sm text-sys-text/85">{item.body}</p>}
        {item.link && <p className="mt-1 break-all font-mono text-xs text-sys-dim">{item.link}</p>}
        {publication && <p className="mt-2 text-xs text-sys-dim">{publication.detail}</p>}
        {item.publication?.url && (
          <p className="mt-1 break-all font-mono text-xs">
            <a href={item.publication.url} target="_blank" rel="noopener noreferrer" className="sys-focus text-sys-cyan underline">
              {item.publication.url}
            </a>
          </p>
        )}

        {isEditing && editing && (
          <form
            className="mt-3 space-y-3"
            aria-label={`Edit ${item.title}`}
            onSubmit={(event) => {
              event.preventDefault();
              void saveEdit();
            }}
          >
            {item.status === "READY" && (
              <p className="text-xs text-amber-300">This item is marked ready. Changing its words returns it to a draft, and it must be marked ready again.</p>
            )}
            <DraftFields draft={editing.draft} onChange={(next) => setEditing({ id: item.id, draft: next })} idPrefix={`edit-${item.id}`} />
            <div className="flex gap-2">
              <Button type="submit" variant="primary" size="sm" disabled={busy || editing.draft.title.trim().length === 0}>
                Save
              </Button>
              <Button size="sm" onClick={() => setEditing(null)} disabled={busy}>
                Cancel
              </Button>
            </div>
          </form>
        )}

        {isReporting && reporting && (
          <form
            className="mt-3 space-y-3"
            aria-label={`Record ${item.title} as posted`}
            onSubmit={(event) => {
              event.preventDefault();
              void reportPosted();
            }}
          >
            <p className="text-xs text-sys-dim">
              Use this when YOU have posted it yourself. It is recorded as reported by you: JARVIS will not have published it and will not check it.
            </p>
            <label className={LABEL_CLASS}>
              <span>Link to the post (optional)</span>
              <input
                value={reporting.url}
                onChange={(event) => setReporting({ id: item.id, url: event.target.value })}
                placeholder="https://"
                className={INPUT_CLASS}
              />
            </label>
            <div className="flex gap-2">
              <Button type="submit" variant="primary" size="sm" disabled={busy}>
                Record as posted
              </Button>
              <Button size="sm" onClick={() => setReporting(null)} disabled={busy}>
                Cancel
              </Button>
            </div>
          </form>
        )}

        {unconfirmed && (
          <p data-testid="unconfirmed-note" className="mt-2 text-xs text-amber-300">
            An earlier attempt to publish this was sent{attempt?.targetName ? ` to ${attempt.targetName}` : ""} and its outcome is not known. It is not
            marked as published, it cannot be edited, and nothing more is sent for it until this is settled.
            {attempt?.lastLookup?.result === "NOT_FOUND" && " JARVIS has looked for the post on the Page and did not find it."}
            {attempt?.lastLookup?.result === "TEXT_MISMATCH" && " JARVIS found a post from that attempt on the Page, but could not confirm its text is this item's text."}
          </p>
        )}

        {isSettling && (
          <form
            className="mt-3 space-y-3"
            aria-label={`Settle the publish of ${item.title}`}
            onSubmit={(event) => {
              event.preventDefault();
              void settleNotPublished(item.id);
            }}
          >
            <p className="text-xs text-sys-dim">
              Use this only after you have looked at the Page yourself and the post is not there. JARVIS will look once more: if it finds the post, the
              item is recorded as published instead. If it does not, the earlier attempt is cleared and the item can be published again — and
              publishing it again will post it.
            </p>
            <div className="flex gap-2">
              <Button type="submit" variant="primary" size="sm" disabled={busy}>
                It was not published — check and clear
              </Button>
              <Button size="sm" onClick={() => setSettling(null)} disabled={busy}>
                Cancel
              </Button>
            </div>
          </form>
        )}

        {/* An unconfirmed item offers only the three ways to settle it. Edit, Back to draft and Archive would all be refused. */}
        {canEdit && !isOut && unconfirmed && !isReporting && !isSettling && (
          <div className="mt-3 flex flex-wrap gap-2">
            {item.status === "READY" && publishable && (
              <Button size="sm" variant="primary" onClick={() => setPublishing(item)} disabled={busy || publishing !== null}>
                Look for the post
              </Button>
            )}
            <Button size="sm" onClick={() => setReporting({ id: item.id, url: "" })} disabled={busy || publishing !== null}>
              I posted this myself
            </Button>
            {status.publishing.available && status.caller.canResolve && (
              <Button size="sm" onClick={() => setSettling(item.id)} disabled={busy || publishing !== null}>
                It was not published
              </Button>
            )}
          </div>
        )}

        {/* A published item is a record. It has no controls, because none could do anything. */}
        {canEdit && !isOut && !unconfirmed && !isEditing && !isReporting && (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void startEdit(item)} disabled={busy || publishing !== null}>
              Edit
            </Button>
            {item.status === "READY" ? (
              <Button size="sm" onClick={() => void setStatus(item, "DRAFT", "Back to a draft.")} disabled={busy || publishing !== null}>
                Back to draft
              </Button>
            ) : (
              item.body.trim().length > 0 && (
                <Button size="sm" onClick={() => void setStatus(item, "READY", "Marked ready. It has not been published.")} disabled={busy || publishing !== null}>
                  Mark ready
                </Button>
              )
            )}
            {item.status === "READY" && publishable && (
              <Button size="sm" variant="primary" onClick={() => setPublishing(item)} disabled={busy || publishing !== null}>
                Publish
              </Button>
            )}
            <Button size="sm" onClick={() => setReporting({ id: item.id, url: "" })} disabled={busy || publishing !== null}>
              I posted this myself
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void setStatus(item, "ARCHIVED", "Archived. It is kept, and off the calendar.")} disabled={busy || publishing !== null}>
              Archive
            </Button>
          </div>
        )}

        {/* Said, not left as a missing button: why this ready item has no Publish. */}
        {canEdit && item.status === "READY" && !publishable && (
          <p className="mt-2 text-xs text-sys-dim">
            {!status.publishing.available
              ? "JARVIS cannot publish from this server. Post it yourself, then record it here."
              : !status.publishing.channels.includes(item.channel)
                ? `JARVIS cannot publish to ${channelLabel(item.channel)}. Post it yourself, then record it here.`
                : "Your role cannot publish."}
          </p>
        )}
      </li>
    );
  }

  const days = calendar?.days.filter((entry) => entry.items.length > 0) ?? [];
  const unscheduled = calendar?.unscheduled ?? [];
  const empty = calendar !== null && days.length === 0 && unscheduled.length === 0;

  return (
    <div className="space-y-6">
      {notice && (
        <p role="status" className="rounded border border-sys-ok/35 bg-sys-ok/10 px-3 py-2 text-sm text-sys-text">
          {notice}
        </p>
      )}
      {actionError && <ErrorState title="That did not go through" message={actionError} />}

      {publishing && (
        <PublishPanel
          item={publishing}
          onClose={() => {
            setPublishing(null);
            void load();
          }}
          onChanged={() => void load()}
        />
      )}

      {canEdit && (
        <Panel title="Add to the calendar" description="Saved as a draft in JARVIS. Nothing is published by saving.">
          <form
            className="space-y-3"
            aria-label="Add content"
            onSubmit={(event) => {
              event.preventDefault();
              void add();
            }}
          >
            <DraftFields draft={draft} onChange={setDraft} idPrefix="new" />
            <Button type="submit" variant="primary" disabled={busy || draft.title.trim().length === 0}>
              Add to calendar
            </Button>
          </form>
        </Panel>
      )}

      <Panel
        title="Content calendar"
        description={`${formatDay(from)} to ${formatDay(to)}. A date is a plan — nothing is published because a date arrives.`}
        action={
          <div className="flex gap-2">
            <Button size="sm" onClick={() => setFrom(addDays(from, -WINDOW_DAYS))} disabled={loading}>
              Earlier
            </Button>
            <Button size="sm" onClick={() => setFrom(todayDate())} disabled={loading}>
              Today
            </Button>
            <Button size="sm" onClick={() => setFrom(addDays(from, WINDOW_DAYS))} disabled={loading}>
              Later
            </Button>
          </div>
        }
      >
        {campaigns.length > 0 && (
          <label className="mb-4 flex items-center gap-2 text-sm text-sys-dim">
            <span>Campaign</span>
            <select aria-label="Campaign" value={campaign} onChange={(event) => setCampaign(event.target.value)} className={SELECT_CLASS}>
              <option value="">All campaigns</option>
              {campaigns.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {loading && !calendar && <LoadingState lines={4} />}
        {error && <ErrorState message={error} onRetry={() => void load()} />}
        {!error && empty && (
          <EmptyState
            title="Nothing planned in these thirty days"
            message={canEdit ? "Add an item above, or ask JARVIS in chat to plan and save a week of posts." : "Nothing has been planned for this period."}
          />
        )}

        <div className="space-y-5">
          {days.map((entry) => (
            <section key={entry.date} aria-label={formatDay(entry.date)} data-testid="calendar-day">
              <h3 className="mb-2 font-mono text-xs uppercase tracking-hud text-sys-dim">{formatDay(entry.date)}</h3>
              <ul className="space-y-3">{entry.items.map(renderItem)}</ul>
            </section>
          ))}

          {unscheduled.length > 0 && (
            <section aria-label="No date yet" data-testid="calendar-unscheduled">
              <h3 className="mb-2 font-mono text-xs uppercase tracking-hud text-sys-dim">No date yet</h3>
              <ul className="space-y-3">{unscheduled.map(renderItem)}</ul>
            </section>
          )}
        </div>

        {calendar?.truncated && (
          <p className="mt-4 text-xs text-sys-dim">
            Showing {days.reduce((sum, entry) => sum + entry.items.length, 0) + unscheduled.length} of {calendar.total} items. Narrow it with a campaign to see the rest.
          </p>
        )}
      </Panel>
    </div>
  );
}

function DraftFields({ draft, onChange, idPrefix }: { draft: Draft; onChange: (next: Draft) => void; idPrefix: string }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <label className={`${LABEL_CLASS} sm:col-span-2`} htmlFor={`${idPrefix}-title`}>
        <span>Title</span>
        <input
          id={`${idPrefix}-title`}
          value={draft.title}
          onChange={(event) => onChange({ ...draft, title: event.target.value })}
          maxLength={160}
          placeholder="What this post is"
          className={INPUT_CLASS}
        />
      </label>
      <label className={`${LABEL_CLASS} sm:col-span-2`} htmlFor={`${idPrefix}-body`}>
        <span>Text — exactly what would be posted</span>
        <textarea
          id={`${idPrefix}-body`}
          value={draft.body}
          onChange={(event) => onChange({ ...draft, body: event.target.value })}
          rows={3}
          maxLength={5000}
          placeholder="Leave empty to save it as an idea"
          className={INPUT_CLASS}
        />
      </label>
      <label className={LABEL_CLASS} htmlFor={`${idPrefix}-channel`}>
        <span>Channel</span>
        <select
          id={`${idPrefix}-channel`}
          value={draft.channel}
          onChange={(event) => onChange({ ...draft, channel: event.target.value as MarketingChannel })}
          className={`${SELECT_CLASS} w-full`}
        >
          {MARKETING_CHANNELS.map((channel) => (
            <option key={channel} value={channel}>
              {channelLabel(channel)}
            </option>
          ))}
        </select>
      </label>
      <label className={LABEL_CLASS} htmlFor={`${idPrefix}-link`}>
        <span>Link (optional)</span>
        <input
          id={`${idPrefix}-link`}
          value={draft.link}
          onChange={(event) => onChange({ ...draft, link: event.target.value })}
          placeholder="https://"
          className={INPUT_CLASS}
        />
      </label>
      <label className={LABEL_CLASS} htmlFor={`${idPrefix}-date`}>
        <span>Planned for (optional)</span>
        <input
          id={`${idPrefix}-date`}
          type="date"
          value={draft.scheduledDate}
          onChange={(event) => onChange({ ...draft, scheduledDate: event.target.value })}
          className={INPUT_CLASS}
        />
      </label>
      <label className={LABEL_CLASS} htmlFor={`${idPrefix}-time`}>
        <span>Time of day (a note, not a timer)</span>
        <input
          id={`${idPrefix}-time`}
          type="time"
          value={draft.scheduledTime}
          onChange={(event) => onChange({ ...draft, scheduledTime: event.target.value })}
          disabled={!draft.scheduledDate}
          className={INPUT_CLASS}
        />
      </label>
    </div>
  );
}
