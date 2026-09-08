"use client";

// ---------------------------------------------------------------------------
// UI V2 — the command centre.
//
// This IS the dashboard now. The Orb, one input, one status line, and — only
// when something is genuinely waiting on a human — one approval panel.
//
// The counts, KPIs and charts that used to sit under the Orb have not been
// deleted; they live in the pages they belong to (/approvals, /opportunities,
// /knowledge, /meta-ads), reachable from the sidebar. A command centre answers
// "what should I do now"; a BI dashboard answers "what happened", and stacking
// nine cards under the Orb made the screen the second thing while pretending
// to be the first.
//
// EVERYTHING SHOWN IS OBSERVED. The status line reads the real chat store and
// the real voice state machine. The approval panel is populated from
// GET /api/v1/approvals and renders the EXISTING ApprovalCard, so the decision
// runs through the same audited endpoints as the approvals page — there is no
// second approval path, which is the only way the "voice can never approve"
// rule stays true.
//
// It does not own a second chat pipeline either. Submitting calls the SAME
// `useChatStore.sendMessage` the assistant page uses, so agent routing, memory,
// tool allowlists, approvals and audit stay in one place.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp, ShieldAlert } from "lucide-react";
import {
  getCapabilities,
  listApprovals,
  type ApprovalRecord,
  type CommandCenterCapabilities,
} from "@/lib/api";
import { useDashboardLayout } from "@/lib/use-dashboard-layout";
import { AttachButton, AttachmentList, type AttachedFile } from "./attach-button";
import {
  COL_SPAN,
  ROW_SPAN,
  visibleWidgets,
  type WidgetId,
  type WidgetPlacement,
} from "@/components/widgets/layout";
import { WidgetFrame } from "@/components/widgets/widget-frame";
import { CustomizeBar, WIDGET_LABELS } from "@/components/widgets/customize-bar";
import { WorldClockWidget } from "@/components/widgets/world-clock-widget";
import { ClockWidget } from "@/components/widgets/clock-widget";
import { WeatherWidget } from "@/components/widgets/weather-widget";
import { SystemWidget } from "@/components/widgets/system-widget";
import { TasksWidget } from "@/components/widgets/tasks-widget";
import { MarketsWidget } from "@/components/widgets/markets-widget";
import { MapWidget } from "@/components/widgets/map-widget";
import { useChatStore } from "@/lib/chat-store";
import { useVoiceStore } from "@/lib/voice/voice-store";
import { MicButton } from "@/components/voice/mic-button";
import { ApprovalCard } from "@/components/approval-card";
import { JarvisOrb } from "@/components/orb/jarvis-orb";

/** The most recent assistant turn, for the status readout. */
function useLatestAssistant(): string | null {
  const messages = useChatStore((s) => s.messages);
  return useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role === "assistant" && m.content.trim()) return m.content;
    }
    return null;
  }, [messages]);
}

/**
 * Whether the CURRENT CONVERSATION has a write parked on a human decision.
 *
 * Read from the conversation's own messages, the same source the voice store
 * consults, so the Orb and the voice approval rule can never disagree.
 */
function useConversationPendingAction(): boolean {
  const messages = useChatStore((s) => s.messages);
  return useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!m || m.role !== "assistant") continue;
      const pending = (m.metadata as Record<string, unknown> | undefined)?.pendingAction as
        | { state?: string }
        | undefined;
      if (pending) return pending.state === "WAITING_CONFIRMATION";
    }
    return false;
  }, [messages]);
}

export function CommandCenter() {
  const router = useRouter();
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  const sending = useChatStore((s) => s.sending);
  const chatError = useChatStore((s) => s.error);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const voiceState = useVoiceStore((s) => s.state);
  const voiceNotice = useVoiceStore((s) => s.notice);
  const checkVoice = useVoiceStore((s) => s.checkAvailability);

  const latestReply = useLatestAssistant();
  const conversationPending = useConversationPendingAction();

  // ---------------------------------------------------------------------------
  // Pending approvals.
  //
  // Fetched rather than inferred: an approval can be raised by a background
  // worker or in another tab, and the operator needs to see it here even if
  // this conversation knows nothing about it.
  // ---------------------------------------------------------------------------
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);

  const loadApprovals = useCallback(async () => {
    const res = await listApprovals("pending", 1, 3);
    // A failure leaves the previous list alone. Blanking the panel on a
    // transient network error would hide a decision that is still waiting.
    if (res.success && Array.isArray(res.data)) setApprovals(res.data);
  }, []);

  useEffect(() => {
    void loadApprovals();
  }, [loadApprovals]);

  // Re-check when a turn finishes: that is when a new approval is most likely
  // to have appeared.
  useEffect(() => {
    if (!sending) void loadApprovals();
  }, [sending, loadApprovals]);

  useEffect(() => {
    void checkVoice();
  }, [checkVoice]);

  // ---------------------------------------------------------------------------
  // Widgets and layout.
  //
  // Capabilities decide what CAN render; the saved layout decides order, size
  // and visibility. Both load once — this is a dashboard, not a feed.
  // ---------------------------------------------------------------------------
  const [capabilities, setCapabilities] = useState<CommandCenterCapabilities | null>(null);
  const [attachments, setAttachments] = useState<AttachedFile[]>([]);
  const dash = useDashboardLayout();

  useEffect(() => {
    void (async () => {
      const caps = await getCapabilities();
      if (caps.success && caps.data) setCapabilities(caps.data);
    })();
  }, []);

  const prefs = dash.preferences;

  // Visible widgets, minus the Orb — it is rendered as its own grid cell rather
  // than through the generic widget switch, because it is the hero and owns the
  // prompt and composer beneath it.
  const gridWidgets = useMemo(
    () => visibleWidgets(dash.layout).filter((p) => p.id !== "orb"),
    [dash.layout]
  );

  // The Orb is always present — `normalizeLayout` guarantees it — but the
  // fallback keeps the type honest rather than asserting non-null.
  const orbPlacement: WidgetPlacement = useMemo(
    () => dash.layout.find((p) => p.id === "orb") ?? { id: "orb", size: { w: 2, h: 3 } },
    [dash.layout]
  );

  const visibleOrder = useMemo(() => visibleWidgets(dash.layout), [dash.layout]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setDraft("");
    await sendMessage(text);
  };

  const awaitingApproval = approvals.length > 0 || conversationPending;

  // What the Orb expresses beyond the voice turn itself.
  const status = useMemo(
    () => ({
      thinking: sending,
      awaitingApproval,
      failed: Boolean(chatError),
    }),
    [sending, awaitingApproval, chatError]
  );

  // One line, and only ever about something that is actually true.
  const readout = (() => {
    if (chatError) return { label: "Error", text: chatError, tone: "error" as const };
    if (awaitingApproval)
      return {
        label: "Approval required",
        text: "An action is waiting for your decision. Voice cannot approve it — confirm below.",
        tone: "warn" as const,
      };
    if (sending) return { label: "Working", text: "Routing your request through the agent stack…", tone: "busy" as const };
    if (voiceState === "transcribing") return { label: "Transcribing", text: "Converting speech to text…", tone: "busy" as const };
    if (voiceState === "listening") return { label: "Listening", text: "Go ahead — tap the microphone again when you're done.", tone: "busy" as const };
    if (voiceState === "speaking") return { label: "Speaking", text: "Reading the reply aloud.", tone: "busy" as const };
    if (voiceNotice) return { label: "Voice", text: voiceNotice.message, tone: voiceNotice.benign ? ("idle" as const) : ("warn" as const) };
    if (latestReply) return { label: "Last reply", text: latestReply, tone: "idle" as const };
    return { label: "Ready", text: "Ask a question, or tap the microphone to speak.", tone: "idle" as const };
  })();

  const toneClass = {
    idle: "text-sys-text/70",
    busy: "text-sys-cyan-soft",
    warn: "text-amber-300/90",
    error: "text-red-300/90",
  }[readout.tone];

  /** One widget, by id. Kept as a function so the grid below stays readable. */
  function renderWidget(id: WidgetId) {
    switch (id) {
      case "clock":
        return (
          <ClockWidget
            mode={prefs.clockMode ?? "DIGITAL"}
            hourFormat={prefs.hourFormat ?? "24"}
            onToggleMode={(clockMode) => dash.updatePreferences({ clockMode })}
          />
        );
      case "worldclock":
        return <WorldClockWidget hourFormat={prefs.hourFormat ?? "24"} />;
      case "weather":
        return (
          <WeatherWidget
            location={prefs.weatherLocation ?? null}
            onLocationDetected={(coords) => dash.updatePreferences({ weatherLocation: coords })}
          />
        );
      case "system":
        return <SystemWidget />;
      case "tasks":
        return <TasksWidget />;
      case "markets":
        return <MarketsWidget indicesEnabled={capabilities?.indices ?? false} />;
      case "map":
        return <MapWidget />;
      default:
        return null;
    }
  }

  return (
    <section
      data-testid="command-center"
      aria-label="JARVIS command centre"
      className="relative flex w-full flex-col items-center px-4 py-5"
    >
      {/*
        Atmosphere, in its own clipping wrapper.

        The glow is inset NEGATIVELY so its blur has room to fall off, which
        without clipping extends the page past the viewport and reintroduces
        horizontal scrolling. It is clipped HERE rather than on the section
        because `overflow-x: hidden` cannot coexist with visible overflow-y —
        CSS promotes the other axis to `auto`, which would turn the whole
        command centre into a nested scroll container with its own scrollbar.
      */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
        <div className="orb-atmosphere" />
      </div>

      <CustomizeBar
        customizing={dash.customizing}
        dirty={dash.dirty}
        saving={dash.saving}
        layout={dash.layout}
        onToggle={() => dash.setCustomizing(!dash.customizing)}
        onSetHidden={dash.setHidden}
        onSave={() => void dash.save()}
        onReset={dash.reset}
      />

      {/* ---- The command centre grid ---------------------------------------
          Four columns on a large screen, two on a tablet, one on a phone. The
          Orb is a CELL like any other — which is what puts the widgets around
          it rather than stacked underneath, and what lets it be resized.

          Dense auto-flow means the browser packs the cells: no collision
          maths, no holes, and it reflows correctly at every breakpoint without
          storing a second layout per screen size.
      */}
      <div
        data-testid="command-grid"
        className="relative grid w-full max-w-6xl grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 lg:[grid-auto-flow:dense] lg:[grid-auto-rows:9.5rem]"
      >
        {/* ---- Orb cell ---- */}
        <WidgetFrame
          placement={orbPlacement}
          label={WIDGET_LABELS.orb}
          customizing={dash.customizing}
          index={visibleOrder.findIndex((p) => p.id === "orb")}
          total={visibleOrder.length}
          onMove={(d) => dash.move("orb", d)}
          onResize={(delta) => dash.resize("orb", delta)}
          onHide={() => undefined}
          onDropOn={(sourceId) => dash.dropOn(sourceId, "orb")}
          className={`sm:col-span-2 ${COL_SPAN[orbPlacement.size.w]} ${ROW_SPAN[orbPlacement.size.h]}`}
        >
          <div className="flex h-full flex-col items-center justify-center">
            <JarvisOrb
              status={status}
              showCaption={false}
              className="w-[min(17rem,62vw)] sm:w-[min(20rem,42vw)] lg:w-[min(22rem,26vw)]"
            />

            <h1 className="mt-2 text-center text-lg font-light tracking-tight text-white/90 sm:text-xl">
              How can I help?
            </h1>

            <div className="mt-2 min-h-[2.5rem] w-full max-w-xl text-center">
              <p className="font-mono text-[0.5rem] uppercase tracking-hud text-sys-dim/70">
                {readout.label}
              </p>
              <p
                data-testid="command-readout"
                role="status"
                aria-live="polite"
                className={`mt-0.5 line-clamp-2 text-[0.8rem] ${toneClass}`}
              >
                {readout.text}
              </p>
            </div>

            {/* ---- Compact command bar ---- */}
            <form onSubmit={submit} className="mt-2 w-full max-w-xl">
              <AttachmentList
                attachments={attachments}
                onRemove={(id) => setAttachments((prev) => prev.filter((a) => a.id !== id))}
              />

              <div className="glass-panel glass-edge flex items-center gap-1 rounded-full py-1.5 pl-2 pr-2 transition-colors focus-within:border-sys-cyan/40">
                {/* Uploads go through the EXISTING knowledge pipeline, so an
                    attachment becomes a retrievable, citable document rather
                    than one-shot context for the next message. */}
                <AttachButton attachments={attachments} onChange={setAttachments} disabled={sending} />

                <label htmlFor="command-input" className="sr-only">
                  Message JARVIS
                </label>
                <input
                  id="command-input"
                  ref={inputRef}
                  data-testid="command-input"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Ask JARVIS…"
                  autoComplete="off"
                  disabled={sending}
                  className="min-w-0 flex-1 bg-transparent text-[0.82rem] text-white placeholder:text-sys-dim/70 focus:outline-none disabled:opacity-60"
                />

                <MicButton />

                <button
                  type="submit"
                  data-testid="command-send"
                  disabled={!draft.trim() || sending}
                  aria-label="Send message"
                  className="sys-focus flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sys-cyan/15 text-sys-cyan transition-colors enabled:hover:bg-sys-cyan/25 disabled:opacity-35"
                >
                  <ArrowUp size={15} aria-hidden="true" />
                </button>
              </div>

              <p className="mt-1.5 text-center font-mono text-[0.45rem] uppercase tracking-hud text-sys-dim/50">
                Enter to send · tap the mic to speak
                {latestReply ? (
                  <>
                    {" · "}
                    <button
                      type="button"
                      onClick={() => router.push("/chat")}
                      className="sys-focus underline decoration-dotted underline-offset-2 hover:text-sys-dim"
                    >
                      Full conversation
                    </button>
                  </>
                ) : null}
              </p>
            </form>
          </div>
        </WidgetFrame>

        {/* ---- Everything else ---- */}
        {gridWidgets.map((placement) => (
          <WidgetFrame
            key={placement.id}
            placement={placement}
            label={WIDGET_LABELS[placement.id]}
            customizing={dash.customizing}
            index={visibleOrder.findIndex((p) => p.id === placement.id)}
            total={visibleOrder.length}
            onMove={(d) => dash.move(placement.id, d)}
            onResize={(delta) => dash.resize(placement.id, delta)}
            onHide={() => dash.setHidden(placement.id, true)}
            onDropOn={(sourceId) => dash.dropOn(sourceId, placement.id)}
            className={`${COL_SPAN[placement.size.w]} ${ROW_SPAN[placement.size.h]} min-w-0`}
          >
            <div className="h-full [&>section]:h-full">{renderWidget(placement.id)}</div>
          </WidgetFrame>
        ))}
      </div>

      {/* ---- Approval ------------------------------------------------------
          Below the grid, full width, and only when something is genuinely
          waiting. It is the one thing that BLOCKS on the person looking at the
          screen, so it is never a widget that could be hidden.

          ApprovalCard is the existing component from the approvals page —
          reused, not reimplemented, so approve/reject go through the same
          audited endpoints with the same expiry and conflict handling.
      */}
      {approvals.length > 0 && (
        <div
          data-testid="command-approvals"
          className="relative mt-4 w-full max-w-3xl space-y-2"
          aria-label="Actions awaiting your approval"
        >
          <div className="flex items-center justify-center gap-2 text-amber-300/90">
            <ShieldAlert size={14} aria-hidden="true" />
            <p className="font-mono text-[0.55rem] uppercase tracking-hud">
              Action requires approval
            </p>
          </div>

          {approvals.map((approval) => (
            <ApprovalCard
              key={approval.approvalId}
              approval={approval}
              onChanged={() => void loadApprovals()}
            />
          ))}

          <p className="text-center font-mono text-[0.5rem] uppercase tracking-hud text-sys-dim/60">
            Voice can never approve an action ·{" "}
            <button
              type="button"
              onClick={() => router.push("/approvals")}
              className="sys-focus underline decoration-dotted underline-offset-2 hover:text-sys-dim"
            >
              All approvals
            </button>
          </p>
        </div>
      )}
    </section>
  );
}

