"use client";

// ---------------------------------------------------------------------------
// VO-2.2 — the Virtual Office as a dashboard widget.
//
// The office lives INSIDE the command centre now, as one of its widgets, and
// has no sidebar entry of its own. The widget shows the floor with the existing
// DOM renderer (the pixel renderer is a later stage) and opens the full office
// in a dialog.
//
// ONE SUBSCRIPTION. The widget calls `useOfficeData` once and hands the result
// to the dialog it opens, so expanding the office starts no second socket and
// no second round of reads.
//
// WHAT OPENS IT.
//   - the expand button in the widget's header;
//   - an agent or JARVIS on the floor, which opens the office with that actor
//     already selected, so the selection survives the expansion;
//   - `?office=open` in the URL, which is where the old `/office` route now
//     sends people. Closing the office removes the parameter again.
//
// CUSTOMISE MODE. While the dashboard is being arranged, the widget is a thing
// to move, not a thing to use: the expand button is disabled and the floor
// ignores clicks, so a drag can never open a dialog by accident. Moving and
// resizing still go through the frame's own grip and handles.
//
// It runs nothing, approves nothing and writes nothing.
// ---------------------------------------------------------------------------

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Maximize2 } from "lucide-react";

import type { DepartmentId } from "./office-model";
import { OfficeScene } from "./office-scene";
import { OfficeStreamBadge } from "./office-stream-status";
import { OfficeExpandedDialog } from "./office-expanded";
import { useOfficeData } from "./use-office-data";

/** `/dashboard?office=open` opens the office. The old `/office` route sends people here. */
export const OFFICE_QUERY_KEY = "office";
export const OFFICE_QUERY_OPEN = "open";
export const OFFICE_DEEP_LINK = `/dashboard?${OFFICE_QUERY_KEY}=${OFFICE_QUERY_OPEN}`;

// ---------------------------------------------------------------------------
// The URL
// ---------------------------------------------------------------------------

/**
 * Keeps the dialog and `?office=open` in step.
 *
 * Its own component, behind a Suspense boundary, because `useSearchParams`
 * needs one in the app router (the same pattern as `auth/google`).
 *
 * While the dashboard is being arranged the request is not acted on and not
 * dropped: it stays in the URL, and is honoured the moment customise mode
 * ends. Nothing opens over a person moving widgets.
 */
function OfficeUrlSync({
  open,
  customizing = false,
  onRequestOpen,
}: {
  open: boolean;
  customizing?: boolean;
  onRequestOpen: () => void;
}) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const wantsOpen = params?.get(OFFICE_QUERY_KEY) === OFFICE_QUERY_OPEN;

  const requestRef = useRef(onRequestOpen);
  requestRef.current = onRequestOpen;
  const wasOpen = useRef(open);

  // The URL asks for the office: open it — once the dashboard is not being
  // arranged. `customizing` is a dependency so the request is retried then.
  useEffect(() => {
    if (wantsOpen && !customizing) requestRef.current();
  }, [wantsOpen, customizing]);

  // The office closed while the URL still asks for it: drop the parameter, so
  // a reload does not reopen what the person just closed.
  useEffect(() => {
    if (wasOpen.current && !open && wantsOpen) {
      const next = new URLSearchParams(params?.toString() ?? "");
      next.delete(OFFICE_QUERY_KEY);
      const query = next.toString();
      const base = pathname || "/dashboard";
      router.replace(query ? `${base}?${query}` : base);
    }
    wasOpen.current = open;
  }, [open, wantsOpen, params, pathname, router]);

  return null;
}

// ---------------------------------------------------------------------------
// The widget
// ---------------------------------------------------------------------------

/**
 * The office widget, gated on the person's saved layout.
 *
 * The command centre renders `DEFAULT_LAYOUT` until `GET /preferences` answers,
 * and the office is visible in that default. Mounting the widget straight away
 * therefore read the office — three requests and one socket subscription — for
 * a widget that a saved layout very often hides, and threw all of it away the
 * moment the layout arrived.
 *
 * `layoutLoaded` is REQUIRED and is the dashboard's own `dash.loaded`, so a
 * caller cannot render this before the layout is known by forgetting a prop.
 * Before it, the frame is drawn and nothing that reads is mounted.
 *
 * The gate is a WRAPPER rather than an early return inside the widget because
 * `useOfficeData` is a hook: the component that calls it must not be mounted at
 * all, otherwise React would be asked to call hooks conditionally.
 */
export function OfficeWidget({
  customizing,
  layoutLoaded,
}: {
  customizing: boolean;
  layoutLoaded: boolean;
}) {
  if (!layoutLoaded) return <OfficeWidgetPending customizing={customizing} />;
  return <OfficeWidgetLive customizing={customizing} />;
}

/**
 * What the office's cell shows while the saved layout is being read.
 *
 * It is deliberately inert: no expand control, no floor, no dialog and no URL
 * handling, so there is nothing to click that would open an office whose
 * visibility is not known yet. It keeps the glass frame so the dashboard does
 * not visibly jump when the real widget arrives.
 */
function OfficeWidgetPending({ customizing }: { customizing: boolean }) {
  return (
    <section
      data-testid="office-widget"
      data-state="pending"
      data-customizing={customizing ? "true" : "false"}
      aria-label="Virtual Office"
      aria-busy="true"
      className="glass-panel glass-edge relative flex h-full min-h-0 min-w-0 flex-col rounded-xl p-3"
    >
      <header className="mb-2 flex shrink-0 items-center justify-between gap-2">
        <h2 className="truncate font-mono text-xs uppercase tracking-hud text-sys-text/85">
          Virtual Office
        </h2>
      </header>

      <div
        data-widget-scroll
        data-testid="office-widget-body"
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
      >
        <p className="py-6 text-center text-xs text-sys-dim">Reading your layout…</p>
      </div>
    </section>
  );
}

function OfficeWidgetLive({ customizing }: { customizing: boolean }) {
  const data = useOfficeData();
  const { model, streamStatus, firstLoad, error, reloadAll } = data;

  const [open, setOpen] = useState(false);
  const [selectedActorId, setSelectedActorId] = useState<string | null>(null);
  // Stage 2 — a room whose sign was clicked on the preview opens the office
  // looking at that room. Cleared on close: it is a way of looking, not a fact.
  const [openDepartment, setOpenDepartment] = useState<DepartmentId | null>(null);
  const expandRef = useRef<HTMLButtonElement | null>(null);

  const openOffice = useCallback(
    (actorId?: string, department?: DepartmentId) => {
      if (customizing) return;
      if (actorId !== undefined) setSelectedActorId(actorId);
      setOpenDepartment(department ?? null);
      setOpen(true);
    },
    [customizing]
  );

  const close = useCallback(() => {
    setOpen(false);
    setOpenDepartment(null);
  }, []);

  const { running, pending, tasksAreTotals } = model.counts;

  return (
    <section
      data-testid="office-widget"
      data-state="ready"
      data-customizing={customizing ? "true" : "false"}
      aria-label="Virtual Office"
      className="glass-panel glass-edge relative flex h-full min-h-0 min-w-0 flex-col rounded-xl p-3"
    >
      <header className="mb-2 flex shrink-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate font-mono text-xs uppercase tracking-hud text-sys-text/85">
            Virtual Office
          </h2>
          <OfficeStreamBadge status={streamStatus} />
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {!firstLoad && !error && (
            <p
              data-testid="office-widget-counts"
              title={
                tasksAreTotals
                  ? "Totals from the task engine"
                  : "Among the newest tasks read; this API sent no totals"
              }
              className="font-mono text-[10px] uppercase tracking-hud tabular-nums text-sys-dim"
            >
              {running} running · {pending} queued
            </p>
          )}
          <button
            ref={expandRef}
            type="button"
            data-testid="office-widget-expand"
            onClick={() => openOffice()}
            disabled={customizing}
            aria-label="Open the Virtual Office"
            title={customizing ? "Finish customising to open the office" : "Open the Virtual Office"}
            className="sys-focus rounded p-1 text-sys-dim transition-colors hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Maximize2 size={13} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div
        data-widget-scroll
        data-testid="office-widget-body"
        className={`relative min-h-0 flex-1 overflow-hidden rounded-md ${
          customizing ? "pointer-events-none select-none" : ""
        }`}
        aria-disabled={customizing || undefined}
      >
        {firstLoad ? (
          <p className="py-6 text-center text-xs text-sys-dim">Reading the office…</p>
        ) : error ? (
          <div className="space-y-2 py-4 text-center">
            <p className="text-xs text-sys-dim">{error}</p>
            <button
              type="button"
              onClick={reloadAll}
              className="sys-focus rounded border border-sys-line px-2 py-1 text-xs text-sys-text hover:border-sys-cyan/40"
            >
              Retry
            </button>
          </div>
        ) : (
          // Stage 2 — the pixel-art office, scaled to the cell. A figure opens
          // the office with that agent selected; a room's sign opens it looking
          // at that room.
          <>
            {/* The body's height. In the grid the cell sets it and this spacer,
                capped by `max-h-full`, can never push past it. In the stacked
                phone column a cell has only a minimum height, so the spacer
                gives the floor its 2:1 height from its width instead of
                collapsing to nothing. */}
            <div
              aria-hidden="true"
              data-testid="office-widget-sizer"
              className="pointer-events-none invisible aspect-[2/1] max-h-full w-full"
            />
            <OfficeScene
              model={model}
              selectedActorId={selectedActorId}
              onSelectActor={(id) => openOffice(id)}
              onSelectDepartment={(id) => openOffice(undefined, id)}
              compact
              className="absolute inset-0"
            />
          </>
        )}
      </div>

      <Suspense fallback={null}>
        <OfficeUrlSync open={open} customizing={customizing} onRequestOpen={() => openOffice()} />
      </Suspense>

      <OfficeExpandedDialog
        open={open}
        onClose={close}
        returnFocusRef={expandRef}
        data={data}
        selectedActorId={selectedActorId}
        onSelectActor={setSelectedActorId}
        initialDepartment={openDepartment}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// The office from the URL, when the widget is hidden
// ---------------------------------------------------------------------------

/**
 * `?office=open` still opens the office when the person has hidden the widget.
 *
 * Rendered by the command centre only while the office widget is hidden, and
 * it reads the office's data only while the URL asks for it — so there is
 * never a second subscription beside a visible widget.
 *
 * The command centre also mounts it only once the saved layout has loaded.
 * Until then "hidden" is not known — the default layout shows the office — and
 * mounting the link early would read the office for someone who has it on their
 * dashboard, then throw that subscription away when the layout arrives.
 *
 * Customise mode is honoured exactly as the widget honours it: while the
 * dashboard is being arranged nothing opens and nothing is read, the request
 * stays in the URL, and the office opens when customise mode ends.
 */
export function OfficeDeepLink({ customizing }: { customizing: boolean }) {
  return (
    <Suspense fallback={null}>
      <DeepLinkGate customizing={customizing} />
    </Suspense>
  );
}

function DeepLinkGate({ customizing }: { customizing: boolean }) {
  const params = useSearchParams();
  if (params?.get(OFFICE_QUERY_KEY) !== OFFICE_QUERY_OPEN) return null;
  if (customizing) return null;
  return <StandaloneOffice />;
}

function StandaloneOffice() {
  const data = useOfficeData();
  const [open, setOpen] = useState(true);
  const [selectedActorId, setSelectedActorId] = useState<string | null>(null);

  return (
    <>
      <OfficeUrlSync open={open} onRequestOpen={() => setOpen(true)} />
      <OfficeExpandedDialog
        open={open}
        onClose={() => setOpen(false)}
        data={data}
        selectedActorId={selectedActorId}
        onSelectActor={setSelectedActorId}
      />
    </>
  );
}
