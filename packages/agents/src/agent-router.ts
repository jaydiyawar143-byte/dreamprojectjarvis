// ---------------------------------------------------------------------------
// Sprint 6.8 — Server-controlled agent resolution.
//
// Routing is a pure, deterministic function of the message and its history. No
// model call decides which agent runs, because the agent choice is what selects
// a tool allowlist: letting the model pick would let it pick its own privileges.
//
// The router returns a RANKED CANDIDATE LIST rather than a single id. The
// Orchestrator walks it and takes the first candidate that is actually
// registered and healthy, so a deployment where WhatsApp or n8n is unconfigured
// (and its agent therefore never registered) degrades to the general assistant
// instead of failing. That also keeps the router honest about ambiguity: two
// plausible domains produce two candidates, not a coin flip.
//
// The Meta heuristic is carried over from Sprint 2.4 UNCHANGED. Its behaviour is
// pinned by twenty routing tests, and Sprint 6 has no mandate to re-tune it —
// the new domains are layered around it, never over it.
// ---------------------------------------------------------------------------

import type { AgentDomain, ConversationMessage } from "@jarvis/core";
import { AGENT_IDS } from "./agent-policy.js";

export interface RouteCandidate {
  agentId: string;
  domain: AgentDomain;
  /** 0-1 heuristic strength. Only compared within a single routing decision. */
  confidence: number;
  reason: string;
}

// ---------------------------------------------------------------------------
// Domain signals
// ---------------------------------------------------------------------------

/**
 * Automation: n8n by name, or an explicit workflow/automation request.
 *
 * "trigger" alone is excluded — it is far too common in ad copy and general
 * speech ("what triggered the CPA spike") to be evidence of anything.
 */
const AUTOMATION_SIGNALS: RegExp[] = [
  /\bn8n\b/i,
  /\bworkflow(s)?\b/i,
  /\bautomation(s)?\b/i,
  /\bautomate\b/i,
];

/**
 * Communication: WhatsApp by name only.
 *
 * A bare "send a message" is not routed here. The communication agent is the
 * only agent holding `whatsapp.send`, and guessing a user into an agent that
 * can message real customers is exactly the guess worth not making.
 */
const COMMUNICATION_SIGNALS: RegExp[] = [
  /\bwhatsapp\b/i,
  /\bwhats app\b/i,
  /\bwa\s+message\b/i,
];

/**
 * Google Ads: the platform named together with advertising, or "adwords".
 *
 * "google" on its own is not enough, and Gmail deliberately does not match:
 * Sprint 5 implemented Google ADS only, so a Gmail request must fall through to
 * the general assistant that can say so, not to an agent that cannot help.
 */
const GOOGLE_ADS_SIGNALS: RegExp[] = [
  /\badwords\b/i,
  /\bgoogle\s+ads?\b/i,
  /\bgoogle\s+(ad\s+)?(campaign|account|insight|spend|performance)/i,
  /\bgoogle\b[^.!?]*\b(ads?|campaign|adwords)\b/i,
];

/** Knowledge: an explicit appeal to the user's own uploaded material. */
const KNOWLEDGE_SIGNALS: RegExp[] = [
  /\bknowledge\s*base\b/i,
  /\bmy\s+(document|documents|docs|files|notes)\b/i,
  /\b(uploaded|attached)\s+(document|documents|doc|docs|file|files|pdf)\b/i,
  /\baccording\s+to\s+(the|my|our)\s+(doc|docs|document|documents|handbook|policy|manual|guide)/i,
  /\b(handbook|policy\s+document|manual|sop|standard\s+operating\s+procedure)\b/i,
  /\bwhat\s+do(es)?\s+(the|my|our)\s+(doc|docs|document|documents|handbook|policy|manual)/i,
];

/** Analytics: measurement language that is not tied to one ad platform. */
/**
 * Sprint 7 — an actual link. Unambiguous, so it is ranked above everything.
 *
 * Deliberately only http(s): a `file:` or `javascript:` string in a message is
 * not a browsing request, and routing it here would send it to an agent whose
 * tools would refuse it anyway.
 */
const BROWSER_URL_SIGNALS: RegExp[] = [/\bhttps?:\/\/[^\s<>"']+/i];

/**
 * Softer browsing phrasings.
 *
 * Narrow on purpose. "check the site" is a browsing request; "check the
 * campaign" is not, and a greedy pattern here would quietly steal traffic from
 * the Meta and analytics agents that this repo's routing tests pin.
 */
const BROWSER_SIGNALS: RegExp[] = [
  /\bweb\s?site\b/i,
  /\bweb\s?page\b/i,
  /\b(open|visit|browse|check|read|look at)\s+(this|that|the)\s+(link|url|site|page|website)\b/i,
  /\bscrape\b/i,
  /\bcrawl\s+(this|that|the)\b/i,
  /\b(fill|complete)\s+(in\s+|out\s+)?(this|that|the)\s+form\b/i,
  /\bsubmit\s+(this|that|the)\s+form\b/i,
  /\bscreenshot\s+(this|that|the)\b/i,
];

const ANALYTICS_SIGNALS: RegExp[] = [
  /\bkpi(s)?\b/i,
  /\banomal(y|ies)\b/i,
  /\btrend(s|ing)?\b/i,
  /\bweek\s+over\s+week\b/i,
  /\bmonth\s+over\s+month\b/i,
  /\bcompare\b/i,
  /\bcomparison\b/i,
  /\bvs\.?\s+last\s+(week|month|quarter|year)\b/i,
  /\banalytics\b/i,
  /\binsight(s)?\b/i,
  /\bperformance\s+(report|summary|metrics|overview)\b/i,
  /\bperformance\b/i,
  /\bsummar(y|ise|ize)\b.*\b(metric|number|result)/i,
];

/**
 * Location: maps, routing, distance and "near me".
 *
 * Every pattern here needs a MAP word, a ROUTING word or an explicit
 * proximity phrase. "show Gondia" alone is deliberately not enough — it is
 * indistinguishable from asking about a campaign named Gondia, and routing on
 * a bare place name would make the router guess at every proper noun.
 *
 * The Hindi and Hinglish forms are first-class, not an afterthought: this
 * product is used in both, and "Balaghat se Gondia ka route dikhao" is the
 * literal example the feature was specified against.
 *
 * `route` is safe next to the automation agent because n8n is named explicitly
 * there and ranks higher, so "route the workflow" still goes to automation.
 */
const LOCATION_SIGNALS: RegExp[] = [
  // Named product.
  /\bgoogle\s*maps?\b/i,
  /\bon\s+(the\s+)?map\b/i,
  /\bmap\s+(par|pe|pr)\b/i,

  // Routing and directions.
  /\broutes?\b/i,
  /\bdirections?\s+(to|from|for)\b/i,
  /\b(driving|walking|cycling|biking|transit|public\s+transport)\s+(route|directions?)\b/i,
  /\brasta\b/i,

  // Distance and travel time.
  /\bdistance\b/i,
  /\bhow\s+far\b/i,
  // `kitna` / `kitni` / `kitne` — Hindi adjectives agree with the noun's
  // gender, and `door`/`doori` are feminine, so "kitni door hai" is the form
  // people actually type. Matching only `kitna` sent the commonest phrasing of
  // the commonest question straight past this agent; caught by a live run.
  /\bkitn[aie]\s+(door|doori|dur|duur|distance)\b/i,
  /\btravel\s+time\b/i,
  /\bhow\s+long\b[^.!?]*\b(drive|driving|walk|walking|to\s+get\s+to|to\s+reach)\b/i,

  // Proximity.
  /\bnear\s*by\b/i,
  /\bnear\s+me\b/i,
  /\bnearest\b/i,
  /\bmere\s+(paas|pass)\b/i,
  /\baas\s*paas\b/i,

  // The user's own position.
  /\b(my|current)\s+location\b/i,
  /\b(meri|mera)\s+(current\s+)?location\b/i,
];

function matches(signals: RegExp[], text: string): boolean {
  return signals.some((re) => re.test(text));
}

// ---------------------------------------------------------------------------
// Meta Ads heuristic — carried over verbatim from Sprint 2.4
// ---------------------------------------------------------------------------

export function isMetaAdsQuery(
  message: string,
  history?: ConversationMessage[]
): boolean {
  const normalized = message.toLowerCase();

  // 1. Explicit non-Meta platforms or generic tech tools (Highest priority overrides context / keywords)
  const nonMetaPlatformTriggers = [
    /\bgoogle\b/i,
    /\blinkedin\b/i,
    /\badwords\b/i,
    /\bgmail\b/i,
    /\bemail\b/i,
    /\bpython\b/i,
    /\bjavascript\b/i,
    /\btypescript\b/i,
    /\bcalendar\b/i,
    /\bpdf\b/i,
    /\bwebsite\b/i,
    /\bexcel\b/i,
  ];

  const hasExplicitNonMetaPlatform = nonMetaPlatformTriggers.some((pattern) =>
    pattern.test(normalized)
  );
  if (hasExplicitNonMetaPlatform) {
    return false;
  }

  // 2. Explicit Meta Ads triggers
  const explicitMetaTriggers = [
    /\bmeta\b/i,
    /\bfacebook\b/i,
    /\binsta\b/i,
    /\binstagram\b/i,
  ];

  const hasExplicitMeta = explicitMetaTriggers.some((pattern) => pattern.test(normalized));
  if (hasExplicitMeta) {
    return true;
  }

  // 3. Strong Meta Ads domain terminologies
  const strongDomainTriggers = [
    /\bcpa\b/i,
    /\broas\b/i,
    /\bctr\b/i,
    /\bcpc\b/i,
    /\bcpm\b/i,
    /\badset\b/i,
    /\badsets\b/i,
    /\bad\s+set\b/i,
    /\bad\s+sets\b/i,
    /\bcreatives?\b/i,
    /\bbadh\s+raha\b/i,
    /\bworst\s+perform\b/i,
  ];

  const hasStrongDomainIntent = strongDomainTriggers.some((pattern) =>
    pattern.test(normalized)
  );
  if (hasStrongDomainIntent) {
    return true;
  }

  // 4. Generic Meta keywords (requires history context to disambiguate)
  const genericMetaKeywords = [
    /\bcampaign\b/i,
    /\bcampaigns\b/i,
    /\bad\b/i,
    /\bads\b/i,
    /\bbudget\b/i,
    /\bbudgets\b/i,
    /\bperformance\b/i,
    /\boptimize\b/i,
    /\bpause\b/i,
    /\bresume\b/i,
    /\banalytics\b/i,
    /\baccount\b/i,
  ];

  const hasGenericMetaKeyword = genericMetaKeywords.some((pattern) =>
    pattern.test(normalized)
  );
  if (hasGenericMetaKeyword) {
    if (history && history.length > 0) {
      const recentMessages = history.slice(-3); // Look at the last 3 turns
      for (const msg of recentMessages) {
        const content = msg.content.toLowerCase();
        const isMeta =
          explicitMetaTriggers.some((p) => p.test(content)) ||
          strongDomainTriggers.some((p) => p.test(content));
        if (isMeta) {
          return true;
        }
      }
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * Ranks candidate agents for a message, most specific first.
 *
 * Ordering encodes which signal is the more reliable evidence, not which agent
 * is more useful. A named platform or system (n8n, WhatsApp, Google Ads) is an
 * unambiguous statement of intent, so those lead. The Meta heuristic sits ahead
 * of analytics deliberately: "why did CPA rise" is both a Meta question and an
 * analytics question, and Meta owns the deeper pipeline for it — Sprint 6.4 asks
 * that domain logic stay in the domain agent rather than being re-derived.
 *
 * The general assistant is always appended, so the list is never empty and the
 * Orchestrator always has a terminal fallback.
 */
export function rankAgentCandidates(
  message: string,
  history?: ConversationMessage[]
): RouteCandidate[] {
  const candidates: RouteCandidate[] = [];
  const text = typeof message === "string" ? message : "";

  // Sprint 7 — an explicit http(s) URL in the message is the least ambiguous
  // signal the router has, so it outranks every keyword heuristic. Somebody
  // who pastes a link wants that link opened, whatever else the sentence says.
  if (matches(BROWSER_URL_SIGNALS, text)) {
    candidates.push({
      agentId: AGENT_IDS.browser,
      domain: "browser",
      confidence: 0.95,
      reason: "message contains an explicit web URL",
    });
  }

  if (matches(AUTOMATION_SIGNALS, text)) {
    candidates.push({
      agentId: AGENT_IDS.automation,
      domain: "automation",
      confidence: 0.9,
      reason: "message names a workflow or automation system",
    });
  }

  if (matches(COMMUNICATION_SIGNALS, text)) {
    candidates.push({
      agentId: AGENT_IDS.communication,
      domain: "communication",
      confidence: 0.9,
      reason: "message names WhatsApp",
    });
  }

  // Ranked here — above Google Ads, below the explicitly-named systems.
  //
  // Its signals are specific (a map word, a routing word, or "near me"), so a
  // match is strong evidence. It sits above Google Ads because "search Google
  // Maps for cafes" names Google without naming Google ADS, and below n8n and
  // WhatsApp because those name a system outright.
  if (matches(LOCATION_SIGNALS, text)) {
    candidates.push({
      agentId: AGENT_IDS.location,
      domain: "location",
      confidence: 0.88,
      reason: "message asks about a map, a route, a distance or somewhere nearby",
    });
  }

  if (matches(GOOGLE_ADS_SIGNALS, text)) {
    candidates.push({
      agentId: AGENT_IDS.googleAds,
      domain: "google-ads",
      confidence: 0.85,
      reason: "message names Google Ads",
    });
  }

  if (matches(KNOWLEDGE_SIGNALS, text)) {
    candidates.push({
      agentId: AGENT_IDS.knowledge,
      domain: "knowledge",
      confidence: 0.8,
      reason: "message appeals to the user's own documents",
    });
  }

  // Placed after knowledge and before Meta. A bare mention of "the website"
  // is weaker evidence than a document appeal, and `isMetaAdsQuery` already
  // treats \bwebsite\b as a veto on the Meta heuristic, so the two agree
  // rather than competing.
  if (matches(BROWSER_SIGNALS, text)) {
    candidates.push({
      agentId: AGENT_IDS.browser,
      domain: "browser",
      confidence: 0.75,
      reason: "message asks for a web page to be opened, read or filled in",
    });
  }

  if (isMetaAdsQuery(text, history)) {
    candidates.push({
      agentId: AGENT_IDS.metaAds,
      domain: "meta-ads",
      confidence: 0.85,
      reason: "message matches the Meta Ads domain heuristic",
    });
  }

  if (matches(ANALYTICS_SIGNALS, text)) {
    candidates.push({
      agentId: AGENT_IDS.analytics,
      domain: "analytics",
      confidence: 0.6,
      reason: "message asks for measurement, comparison or anomaly analysis",
    });
  }

  candidates.push({
    agentId: AGENT_IDS.general,
    domain: "general",
    confidence: candidates.length === 0 ? 0.5 : 0.2,
    reason:
      candidates.length === 0
        ? "no domain signal matched"
        : "fallback when no specialized agent is available",
  });

  return candidates;
}

/**
 * True when two or more DISTINCT specialized domains claimed the message.
 *
 * Used for observability rather than control flow: the Orchestrator still picks
 * the highest-ranked available agent, but records that the choice was contested
 * so a persistently ambiguous phrasing is visible in the audit trail instead of
 * silently resolving one way forever.
 */
export function isAmbiguous(candidates: RouteCandidate[]): boolean {
  return candidates.filter((c) => c.domain !== "general").length > 1;
}
