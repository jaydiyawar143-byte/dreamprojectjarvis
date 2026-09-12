// ---------------------------------------------------------------------------
// Server-side configuration validation and masking.
//
// ONE VALIDATOR, BOTH PATHS. The browser renders its form from the same
// `IntegrationFieldSpec` list this module validates against, and the JARVIS
// tool submits values through the same function. There is no "the UI already
// checked it" shortcut: a value arriving from a model is validated exactly as
// one arriving from a form, because the model is not a trusted client.
//
// MASKING IS ONE-WAY. `maskConfig` is the ONLY thing that turns stored values
// into a response, and it cannot emit a secret: the mask is produced from the
// field's DECLARED kind, not from the value, so a secret stored under a field
// spec that says `secret` comes back as dots whatever it contains. There is no
// "reveal" parameter anywhere in this module, because the only true beneficiary
// of a reveal endpoint is whoever steals the session.
// ---------------------------------------------------------------------------

import type {
  IntegrationFieldSpec,
  IntegrationFieldState,
} from "@jarvis/core";

/** What the UI renders in place of a stored secret. Never a real prefix. */
export const MASK = "••••••••••••";

/**
 * The sentinel a client sends back to mean "leave this secret alone".
 *
 * The form round-trips masked values, so a save that did not touch the token
 * field posts the mask back. Treating that literally would overwrite a working
 * credential with a string of dots — the classic way an edit-in-place form
 * destroys the secret it was displaying.
 */
export const UNCHANGED_SENTINEL = MASK;

export interface ValidationIssue {
  field: string;
  /** Safe for display. Describes the FORMAT, never echoes the value. */
  message: string;
}

export interface ValidationOutcome {
  valid: boolean;
  issues: ValidationIssue[];
  /**
   * Values to persist — already normalised, with untouched secrets removed so
   * the caller merges rather than overwrites.
   */
  normalized: Record<string, string>;
  /** Required fields still without a value after the merge. */
  missing: string[];
}

/**
 * Normalises one value for storage.
 *
 * Trimming is not cosmetic here: a pasted API key with a trailing newline is
 * the single most common cause of a credential that looks right in the form and
 * is rejected by the provider, and the resulting 401 is indistinguishable from
 * a genuinely wrong key.
 */
function normalize(field: IntegrationFieldSpec, raw: unknown): string {
  const text = typeof raw === "string" ? raw.trim() : String(raw ?? "").trim();
  // Google Ads customer ids are written with dashes everywhere in Google's own
  // UI and rejected with dashes by the API.
  if (field.name === "adsCustomerId" || field.name === "adsLoginCustomerId") {
    return text.replace(/-/g, "");
  }
  return text;
}

/**
 * Validates a submitted configuration against a descriptor's field specs.
 *
 * @param existing Field names that ALREADY have a stored value. Required to
 *   decide whether an omitted field is "missing" or merely "unchanged" — a
 *   partial update that only sets the customer id must not report the token as
 *   missing when one is already stored.
 */
export function validateConfig(
  fields: readonly IntegrationFieldSpec[],
  submitted: Record<string, unknown>,
  existing: ReadonlySet<string> = new Set()
): ValidationOutcome {
  const issues: ValidationIssue[] = [];
  const normalized: Record<string, string> = {};
  const specByName = new Map(fields.map((f) => [f.name, f]));

  // Unknown keys are rejected rather than ignored. An ignored key is how a
  // client ends up believing it configured something it did not, and how a
  // typo'd field name becomes a silent no-op that is then debugged for an hour.
  for (const key of Object.keys(submitted)) {
    if (!specByName.has(key)) {
      issues.push({ field: key, message: `Unknown configuration field "${key}".` });
    }
  }

  for (const field of fields) {
    const submittedValue = submitted[field.name];

    // A field the server owns cannot be set through the API at all. Accepting
    // it and silently dropping it would report success for a change that did
    // not happen.
    if (field.serverManaged && submittedValue !== undefined) {
      issues.push({
        field: field.name,
        message: `${field.label} is set by a server environment variable and cannot be changed here.`,
      });
      continue;
    }

    if (submittedValue === undefined) continue;

    // The client echoed the mask back: keep what is stored, change nothing.
    if (field.kind === "secret" && submittedValue === UNCHANGED_SENTINEL) continue;

    const value = normalize(field, submittedValue);

    // Explicit clear.
    if (value === "") {
      if (field.required) {
        issues.push({ field: field.name, message: `${field.label} is required.` });
        continue;
      }
      normalized[field.name] = "";
      continue;
    }

    if (field.pattern && !new RegExp(field.pattern).test(value)) {
      issues.push({
        field: field.name,
        // The HINT, never the value: an error message is a log line waiting to
        // happen, and echoing a rejected secret into one is how tokens end up
        // in log aggregators.
        message: `${field.label} must be ${field.patternHint ?? "in the expected format"}.`,
      });
      continue;
    }

    if (field.kind === "url") {
      try {
        const parsed = new URL(value);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
          issues.push({ field: field.name, message: `${field.label} must be an http(s) URL.` });
          continue;
        }
      } catch {
        issues.push({ field: field.name, message: `${field.label} must be a valid absolute URL.` });
        continue;
      }
    }

    if (field.kind === "number" && !Number.isFinite(Number(value))) {
      issues.push({ field: field.name, message: `${field.label} must be a number.` });
      continue;
    }

    normalized[field.name] = value;
  }

  // What is missing AFTER applying this change, which is the question the user
  // actually has — not what was missing before it.
  const missing = fields
    .filter((f) => f.required && !f.serverManaged)
    .filter((f) => {
      const incoming = normalized[f.name];
      if (incoming !== undefined) return incoming === "";
      return !existing.has(f.name);
    })
    .map((f) => f.name);

  return { valid: issues.length === 0, issues, normalized, missing };
}

/**
 * Turns stored values into the field states a client may see.
 *
 * A secret never becomes `value`; it becomes `hasValue` plus a fixed mask. The
 * mask is a constant, not a prefix of the real value — showing the first four
 * characters of a key is a meaningful fraction of its entropy and an
 * unnecessary gift to anyone reading over a shoulder or a screen share.
 */
export function maskConfig(
  fields: readonly IntegrationFieldSpec[],
  stored: Record<string, string> | null,
  serverManagedPresence: Record<string, boolean> = {}
): IntegrationFieldState[] {
  return fields.map((field) => {
    const hasValue = field.serverManaged
      ? Boolean(serverManagedPresence[field.name])
      : Boolean(stored?.[field.name]);

    const isSecret = field.kind === "secret";

    return {
      name: field.name,
      label: field.label,
      kind: field.kind,
      required: field.required,
      hasValue,
      masked: hasValue && isSecret ? MASK : null,
      // Non-secret values echo back so an operator can see WHICH account is
      // configured without retyping it. Server-managed non-secrets stay null:
      // their values come from the environment, and this layer does not read
      // the environment on a client's behalf.
      value: !isSecret && !field.serverManaged ? (stored?.[field.name] ?? null) : null,
      serverManaged: Boolean(field.serverManaged),
      ...(field.help ? { help: field.help } : {}),
    };
  });
}
