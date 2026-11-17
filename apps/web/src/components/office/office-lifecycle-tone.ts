// ---------------------------------------------------------------------------
// VO-3.1 — one lifecycle state, one UI tone.
//
// The roster, the room panel and the selected-actor panel all render the same
// lifecycle labels. Keeping the tone mapping here means the three cannot drift
// apart, and a new lifecycle state is a compile error until it is given a tone.
// ---------------------------------------------------------------------------

import type { OfficeAgentLifecycle } from "./office-lifecycle";

export type OfficeTone = "neutral" | "info" | "ok" | "warn" | "danger";

export function lifecycleTone(lifecycle: OfficeAgentLifecycle): OfficeTone {
  switch (lifecycle) {
    case "idle":
      return "neutral";
    case "queued":
    case "assigned":
      return "info";
    case "working":
    case "researching":
    case "using_tool":
      return "ok";
    case "waiting_for_approval":
      return "warn";
    case "completed":
      return "ok";
    case "failed":
      return "danger";
  }
}
