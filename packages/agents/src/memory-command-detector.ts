// ---------------------------------------------------------------------------
// Memory-command detection — S7.2 L5.
//
// Answers one narrow question about a chat message: is the user giving an
// explicit command about JARVIS's MEMORY of them? A pure, closed-pattern
// heuristic — no model call — the same shape as `intent-detector.ts` and
// `work-request-detector.ts`.
//
// THE DEFAULT IS NONE. Only a whole message that is clearly a memory command
// matches; anything else flows on exactly as before. "forget it", "forget",
// "never mind" are NONE on purpose: with a pending action they already mean
// "cancel it", and without one they are conversation, not deletion. A match
// decides nothing destructive by itself — the chat route resolves the target
// to ids, shows it, and deletion still needs a confirmed pending action.
// ---------------------------------------------------------------------------

import type { MemoryCommand } from "@jarvis/core";

const NONE: MemoryCommand = { kind: "NONE" };

function normalize(message: string): string {
  return message
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:(?:hey|ok|okay) )?jarvis[,:!]? /, "")
    .replace(/[\s.!?]+$/u, "")
    .replace(/^please /, "")
    .replace(/ please$/, "");
}

const HINGLISH_FORGET = "(?:bhool ja(?:o|iye)|delete kar(?:o| do)|hata do|mita do)";
const SAID = "what i (?:just )?(?:said|told you|wrote)";

const LIST: readonly RegExp[] = [
  /^(?:show|list|display)(?: me)?(?: all)?(?: of)? (?:my|your) (?:saved |stored )?memories$/,
  /^(?:tell me )?what (?:do you remember|have you remembered) about me$/,
  /^(?:meri|mere) (?:saari |sari |sab )?(?:memories|memory|yaadein) (?:dikhao|dikha do|dikhaiye|batao|bata do)$/,
  /^(?:tumhe|tumhein|aapko|tujhe) mere (?:baare|bare) (?:mein|me|main) kya (?:kya )?yaad hai$/,
];

const FORGET_ALL: readonly RegExp[] = [
  /^(?:forget|delete|erase|remove|clear|wipe) (?:everything|all|it all) (?:you (?:remember|know) )?about me$/,
  /^(?:forget|delete|erase|remove|clear|wipe) all (?:of )?(?:my|your|the) memories$/,
  new RegExp(`^(?:meri|mere) (?:saari|sari|sab|sabhi) (?:memories|memory|yaadein) ${HINGLISH_FORGET}$`),
  /^mere (?:baare|bare) (?:mein|me|main) (?:sab kuch|sabkuch|sab) bhool ja(?:o|iye)$/,
];

const FORGET_LEGACY = /^(?:forget|delete|erase|remove|clear) (?:all )?(?:(?:of )?my )?(?:old|older|legacy) memories$/;

const SELECTION: readonly RegExp[] = [
  /^(?:forget|delete|remove|erase) (?:memory |memories |number |numbers |no\.? ?|#)?(\d{1,3}(?:(?:, ?| and | & |, and )(?:#|number )?\d{1,3})*)$/,
  new RegExp(`^(?:number )?(\\d{1,3}) (?:number )?(?:wali )?(?:memory )?${HINGLISH_FORGET}$`),
];

const FORGET_THIS: readonly RegExp[] = [
  /^(?:forget|delete|remove|erase) (?:this|that) (?:memory|preference|fact)$/,
  /^forget this$/,
  new RegExp(`^(?:ye|yeh|is|iss) (?:memory|yaad|preference) (?:ko )?${HINGLISH_FORGET}$`),
];

const VETO: readonly RegExp[] = [
  new RegExp(`^forget (?:that|${SAID})$`),
  new RegExp(`^(?:don't|do not|dont) (?:remember|save|store) (?:that|${SAID})$`),
  /^(?:jo|jo bhi) maine (?:abhi )?(?:kaha|bola|likha) (?:woh|wo|vo|use|usko) (?:yaad mat rakh(?:na|o)|bhool ja(?:o|na|iye))$/,
];

const CORRECT: readonly RegExp[] = [
  /^(?:no,? )?(?:that|this|it)(?:'s| is| was) (?:wrong|incorrect|outdated|not (?:true|right|correct)(?: anymore)?|no longer (?:true|right|correct))$/,
  /^(?:that|this) (?:memory|preference|fact) is (?:wrong|incorrect|outdated|no longer true|not true(?: anymore)?)$/,
  /^(?:ye|yeh|woh|wo) (?:galat|glt) hai$/,
  /^(?:ye|yeh|woh|wo) ab (?:sach|sahi) nahi hai$/,
];

const PAUSE: readonly RegExp[] = [
  /^(?:don't|do not|dont) remember anything(?: about me)?(?: (?:from now on|anymore|any more|going forward))?$/,
  /^stop (?:remembering|learning|saving)(?: (?:things|anything|stuff|everything))?(?: about me)?(?: from now on)?$/,
  /^(?:pause|turn off|disable) (?:your |my )?(?:memory|memories|learning)$/,
  /^(?:ab se )?mere (?:baare|bare) (?:mein|me|main) kuch (?:bhi )?(?:yaad mat rakh(?:na|o)|save mat kar(?:na|o))$/,
  /^yaad rakhna band kar(?:o| do)$/,
];

const RESUME: readonly RegExp[] = [
  /^(?:start|resume|continue) (?:remembering|learning)(?: (?:things|stuff))?(?: about me)?(?: again)?$/,
  /^(?:resume|unpause|turn on|enable) (?:your |my )?(?:memory|memories|learning)$/,
  /^(?:phir se|fir se|dobara) yaad rakhna shuru kar(?:o| do)$/,
];

// ---------------------------------------------------------------------------
// Phase 14 — a correction that carries its new value.
//
//   "That's wrong. I prefer light mode."   "No, that's wrong — I prefer …"
//   "change that to I prefer light mode"   "change 2 to I prefer light mode"
//   "ye galat hai, mujhe … pasand hai"
//
// The marker must END before the new value begins — a full stop, a comma, a
// dash — so "that's wrong about the capital, it's Paris" is still ordinary
// conversation. The value is returned in the user's OWN words and casing; it
// is never rewritten here. Recognising one decides nothing: the chat route
// still needs a memory behind the last reply (or a numbered list), the
// statement must be learnable on its own, and the user must confirm.
// ---------------------------------------------------------------------------

const WRONG = "(?:no,? )?(?:that|this|it)(?:'s| is| was) (?:wrong|incorrect|outdated|not (?:true|right|correct)(?: anymore)?|no longer (?:true|right|correct))";
const BREAK = "\\s*[.,;:!\u2014\u2013-]+\\s*";

const CORRECT_WITH: readonly RegExp[] = [
  new RegExp(`^${WRONG}${BREAK}(.+)$`, "i"),
  new RegExp(`^(?:ye|yeh|woh|wo) (?:galat|glt) hai${BREAK}(.+)$`, "i"),
  /^(?:change|correct|update|replace) (?:that|this|it|(?:that|this) (?:memory|preference|fact)) (?:to|with)[:,]? (.+)$/i,
];

const CORRECT_SELECTION = /^(?:change|correct|update|replace) (?:memory |number |no\.? ?|#)?(\d{1,3}) (?:to|with)[:,]? (.+)$/i;

/** The message with its spacing and quotes tidied, and the user's own casing kept. */
function tidy(message: string): string {
  return message
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:(?:hey|ok|okay) )?jarvis[,:!]? /i, "")
    .replace(/^please /i, "");
}

/** A new value, stated as a command. Learned by L1 → L4 like any statement; never a deletion. */
const REPLACE = /^(?:change|update|set|switch) my (?:[a-z]+ ){0,3}(?:preference|default|setting)s?(?: [a-z]+){0,3} (?:to|from) .+$/;

function matches(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((p) => p.test(text));
}

/** Positions in the order said, each once. */
function positionsOf(text: string): number[] {
  return [...new Set((text.match(/\d{1,3}/g) ?? []).map(Number))].filter((n) => n > 0);
}

export function detectMemoryCommand(message: string): MemoryCommand {
  const text = normalize(message);
  if (text.length === 0) return NONE;

  if (matches(FORGET_ALL, text)) return { kind: "FORGET_ALL", scope: "ALL" };
  if (FORGET_LEGACY.test(text)) return { kind: "FORGET_ALL", scope: "LEGACY" };

  if (matches(SELECTION, text)) {
    const positions = positionsOf(text);
    if (positions.length > 0) return { kind: "FORGET", target: { kind: "SELECTION", positions } };
  }
  if (matches(FORGET_THIS, text)) return { kind: "FORGET", target: { kind: "THIS" } };
  if (matches(VETO, text)) return { kind: "VETO", target: { kind: "PREVIOUS_MESSAGE" } };
  if (matches(CORRECT, text)) return { kind: "CORRECT", target: { kind: "LAST_REPLY" } };

  // Phase 14 — a correction with its new value, in the user's own words.
  const original = tidy(message);
  const numbered = CORRECT_SELECTION.exec(original);
  if (numbered && Number(numbered[1]) > 0 && numbered[2]!.trim().length > 0) {
    return { kind: "CORRECT", target: { kind: "SELECTION", positions: [Number(numbered[1])] }, statement: numbered[2]!.trim() };
  }
  for (const pattern of CORRECT_WITH) {
    const statement = pattern.exec(original)?.[1]?.trim();
    if (statement) return { kind: "CORRECT", target: { kind: "LAST_REPLY" }, statement };
  }

  if (matches(PAUSE, text)) return { kind: "LEARNING_PAUSE" };
  if (matches(RESUME, text)) return { kind: "LEARNING_RESUME" };
  if (matches(LIST, text)) return { kind: "LIST" };
  if (REPLACE.test(text)) return { kind: "REPLACE" };
  return NONE;
}
