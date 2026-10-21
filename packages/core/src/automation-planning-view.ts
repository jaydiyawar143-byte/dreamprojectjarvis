// ---------------------------------------------------------------------------
// Phase 18, Stage 18.4 — the browser-safe entry point for workflow planning
// (`@jarvis/core/automation-planning`). The vocabulary's values, and the
// shapes the server sends, as types only: nothing here pulls a Node-only
// module into the page.
// ---------------------------------------------------------------------------

export * from "./automation-vocabulary.js";
export type { LibraryIntegrationCategory, LibraryTriggerKind } from "./automation-inspection.js";
export type { AutomationRequest, CandidateFit, PlanningCandidate, PlanningMatch, PlanningOutcome } from "./automation-planning.js";
export type {
  DraftCheck,
  DraftCheckId,
  DraftConnection,
  DraftContent,
  DraftDiff,
  DraftIssue,
  DraftKind,
  DraftListPage,
  DraftNode,
  DraftNodeKind,
  DraftRequirement,
  DraftSetting,
  DraftSettingKind,
  DraftSource,
  DraftStatus,
  DraftView,
  PlanningMatchView,
} from "./automation-draft.js";
