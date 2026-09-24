import type { IntentResult, PendingAction } from "@jarvis/core";

export const CONFIRM_PATTERNS: RegExp[] = [
  /^(yes|y|haan|haa|haan kar do|haa kar do|yes please|sure|okay|ok|go ahead|proceed|do it|please do|create it|kar do|bana do|banaa do|theek hai|i approve|approve|confirm|bana de|banao|yes do it|go for it|do it please|please go ahead|sounds good|perfect|great|done|let's do it|let's go|i'm in|count me in|absolutely|definitely|of course|why not|yeah|yep|yup|ji haan|ji|haanji|chalein|chal)$/i,
  /^yes[,.]?\s+(?:please|do|go|approve|confirm|proceed|karo|banao|kar)\b/i,
  /^(?:please|kindly|sure|okay|ok)[,.]?\s+(?:do|go|approve|confirm|proceed|create)\b/i,
];

const REJECT_PATTERNS: RegExp[] = [
  /^(no|n|nahi|nahi kar do|nahi banao|cancel|don't|do not|reject|stop|never mind|nevermind|skip|abort|nope|nah|na|mat karo|mat banao|hold off|not now|later|maybe later|i decline|i reject|forget it|forget about it|scratch that|never|don't do it|please don't)$/i,
];

const MODIFY_SIGNALS = /\b(change|update|modify|actually|instead|rather|make it|set it|adjust|revise|edit|modify to|change to|update to|set to|banao|karo)\b/i;
const HAS_NUMBERS = /\d/;

/**
 * Detect the user's intent relative to a pending action.
 *
 * This is a pure heuristic detector — no LLM call. It handles:
 * - CONFIRM: "yes", "haan kar do", "go ahead", etc.
 * - REJECT: "no", "nahi", "cancel", etc.
 * - MODIFY: "make it ₹200/day", "change budget to 200", etc.
 * - NEW_ACTION: no pending action or message is a new request
 * - CLARIFY: ambiguous message with pending action
 */
export function detectIntent(
  message: string,
  pendingAction: PendingAction | null
): IntentResult {
  if (!pendingAction) {
    return { type: "NEW_ACTION", confidence: 1.0 };
  }

  const trimmed = message.trim();
  const lower = trimmed.toLowerCase();

  // Check confirmation patterns
  for (const pattern of CONFIRM_PATTERNS) {
    if (pattern.test(lower)) {
      return { type: "CONFIRM", confidence: 0.95 };
    }
  }

  // Check rejection patterns
  for (const pattern of REJECT_PATTERNS) {
    if (pattern.test(lower)) {
      return { type: "REJECT", confidence: 0.95 };
    }
  }

  // Check if it looks like a parameter modification
  const hasModifySignal = MODIFY_SIGNALS.test(lower);
  const hasNumbers = HAS_NUMBERS.test(trimmed);

  if (hasModifySignal || (hasNumbers && pendingAction)) {
    const extracted = extractModifiedParams(trimmed, pendingAction);
    if (Object.keys(extracted).length > 0) {
      return {
        type: "MODIFY",
        confidence: 0.8,
        extractedParams: extracted,
      };
    }
  }

  // If message is very short and has a pending action, likely a clarification
  // about the pending action (e.g., "what was the budget?")
  const wordCount = lower.split(/\s+/).length;
  if (wordCount <= 6 && pendingAction) {
    return { type: "CLARIFY", confidence: 0.5 };
  }

  // Default: treat as a new action
  return { type: "NEW_ACTION", confidence: 0.6 };
}

/**
 * Extract modified parameters from a user message.
 * Uses simple heuristics to find budget, name, and other common campaign params.
 */
function extractModifiedParams(
  message: string,
  pendingAction: PendingAction
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const lower = message.toLowerCase();

  // Budget extraction
  const budgetPatterns = [
    /(?:₹|rs\.?|inr|rupees?)\s*(\d[\d,]*)/i,
    /(\d[\d,]*)\s*(?:\/\s*day|per day|daily|daily budget)/i,
    /budget\s*(?:of|:|=|to)?\s*(?:₹|rs\.?|inr)?\s*(\d[\d,]*)/i,
    /(\d[\d,]*)\s*(?:budget)/i,
  ];

  for (const pattern of budgetPatterns) {
    const match = message.match(pattern);
    if (match) {
      const value = parseInt(match[1]!.replace(/,/g, ""), 10);
      if (value > 0 && value < 1_000_000) {
        // Detect if this is a daily or lifetime budget based on context
        const isDaily = /daily|\/\s*day|per day/i.test(message) || /daily|\/\s*day|per day/i.test(lower);
        if (isDaily || lower.includes("day")) {
          params.dailyBudget = value;
        } else {
          params.dailyBudget = value;
        }
        break;
      }
    }
  }

  // Campaign name extraction
  const namePatterns = [
    /(?:campaign\s+)?(?:name|called?|named?|title)\s*(?:is|:|=|to)?\s*["']?([^"']+?)["']?\s*(?:\.|,|$)/i,
    /["']([^"']+)["']/,
  ];

  for (const pattern of namePatterns) {
    const match = message.match(pattern);
    if (match && match[1]) {
      const name = match[1].trim();
      if (name.length > 0 && name.length < 100) {
        params.name = name;
        break;
      }
    }
  }

  // Objective extraction
  const objectiveMap: Record<string, string> = {
    "lead": "OUTCOME_LEADS",
    "leads": "OUTCOME_LEADS",
    "conversion": "OUTCOME_SALES",
    "conversions": "OUTCOME_SALES",
    "sales": "OUTCOME_SALES",
    "traffic": "OUTCOME_TRAFFIC",
    "awareness": "OUTCOME_AWARENESS",
    "reach": "OUTCOME_REACH",
    "engagement": "OUTCOME_ENGAGEMENT",
    "app install": "OUTCOME_APP_INSTALLS",
    "app installs": "OUTCOME_APP_INSTALLS",
    "video views": "OUTCOME_VIEWS",
    "catalog": "OUTCOME_CATALOG_SALES",
  };

  for (const [keyword, objective] of Object.entries(objectiveMap)) {
    if (lower.includes(keyword)) {
      params.objective = objective;
      break;
    }
  }

  // Only return params that are actually present in the message
  // and differ from current pending action params
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (pendingAction.params[key] !== value) {
      filtered[key] = value;
    }
  }

  return filtered;
}

/**
 * Check if a pending action is expired.
 */
export function isPendingActionExpired(pendingAction: PendingAction): boolean {
  return new Date(pendingAction.expiresAt).getTime() <= Date.now();
}

/**
 * Map ApprovalStatus to PendingActionState.
 */
export function approvalStatusToPendingState(
  status: string,
  expiresAt: string
): "WAITING_CONFIRMATION" | "APPROVED" | "REJECTED" | "COMPLETED" {
  if (status === "expired" || new Date(expiresAt).getTime() <= Date.now()) {
    return "WAITING_CONFIRMATION"; // expired but treated as still waiting
  }
  switch (status) {
    case "pending": return "WAITING_CONFIRMATION";
    case "approved": return "APPROVED";
    case "consumed": return "COMPLETED";
    case "rejected": return "REJECTED";
    default: return "WAITING_CONFIRMATION";
  }
}

/**
 * Generate a human-readable summary of a pending action.
 */
export function summarizePendingAction(pendingAction: PendingAction): string {
  const toolName = pendingAction.toolId
    .replace(/^meta\./, "Meta ")
    .replace(/\.create$/, " Create")
    .replace(/\.pause$/, " Pause")
    .replace(/\.resume$/, " Resume")
    .replace(/\.update$/, " Update")
    .replace(/\.budget\.update$/, " Budget Update")
    .replace(/\./g, " ");

  const paramLines: string[] = [];
  const p = pendingAction.params;

  if (p.name) paramLines.push(`Name: ${p.name}`);
  if (p.objective) paramLines.push(`Objective: ${String(p.objective).replace("OUTCOME_", "")}`);
  if (p.dailyBudget) paramLines.push(`Budget: ₹${p.dailyBudget}/day`);
  if (p.status) paramLines.push(`Status: ${p.status}`);
  if (p.campaignId) paramLines.push(`Campaign ID: ${p.campaignId}`);

  return `${toolName}\n${paramLines.join("\n")}`;
}
