// ---------------------------------------------------------------------------
// Phase 18.2 — what speech may not start.
//
// Voice may ask for nearly anything a typed turn may ask for; the pipeline
// behind it is the same. A few tools start work that a misheard sentence
// should never start — work that spends a shared budget and runs on after the
// reply. They are listed here, once, and refused for a spoken turn by the
// execution layer itself: the executor before the tool runs, the orchestrator
// before anything is planned around it, and the tool again as it runs. Hiding
// a control is never the check.
//
// The list only narrows. A turn that is not marked "voice" is unaffected, and
// nothing here grants anything.
// ---------------------------------------------------------------------------

import { AUTOMATION_LIBRARY_TOOL_IDS } from "./automation-library.js";
import { COMPUTER_CONTROL_VOICE_REFUSED_TOOLS } from "./computer-control.js";
import { VOICE_APPROVAL_POLICY, type InputMode } from "./types/voice.js";

/** The refusal code every surface reports for a tool speech may not start. */
export const VOICE_TOOL_REFUSED_CODE = "VOICE_NOT_ALLOWED";

/** Tools a spoken turn may not run, with the sentence that says so. */
export const VOICE_REFUSED_TOOLS: Readonly<Record<string, string>> = Object.freeze({
  [AUTOMATION_LIBRARY_TOOL_IDS.sync]:
    "A workflow library synchronization cannot be started or continued by voice. Use the Sync control on the Automations page.",
  // Phase 19.1 — sensitive browser actions and desktop input/screen reading.
  // Read-only browser actions stay allowed, and ending a desktop session is
  // always allowed: revoking control must not require a typed turn.
  ...COMPUTER_CONTROL_VOICE_REFUSED_TOOLS,
});

/** The refusal for this tool on this turn, or null when it may run. */
export function voiceToolRefusal(toolId: string, inputMode: InputMode | undefined): string | null {
  if (inputMode !== "voice") return null;
  return Object.prototype.hasOwnProperty.call(VOICE_REFUSED_TOOLS, toolId) ? VOICE_REFUSED_TOOLS[toolId]! : null;
}

// ---------------------------------------------------------------------------
// Phase 18.3A — a spoken turn never confirms.
//
// `VOICE_APPROVAL_POLICY` (types/voice.ts) is the locked rule: voice may
// PROPOSE an approval-gated action and never confirm one. This is where the
// server enforces it, from the turn's server-established input mode. The chat
// route refuses a spoken "yes" before the pending action is touched, the
// confirmation endpoint refuses a confirmation that says it was spoken, and
// ToolExecutor never spends an approval for a spoken turn — whatever path
// brought the approval id there. The integration and Google write services
// receive the same mode as their `voice` flag and refuse too.
// ---------------------------------------------------------------------------

/** What a spoken confirmation is told, everywhere it is refused. Names no action, id or parameter. */
export const VOICE_CONFIRMATION_REFUSED_MESSAGE =
  "That can't be confirmed by voice. Review it on screen and press Confirm there — the request is still waiting.";

/** The refusal for confirming, approving or carrying out an approved action on this turn, or null when it may. */
export function voiceConfirmationRefusal(inputMode: InputMode | undefined): string | null {
  return inputMode === "voice" && !VOICE_APPROVAL_POLICY.canConfirmPendingActions ? VOICE_CONFIRMATION_REFUSED_MESSAGE : null;
}
