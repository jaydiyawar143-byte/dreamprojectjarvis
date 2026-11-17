"use client";

// ---------------------------------------------------------------------------
// VO-2.2 — the expanded Virtual Office.
//
// What used to be the `/office` page, now opened from the dashboard widget as
// a full-screen dialog. It is handed the widget's data (`useOfficeData`), so it
// starts no second socket and no second round of reads.
//
// TWO PARTS.
//
//   `OfficeView`             the office itself. Since Stage 2 the pixel-art
//                            floor is the primary thing on screen — pan, zoom,
//                            a room to inspect — with the selected actor or
//                            the inspected room beside it; the live status,
//                            the three totals, the legend, the roster and the
//                            activity table follow. Unchanged in what it
//                            claims and what it refuses to claim.
//
//   `OfficeExpandedDialog`   the dialog around it: a portal to <body>, focus
//                            moved in on open and given back on close, Tab
//                            kept inside, Escape and the close button closing.
//
// WHY A PORTAL. The widget lives in a react-grid-layout cell, which positions
// with CSS transforms. A `position: fixed` element inside a transformed
// ancestor is placed against that ancestor, not the viewport, so a dialog
// rendered in place would be trapped inside the widget's box.
//
// WHY z-[80]. The chat surface layer sits at z-55 to z-70. A full-screen modal
// that a surface could float over would not be a modal.
//
// WHAT THIS DOES NOT DO. It runs nothing, approves nothing and writes nothing.
// Refresh re-reads the three sources and reconnects the live feed; that is the
// only action it has.
// ---------------------------------------------------------------------------

import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { PanelGrid } from "@/components/dashboard/page-container";
import { Panel, StatPanel } from "@/components/dashboard/panel";
import { ErrorState, LoadingState } from "@/components/dashboard/states";
import { Button } from "@/components/ui/primitives";

import { OFFICE_DEPARTMENTS, findOfficeActor, type DepartmentId } from "./office-model";
import { OfficeScene } from "./office-scene";
import { OfficeSelectionPanel } from "./office-selection-panel";
import { OfficeDepartmentPanel } from "./office-department-panel";
import { OfficeLegend } from "./office-legend";
import { OfficeRoster } from "./office-roster";
import { OfficeEventList } from "./office-event-list";
import { OfficeStreamStatus } from "./office-stream-status";
import type { OfficeData } from "./use-office-data";

// ---------------------------------------------------------------------------
// The office
// ---------------------------------------------------------------------------

export interface OfficeViewProps {
  data: OfficeData;
  selectedActorId: string | null;
  onSelectActor: (id: string | null) => void;
  /** A room to open on — the one whose sign was clicked on the widget. */
  initialDepartment?: DepartmentId | null;
  /**
   * VO-3.1 — decorative break activities. On in production; a test that must
   * not depend on the wall clock passes `false`.
   */
  ambient?: boolean;
}

export function OfficeView({
  data,
  selectedActorId,
  onSelectActor,
  initialDepartment = null,
  ambient = true,
}: OfficeViewProps) {
  const { model, streamStatus, firstLoad, error, reloadAll } = data;
  const selection = findOfficeActor(model, selectedActorId);

  // The room being inspected. Per opening of the office: it is a way of
  // looking, not a fact, so unlike the selected actor it does not survive a
  // close.
  const [focusDepartment, setFocusDepartment] = useState<DepartmentId | null>(initialDepartment);
  const inspected = focusDepartment
    ? model.departments.find((department) => department.id === focusDepartment) ?? null
    : null;

  // Which of the two the side panel shows: whichever the person asked for
  // last. Inspecting a room while an agent is selected shows the room — the
  // selection is kept (it stays ringed on the floor, and survives a close) —
  // and choosing an agent shows the agent.
  const [sidePanel, setSidePanel] = useState<"actor" | "department">(
    initialDepartment ? "department" : "actor"
  );
  const inspectDepartment = (id: DepartmentId | null) => {
    setFocusDepartment(id);
    setSidePanel(id ? "department" : "actor");
  };
  const chooseActor = (id: string | null) => {
    onSelectActor(id);
    setSidePanel(id ? "actor" : focusDepartment ? "department" : "actor");
  };

  if (firstLoad) {
    return <LoadingState label="Reading the registry, task queue and recent activity…" />;
  }

  if (error) {
    return <ErrorState title="Could not open the office" message={error} onRetry={reloadAll} />;
  }

  const chip = (active: boolean) =>
    `sys-focus rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-hud transition-colors ${
      active
        ? "border-sys-cyan/60 bg-sys-cyan/10 text-sys-cyan"
        : "border-sys-line text-sys-dim hover:border-sys-cyan/35 hover:text-white"
    }`;

  return (
    <div data-testid="office-view" className="space-y-4">
      <div className="max-w-xl">
        <OfficeStreamStatus status={streamStatus} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-4">
          <Panel
            title="The office"
            description="Six rooms. Only agents registered in this process are drawn. Drag to look around; ctrl + wheel, + and − zoom."
            bodyClassName="p-2"
          >
            <div
              data-testid="office-stage"
              className="relative aspect-[2/1] max-h-[62vh] min-h-[16rem] w-full overflow-hidden rounded-md border border-sys-line/70 bg-sys-void"
            >
              <OfficeScene
                model={model}
                selectedActorId={selectedActorId}
                onSelectActor={chooseActor}
                focusDepartment={focusDepartment}
                onSelectDepartment={inspectDepartment}
                interactive
                ambient={ambient}
                className="absolute inset-0"
              />
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-1.5 px-1" role="group" aria-label="Rooms">
              <button
                type="button"
                data-testid="office-department-chip"
                data-department-id="all"
                aria-pressed={focusDepartment === null}
                className={chip(focusDepartment === null)}
                onClick={() => inspectDepartment(null)}
              >
                Whole office
              </button>
              {OFFICE_DEPARTMENTS.map((department) => (
                <button
                  key={department.id}
                  type="button"
                  data-testid="office-department-chip"
                  data-department-id={department.id}
                  aria-pressed={focusDepartment === department.id}
                  className={chip(focusDepartment === department.id)}
                  onClick={() => inspectDepartment(department.id)}
                >
                  {department.label}
                </button>
              ))}
            </div>
          </Panel>

          <PanelGrid columns={3}>
            <StatPanel
              label="Agents on the floor"
              value={model.counts.availableAgents}
              hint={
                model.counts.unavailableAgents === 0
                  ? "Every declared agent is registered"
                  : `${model.counts.unavailableAgents} declared but not registered`
              }
            />
            <StatPanel
              label="Running tasks"
              value={model.counts.running}
              hint={
                model.counts.tasksAreTotals
                  ? "Every RUNNING task in the task engine"
                  : "RUNNING among the newest tasks read; this API sent no totals"
              }
              tone={model.counts.running > 0 ? "success" : "default"}
            />
            <StatPanel
              label="Queued tasks"
              value={model.counts.pending}
              hint={
                model.counts.tasksAreTotals
                  ? "Every PENDING task in the task engine"
                  : "PENDING among the newest tasks read; this API sent no totals"
              }
              tone={model.counts.pending > 0 ? "warning" : "default"}
            />
          </PanelGrid>
        </div>

        <div className="min-w-0">
          {inspected && (sidePanel === "department" || !selection) ? (
            <OfficeDepartmentPanel
              department={inspected}
              system={model.system}
              events={model.events}
              selectedActorId={selectedActorId}
              onSelectActor={chooseActor}
              onShowAll={() => inspectDepartment(null)}
            />
          ) : (
            <OfficeSelectionPanel selection={selection} onClear={() => chooseActor(null)} />
          )}
        </div>
      </div>

      <OfficeLegend />

      <OfficeRoster agents={model.agents} unavailable={model.unavailableAgents} />

      <OfficeEventList events={model.events} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface OfficeExpandedDialogProps extends OfficeViewProps {
  open: boolean;
  onClose: () => void;
  /**
   * Where focus returns on close when the element that opened the dialog is no
   * longer there to take it — for instance when it was opened from the URL,
   * with nothing focused.
   */
  returnFocusRef?: RefObject<HTMLElement>;
}

export function OfficeExpandedDialog({ open, ...rest }: OfficeExpandedDialogProps) {
  if (!open || typeof document === "undefined") return null;
  return createPortal(<DialogPanel {...rest} />, document.body);
}

function DialogPanel({
  onClose,
  returnFocusRef,
  data,
  selectedActorId,
  onSelectActor,
  initialDepartment = null,
  ambient = true,
}: Omit<OfficeExpandedDialogProps, "open">) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  // The newest handlers, read from refs so the open/close effect runs once per
  // opening rather than once per render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const returnFocusRefRef = useRef(returnFocusRef);
  returnFocusRefRef.current = returnFocusRef;

  useEffect(() => {
    // Whatever opened the dialog gets focus back when it closes.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();

    // Escape, caught at the window in the capture phase: the dialog is on top,
    // so it — and nothing beneath it, such as a chat surface — answers it.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      event.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey, true);

    return () => {
      window.removeEventListener("keydown", onKey, true);
      const back =
        opener && opener !== document.body && opener.isConnected
          ? opener
          : returnFocusRefRef.current?.current ?? null;
      back?.focus();
    };
  }, []);

  /** Tab and Shift+Tab stay inside the dialog. */
  function keepFocusInside(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;

    const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (element) => element.getAttribute("aria-hidden") !== "true"
    );
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }

    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;

    if (event.shiftKey && (active === first || !panel.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      data-testid="office-dialog-backdrop"
      className="fixed inset-0 z-[80] flex items-stretch justify-center bg-sys-void/80 p-2 backdrop-blur-sm sm:p-4"
      onMouseDown={(event) => {
        // Only a press on the backdrop itself, never one that started inside.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        data-testid="office-dialog"
        onKeyDown={keepFocusInside}
        className="glass-panel glass-edge flex h-full w-full max-w-[1600px] flex-col overflow-hidden rounded-xl"
      >
        <header className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b border-sys-line/70 px-4 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-semibold text-white">
              Virtual Office
            </h2>
            <p id={descriptionId} className="mt-0.5 max-w-3xl text-xs leading-snug text-sys-dim">
              A pixel-art floor of the agents registered on this deployment, the task engine&apos;s
              real queue, and the newest audit records. Live events arrive while the dashboard is
              open; Refresh re-reads everything. Idle movement is decorative; the activity table is
              the record.
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Button variant="secondary" size="sm" onClick={data.refresh}>
              Refresh
            </Button>
            <button
              ref={closeRef}
              type="button"
              data-testid="office-dialog-close"
              onClick={onClose}
              aria-label="Close Virtual Office"
              className="sys-focus rounded p-1.5 text-sys-dim transition-colors hover:text-white"
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <OfficeView
            data={data}
            selectedActorId={selectedActorId}
            onSelectActor={onSelectActor}
            initialDepartment={initialDepartment}
            ambient={ambient}
          />
        </div>
      </div>
    </div>
  );
}
