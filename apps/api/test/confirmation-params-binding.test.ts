import { describe, it, expect, beforeEach } from "vitest";
import type { IntegrationId } from "@jarvis/core";
import {
  issueConfirmation,
  consumeConfirmation,
  __resetConfirmations,
} from "../src/services/integrations/confirmations.js";

// A confirmation token is bound to the exact parameters that were described to
// the user. These cases pin that binding for nested values — a budget inside a
// campaign object — which a top-level-only hash cannot tell apart.

const USER = "user-binding-test";
const INTEGRATION = "meta" as IntegrationId;
const ACTION = "campaign.update";

function issue(params: Record<string, unknown>): string {
  return issueConfirmation({
    userId: USER,
    integration: INTEGRATION,
    actionId: ACTION,
    params,
    summary: "test summary",
    irreversible: true,
  }).token;
}

function consume(token: string, params: Record<string, unknown>) {
  return consumeConfirmation({
    token,
    userId: USER,
    integration: INTEGRATION,
    actionId: ACTION,
    params,
  });
}

describe("confirmation parameter binding", () => {
  beforeEach(() => __resetConfirmations());

  it("rejects a token replayed against a different nested value", () => {
    const token = issue({ campaign: { budget: 10 } });
    expect(consume(token, { campaign: { budget: 10000 } })).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("rejects a token replayed against a different array element", () => {
    const token = issue({ items: [{ id: "a" }] });
    expect(consume(token, { items: [{ id: "b" }] })).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("accepts identical nested parameters serialised in a different key order", () => {
    const token = issue({ campaign: { name: "x", budget: 10 }, mode: "safe" });
    expect(consume(token, { mode: "safe", campaign: { budget: 10, name: "x" } })).toEqual({
      ok: true,
      summary: "test summary",
    });
  });

  it("rejects a different top-level value", () => {
    const token = issue({ amount: 10 });
    expect(consume(token, { amount: 11 })).toEqual({ ok: false, reason: "mismatch" });
  });
});
