"use client";

// ---------------------------------------------------------------------------
// VO-1 — the scene wrapper.
//
// The scene owns no state and derives nothing. It exists so the page has one
// element to place, one accessible summary to announce, and one renderer to
// swap in VO-4.
//
// `role="group"` rather than `role="img"` is deliberate: the actors inside are
// real buttons, and `role="img"` would hide them from assistive technology.
// The visual floor is decorative; the summary and the event table carry the
// information.
// ---------------------------------------------------------------------------

import type { OfficeModel } from "./office-model";
import { OFFICE_RENDERERS } from "./office-renderer";

export function officeSceneSummary(model: OfficeModel): string {
  const { availableAgents, unavailableAgents, running, pending } = model.counts;

  const agents =
    availableAgents === 1
      ? "1 registered agent is on the floor"
      : `${availableAgents} registered agents are on the floor`;

  const absent =
    unavailableAgents === 0
      ? "Every declared agent is registered on this deployment."
      : `${unavailableAgents} declared ${
          unavailableAgents === 1 ? "agent is" : "agents are"
        } not on this deployment and ${
          unavailableAgents === 1 ? "is" : "are"
        } not shown on the floor.`;

  return `${agents}. ${running} ${
    running === 1 ? "task is" : "tasks are"
  } running and ${pending} ${pending === 1 ? "task is" : "tasks are"} queued. ${absent} Slow idle movement is decorative.`;
}

export function OfficeScene({
  model,
  selectedActorId,
  onSelectActor,
}: {
  model: OfficeModel;
  selectedActorId: string | null;
  onSelectActor: (id: string) => void;
}) {
  // VO-1 has exactly one renderer. VO-4 adds "pixi" here and nowhere else.
  const Renderer = OFFICE_RENDERERS.dom;

  return (
    <div
      data-testid="office-scene"
      role="group"
      aria-label="Virtual office floor plan"
      className="space-y-2"
    >
      <p data-testid="office-scene-summary" className="sr-only">
        {officeSceneSummary(model)}
      </p>
      <Renderer
        model={model}
        selectedActorId={selectedActorId}
        onSelectActor={onSelectActor}
      />
    </div>
  );
}
