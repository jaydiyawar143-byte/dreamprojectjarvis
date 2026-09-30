// ---------------------------------------------------------------------------
// S7.2 L5 — memory management: the user's own control over what JARVIS keeps.
//
// The commands a user can give about their memories, the one safe way a
// memory is shown to them, what each command needs before anything is
// deleted, and the user's learning controls. L5 lists, forgets, pauses and
// vetoes; it never learns. A new or corrected statement is only ever learned
// through L1 → L4, exactly as before.
//
// Pure: type-only imports, no clock, no randomness, no I/O.
// ---------------------------------------------------------------------------

import type { MemoryRecord } from "./types/memory.js";

export const MEMORY_COMMAND_KINDS = [
  "LIST",
  "FORGET",
  "FORGET_ALL",
  "CORRECT",
  "REPLACE",
  "VETO",
  "LEARNING_PAUSE",
  "LEARNING_RESUME",
  "NONE",
] as const;
export type MemoryCommandKind = (typeof MEMORY_COMMAND_KINDS)[number];

/**
 * What a command points at. Never memory text: a destructive target is always
 * resolved to ids, from something the user was shown or said in this chat.
 *   SELECTION         "forget 2", "forget 1 and 3" — positions in the last list shown
 *   THIS              "forget this memory" — the one memory just shown or learned
 *   PREVIOUS_MESSAGE  "forget that", "don't remember what I just said"
 *   LAST_REPLY        "that's wrong" — a memory JARVIS used in its last reply
 */
export type MemoryTargetReference =
  | { kind: "SELECTION"; positions: number[] }
  | { kind: "THIS" }
  | { kind: "PREVIOUS_MESSAGE" }
  | { kind: "LAST_REPLY" };

/** ALL: every memory. LEGACY: only memories learned before provenance and evidence existed. */
export type MemoryForgetScope = "ALL" | "LEGACY";

export type MemoryCommand =
  | { kind: "NONE" | "LIST" | "REPLACE" | "LEARNING_PAUSE" | "LEARNING_RESUME" }
  | { kind: "FORGET"; target: { kind: "SELECTION"; positions: number[] } | { kind: "THIS" } }
  | { kind: "FORGET_ALL"; scope: MemoryForgetScope }
  | { kind: "CORRECT"; target: { kind: "LAST_REPLY" } }
  | { kind: "VETO"; target: { kind: "PREVIOUS_MESSAGE" } };

/**
 * What a command needs before anything is deleted:
 *   NONE      nothing is deleted — listing, pausing, resuming; a REPLACE is
 *             an ordinary statement, learned by L1 → L4
 *   EXPLICIT  a pending action the user confirms: typed "yes" or the
 *             on-screen button. Voice never confirms.
 *   STRICT    as EXPLICIT, but a typed confirmation must be the exact phrase:
 *             a wipe must never ride on a stray "great".
 * A VETO stops learning from the message at once; deleting what that message
 * already taught is EXPLICIT.
 */
export type MemoryConfirmation = "NONE" | "EXPLICIT" | "STRICT";

export const MEMORY_CONFIRMATION: Readonly<Record<MemoryCommandKind, MemoryConfirmation>> = Object.freeze({
  LIST: "NONE",
  FORGET: "EXPLICIT",
  FORGET_ALL: "STRICT",
  CORRECT: "EXPLICIT",
  REPLACE: "NONE",
  VETO: "EXPLICIT",
  LEARNING_PAUSE: "NONE",
  LEARNING_RESUME: "NONE",
  NONE: "NONE",
});

export const MEMORY_TOOL_IDS = Object.freeze({
  list: "memory.list",
  forget: "memory.forget",
  forgetAll: "memory.forget_all",
} as const);

/** The most memories one confirmation may forget by id. */
export const MEMORY_FORGET_LIMIT = 20;

/** The tools that delete. Registered for ToolExecutor; granted to no agent. */
export const DESTRUCTIVE_MEMORY_TOOL_IDS: readonly string[] = Object.freeze([MEMORY_TOOL_IDS.forget, MEMORY_TOOL_IDS.forgetAll]);

export function isDestructiveMemoryTool(toolId: string): boolean {
  return DESTRUCTIVE_MEMORY_TOOL_IDS.includes(toolId);
}

export function memoryToolConfirmation(toolId: string): MemoryConfirmation {
  if (toolId === MEMORY_TOOL_IDS.forgetAll) return "STRICT";
  if (toolId === MEMORY_TOOL_IDS.forget) return "EXPLICIT";
  return "NONE";
}

/** The exact words that confirm a STRICT action when typed. */
export const MEMORY_STRICT_CONFIRMATION = "yes, forget all";

function words(text: string): string {
  return text.toLowerCase().replace(/[^a-z]+/g, " ").trim();
}

export function isStrictMemoryConfirmation(message: string): boolean {
  return words(message) === words(MEMORY_STRICT_CONFIRMATION);
}

// ---------------------------------------------------------------------------
// The safe view
// ---------------------------------------------------------------------------

/**
 * A memory as its owner may see it. Never the raw metadata, the source or
 * conversation ids, a trace id, the vector or any internal confidence.
 */
export interface MemoryView {
  id: string;
  type: string;
  content: string;
  summary?: string;
  createdAt: string;
  /** When it last changed — also the version a destructive action is bound to. */
  changedAt: string;
  expiresAt?: string;
  /** Genuine user statements behind it (L4); 0 when none were recorded. */
  evidenceCount: number;
  firstSeenAt?: string;
  lastSeenAt?: string;
  revisions: number;
  /** Learned before provenance and evidence existed (pre-L2/L4). Shown, never hidden. */
  legacy: boolean;
}

function counter(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

/** The counts and dates of v1 evidence, read for display only — never for a learning decision. */
function evidenceSummary(value: unknown): { count: number; revisions: number; firstSeenAt: string; lastSeenAt: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const e = value as Record<string, unknown>;
  if (e.v !== 1 || !counter(e.count) || !counter(e.revisions)) return null;
  if (typeof e.firstSeenAt !== "string" || typeof e.lastSeenAt !== "string") return null;
  return { count: e.count, revisions: e.revisions, firstSeenAt: e.firstSeenAt, lastSeenAt: e.lastSeenAt };
}

export function toMemoryView(record: MemoryRecord): MemoryView {
  const evidence = evidenceSummary(record.metadata?.evidence);
  return {
    id: record.id,
    type: record.type,
    content: record.content,
    ...(record.summary ? { summary: record.summary } : {}),
    createdAt: record.createdAt.toISOString(),
    changedAt: record.updatedAt.toISOString(),
    ...(record.expiresAt ? { expiresAt: record.expiresAt.toISOString() } : {}),
    evidenceCount: evidence?.count ?? 0,
    ...(evidence ? { firstSeenAt: evidence.firstSeenAt, lastSeenAt: evidence.lastSeenAt } : {}),
    revisions: evidence?.revisions ?? 0,
    legacy: !evidence || record.sourceType !== "USER",
  };
}

// ---------------------------------------------------------------------------
// Learning controls — one small per-user document
// ---------------------------------------------------------------------------

export interface MemoryLearningControl {
  /** The user said to stop learning about them. Nothing new is persisted. */
  learningPaused: boolean;
  /** USER messages the user said not to learn from — the newest MEMORY_VETO_LIMIT. */
  vetoedSourceMessageIds: string[];
}

// ponytail: a veto older than the newest 200 is dropped, so a replay of a very
// old vetoed message could be learned again; keep a per-message flag if
// replays that old ever happen.
export const MEMORY_VETO_LIMIT = 200;

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * The stored document, read fail-closed. Absent means the defaults: learning
 * on, no vetoes. Present but unreadable means paused: when the user's own
 * setting cannot be read, nothing is learned.
 */
export function parseMemoryLearningControl(doc: unknown): MemoryLearningControl {
  if (doc === null || doc === undefined) return { learningPaused: false, vetoedSourceMessageIds: [] };
  const d = typeof doc === "object" ? (doc as Record<string, unknown>) : {};
  const ids = Array.isArray(d.vetoedSourceMessageIds) ? d.vetoedSourceMessageIds : null;
  if (d.v !== 1 || typeof d.learningPaused !== "boolean" || !ids || !ids.every(nonBlank)) {
    return { learningPaused: true, vetoedSourceMessageIds: (ids ?? []).filter(nonBlank) };
  }
  return { learningPaused: d.learningPaused, vetoedSourceMessageIds: ids.slice(-MEMORY_VETO_LIMIT) };
}

export function serializeMemoryLearningControl(control: MemoryLearningControl): Record<string, unknown> {
  return { v: 1, learningPaused: control.learningPaused, vetoedSourceMessageIds: [...control.vetoedSourceMessageIds] };
}

export function withLearningPaused(control: MemoryLearningControl, learningPaused: boolean): MemoryLearningControl {
  return { learningPaused, vetoedSourceMessageIds: [...control.vetoedSourceMessageIds] };
}

export function withVetoedSource(control: MemoryLearningControl, messageId: string): MemoryLearningControl {
  if (control.vetoedSourceMessageIds.includes(messageId)) return control;
  return {
    learningPaused: control.learningPaused,
    vetoedSourceMessageIds: [...control.vetoedSourceMessageIds, messageId].slice(-MEMORY_VETO_LIMIT),
  };
}

/** Whether a statement from `sourceMessageId` may be persisted. */
export function isLearningBlocked(control: MemoryLearningControl, sourceMessageId: string | undefined): boolean {
  return control.learningPaused || (sourceMessageId !== undefined && control.vetoedSourceMessageIds.includes(sourceMessageId));
}
