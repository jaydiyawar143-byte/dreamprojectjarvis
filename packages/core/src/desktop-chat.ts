// ---------------------------------------------------------------------------
// Phase 19.7 — what chat may ask of a paired Windows computer.
//
// The owner reversed D5: a model may PROPOSE opening an approved application
// or typing approved text. It proposes and nothing else. Every step that makes
// the proposal real belongs to someone else:
//
//   • the owner's own message must ask for exactly this
//     (`desktopOwnerAuthorization`), so a web page, a document or anything else
//     a model has read cannot start a desktop action by telling it to;
//   • the server finds the device and the grant, never the model;
//   • a person approves the one action, with what it will do in front of them;
//   • typing is its own request, its own approval and its own Windows Hello.
//
// Pure rules and fixed sentences, no I/O: the desktop service and the
// orchestrator hold this to the same answer.
// ---------------------------------------------------------------------------

import { COMPUTER_CONTROL_OUTCOME_UNKNOWN_MESSAGE, DESKTOP_APP_IDS, DESKTOP_APP_LABELS, type DesktopAppId } from "./computer-control.js";
import { DESKTOP_COMMAND_TTL_MS } from "./desktop-agent.js";
import { containsSecret } from "./utils/redact-secrets.js";

/** The two things chat may propose. Clicks and named keys stay on the Computer Control page. */
export const DESKTOP_CHAT_TOOL_IDS = Object.freeze(["desktop.app.launch", "desktop.input.type"] as const);
export type DesktopChatToolId = (typeof DESKTOP_CHAT_TOOL_IDS)[number];

const CHAT_TOOL_SET: ReadonlySet<string> = new Set<string>(DESKTOP_CHAT_TOOL_IDS);
export function isDesktopChatTool(value: unknown): value is DesktopChatToolId {
  return typeof value === "string" && CHAT_TOOL_SET.has(value);
}

/** How long chat waits for the computer: a command's whole life, then its margin to answer. */
export const DESKTOP_RESULT_WAIT_MS = DESKTOP_COMMAND_TTL_MS + 15_000;
/** What the executor must allow a confirmed desktop tool: its wait, and a margin to report it. */
export const DESKTOP_CHAT_EXECUTION_TIMEOUT_MS = DESKTOP_RESULT_WAIT_MS + 5_000;

// ---------------------------------------------------------------------------
// The owner's words
// ---------------------------------------------------------------------------

/** How a person names each application. Only ever matched against their own message. */
const APP_WORDS: Readonly<Record<DesktopAppId, string>> = Object.freeze({
  notepad: "notepad",
  calculator: "calculator|calc",
  edge: "microsoft\\s+edge|edge",
  chrome: "google\\s+chrome|chrome",
  explorer: "file\\s+explorer|windows\\s+explorer|explorer",
});

const OPEN_VERBS = "open|launch|start|run";
const NEGATED_OPEN = new RegExp(`\\b(?:do\\s+not|don'?t|never)\\s+(?:\\w+\\s+){0,2}?(?:${OPEN_VERBS})\\b`, "i");

function asksToOpen(app: DesktopAppId, message: string): boolean {
  if (NEGATED_OPEN.test(message)) return false;
  // The verb governs the application: "open up the calculator app", never a
  // mention of it somewhere else in the sentence.
  return new RegExp(`\\b(?:${OPEN_VERBS})\\b(?:\\s+[\\w'-]+){0,3}?\\s+(?:${APP_WORDS[app]})\\b`, "i").test(message);
}

function asksToOpenAnything(message: string): boolean {
  return DESKTOP_APP_IDS.some((app) => asksToOpen(app, message));
}

/** A message that opens with a request to type, or names typing into Notepad. "Type of campaign" is neither. */
const TYPING_SENTENCE = /^\s*(?:(?:please|now|then|ok|okay|can\s+you|could\s+you)[\s,]+)*type\b(?!\s+of\b)|\b(?:type|write|enter)\b.*\b(?:in|into)\s+notepad\b|\bin\s+notepad\b.*\b(?:type|write|enter)\b/i;
const NAMES_THE_COMPUTER = /\bon\s+(?:my|this|the)\s+(?:windows\s+)?(?:computer|pc|laptop|desktop)\b/i;

/**
 * Whether a message reads as a request for the desktop. For routing only: it
 * sends the message to the agent that holds the tools and authorizes nothing.
 */
export function looksLikeDesktopRequest(message: string): boolean {
  return asksToOpenAnything(message) || TYPING_SENTENCE.test(message) || NAMES_THE_COMPUTER.test(message);
}

/** A request to type, ending just before the text: "type", "type this exactly:", `please type "`. */
const TYPE_REQUEST = /\b(?:type|enter|write)\b(?:\s+(?:in|into|out|this|that|exactly|text|the\s+text|the\s+words|these\s+words|the\s+following))*[\s:"'“”‘’(-]*$/i;

function occurrences(text: string, message: string): number[] {
  const found: number[] = [];
  for (let at = message.indexOf(text); at !== -1; at = message.indexOf(text, at + 1)) found.push(at);
  return found;
}

export type DesktopOwnerVerdict = { ok: true } | { ok: false; code: "NOT_ASKED" | "TYPE_NEEDS_OWN_REQUEST" };

/**
 * Whether the owner's own message asks for exactly this action. `ownerMessage`
 * is the authenticated person's message as it arrived, never a composed prompt,
 * so nothing a model read can satisfy it. Text must appear there word for word:
 * a model may not improve it, finish it or add to it.
 */
export function desktopOwnerAuthorization(
  action: DesktopChatToolId,
  params: Record<string, unknown>,
  ownerMessage: string
): DesktopOwnerVerdict {
  if (action === "desktop.app.launch") {
    const app = params.app;
    if (typeof app !== "string" || !(DESKTOP_APP_IDS as readonly string[]).includes(app)) return { ok: false, code: "NOT_ASKED" };
    return asksToOpen(app as DesktopAppId, ownerMessage) ? { ok: true } : { ok: false, code: "NOT_ASKED" };
  }

  const text = params.text;
  if (typeof text !== "string" || text.length === 0) return { ok: false, code: "NOT_ASKED" };
  const at = occurrences(text, ownerMessage).find((index) => TYPE_REQUEST.test(ownerMessage.slice(0, index)));
  if (at === undefined) return { ok: false, code: "NOT_ASKED" };
  // Without the text itself, whose words are the owner's to choose: typing
  // "open notepad" is typing, and not a second request.
  const around = `${ownerMessage.slice(0, at)} ${ownerMessage.slice(at + text.length)}`;
  return asksToOpenAnything(around) ? { ok: false, code: "TYPE_NEEDS_OWN_REQUEST" } : { ok: true };
}

// ---------------------------------------------------------------------------
// What is never typed
// ---------------------------------------------------------------------------

/** A secret said in words, which token shapes cannot see: "my password is hunter2". */
const SECRET_IN_WORDS =
  /\b(?:password|passcode|passphrase|passwd|pwd|pin|otp|one[- ]time\s+(?:code|password)|secret|credentials?|api[ _-]?key|access[ _-]?token|auth[ _-]?token|recovery\s+code)\b\s*(?:is|are|was|were|:|=)\s*\S+/i;

function isCardNumber(text: string): boolean {
  for (const candidate of text.match(/\b\d(?:[ -]?\d){12,18}\b/g) ?? []) {
    const digits = candidate.replace(/[ -]/g, "");
    let sum = 0;
    for (let i = 0; i < digits.length; i += 1) {
      const digit = Number(digits[digits.length - 1 - i]);
      sum += i % 2 === 1 ? (digit * 2 > 9 ? digit * 2 - 9 : digit * 2) : digit;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

/**
 * Text that must never be typed on a person's behalf. A check can only know
 * shapes and words, so it adds to the person reading the exact text before they
 * approve it; it does not replace them.
 */
export function isSensitiveDesktopText(text: string): boolean {
  return containsSecret(text) || SECRET_IN_WORDS.test(text) || isCardNumber(text);
}

// ---------------------------------------------------------------------------
// Refusals: fixed sentences, which never repeat what was asked
// ---------------------------------------------------------------------------

const APP_NAMES = DESKTOP_APP_IDS.map((id) => DESKTOP_APP_LABELS[id]).join(", ");

export const DESKTOP_CHAT_REFUSALS = Object.freeze({
  NOT_ASKED: "Nothing was proposed: that was not asked for in your own message. A desktop action needs you to ask for it yourself, in your own words.",
  TYPE_NEEDS_OWN_REQUEST: "Nothing was typed. Typing is its own request: once the application is open, send the text in a new message, for example: Type your text here.",
  UNKNOWN_APP: `That application is not on the approved list, so nothing was proposed. JARVIS can open: ${APP_NAMES}.`,
  INVALID_TEXT: "That text cannot be typed, so nothing was proposed. Line breaks, tabs and invisible characters are not allowed.",
  TEXT_TOO_LONG: "That text is longer than this server allows to be typed in one action, so nothing was proposed.",
  TEXT_SENSITIVE: "That looks like a password, a code or a credential. JARVIS never types those, so nothing was proposed.",
  NO_DEVICE: "No paired Windows computer is ready, so nothing was proposed. Pair one on the Computer Control page.",
  SEVERAL_DEVICES: "More than one of your computers allows control right now, so nothing was proposed. Use the Computer Control page to choose one.",
  NO_GRANT: "Control is not allowed for this on your computer right now, so nothing was proposed. Choose Allow control in the JARVIS tray on that computer, and tick this kind of action.",
  ALREADY_UNKNOWN: "The same action was already sent to this computer and its outcome is unknown, so it was not proposed again. Check the computer first.",
  ONE_AT_A_TIME: "One desktop action at a time: this one was not proposed. Ask for it again once the first has finished.",
  UNAVAILABLE: "Desktop control is not available right now, so nothing was proposed.",
});
export type DesktopChatRefusalCode = keyof typeof DESKTOP_CHAT_REFUSALS;

// ---------------------------------------------------------------------------
// What chat is told happened
// ---------------------------------------------------------------------------

export type DesktopChatOutcome = "succeeded" | "not-executed" | "unknown" | "no-answer" | "not-sent";

export interface DesktopChatReport {
  outcome: DesktopChatOutcome;
  /** The computer's code, or the service's, when there is one. Value-free. */
  code: string | null;
  /** One fixed sentence or two, for the person. */
  message: string;
}

const CANNOT_SEE = "JARVIS cannot see the screen, so check it on the computer.";

const NOT_EXECUTED_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  HELLO_FAILED: "Windows Hello was not verified, so nothing was typed.",
  HELLO_UNAVAILABLE: "Windows Hello is not set up on that computer, so nothing was typed.",
  APP_NOT_INSTALLED: "That application is not installed where JARVIS may open it from, so nothing was opened.",
  LAUNCH_FAILED: "Windows could not start that application, so nothing was opened.",
  SESSION_LOCKED: "The computer is locked, so nothing was done.",
  GRANT_INACTIVE: "Control is no longer allowed on the computer, so nothing was done.",
  COMMAND_EXPIRED: "That took too long and the command expired, so nothing was done.",
  NO_TARGET: "No suitable window had focus, or the window changed, so nothing was done.",
  ELEVATED_TARGET: "The window with focus runs as administrator, which JARVIS may not act in, so nothing was done.",
  OUT_OF_BOUNDS: "That position is outside the screen, so nothing was done.",
  BUSY: "The computer was busy with another action, so nothing was done.",
  INVALID_COMMAND: "The computer refused the command as invalid, so nothing was done.",
});

/**
 * One command's state, as chat reports it. `succeeded` is said only when the
 * computer answered that it did; everything else says what is not known.
 */
export function desktopChatReport(input: {
  action: DesktopChatToolId;
  app?: DesktopAppId;
  status: "issued" | "delivered" | "succeeded" | "not_executed" | "unknown" | "expired";
  resultCode: string | null;
}): DesktopChatReport {
  switch (input.status) {
    case "succeeded":
      return {
        outcome: "succeeded",
        code: null,
        message:
          input.action === "desktop.app.launch"
            ? `Windows started ${input.app ? DESKTOP_APP_LABELS[input.app] : "the application"}. ${CANNOT_SEE} Nothing was typed. To type into it, send the text in a new message, for example: Type your text here.`
            : `The computer reports the text was typed into the window that had focus. ${CANNOT_SEE}`,
      };
    case "not_executed":
      return {
        outcome: "not-executed",
        code: input.resultCode,
        message: (input.resultCode ? NOT_EXECUTED_MESSAGES[input.resultCode] : undefined) ?? "The computer did not carry that out, so nothing was done.",
      };
    case "unknown":
      return { outcome: "unknown", code: input.resultCode, message: `${COMPUTER_CONTROL_OUTCOME_UNKNOWN_MESSAGE} Check the computer before asking again.` };
    case "expired":
      return { outcome: "not-executed", code: input.resultCode, message: "The command never reached the computer, so nothing was done." };
    default:
      return {
        outcome: "no-answer",
        code: null,
        message: "The command was sent and the computer has not answered yet. It will not be sent again. The Computer Control page shows the result when it arrives.",
      };
  }
}

// ---------------------------------------------------------------------------
// The port the tools and the orchestrator hold
// ---------------------------------------------------------------------------

export type DesktopChatProposal =
  | { ok: true; params: Record<string, unknown> }
  | { ok: false; code: DesktopChatRefusalCode; message: string };

export interface DesktopChatPort {
  /**
   * Everything that must hold before a person is asked, and the exact
   * parameters the approval will be bound to. Creates nothing.
   */
  propose(input: {
    userId: string;
    action: DesktopChatToolId;
    params: Record<string, unknown>;
    ownerMessage: string;
  }): Promise<DesktopChatProposal>;

  /** Spends an approved approval and waits for the computer's answer. Never sends twice. */
  runApproved(input: {
    userId: string;
    action: DesktopChatToolId;
    params: Record<string, unknown>;
    approvalId: string;
    signal?: AbortSignal;
  }): Promise<DesktopChatReport>;
}
