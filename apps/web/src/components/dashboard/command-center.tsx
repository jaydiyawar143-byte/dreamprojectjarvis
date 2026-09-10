"use client";

// ---------------------------------------------------------------------------
// V4 — the command centre.
//
// This IS the dashboard: a bounded workspace of widgets the user arranges by
// hand, with the Orb among them and one command bar anchored beneath.
//
// The counts, KPIs and charts that used to sit under the Orb have not been
// deleted; they live in the pages they belong to (/approvals, /opportunities,
// /knowledge, /meta-ads), reachable from the sidebar. A command centre answers
// "what should I do now"; a BI dashboard answers "what happened".
//
// EVERYTHING SHOWN IS OBSERVED. The status line reads the real chat store and
// the real voice state machine. The approval panel is populated from
// GET /api/v1/approvals and renders the EXISTING ApprovalCard, so the decision
// runs through the same audited endpoints as the approvals page. It does not
// own a second chat pipeline either — submitting calls the SAME
// `useChatStore.sendMessage` the assistant page uses.
//
// ---------------------------------------------------------------------------
// THE LAYOUT, AND WHY THE PAGE CANNOT SCROLL.
//
// Three bands, in a column pinned to the height the shell gives it:
//
//     CustomizeBar   shrink-0    natural height
//     workspace      flex-1      whatever is left  <- the grid lives here
//     command bar    shrink-0    natural height
//     approvals      shrink-0    only when something is waiting, capped
//
// The workspace is MEASURED, and the grid's row height is then derived from it:
// however many rows the arrangement needs, they always add up to exactly the
// space available. That is what makes a page scrollbar structurally impossible
// rather than merely absent — not a rule that the grid must not grow, but an
// arithmetic in which growing costs row HEIGHT instead of overflow. Nothing
// here clips anything; there is no overflow to clip.
//
// The shipped layout needs twelve rows and fills them. A drag that displaces
// widgets can push the arrangement to fourteen, and then there are fourteen
// shorter rows — see MAX_ROWS in widgets/layout.ts for why that beats the two
// alternatives (refusing every drop, or scrolling the workspace).
//
// WHY THE COMMAND BAR IS ITS OWN BAND AND NOT PART OF THE ORB.
//
// It used to live inside the Orb widget. That was fine when the Orb's size came
// from a fixed grid, and became a bug the moment the user could drag the Orb's
// corner: shrinking the hero would have squeezed the composer — the one control
// on this screen that must always be usable — until it was unreachable. Pulling
// it out of the grid means no arrangement the user can build can take the
// command bar away, and it also stops the composer's height participating in
// the grid's height at all.
// ---------------------------------------------------------------------------

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import GridLayout, { type Layout } from "react-grid-layout";
import { ArrowUp, ShieldAlert } from "lucide-react";
import {
  getCapabilities,
  listApprovals,
  type ApprovalRecord,
  type CommandCenterCapabilities,
} from "@/lib/api";
import { useDashboardLayout } from "@/lib/use-dashboard-layout";
import { useSurfaceStore } from "@/lib/surface-store";
import { AttachButton, AttachmentList, type AttachedFile } from "./attach-button";
import {
  GRID_COLS,
  CONSTRAINTS,
  clampToColumns,
  gridRowHeight,
  MAX_ROWS,
  layoutRows,
  visibleWidgets,
  type WidgetId,
  type WidgetPlacement,
} from "@/components/widgets/layout";
import { WidgetFrame, DRAG_HANDLE_CLASS } from "@/components/widgets/widget-frame";
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

/** Gap between cells, in px. Also the grid's own outer padding is zero. */
const CELL_MARGIN = 10;

/**
 * Below this the 12-column grid stops being usable — a cell would be ~30px —
 * so the dashboard stacks instead and the grid is not rendered at all.
 */
const GRID_MIN_WIDTH = 1024;

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

/**
 * The workspace's real size.
 *
 * The grid needs a definite width and height in pixels — it positions in px,
 * not percentages — and both are "whatever is left after the chrome", which
 * only the browser knows. `useLayoutEffect` so the first paint already has the
 * measurement and the widgets do not visibly jump into place.
 */
function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const read = () =>
      setSize((prev) => {
        const width = el.clientWidth;
        const height = el.clientHeight;
        // Sub-pixel churn from the sidebar's hover transition would otherwise
        // re-render every widget several times a frame.
        if (Math.abs(prev.width - width) < 1 && Math.abs(prev.height - height) < 1) return prev;
        return { width, height };
      });

    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, size] as const;
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
  // Capabilities decide what CAN render; the saved layout decides position,
  // size and visibility. Both load once — this is a dashboard, not a feed.
  // ---------------------------------------------------------------------------
  const [capabilities, setCapabilities] = useState<CommandCenterCapabilities | null>(null);
  const [attachments, setAttachments] = useState<AttachedFile[]>([]);
  const dash = useDashboardLayout();
  const [workspaceRef, workspace] = useElementSize<HTMLDivElement>();

  useEffect(() => {
    void (async () => {
      const caps = await getCapabilities();
      if (caps.success && caps.data) setCapabilities(caps.data);
    })();
  }, []);

  const prefs = dash.preferences;
  const visible = useMemo(() => visibleWidgets(dash.layout), [dash.layout]);

  // ---------------------------------------------------------------------------
  // The grid's geometry, derived from the measured workspace.
  //
  // `rowHeight` is the whole trick. Twelve rows plus eleven gaps must come to no
  // more than the height available, so the row height is that height divided
  // back out — and floored, because a fractional row height rounded UP is
  // exactly how a layout ends up one pixel taller than its container.
  // ---------------------------------------------------------------------------
  const useGrid = workspace.width >= GRID_MIN_WIDTH && workspace.height > 0;

  // How many rows THIS arrangement ACTUALLY needs — twelve for the shipped
  // layout, more while a drag has displaced widgets downward.
  //
  // Not capped. Capping it was a bug: the library does not honour `maxRows`
  // during compaction, so a capped count computed a row height for a shallower
  // layout than the one being rendered, and the bottom widgets hung out of the
  // workspace. Taking the real depth is what keeps the arithmetic true.
  const rows = useMemo(() => layoutRows(dash.layout), [dash.layout]);

  const rowHeight = useMemo(
    () => (useGrid ? gridRowHeight(workspace.height, CELL_MARGIN, rows) : 0),
    [useGrid, workspace.height, rows]
  );

  const colWidth = useGrid
    ? (workspace.width - CELL_MARGIN * (GRID_COLS - 1)) / GRID_COLS
    : 0;

  // What react-grid-layout is handed. Hidden widgets are simply not present.
  const rglLayout: Layout[] = useMemo(
    () =>
      visible.map((p) => ({
        i: p.id,
        x: p.x,
        y: p.y,
        w: p.w,
        h: p.h,
        minW: CONSTRAINTS[p.id].minW,
        minH: CONSTRAINTS[p.id].minH,
        maxW: CONSTRAINTS[p.id].maxW,
        maxH: CONSTRAINTS[p.id].maxH,
      })),
    [visible]
  );

  const onLayoutChange = useCallback(
    (next: Layout[]) => {
      // Horizontal bounds and size limits are re-applied on the way in rather
      // than trusted — they must hold even if the library is misconfigured,
      // upgraded or swapped out. The ROW is deliberately taken as given: see
      // clampToColumns for why clamping it here makes widgets fall out of the
      // workspace instead of keeping them in it.
      dash.applyLayout(
        next.map((l) => clampToColumns({ id: l.i as WidgetId, x: l.x, y: l.y, w: l.w, h: l.h }))
      );
    },
    [dash]
  );

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setDraft("");
    await sendMessage(text);
  };

  // ---------------------------------------------------------------------------
  // Surface actions.
  //
  // "Alternatives", "Analyse", "Retry" are PHRASES, not function calls. Each
  // one is sent through `sendMessage` — the same path the composer uses — so a
  // button on a panel reaches the orchestrator, the permission checks and the
  // approval gate exactly as if the user had typed it. There is deliberately no
  // route from a surface control to a tool that skips any of that.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const onSurfaceIntent = (event: Event) => {
      const intent = (event as CustomEvent<{ intent?: string }>).detail?.intent;
      if (typeof intent === "string" && intent.trim()) void sendMessage(intent.trim());
    };
    window.addEventListener("jarvis:surface-intent", onSurfaceIntent);
    return () => window.removeEventListener("jarvis:surface-intent", onSurfaceIntent);
  }, [sendMessage]);

  // The surface layer needs to know when the dashboard is being rearranged, so
  // it can stop animating and stop retiring panels mid-drag. This is the ONLY
  // thing the two systems tell each other — no layout is shared, and a surface
  // still cannot read or move a widget.
  useEffect(() => {
    useSurfaceStore.getState().setDashboardCustomizing(dash.customizing);
  }, [dash.customizing]);

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
      case "orb":
        return <OrbWidget status={status} label={readout.label} text={readout.text} tone={toneClass} />;
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

  /** A widget inside its frame, used by both the grid and the stacked fallback. */
  const framed = (p: WidgetPlacement) => (
    <WidgetFrame
      placement={p}
      label={WIDGET_LABELS[p.id]}
      customizing={dash.customizing}
      onNudge={(dx, dy) => dash.nudge(p.id, dx, dy)}
      onResizeBy={(dw, dh) => dash.resizeBy(p.id, dw, dh)}
      onHide={() => dash.setHidden(p.id, true)}
    >
      <div className="h-full min-h-0 w-full [&>section]:h-full">{renderWidget(p.id)}</div>
    </WidgetFrame>
  );

  return (
    <section
      data-testid="command-center"
      aria-label="JARVIS command centre"
      className="relative flex h-full min-h-0 w-full flex-col px-3 py-2.5"
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

      {/* ---- The workspace -------------------------------------------------
          The bounded surface the widgets live inside. It takes the height the
          column has left (`flex-1` + `min-h-0`) and the full width after the
          sidebar — no `max-width`, so a 1920px screen gets a ~1840px dashboard
          rather than 1152px in the middle of one.

          It does not scroll on desktop, because the grid inside it is sized to
          fit exactly. Below the grid's minimum width it becomes a stacked
          column, and THEN it scrolls — inside itself, never the page.
      */}
      <div
        ref={workspaceRef}
        data-testid="command-workspace"
        data-mode={useGrid ? "grid" : "stacked"}
        className={`relative min-h-0 flex-1 ${
          useGrid ? "overflow-hidden" : "overflow-y-auto overflow-x-hidden"
        }`}
      >
        {/* Grid guides. Customise mode only — the clean dashboard shows no
            spreadsheet. The cell size is dynamic, so it is handed to CSS as
            custom properties rather than hard-coded in the stylesheet. */}
        {useGrid && dash.customizing && (
          <div
            aria-hidden="true"
            data-testid="grid-guides"
            className="jarvis-grid-guides pointer-events-none absolute inset-0 rounded-lg"
            style={
              {
                "--jarvis-cell-w": `${colWidth + CELL_MARGIN}px`,
                "--jarvis-cell-h": `${rowHeight + CELL_MARGIN}px`,
              } as React.CSSProperties
            }
          />
        )}

        {useGrid ? (
          <GridLayout
            className="relative"
            data-testid="command-grid"
            layout={rglLayout}
            cols={GRID_COLS}
            // Advisory only. Measured NOT to constrain vertical compaction —
            // the arrangement goes deeper than this and the library is content.
            // It is passed because it does bound a direct drag, and the row
            // height above is what actually guarantees the fit.
            maxRows={MAX_ROWS}
            rowHeight={rowHeight}
            width={workspace.width}
            margin={[CELL_MARGIN, CELL_MARGIN]}
            containerPadding={[0, 0]}
            // Vertical compaction is what turns a collision into a REFLOW: a
            // dropped widget pushes the ones it lands on, and everything then
            // settles back upward. `preventCollision` off is what allows the
            // push rather than refusing the drop, and `allowOverlap` off is the
            // guarantee that two widgets can never occupy the same cell.
            //
            // Settling upward is not tidiness for its own sake. Without it a
            // push is permanent: one drag of the Orb across two columns shoved
            // the whole right-hand side down eight rows and left it there,
            // which drove the arrangement into the row ceiling and shrank every
            // widget. With it, the rows displaced by a drag are reclaimed the
            // moment the drag ends, and the layout returns to twelve rows.
            //
            // The cost is real and worth naming: a user cannot leave a
            // deliberate vertical gap, because compaction will close it. That
            // is the trade for never opening the dashboard to a hole in the
            // middle of it.
            compactType="vertical"
            preventCollision={false}
            allowOverlap={false}
            isBounded
            isDraggable={dash.customizing}
            isResizable={dash.customizing}
            // Only the grip moves a widget. Without this the whole card is a
            // drag surface and the map inside it could never be panned.
            draggableHandle={`.${DRAG_HANDLE_CLASS}`}
            resizeHandles={["s", "e", "se"]}
            onLayoutChange={onLayoutChange}
            useCSSTransforms
          >
            {visible.map((p) => (
              <div
                key={p.id}
                data-testid={`cell-${p.id}`}
                // The placement in GRID UNITS, which is what is actually stored
                // and restored. Pixel geometry is a function of the viewport and
                // of whether the customise toolbar is open, so a test that
                // compares pixels across a reload compares the wrong thing.
                data-x={p.x}
                data-y={p.y}
                data-w={p.w}
                data-h={p.h}
                className="min-h-0 min-w-0"
              >
                {framed(p)}
              </div>
            ))}
          </GridLayout>
        ) : (
          /* Phone and small tablet: one column, in the user's own order. The
             grid's coordinates still decide that order — reading top-to-bottom
             then left-to-right is what a person means by "the order they are
             in" — so a rearrangement made on a desktop is still recognisable
             here. */
          <div data-testid="command-stack" className="flex flex-col gap-2.5 pb-1">
            {[...visible]
              .sort((a, b) => a.y - b.y || a.x - b.x)
              .map((p) => (
                <div key={p.id} data-testid={`cell-${p.id}`} className="min-h-[13rem]">
                  {framed(p)}
                </div>
              ))}
          </div>
        )}
      </div>

      {/* ---- Command bar ---------------------------------------------------
          Outside the grid, and deliberately so: no arrangement the user can
          build can shrink it, cover it, or push it off the screen.
      */}
      <form
        onSubmit={submit}
        data-testid="command-bar"
        className="relative mx-auto mt-2 w-full max-w-3xl shrink-0"
      >
        <AttachmentList
          attachments={attachments}
          onRemove={(id) => setAttachments((prev) => prev.filter((a) => a.id !== id))}
        />

        <div className="glass-panel glass-edge flex items-center gap-1 rounded-full py-1.5 pl-2 pr-2 transition-colors focus-within:border-sys-cyan/40">
          {/* Uploads go through the EXISTING knowledge pipeline, so an
              attachment becomes a retrievable, citable document rather than
              one-shot context for the next message. */}
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
            className="min-w-0 flex-1 bg-transparent text-sm text-white placeholder:text-sys-dim focus:outline-none disabled:opacity-60"
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

        <p className="mt-1 text-center font-mono text-xs uppercase tracking-hud text-sys-dim">
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

      {/* ---- Approval ------------------------------------------------------
          Only when something is genuinely waiting. It is the one thing that
          BLOCKS on the person looking at the screen, so it is never a widget
          that could be hidden or dragged away.

          `shrink-0` so a decision is never squeezed to nothing, capped and
          scrolled internally so three queued approvals cannot push the
          workspace out of the viewport. The grid gives up the space, which is
          correct: this is the thing that blocks.

          ApprovalCard is the existing component from the approvals page —
          reused, not reimplemented, so approve/reject go through the same
          audited endpoints with the same expiry and conflict handling.
      */}
      {approvals.length > 0 && (
        <div
          data-testid="command-approvals"
          className="relative mx-auto mt-2 max-h-[34%] w-full max-w-3xl shrink-0 space-y-2 overflow-y-auto"
          aria-label="Actions awaiting your approval"
        >
          <div className="flex items-center justify-center gap-2 text-amber-300/90">
            <ShieldAlert size={14} aria-hidden="true" />
            <p className="font-mono text-xs uppercase tracking-hud">Action requires approval</p>
          </div>

          {approvals.map((approval) => (
            <ApprovalCard
              key={approval.approvalId}
              approval={approval}
              onChanged={() => void loadApprovals()}
            />
          ))}

          <p className="text-center font-mono text-xs uppercase tracking-hud text-sys-dim">
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

// ---------------------------------------------------------------------------
// The Orb, as a widget like any other.
//
// It is sized by its CELL now, not by the viewport: `h-full` with a square
// aspect makes the height the input and the width follow, so the Orb is always
// as large as the box the user dragged it to and never larger. The status line
// sits beneath it and is `shrink-0`, so shrinking the widget takes space from
// the animation rather than from the words.
// ---------------------------------------------------------------------------
function OrbWidget({
  status,
  label,
  text,
  tone,
}: {
  status: { thinking: boolean; awaitingApproval: boolean; failed: boolean };
  label: string;
  text: string;
  tone: string;
}) {
  return (
    <section
      aria-label="JARVIS Orb"
      className="glass-panel glass-edge relative flex h-full min-h-0 min-w-0 flex-col items-center justify-center gap-2 rounded-xl p-3"
    >
      <div className="flex min-h-0 w-full flex-1 items-center justify-center">
        <JarvisOrb status={status} showCaption={false} className="aspect-square h-full max-w-full" />
      </div>

      <div className="w-full shrink-0 text-center">
        <p className="font-mono text-xs uppercase tracking-hud text-sys-dim">{label}</p>
        <p
          data-testid="command-readout"
          role="status"
          aria-live="polite"
          className={`mt-0.5 line-clamp-2 text-[0.8rem] ${tone}`}
        >
          {text}
        </p>
      </div>
    </section>
  );
}
