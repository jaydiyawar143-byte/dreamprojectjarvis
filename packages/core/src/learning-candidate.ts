// ---------------------------------------------------------------------------
// S7.2 L1 — the learning-candidate contract. Step 1: REJECTION RULES ONLY.
//
// A learning candidate is a statement that might become a memory. This module
// decides, with fixed deterministic rules and no model, what may NEVER become
// one — the parts of the answer the architecture has already settled:
//
//   - nothing that grants authorization or approval (the S1 allowlist, the
//     write-intent gate and confirmations are code, never learned data);
//   - no secret (the memory secret filters already forbid them);
//   - no claim that exists only in JARVIS's own reply;
//   - no temporary or one-off instruction;
//   - no acknowledgement, silence or follow-up question (S5: silence and
//     "thanks" are not feedback, and they are not facts either).
//
// L1b Step 2 adds ACCEPT — only for a USER statement that is clearly a
// stable, user-owned preference, personal fact or working convention — and
// gives everything else a named UNDECIDED reason (uncertain, hypothetical,
// one-off, general, permission language, or simply not clear enough).
// Step 1's rules still run first and are unchanged. L1c-2 adds one rejection
// after them: USER_MEMORY_VETO, for an explicit "don't save this". NEEDS_CONFIRMATION,
// SUPERSEDE, confidence, corroboration, expiry and project scope belong to
// later S7.2 layers and are not decided here.
//
// PURE. No imports, no clock, no randomness, no I/O. Nothing calls this yet:
// it is deliberately not exported from the package index, and a source-scan
// test pins that no memory, agent, gate, policy, executor or API module
// references it.
// ---------------------------------------------------------------------------

/**
 * Whose words a candidate is grounded in. The CALLER establishes this from
 * provenance; the text is never used to guess it. Anything else is rejected.
 */
export type LearningStatedBy = "USER" | "ASSISTANT";

export interface LearningCandidateInput {
  /** The text that would be remembered. */
  statement: string;
  /** Who said it. Only the user's own words can ever be learned. */
  statedBy: LearningStatedBy;
}

/**
 * Every rule, in PRECEDENCE order: the first that matches decides, so the
 * reported rule is always the most serious reason.
 */
export const LEARNING_RULES = [
  "EMPTY_STATEMENT",
  "CONTAINS_SECRET",
  "GRANTS_AUTHORIZATION",
  "ORIGIN_UNKNOWN",
  "ASSISTANT_ONLY_CLAIM",
  "TEMPORARY_INSTRUCTION",
  "ACKNOWLEDGEMENT_ONLY",
  "QUESTION_ONLY",
  // L1c-2 — the user explicitly says not to save it. A rejection, placed
  // after Step 1's rules (whose verdicts are unchanged) and before any L1b rule.
  "USER_MEMORY_VETO",
  // L1b — reached only by a USER statement no Step 1 rule decided. The
  // reasons to hold back come before acceptance, so doubt always wins.
  "PERMISSION_LANGUAGE",
  "AMBIGUOUS_PREFERENCE",
  "HYPOTHETICAL_STATEMENT",
  "ONE_OFF_CONTEXT",
  "GENERAL_STATEMENT",
  "STABLE_PREFERENCE",
  "STABLE_WORKING_CONVENTION",
  "STABLE_PERSONAL_FACT",
  // Nothing identified it as stable: not clear enough to accept.
  "NO_REJECTION_RULE_MATCHED",
] as const;

export type LearningRule = (typeof LEARNING_RULES)[number];

/**
 * REJECT — must never be learned. NOT_A_CANDIDATE — nothing here to learn.
 * ACCEPT — a clearly stable, user-owned statement. UNDECIDED — possibly
 * useful, but not clear enough to learn automatically.
 */
export type LearningDecisionKind = "REJECT" | "NOT_A_CANDIDATE" | "ACCEPT" | "UNDECIDED";

export interface LearningDecision {
  decision: LearningDecisionKind;
  /** The named rule that produced the decision. Never the statement itself. */
  rule: LearningRule;
}

const DECISION_OF: Readonly<Record<LearningRule, LearningDecisionKind>> = Object.freeze({
  EMPTY_STATEMENT: "NOT_A_CANDIDATE",
  CONTAINS_SECRET: "REJECT",
  GRANTS_AUTHORIZATION: "REJECT",
  ORIGIN_UNKNOWN: "REJECT",
  ASSISTANT_ONLY_CLAIM: "REJECT",
  TEMPORARY_INSTRUCTION: "REJECT",
  ACKNOWLEDGEMENT_ONLY: "NOT_A_CANDIDATE",
  QUESTION_ONLY: "NOT_A_CANDIDATE",
  USER_MEMORY_VETO: "REJECT",
  PERMISSION_LANGUAGE: "UNDECIDED",
  AMBIGUOUS_PREFERENCE: "UNDECIDED",
  HYPOTHETICAL_STATEMENT: "UNDECIDED",
  ONE_OFF_CONTEXT: "UNDECIDED",
  GENERAL_STATEMENT: "UNDECIDED",
  STABLE_PREFERENCE: "ACCEPT",
  STABLE_WORKING_CONVENTION: "ACCEPT",
  STABLE_PERSONAL_FACT: "ACCEPT",
  NO_REJECTION_RULE_MATCHED: "UNDECIDED",
});

// ---------------------------------------------------------------------------
// Secrets — a superset of every existing secret filter, so the contract is
// never weaker than the paths it will later guard. Sources:
//   [core]  utils/redact-secrets.ts
//   [ext]   memory-extraction-service.ts
//   [repo]  memory-repository.ts
//   [new]   obvious credential shapes none of them covered
// (Consolidating the three existing lists into one helper is follow-up work;
// it would touch those modules, which this step must not.)
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-(?:proj|ant|org)?[A-Za-z0-9_-]{10,}/, // [core][repo] model-provider "sk-" keys
  /\bsk[_-][A-Za-z0-9]{20,}/, // [ext]
  /\bsk_(?:live|test)_[A-Za-z0-9]{20,}/, // [ext] Stripe
  /\bEAA[A-Za-z0-9_-]{10,}/, // [core] Meta access token
  /\beyJ[A-Za-z0-9._-]{20,}/, // [core] JWT
  /\bbearer\s+[A-Za-z0-9._-]{20,}/i, // [core][ext][repo]
  /\b(?:password|passwd|pwd)\s*[:=]\s*\S+/i, // [core][ext][repo]
  /\b(?:api[_-]?key|apikey)\s*[:=]\s*\S+/i, // [core][ext][repo]
  /\b(?:access[_-]?token|jwt|token)\s*[:=]\s*\S+/i, // [core][repo]
  /\b(?:secret|token|credential)\s*[:=]\s*\S+/i, // [ext]
  /\b(?:jwt|refresh[_-]?token)\s*[:=]\s*\S+/i, // [ext]
  /\b(?:DATABASE_URL|DB_PASSWORD|DB_PASS)\s*[:=]\s*\S+/i, // [ext]
  /-----BEGIN\s+(?:[A-Z]+\s+)*PRIVATE\s+KEY-----/, // [ext] extended to OPENSSH / EC
  /\bghp_[A-Za-z0-9]{36,}/, // [ext] GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/, // [new] GitHub fine-grained
  // [new] a credential stated in prose: "my password is …", "the OTP is …"
  /\b(?:password|passwd|passcode|pwd|api[\s_-]?key|access[\s_-]?token|refresh[\s_-]?token|otp|one[\s-]?time\s+(?:password|code|pin))\s+(?:is|was)\s+\S+/i,
  /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|amqps?):\/\/[^\s:@/]+:[^\s@/]+@/i, // [new] URL with credentials
  /\bAKIA[0-9A-Z]{16}\b/, // [new] AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}/, // [new] Google API key
  /\bxox[abprs]-[0-9A-Za-z-]{10,}/, // [new] Slack token
];

// ---------------------------------------------------------------------------
// Authorization / approval granting. A GRANT is refused; a RESTRICTION
// ("always ask me", "never without my approval", "you can't … without
// asking") is not a grant and is left alone.
// ---------------------------------------------------------------------------

const NEGATED = "(?:don't|do\\s+not|doesn't|does\\s+not|no\\s+longer|never)";
const APPROVAL_NOUN = "(?:approval|permission|confirmation|consent|sign[-\\s]?off|go-ahead)";

const AUTHORIZATION_PATTERNS: readonly RegExp[] = [
  // "you can / may / feel free to / go ahead and … without asking | my approval"
  new RegExp(
    "\\b(?:can(?!'t|not)|may|feel\\s+free\\s+to|go\\s+ahead\\s+and|have\\s+(?:my\\s+)?permission\\s+to)\\b" +
      "(?:(?!\\b(?:never|not)\\b|n't)[^.!?]){0,80}?" +
      `\\bwithout\\s+(?:asking|checking|confirm(?:ing|ation)|(?:my|any)\\s+(?:${APPROVAL_NOUN}|ok(?:ay)?)|${APPROVAL_NOUN})`,
    "i"
  ),
  // "you don't need to ask me / check with me / wait for my …"
  new RegExp(
    `\\b${NEGATED}\\s+(?:need|have)\\s+to\\s+` +
      "(?:ask\\s+(?:me|first|for\\s+(?:my\\s+)?(?:approval|permission|confirmation))|check\\s+with\\s+me|confirm\\s+with\\s+me|" +
      "confirm\\s+(?:it\\s+)?first|wait\\s+for\\s+(?:me|my)|get\\s+(?:my\\s+)?(?:approval|permission|confirmation|sign[-\\s]?off))",
    "i"
  ),
  // "you don't need my approval"
  new RegExp(`\\b${NEGATED}\\s+need\\s+(?:my\\s+|any\\s+|an?\\s+)?${APPROVAL_NOUN}\\b`, "i"),
  // "no need to ask / confirm", "no need for my approval"
  new RegExp(
    "\\bno\\s+need\\s+(?:to\\s+(?:ask|confirm|check\\s+with\\s+me|wait\\s+for\\s+(?:me|my))|" +
      `for\\s+(?:my\\s+|any\\s+)?${APPROVAL_NOUN})`,
    "i"
  ),
  // "you have / you've got my permission …"
  new RegExp(
    "\\byou\\s+(?:now\\s+)?(?:have|'ve|'ve\\s+got|got)\\s+(?:my\\s+|full\\s+|the\\s+)?(?:permission|authori[sz]ation|approval|go-ahead|consent)\\b",
    "i"
  ),
  // "you're allowed / authorised / permitted to …"
  /\byou(?:'re|\s+are|\s+have\s+been|'ve\s+been)?\s+(?:now\s+)?(?:allowed|authori[sz]ed|permitted|cleared|free)\s+to\b/i,
  // "I grant you full access"
  /\bgrant(?:s|ed|ing)?\s+you\s+(?:full\s+|my\s+|the\s+)?(?:permission|access|authori[sz]ation|approval|rights?|control)\b/i,
  // "skip the approval step" (but not "don't skip the approval")
  /(?<!\b(?:don't|not|never)\s)\b(?:skip|bypass|ignore|disable|turn\s+off)\s+(?:the\s+|my\s+|all\s+)?(?:approval|confirmation|permission|consent)s?\b/i,
  // "auto-approve"
  /\bauto[-\s]?approv(?:e|es|ed|ing|al)\b/i,
  // "approve everything automatically / on my behalf / yourself"
  /\bapprov(?:e|es|ing)\b[^.!?]{0,40}\b(?:automatically|on\s+my\s+behalf|yourself|without\s+(?:me|asking|checking))/i,
  // Hinglish: "puchne ki zarurat nahi", "approval ki zarurat nahi"
  /\b(?:puchh?ne|poochh?ne|approval|permission|confirm(?:ation)?)\s+ki\s+(?:koi\s+)?(?:zaa?ru?rat|zaroorat|jaa?ru?rat|jaroorat)\s+nahi?n?\b/i,
];

// ---------------------------------------------------------------------------
// Temporary / one-off instructions — context for one turn, never a lasting fact.
// ---------------------------------------------------------------------------

const TEMPORARY_PATTERNS: readonly RegExp[] = [
  /\b(?:not|don't|do\s+not|mat)\b[^.!?]{0,40}\byet\b/i, // "don't send this yet"
  /\bfor\s+(?:this|that|the\s+current)\s+(?:\w+\s+){0,2}only\b/i, // "for this task only"
  /\bonly\s+(?:for|in)\s+(?:this|that|today's|todays|today|the\s+current)\b/i, // "only for this email"
  /\b(?:just\s+)?this\s+once\b/i,
  /\bone[-\s]?off\b/i,
  /\bone[-\s]?time\s+(?:only|thing|exception|request)\b/i,
  /\bfor\s+today(?:'s|s)?\b[^.!?]{0,40}\bonly\b/i, // "for today's campaign only"
  /\b(?:today|tonight)\s+only\b/i,
  /\bfor\s+now\b/i,
  /\bsirf\s+(?:aaj|abhi|is\s+baar|iss\s+baar)\b/i, // Hinglish "only today / now / this time"
  /\babhi\s+mat\b/i, // Hinglish "not now"
  /\b(?:is|iss)\s+baar\b/i, // Hinglish "this time"
];

// ---------------------------------------------------------------------------
// Not a candidate — acknowledgements and follow-up questions.
// ---------------------------------------------------------------------------

const ACKNOWLEDGEMENT =
  /^(?:ok(?:ay)?|k|thanks?(?:\s+(?:a\s+lot|so\s+much|again))?|thank\s+you(?:\s+(?:so\s+much|very\s+much))?|thx|ty|cool|great|nice|awesome|perfect|fine|sure|yes|yeah|yep|no|nope|got\s+it|sounds\s+good|noted|alright|all\s+right|done|theek\s+hai|thik\s+hai|theek|thik|accha|achha|acha|haan|han|ha|ji|shukriya|dhanyavaad|dhanyawad)(?:\s+(?:ji|jarvis|bhai))?$/i;

/** An explicit request to remember is a candidate even when phrased as a question. */
const REMEMBER_REQUEST = /\b(?:remember|note\s+that|keep\s+in\s+mind|don't\s+forget|yaad\s+rakh(?:na|o|iye|ein)?)\b/i;

const QUESTION_OPENER =
  /^(?:what|what's|whats|why|how|when|where|who|whom|whose|which|can\s+you|could\s+you|would\s+you|will\s+you|do\s+you|did\s+you|does|is\s+there|are\s+there|is\s+it|are\s+you|kya|kaise|kyun|kyon|kab|kaun|kahan|kitna|kitne)\b/i;

// ---------------------------------------------------------------------------
// L1c-2 — the user's veto: "don't save / remember / store this", "forget
// this", "off the record". Only an explicit negation of remembering, and only
// about the conversation's content ("this", "what I said", "my … details"),
// so "don't forget to …", "remember that …" and "don't keep my captions long"
// are not vetoes.
// ---------------------------------------------------------------------------

const VETO_NEGATION = "(?:please\\s+don't|pls\\s+don't|don't|do\\s+not|never|no\\s+need\\s+to|not\\s+to)";
const VETO_VERB = "(?:save|store|remember|memori[sz]e|record|retain|log|keep|write\\s+down|note\\s+down)";
const VETO_OBJECT =
  "(?:this|that|it|these|those|anything|any\\s+of\\s+(?:this|that|it)|what\\s+i\\s+(?:just\\s+)?(?:said|told\\s+you|wrote)|my\\s+(?:\\w+\\s+){0,2}(?:details|information|info|data|number|address))";

const MEMORY_VETO_PATTERNS: readonly RegExp[] = [
  new RegExp(`\\b${VETO_NEGATION}\\s+(?:ever\\s+)?${VETO_VERB}\\s+${VETO_OBJECT}\\b`, "i"),
  new RegExp(`(?<!\\b(?:don't|do\\s+not|never)\\s)\\bforget\\s+(?:about\\s+)?${VETO_OBJECT}\\b`, "i"),
  new RegExp(`\\b(?:don't|do\\s+not|never)\\s+put\\s+${VETO_OBJECT}\\s+in\\s+(?:your\\s+)?memory\\b`, "i"),
  /\boff\s+the\s+record\b/i,
  // Hinglish: "yaad mat rakhna", "save mat karna", "mat save karo", "bhool jao"
  /\b(?:yaad|save|store|record)\s+(?:mat|na|nahi|nahin)\s+(?:rakh\w*|kar\w*)\b/i,
  /\bmat\s+(?:save|store|record)\b/i,
  /\bbhool\s+ja(?:o|na|iye|ein)\b/i,
];

// ---------------------------------------------------------------------------
// L1b — acceptance. Reached only by a USER statement that no Step 1 rule
// decided. Every reason to hold back is checked BEFORE any acceptance rule.
// ---------------------------------------------------------------------------

/** Permission or authentication language: never learned automatically. */
const PERMISSION_LANGUAGE =
  /\b(?:approv\w*|permissions?|authori[sz]\w*|authenticat\w*|confirm\w*|consent\w*|access|ask(?:ing)?\s+me|check(?:ing)?\s+with\s+me|log\s?in|sign\s?in|username|user\s+name|credentials?|passwords?|passcodes?|otp|2fa|two[-\s]factor|pin\s+code|api[\s_-]?keys?|tokens?|secrets?)\b/i;

/** Uncertain language. */
const AMBIGUOUS =
  /\b(?:maybe|perhaps|possibly|probably|i\s+think|i\s+guess|i\s+suppose|i\s+believe|i\s+feel\s+like|not\s+sure|kind\s+of|sort\s+of|shayad|lagta\s+hai|ho\s+sakta\s+hai)\b/i;

/** Hypothetical or conditional language. */
const HYPOTHETICAL =
  /\b(?:if|unless|would|could|might|suppose|supposing|imagine|hypothetically|in\s+case|agar)\b|'d\s+(?:prefer|like|want|love)\b/i;

/** Bound to something in the current context or a point in time. */
const ONE_OFF_PATTERNS: readonly RegExp[] = [
  /\b(?:this|these)\b/i,
  /\b(?:that|those)\s+(?:one|ones|post|posts|design|designs|campaign|version|thing|option|style|file|image|caption|email|report|template|draft|idea|ad)\b/i,
  /\b(?:that|those)$/i,
  /\b(?:today|tomorrow|tonight|yesterday|right\s+now|later|soon|next\s+(?:week|month|year|time))\b/i,
  /\b(?:aaj|kal|abhi)\b/i,
  /\b(?:like|love|want|prefer|hate|enjoy|keep|use|do)\s+(?:it|them|you)$/i,
];

/** A statement that names the user (or the user's own business). */
const FIRST_PERSON =
  /\b(?:i|i'm|i've|i'd|i'll|me|my|mine|myself|we|we're|we've|our|ours|us|mujhe|mera|meri|mere|hum|hamara|hamari|hamare)\b/i;

/** An instruction to JARVIS, optionally with a leading always / never / don't. */
const IMPERATIVE =
  /^(?:(?:always|never|don't|do\s+not)\s+)?(?:keep|use|make|write|format|show|display|send|post|create|design|add|include|avoid|put|give|set|schedule|reply|respond|address|call|sign|mention|highlight|share|translate|convert|round|list|sort|draft|prepare|mark|tag|label|spell|name|present|quote|price|remind|start|stop|end|open|close|do|stick|limit|cap|follow)\b/i;

/** "From now on, …" and friends make an instruction standing. */
const STANDING_PREFIX = /^(?:from\s+now\s+on|going\s+forward|by\s+default|in\s+general|as\s+a\s+rule)\b\s*,?\s*/i;
const STANDING_MARKER =
  /\b(?:my|by\s+default|as\s+(?:a|the|my)\s+default|from\s+now\s+on|going\s+forward|whenever|every\s+time|always|never)\b/i;

const HABIT =
  /\b(?:every\s+(?:day|week|month|morning|evening|night|weekday|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|daily|weekly|monthly|on\s+(?:mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays|weekdays|weekends))\b/i;

const PREFERENCE =
  /^i\s+(?:(?:really|always|usually|generally|mostly|normally|typically|also|strongly|definitely)\s+)?(prefer|like|love|want|enjoy|dislike|hate|don't\s+like|do\s+not\s+like|don't\s+want|do\s+not\s+want|can't\s+stand|cannot\s+stand)\s+(\S.*)$/i;
const NAMED_PREFERENCE = /^my\s+(?:most\s+)?(?:preferred|favou?rite)\s+[\w\s'-]+?\s+(?:is|are)\s+\S/i;
const HINGLISH_PREFERENCE = /^mujhe\s+.+?\s+pasand\s+(?:nahi\s+)?(?:hai|hain|he|h)\b/i;

const PERSONAL_FACT_PATTERNS: readonly RegExp[] = [
  /^my\s+(?!(?:most\s+)?(?:preferred|favou?rite|defaults?)\b)[\w'-]+(?:\s+[\w'-]+){0,4}\s+(?:is|are)\s+\S/i,
  /^i\s+(?:only\s+|mainly\s+|mostly\s+|also\s+)?(?:work|live|run|own|manage|lead|use|speak|sell|handle|teach|build|operate)\s+\S/i,
  /^i(?:\s+am|'m)\s+(?:a|an|the|based|from|located|living|working)\b/i,
];

/** The part of the statement to classify: without "please remember that …" or end punctuation. */
function classifiable(text: string): string {
  return text
    .replace(/[\s.!?]+$/u, "")
    .replace(
      /^(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?(?:remember|note|keep\s+in\s+mind|don't\s+forget)(?:\s+that)?\s*[,:]?\s*/i,
      ""
    )
    .trim();
}

function isStablePreference(text: string): boolean {
  const match = PREFERENCE.exec(text);
  if (match) {
    const verb = match[1]!.toLowerCase();
    const object = match[2]!.trim();
    if (/\bwant$/.test(verb) && /^to\b/i.test(object)) return false; // "I want to launch …" is an intention
    if (/^(?:it|them|you|this|that|these|those)\b/i.test(object)) return false;
    return true;
  }
  return NAMED_PREFERENCE.test(text) || HINGLISH_PREFERENCE.test(text);
}

function isWorkingConvention(text: string): boolean {
  if (/^my\s+defaults?\b/i.test(text)) return true; // "My default platform … is …"
  if (/^(?:for|in|with|across)\s+(?:all\s+(?:of\s+)?)?my\s+[\w'-]+/i.test(text)) return true; // "For my projects, …"

  const standing = STANDING_PREFIX.test(text);
  const instruction = text.replace(STANDING_PREFIX, "").replace(/^please\s+/i, "");
  if (IMPERATIVE.test(instruction) && (standing || STANDING_MARKER.test(instruction))) return true;

  // The user's own routine: "I usually post on Mondays", "I send reports every Monday".
  if (/^i\s+(?:usually|always|normally|typically|generally|mostly|regularly|often|never)\s+(?!(?:want|like|prefer|love|enjoy|hate|dislike)\b)[a-z]+/i.test(text)) {
    return true;
  }
  return /^i\s+[a-z]+\b/i.test(text) && HABIT.test(text);
}

function acceptanceRuleFor(text: string): LearningRule {
  const statement = classifiable(text);

  if (PERMISSION_LANGUAGE.test(statement)) return "PERMISSION_LANGUAGE";
  if (AMBIGUOUS.test(statement)) return "AMBIGUOUS_PREFERENCE";
  if (HYPOTHETICAL.test(statement)) return "HYPOTHETICAL_STATEMENT";
  if (matchesAny(ONE_OFF_PATTERNS, statement)) return "ONE_OFF_CONTEXT";
  const instruction = statement.replace(STANDING_PREFIX, "").replace(/^please\s+/i, "");
  if (!FIRST_PERSON.test(statement) && !IMPERATIVE.test(instruction)) return "GENERAL_STATEMENT";

  if (isStablePreference(statement)) return "STABLE_PREFERENCE";
  if (isWorkingConvention(statement)) return "STABLE_WORKING_CONVENTION";
  if (matchesAny(PERSONAL_FACT_PATTERNS, statement)) return "STABLE_PERSONAL_FACT";

  return "NO_REJECTION_RULE_MATCHED";
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

function normalize(statement: string): string {
  return statement.replace(/[‘’ʼ]/g, "'").replace(/\s+/g, " ").trim();
}

function matchesAny(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function ruleFor(input: LearningCandidateInput): LearningRule {
  const raw: unknown = input?.statement;
  if (typeof raw !== "string") return "EMPTY_STATEMENT";
  const text = normalize(raw);
  if (!/[\p{L}\p{N}]/u.test(text)) return "EMPTY_STATEMENT";

  if (matchesAny(SECRET_PATTERNS, text)) return "CONTAINS_SECRET";
  if (matchesAny(AUTHORIZATION_PATTERNS, text)) return "GRANTS_AUTHORIZATION";

  const statedBy: unknown = input.statedBy;
  if (statedBy !== "USER" && statedBy !== "ASSISTANT") return "ORIGIN_UNKNOWN";
  if (statedBy === "ASSISTANT") return "ASSISTANT_ONLY_CLAIM";

  if (matchesAny(TEMPORARY_PATTERNS, text)) return "TEMPORARY_INSTRUCTION";

  const bare = text.replace(/[^\p{L}\p{N}\s']+/gu, " ").replace(/\s+/g, " ").trim();
  if (ACKNOWLEDGEMENT.test(bare)) return "ACKNOWLEDGEMENT_ONLY";

  const asksSomething = text.endsWith("?") || QUESTION_OPENER.test(text);
  if (asksSomething && !REMEMBER_REQUEST.test(text)) return "QUESTION_ONLY";

  if (matchesAny(MEMORY_VETO_PATTERNS, text)) return "USER_MEMORY_VETO";

  return acceptanceRuleFor(text);
}

/**
 * Decides what the rejection rules say about one learning candidate.
 * Deterministic and pure: the same input always gives the same decision, and
 * the decision carries a rule name, never the statement.
 */
export function decideLearningCandidate(input: LearningCandidateInput): LearningDecision {
  const rule = ruleFor(input);
  return { decision: DECISION_OF[rule], rule };
}
