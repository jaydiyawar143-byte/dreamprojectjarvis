// S7.2 L2 — learning provenance.
//
// Where an automatically learned memory came from: the speaker, the
// conversation, the message, and the trace when one is known. A USER memory
// may only come from USER evidence; JARVIS's reply is context, never a source.
//
// `resolveUserProvenance` makes the one decision. The extraction model's
// citation for a candidate — the label of the message it came from and a
// verbatim quote — is only a POINTER: the speaker and every id are taken from
// the service's own record of that message, and the quote must really be in
// it. Anything else is refused with a reason, never defaulted to USER.
//
// Pure and deterministic: no imports, no I/O, no clock, no environment. The
// result is plain data (ids only, never text), safe to store and serialize.

export const PROVENANCE_SOURCE_TYPES = ["USER", "ASSISTANT", "SYSTEM"] as const;

export type ProvenanceSourceType = (typeof PROVENANCE_SOURCE_TYPES)[number];

/** The source of one learned memory. */
export interface LearningProvenance {
  sourceType: ProvenanceSourceType;
  sourceConversationId: string;
  sourceMessageId: string;
  /** Present only when the source message carried one. */
  sourceTraceId?: string;
}

/** One message of the turn, as the service recorded it and labelled it for the model. */
export interface ProvenanceSource {
  /** The label the extraction model saw, e.g. "M1". */
  ref: string;
  sourceType: ProvenanceSourceType;
  /** The message text — used only to check the quote, never returned. */
  statement: string;
  sourceConversationId?: string;
  sourceMessageId?: string;
  sourceTraceId?: string;
}

/** What the extraction model said about a candidate's origin. Untrusted. */
export interface ProvenanceCitation {
  source?: unknown;
  evidence?: unknown;
}

/** Why a candidate got no USER provenance, in the order the checks run. */
export const PROVENANCE_REJECTIONS = [
  "SOURCE_MISSING",
  "SOURCE_UNKNOWN",
  "SOURCE_NOT_USER",
  "SOURCE_IDS_MISSING",
  "EVIDENCE_MISSING",
  "EVIDENCE_NOT_IN_SOURCE",
] as const;

export type ProvenanceRejection = (typeof PROVENANCE_REJECTIONS)[number];

export type ProvenanceResolution =
  | { accepted: true; provenance: LearningProvenance }
  | { accepted: false; reason: ProvenanceRejection };

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeRef(ref: string): string {
  return ref.trim().replace(/^\[\s*/, "").replace(/\s*\]$/, "").toUpperCase();
}

/** Compared as text: Unicode-normalized, curly quotes straightened, whitespace collapsed, case-folded. */
function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** A quote without the quotation marks or sentence punctuation around it. */
function quoteBody(evidence: string): string {
  return normalizeText(evidence).replace(/^[\s"'`.,!?;:]+|[\s"'`.,!?;:]+$/g, "");
}

function reject(reason: ProvenanceRejection): ProvenanceResolution {
  return { accepted: false, reason };
}

export function resolveUserProvenance(
  citation: ProvenanceCitation,
  sources: readonly ProvenanceSource[]
): ProvenanceResolution {
  if (!nonBlank(citation.source)) return reject("SOURCE_MISSING");

  const ref = normalizeRef(citation.source);
  const matches = sources.filter((s) => normalizeRef(s.ref) === ref);
  if (matches.length !== 1) return reject("SOURCE_UNKNOWN");
  const source = matches[0]!;

  if (source.sourceType !== "USER") return reject("SOURCE_NOT_USER");
  if (!nonBlank(source.sourceConversationId) || !nonBlank(source.sourceMessageId)) return reject("SOURCE_IDS_MISSING");

  if (typeof citation.evidence !== "string") return reject("EVIDENCE_MISSING");
  const quote = quoteBody(citation.evidence);
  if (!/[\p{L}\p{N}]/u.test(quote)) return reject("EVIDENCE_MISSING");
  if (!normalizeText(source.statement).includes(quote)) return reject("EVIDENCE_NOT_IN_SOURCE");

  return {
    accepted: true,
    provenance: {
      sourceType: "USER",
      sourceConversationId: source.sourceConversationId,
      sourceMessageId: source.sourceMessageId,
      ...(nonBlank(source.sourceTraceId) ? { sourceTraceId: source.sourceTraceId } : {}),
    },
  };
}
