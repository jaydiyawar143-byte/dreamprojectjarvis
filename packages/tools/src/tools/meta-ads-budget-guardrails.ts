import type { BudgetGuardrailsConfig, BudgetValidationResult } from "@jarvis/core";

// ---------------------------------------------------------------------------
// Budget Guardrails — Server-side financial limits (Phase 9.2)
// ---------------------------------------------------------------------------
// Every budget modification MUST pass these limits BEFORE approval.
// Limits are configurable. Defaults are conservative.
// The AI/model CANNOT bypass these limits through approval.
// ---------------------------------------------------------------------------

export const DEFAULT_BUDGET_GUARDRAILS: BudgetGuardrailsConfig = {
  maxDailyBudget: 10000,
  maxIncreasePercent: 25,
  maxIncreaseAbsolute: 2500,
  maxDecreasePercent: 50,
  maxDecreaseAbsolute: 5000,
};

// ---------------------------------------------------------------------------
// Budget amount validation
// ---------------------------------------------------------------------------

export interface BudgetAmountValidation {
  valid: boolean;
  amount?: number;
  error?: string;
}

/**
 * Validate a raw budget value and return a clean numeric amount.
 * Accepts string ("100.00") or number (100).
 * Rejects: negative, zero (if used), NaN, Infinity, excessive precision.
 */
export function validateBudgetAmount(value: unknown): BudgetAmountValidation {
  if (value === null || value === undefined) {
    return { valid: false, error: "Budget amount is required" };
  }

  let amount: number;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return { valid: false, error: "Budget amount is empty" };
    }
    amount = Number(trimmed);
  } else if (typeof value === "number") {
    amount = value;
  } else {
    return { valid: false, error: "Budget must be a number or numeric string" };
  }

  if (!Number.isFinite(amount)) {
    return { valid: false, error: "Budget must be a finite number" };
  }

  if (Number.isNaN(amount)) {
    return { valid: false, error: "Budget is not a valid number" };
  }

  if (amount <= 0) {
    return { valid: false, error: "Budget must be greater than zero" };
  }

  // Meta supports 2 decimal places (cents)
  const rounded = Math.round(amount * 100) / 100;
  if (Math.abs(amount - rounded) > 0.001) {
    return { valid: false, error: "Budget has excessive precision (max 2 decimal places)" };
  }

  return { valid: true, amount: rounded };
}

// ---------------------------------------------------------------------------
// Budget transition validation against guardrails
// ---------------------------------------------------------------------------

/**
 * Validate a budget transition from current to requested against guardrails.
 * Returns valid=true if the change is within all configured limits.
 */
export function validateBudgetTransition(
  currentBudget: number,
  requestedBudget: number,
  config: BudgetGuardrailsConfig = DEFAULT_BUDGET_GUARDRAILS
): BudgetValidationResult {
  const errors: string[] = [];

  if (requestedBudget <= 0) {
    errors.push("Requested budget must be greater than zero");
  }

  if (requestedBudget > config.maxDailyBudget) {
    errors.push(
      `Requested budget ${requestedBudget} exceeds maximum daily budget ${config.maxDailyBudget}`
    );
  }

  const absoluteChange = requestedBudget - currentBudget;
  const percentChange =
    currentBudget > 0 ? (absoluteChange / currentBudget) * 100 : 0;

  if (absoluteChange > 0) {
    // Budget increase
    if (absoluteChange > config.maxIncreaseAbsolute) {
      errors.push(
        `Budget increase ${absoluteChange.toFixed(2)} exceeds maximum allowed increase ${config.maxIncreaseAbsolute}`
      );
    }
    if (percentChange > config.maxIncreasePercent) {
      errors.push(
        `Budget increase ${percentChange.toFixed(1)}% exceeds maximum allowed increase ${config.maxIncreasePercent}%`
      );
    }
  } else if (absoluteChange < 0) {
    // Budget decrease
    const decreaseAmount = Math.abs(absoluteChange);
    const decreasePercent = Math.abs(percentChange);
    if (decreaseAmount > config.maxDecreaseAbsolute) {
      errors.push(
        `Budget decrease ${decreaseAmount.toFixed(2)} exceeds maximum allowed decrease ${config.maxDecreaseAbsolute}`
      );
    }
    if (decreasePercent > config.maxDecreasePercent) {
      errors.push(
        `Budget decrease ${decreasePercent.toFixed(1)}% exceeds maximum allowed decrease ${config.maxDecreasePercent}%`
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    absoluteChange,
    percentChange,
  };
}

// ---------------------------------------------------------------------------
// Budget change formatting for approval UX
// ---------------------------------------------------------------------------

export interface BudgetChangeSummary {
  currentBudget: number;
  requestedBudget: number;
  absoluteChange: number;
  percentChange: number;
  direction: "increase" | "decrease" | "unchanged";
  currency: string;
}

/**
 * Build a human-readable budget change summary for approval display.
 */
export function buildBudgetChangeSummary(
  currentBudget: number,
  requestedBudget: number,
  currency: string
): BudgetChangeSummary {
  const absoluteChange = requestedBudget - currentBudget;
  const percentChange =
    currentBudget > 0 ? (absoluteChange / currentBudget) * 100 : 0;

  let direction: "increase" | "decrease" | "unchanged" = "unchanged";
  if (absoluteChange > 0.001) direction = "increase";
  else if (absoluteChange < -0.001) direction = "decrease";

  return {
    currentBudget,
    requestedBudget,
    absoluteChange,
    percentChange,
    direction,
    currency,
  };
}

// ---------------------------------------------------------------------------
// Post-write verification
// ---------------------------------------------------------------------------

/**
 * Verify that the actual budget after write matches the requested budget
 * within Meta-supported precision (2 decimal places).
 */
export function verifyBudgetResult(
  requestedBudget: number,
  actualBudget: number,
  tolerance = 0.01
): { verified: boolean; error?: string } {
  if (Math.abs(requestedBudget - actualBudget) <= tolerance) {
    return { verified: true };
  }
  return {
    verified: false,
    error: `Verification failed: requested ${requestedBudget}, actual ${actualBudget}`,
  };
}
