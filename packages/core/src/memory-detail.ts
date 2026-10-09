// ---------------------------------------------------------------------------
// Phase 14 — projects, and a memory as its OWNER manages it.
//
// A PROJECT is the smallest thing that can give a memory a scope: a name the
// user chose, owned by that user. It is not a project-management system — it
// has no members, no tasks and no settings.
//
//   memory.projectId absent   a PERSONAL memory, usable in every conversation
//                             of its owner
//   memory.projectId = X      a PROJECT memory, usable only in conversations
//                             of project X
//
// THE ACTIVE PROJECT IS A PROPERTY OF THE CONVERSATION. It is chosen once,
// when the conversation is created (`projectId` on the first chat request),
// checked against the user's own projects, stored on the conversation row and
// never changed. Every later turn reads it from that row — a later request
// cannot name a different one. A conversation with no project is personal.
//
// `MemoryDetail` is what the memory screen and the memory API return. It adds
// to the chat's safe view (`MemoryView`) what an owner needs to manage a
// memory — its confidence, its project and where it came from — and still
// never the vector, the raw metadata, or a message, conversation or trace id.
//
// Pure: no I/O, no clock (the caller passes `now`), no randomness.
// ---------------------------------------------------------------------------

import type { MemoryRecord } from "./types/memory.js";
import { memoryEvidenceSummary, toMemoryView, type MemoryView } from "./memory-management.js";
import { effectiveMemoryConfidence, memoryConfidenceLevel, type MemoryConfidenceLevel } from "./memory-relevance.js";

export interface Project {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export const PROJECT_NAME_MAX_LENGTH = 80;
export const PROJECT_DESCRIPTION_MAX_LENGTH = 500;
/** The most projects one user may hold. A bound, not a product limit. */
export const PROJECT_LIMIT = 100;

export interface MemoryProvenanceSummary {
  /** USER: learned from the user's own saved message. LEGACY: from before sources were recorded. */
  source: "USER" | "LEGACY";
  /** Distinct messages in which the user stated it. */
  statements: number;
  /** Distinct conversations in which the user stated it. */
  conversations: number;
  firstStatedAt?: string;
  lastStatedAt?: string;
  /** How many times its wording was replaced by a later statement or a correction. */
  revisions: number;
}

export interface MemoryDetail extends MemoryView {
  /** The same instant as `changedAt`, under the name the API documents. */
  updatedAt: string;
  /** Evidence-derived, 0–0.95. Never a number a model chose. */
  confidence: number;
  confidenceLevel: MemoryConfidenceLevel;
  /** `null` for a personal memory. */
  projectId: string | null;
  /** The project's name, when the caller supplied the user's projects. */
  projectName?: string;
  provenance: MemoryProvenanceSummary;
  /** Past its expiry: no longer recalled, kept only until the retention sweep. */
  expired: boolean;
}

export function toMemoryDetail(record: MemoryRecord, now: Date, projectNames?: ReadonlyMap<string, string>): MemoryDetail {
  const view = toMemoryView(record);
  const evidence = memoryEvidenceSummary(record.metadata?.evidence);
  const confidence = effectiveMemoryConfidence(record);
  const projectName = record.projectId ? projectNames?.get(record.projectId) : undefined;
  return {
    ...view,
    updatedAt: view.changedAt,
    confidence,
    confidenceLevel: memoryConfidenceLevel(confidence),
    projectId: record.projectId ?? null,
    ...(projectName ? { projectName } : {}),
    provenance: {
      source: view.legacy ? "LEGACY" : "USER",
      statements: evidence?.count ?? 0,
      conversations: evidence?.conversations ?? 0,
      ...(evidence ? { firstStatedAt: evidence.firstSeenAt, lastStatedAt: evidence.lastSeenAt } : {}),
      revisions: evidence?.revisions ?? 0,
    },
    expired: record.expiresAt !== undefined && record.expiresAt.getTime() <= now.getTime(),
  };
}
