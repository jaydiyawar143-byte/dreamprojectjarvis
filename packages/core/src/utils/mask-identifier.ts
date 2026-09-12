// ---------------------------------------------------------------------------
// Masking provider identifiers for display.
//
// DISTINCT FROM `redactSecrets`, and both are needed for different reasons.
//
//   redactSecrets  — removes things that are SECRET (tokens, keys, bearers).
//                    Applied to logs and audit rows. Its job is to destroy.
//   maskIdentifier — shortens things that are merely IDENTIFYING (an ad account
//                    id, a customer id, a phone number id). Its job is to keep
//                    a value RECOGNISABLE while not reproducing it in full.
//
// Why mask an identifier at all, when it is not a secret? Because a full
// account id is the thing an attacker needs to address an API call, it appears
// in screenshots and screen shares, and a user does not need all sixteen digits
// to know which account is meant — the first few and last few are enough to
// recognise it, and that is the entire purpose the value serves on screen.
//
// THE INVARIANT: masking is not reversible and never widens. Given a value, the
// output reveals at most `HEAD` leading and `TAIL` trailing characters of the
// significant part. A value too short to mask safely is replaced wholesale
// rather than returned as-is — returning it unchanged is how a "masking"
// function ends up printing short secrets verbatim.
// ---------------------------------------------------------------------------

/** Characters shown at each end of the significant part. */
const HEAD = 4;
const TAIL = 4;

/** The bullet run used for the elided middle. Fixed-width, never value-length. */
const ELLIPSIS = "••••••";

/**
 * Provider prefixes that are structural, not identifying.
 *
 * `act_` says "this is a Meta ad account"; it reveals nothing about WHICH one.
 * Preserving it keeps the masked value recognisable as the right KIND of
 * identifier, which is most of what a reader needs.
 */
const KNOWN_PREFIXES = ["act_", "ad_", "cmp_", "px_", "ig_", "fb_", "wa_", "customers/"];

function splitPrefix(value: string): { prefix: string; rest: string } {
  for (const prefix of KNOWN_PREFIXES) {
    if (value.toLowerCase().startsWith(prefix.toLowerCase())) {
      return { prefix: value.slice(0, prefix.length), rest: value.slice(prefix.length) };
    }
  }
  return { prefix: "", rest: value };
}

/**
 * Masks a provider identifier for display.
 *
 *   act_2478566669291624  ->  act_2478••••••1624
 *   1234567890            ->  1234••••••7890
 *   short                 ->  ••••••          (too short to reveal any of)
 *
 * Returns the empty string for empty input so a caller can distinguish "no
 * value" from "a value I am not showing you".
 */
export function maskIdentifier(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  const trimmed = String(value).trim();
  if (trimmed === "") return "";

  const { prefix, rest } = splitPrefix(trimmed);

  // Anything whose significant part cannot spare HEAD+TAIL characters and still
  // elide something is replaced entirely. Revealing 8 of 9 characters is not
  // masking, and this is exactly the branch where a naive implementation leaks.
  if (rest.length <= HEAD + TAIL) {
    return `${prefix}${ELLIPSIS}`;
  }

  return `${prefix}${rest.slice(0, HEAD)}${ELLIPSIS}${rest.slice(-TAIL)}`;
}

/**
 * Masks an email for display: the local part is masked, the domain kept.
 *
 * The domain is the useful half when identifying WHICH account is connected
 * (`…@company.com` vs `…@gmail.com`) and is not itself identifying of a person.
 */
export function maskEmail(value: string | null | undefined): string {
  if (!value) return "";
  const trimmed = String(value).trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return maskIdentifier(trimmed);

  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at);

  // Two characters is enough to recognise your own address in a list; more
  // starts reproducing it.
  const shown = local.length <= 2 ? "" : local.slice(0, 2);
  return `${shown}${ELLIPSIS}${domain}`;
}

// ---------------------------------------------------------------------------
// Free-text scrubbing
// ---------------------------------------------------------------------------

/**
 * Identifier shapes to mask when they appear inside prose.
 *
 * This is the belt to `maskIdentifier`'s braces: a value can reach a user
 * through a sentence a model composed rather than through a field the server
 * formatted, and a model that has seen a full account id will sometimes print
 * it. Each pattern is anchored on a provider-specific shape so ordinary numbers
 * in prose ("spend was 24785") are left alone.
 */
const IDENTIFIER_PATTERNS: RegExp[] = [
  // Meta ad account / object ids: act_ or a long bare digit run after `id`.
  /\bact_\d{6,}\b/gi,
  // Google Ads customer ids, with or without dashes, 10 digits.
  /\bcustomers\/\d{10}\b/gi,
  /\b\d{3}-\d{3}-\d{4}\b/g,
  // Google Maps / Google API keys.
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  // Meta long-lived tokens.
  /\bEAA[0-9A-Za-z]{20,}\b/g,
  // WhatsApp phone number ids and other long bare digit runs of 12+.
  /\b\d{12,}\b/g,
];

/**
 * Masks every recognisable identifier inside a block of text.
 *
 * Applied to model-authored text on its way to a user. It cannot catch an
 * identifier shape nobody anticipated, which is why the real control is not
 * giving the model the full value in the first place — this is the second line.
 */
export function maskIdentifiersInText(text: string): string {
  if (!text) return text;
  let out = text;
  for (const pattern of IDENTIFIER_PATTERNS) {
    out = out.replace(pattern, (match) => maskIdentifier(match));
  }
  return out;
}

/** True when `text` still contains something that looks like a full identifier. */
export function containsUnmaskedIdentifier(text: string): boolean {
  if (!text) return false;
  return IDENTIFIER_PATTERNS.some((p) => {
    // `lastIndex` is shared on a global regex; test on a fresh copy.
    const fresh = new RegExp(p.source, p.flags.replace("g", ""));
    return fresh.test(text);
  });
}
