// ---------------------------------------------------------------------------
// Visual intent — "would a picture help, and a picture of what?"
//
// ---------------------------------------------------------------------------
// WHAT THIS IS NOT.
//
// It is not a second agent router. It has no opinion about which agent answers,
// which tool runs, or whether anything is permitted — all of that already
// happened, in `AgentRouter` and the orchestrator, and this never touches it.
// The only question here is whether the answer that is ALREADY being produced
// would land better with a panel next to it, and if so which panel.
//
// WHY IT IS RULES AND NOT A MODEL CALL.
//
// Because it runs on every message, and because being wrong is cheap in one
// direction and expensive in the other. A missed surface costs the user a
// picture they would have liked. A hallucinated one throws a panel over the
// screen for "what is 2 + 2". Rules are auditable, instant, free, and cannot
// invent a fourteenth surface type that has no renderer.
//
// A model still gets the final say in the other direction: `surface-decision`
// will DECLINE to open a surface the rules asked for when the tools came back
// with nothing real to show. Rules propose; data disposes.
//
// HINDI AND HINGLISH ARE FIRST-CLASS.
//
// Every worked example in this feature's brief is Hinglish — "abhi kya time hua
// hai", "Balaghat se Gondia jaane ka best route", "Solana mein invest karna
// chahiye". Latin-script Hindi is how this product is actually spoken to, so it
// is matched directly rather than left to a translation step that would add a
// network round trip to deciding whether to draw a clock.
// ---------------------------------------------------------------------------

export type VisualIntent =
  | "TIME"
  | "WORLD_TIME"
  | "ROUTE"
  | "PLACE_SEARCH"
  | "WEATHER"
  | "MARKET_PRICE"
  | "MARKET_ANALYSIS"
  | "SYSTEM_STATUS"
  | "TASKS"
  | "KNOWLEDGE"
  | "CLOSE_SURFACE"
  | "NONE";

export interface VisualIntentResult {
  intent: VisualIntent;
  /** 0..1. Below `MIN_CONFIDENCE` the caller treats it as NONE. */
  confidence: number;
  /** The phrases that matched, for the audit record and for debugging. */
  signals: string[];
}

/** Below this a match is too thin to justify covering part of the screen. */
export const MIN_CONFIDENCE = 0.5;

const norm = (s: string) =>
  s
    .toLowerCase()
    // Devanagari is kept; only punctuation is flattened, so "समय" still matches.
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

interface Rule {
  intent: VisualIntent;
  /** Any of these present is a hit. */
  any: RegExp[];
  /** All of these must also be present, when given. */
  requires?: RegExp[];
  /** None of these may be present. */
  unless?: RegExp[];
  weight: number;
}

// Word-boundary helper. `\b` is unreliable next to Devanagari, so matching is
// done against space-padded text instead.
const w = (...alts: string[]) => new RegExp(`(?:^| )(?:${alts.join("|")})(?: |$)`, "u");

/**
 * Ordered by specificity: the first rule that fires wins.
 *
 * "Solana mein invest karna chahiye" contains a coin name AND an investment
 * verb; it must resolve to ANALYSIS, not PRICE, so ANALYSIS is listed first.
 * The same reasoning puts WORLD_TIME above TIME and ROUTE above PLACE_SEARCH.
 */
const RULES: Rule[] = [
  // ---- explicit dismissal ------------------------------------------------
  {
    intent: "CLOSE_SURFACE",
    any: [
      w("close", "band", "hatao", "hata", "dismiss", "chhupao", "chupao"),
      /(?:^| )(?:close|hide|dismiss) (?:it|this|the |that)/u,
      /(?:band|bandh) (?:karo|kar do|kardo)/u,
    ],
    weight: 0.95,
  },

  // ---- market ------------------------------------------------------------
  {
    intent: "MARKET_ANALYSIS",
    any: [
      w("invest", "investment", "nivesh", "analyse", "analyze", "analysis"),
      /invest (?:karna|karu|karun|kare|should)/u,
      /(?:worth|good) (?:buying|investing)/u,
      /(?:buy|sell) (?:karna|karu|karun)/u,
      w("bullish", "bearish", "risk", "risky"),
    ],
    // Only an analysis surface if it is about something tradeable — otherwise
    // "should I invest time in this" would open a price card.
    requires: [
      /(?:solana|sol|bitcoin|btc|ethereum|eth|crypto|coin|token|stock|share|market|nifty|banknifty|sensex)/u,
    ],
    weight: 0.9,
  },
  {
    intent: "MARKET_PRICE",
    any: [
      w("price", "rate", "bhav", "daam", "keemat", "quote"),
      w("solana", "sol", "bitcoin", "btc", "ethereum", "eth"),
      w("crypto", "cryptocurrency", "market", "nifty", "banknifty", "sensex"),
      /(?:kya|kitna|kitne) (?:price|rate|bhav|daam)/u,
    ],
    requires: [
      /(?:solana|sol|bitcoin|btc|ethereum|eth|crypto|coin|token|price|rate|bhav|daam|market|nifty|banknifty|sensex)/u,
    ],
    weight: 0.85,
  },

  // ---- location ----------------------------------------------------------
  {
    intent: "ROUTE",
    any: [
      w("route", "directions", "rasta", "raasta", "marg"),
      / se .* (?:tak|jaane|jane|jana|ja) /u,
      /(?:from) .+ (?:to) .+/u,
      w("navigate", "drive", "driving"),
      /(?:kaise|kese) (?:jau|jaun|jaaye|jaye|pahunchu|pahuchu)/u,
      /how (?:do i |to )?(?:get|reach|drive)/u,
      w("distance", "doori", "duri", "kitni dur", "kitna dur"),
    ],
    weight: 0.9,
  },
  {
    intent: "PLACE_SEARCH",
    any: [
      w("near me", "nearby", "aas paas", "aaspaas", "paas mein", "najdeek", "nazdeek"),
      /(?:find|search|dhundo|dhundho|batao) .*(?:restaurant|hotel|cafe|atm|hospital|petrol|pump|station|shop|store)/u,
      w("map", "naksha"),
      /where is /u,
      /(?:kahan|kaha) (?:hai|par hai)/u,
    ],
    weight: 0.75,
  },

  // ---- time --------------------------------------------------------------
  {
    intent: "WORLD_TIME",
    any: [
      /(?:world|duniya) (?:clock|time)/u,
      // "London ka time", "Tokyo mein kya time", "time in Tokyo"
      /(?:time|samay|baje) (?:in|at) [a-z]/u,
      /[a-z]+ (?:ka|mein|me) (?:time|samay|baje)/u,
      w("timezone", "time zone", "utc", "gmt"),
    ],
    /**
     * A PLACE has to be named, or it is not a world clock.
     *
     * The "time in X" pattern above is genuinely useful and genuinely greedy:
     * without this it also fires on "should I invest TIME IN learning rust" and
     * on "the best time in the morning", covering the screen with a clock for
     * Tokyo because the sentence contained a preposition. Requiring a city (or
     * an explicit timezone word) is what separates the two, and it costs
     * nothing real — a world clock for a place we cannot resolve could not be
     * rendered anyway.
     */
    requires: [
      /(?:london|tokyo|new york|newyork|paris|dubai|singapore|sydney|berlin|moscow|delhi|mumbai|kolkata|bengaluru|india|san francisco|los angeles|chicago|utc|gmt|timezone|time zone|world clock|duniya)/u,
    ],
    weight: 0.85,
  },
  {
    intent: "TIME",
    /**
     * Phrasings that ASK the time, not sentences that contain the word.
     *
     * A bare `time` keyword was the obvious implementation and the wrong one:
     * it fires on "should I invest time in learning rust", "the best time to
     * post" and "long time no see", each of which would put a clock over the
     * screen. Every pattern below is interrogative or explicitly about the
     * current moment, which is the actual trigger.
     */
    any: [
      /(?:kya|kitne|kitna) (?:time|samay|baje|baj)/u,
      /(?:what|whats|what s) (?:the )?time/u,
      /(?:time|samay) (?:hua|hai|ho gaya|hogaya)/u,
      /abhi .*(?:time|samay|baje)/u,
      /current time/u,
      w("clock", "ghadi", "समय"),
    ],
    // "how much time will the route take" is a route question with the word
    // "time" in it, and must not open a clock over the map.
    unless: [
      /(?:kitna|kitni|how (?:much|long)) (?:time|samay|der)/u,
      /(?:route|rasta|raasta|journey|travel|drive|trip)/u,
      /(?:time zone|timezone)/u,
      /(?:invest|spend|waste|save) (?:time|samay)/u,
    ],
    weight: 0.8,
  },

  // ---- weather -----------------------------------------------------------
  {
    intent: "WEATHER",
    any: [
      w("weather", "mausam", "temperature", "taapman", "forecast"),
      w("rain", "baarish", "barish", "humidity", "wind"),
      /(?:kitni|kitna) (?:garmi|thand|thandi)/u,
      /how (?:hot|cold|warm) is/u,
    ],
    weight: 0.85,
  },

  // ---- system ------------------------------------------------------------
  {
    intent: "SYSTEM_STATUS",
    any: [
      /(?:system|pc|laptop|machine|computer) (?:kaisa|kaise|status|health|performance)/u,
      w("cpu", "ram", "memory", "gpu", "disk", "sensor", "telemetry"),
      /(?:system|machine) (?:monitor|stats|usage)/u,
      /(?:mera|my) (?:system|pc|laptop)/u,
    ],
    weight: 0.85,
  },

  // ---- tasks -------------------------------------------------------------
  {
    intent: "TASKS",
    any: [
      w("task", "tasks", "todo", "to do", "reminder", "reminders", "kaam"),
      /(?:meri|my) (?:tasks|todos|reminders)/u,
    ],
    weight: 0.75,
  },

  // ---- knowledge ---------------------------------------------------------
  {
    intent: "KNOWLEDGE",
    any: [
      /(?:summar(?:ise|ize|y)|saaransh|sarans) /u,
      /(?:is|this|the) (?:pdf|document|doc|file|report) /u,
      /(?:pdf|document|doc) (?:ka|ki|mein|me) /u,
      w("knowledge base", "uploaded"),
    ],
    weight: 0.8,
  },
];

/**
 * Classifies the visual intent of a message.
 *
 * Deliberately conservative: anything that does not clearly match a surface
 * returns NONE, and the answer is spoken or written with no panel at all. That
 * is the correct outcome for most messages — "JARVIS should NOT open a visual
 * surface for every response".
 */
export function detectVisualIntent(message: string): VisualIntentResult {
  const text = ` ${norm(message)} `;
  if (!text.trim()) return { intent: "NONE", confidence: 0, signals: [] };

  for (const rule of RULES) {
    if (rule.unless?.some((re) => re.test(text))) continue;
    if (rule.requires && !rule.requires.every((re) => re.test(text))) continue;

    const signals = rule.any.filter((re) => re.test(text)).map((re) => re.source);
    if (signals.length === 0) continue;

    // A second independent signal raises confidence, but never past the rule's
    // own ceiling: two weak hints are not proof.
    const confidence = Math.min(rule.weight + (signals.length - 1) * 0.05, 0.99);
    return { intent: rule.intent, confidence, signals };
  }

  return { intent: "NONE", confidence: 0, signals: [] };
}

/**
 * Whether a follow-up is still about the surface already on screen.
 *
 * "Alternative route?", "aur Tokyo?", "isme toll hai?" carry no subject at all
 * — they inherit one. Treating them as new topics is what makes an assistant
 * ask "which route?" about the route it is already displaying.
 *
 * Deliberately narrow. It looks for the SHAPE of a follow-up (very short, or
 * opening with a continuation word) rather than trying to understand it; the
 * cost of a false positive is updating a surface the user had finished with,
 * which the idle timer then closes anyway.
 */
export function isFollowUp(message: string): boolean {
  const text = norm(message);
  if (!text) return false;

  const words = text.split(" ").filter(Boolean);

  const CONTINUATION =
    /^(?:and|also|aur|bhi|ok|okay|theek|thik|acha|accha|alternative|alternate|dusra|dusri|doosra|other|another|compare|isme|ismein|iska|iski|usme|usmein|uska|uski|wahan|waha|yahan|yaha|kya|what|how|why|kitna|kitni|kaunsa|konsa)\b/u;

  // Anything trailing "bhi" ("Tokyo bhi", "Bitcoin ka bhi") is additive by
  // construction: it means "that one too", which only parses against something
  // already on screen.
  if (/(?:^| )bhi(?: |$)/u.test(text)) return true;

  if (words.length <= 4) return true;
  return CONTINUATION.test(text) && words.length <= 10;
}
