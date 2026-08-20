import { META_ALLOWED_METRICS, META_ALLOWED_BREAKDOWNS } from "@jarvis/core";

const MAX_DATE_RANGE_DAYS = 90;
const MAX_RESULT_LIMIT = 500;
const DEFAULT_RESULT_LIMIT = 50;

const ACCOUNT_ID_PATTERN = /^act_\d{5,}$/;
const ID_PATTERN = /^\d{5,}$/;

export function validateAccountId(accountId: string): string | null {
  if (typeof accountId !== "string") return null;
  const trimmed = accountId.trim();
  if (trimmed.length === 0 || trimmed.length > 50) return null;
  if (ACCOUNT_ID_PATTERN.test(trimmed)) return trimmed;
  if (ID_PATTERN.test(trimmed)) return "act_" + trimmed;
  return null;
}

export function validateEntityId(id: string): string | null {
  if (typeof id !== "string") return null;
  const trimmed = id.trim();
  if (trimmed.length === 0 || trimmed.length > 50) return null;
  if (ID_PATTERN.test(trimmed) || ACCOUNT_ID_PATTERN.test(trimmed)) return trimmed;
  return null;
}

export interface DateRangeValidation {
  valid: boolean;
  error?: string;
}

export function validateDateRange(range: { start?: string; end?: string }): DateRangeValidation {
  if (!range.start || !range.end) {
    return { valid: false, error: "start and end dates are required" };
  }

  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(range.start) || !dateRegex.test(range.end)) {
    return { valid: false, error: "Dates must be in YYYY-MM-DD format" };
  }

  const startDate = new Date(range.start + "T00:00:00Z");
  const endDate = new Date(range.end + "T00:00:00Z");

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return { valid: false, error: "Invalid date values" };
  }

  if (startDate > endDate) {
    return { valid: false, error: "start date must be before end date" };
  }

  const diffMs = endDate.getTime() - startDate.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);

  if (diffDays > MAX_DATE_RANGE_DAYS) {
    return {
      valid: false,
      error: `Date range cannot exceed ${MAX_DATE_RANGE_DAYS} days`,
    };
  }

  return { valid: true };
}

export function validateLimit(limit: unknown): number {
  const n = Number(limit);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_RESULT_LIMIT;
  return Math.min(n, MAX_RESULT_LIMIT);
}

export function validateMetrics(metrics: unknown): string[] {
  if (!Array.isArray(metrics)) return [];
  return metrics.filter(
    (m): m is string =>
      typeof m === "string" && (META_ALLOWED_METRICS as readonly string[]).includes(m)
  );
}

export function validateBreakdown(breakdown: unknown): string | undefined {
  if (typeof breakdown !== "string") return undefined;
  if ((META_ALLOWED_BREAKDOWNS as readonly string[]).includes(breakdown)) return breakdown;
  return undefined;
}

export function validateInsightLevel(level: unknown): string {
  const validLevels = ["account", "campaign", "adset", "ad"];
  if (typeof level === "string" && validLevels.includes(level)) return level;
  return "account";
}

export function sanitizeAccountId(input: string): string | null {
  return validateAccountId(input);
}

export const META_ADS_CONSTANTS = {
  MAX_DATE_RANGE_DAYS,
  MAX_RESULT_LIMIT,
  DEFAULT_RESULT_LIMIT,
  ACCOUNT_ID_PATTERN,
  ID_PATTERN,
} as const;

// ---------------------------------------------------------------------------
// Budget Validators (Phase 9.2)
// ---------------------------------------------------------------------------

const MIN_BUDGET_VALUE = 0.01;

export function validateBudgetParam(value: unknown): { valid: boolean; error?: string } {
  if (value === null || value === undefined) {
    return { valid: false, error: "Budget is required" };
  }

  let num: number;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return { valid: false, error: "Budget is empty" };
    num = Number(trimmed);
  } else if (typeof value === "number") {
    num = value;
  } else {
    return { valid: false, error: "Budget must be a number or numeric string" };
  }

  if (!Number.isFinite(num)) return { valid: false, error: "Budget must be finite" };
  if (Number.isNaN(num)) return { valid: false, error: "Budget is NaN" };
  if (num < MIN_BUDGET_VALUE) return { valid: false, error: `Budget must be at least ${MIN_BUDGET_VALUE}` };

  // Check precision: Meta supports 2 decimal places
  const rounded = Math.round(num * 100) / 100;
  if (Math.abs(num - rounded) > 0.001) {
    return { valid: false, error: "Budget has excessive precision (max 2 decimals)" };
  }

  return { valid: true };
}

export function parseBudgetValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value * 100) / 100;
  }
  if (typeof value === "string") {
    const num = Number(value.trim());
    if (Number.isFinite(num)) return Math.round(num * 100) / 100;
  }
  return null;
}
