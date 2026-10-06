import { describe, it, expect, beforeEach } from "vitest";
import type { IntegrationId } from "@jarvis/core";
import {
  createConfirmationService,
  type ConfirmationPort,
} from "../src/services/integrations/confirmations.js";
import { memoryConfirmationStore } from "./helpers/memory-confirmation-store.js";

// A confirmation token is bound to the exact parameters that were described to
// the user. These cases pin that binding for nested values — a budget inside a
// campaign object — which a top-level-only hash cannot tell apart.

const USER = "user-binding-test";
const INTEGRATION = "meta" as IntegrationId;
const ACTION = "campaign.update";

let confirmations: ConfirmationPort;

async function issue(params: Record<string, unknown>): Promise<string> {
  return (
    await confirmations.issue({
      userId: USER,
      integration: INTEGRATION,
      actionId: ACTION,
      params,
      summary: "test summary",
      irreversible: true,
    })
  ).token;
}

function consume(token: string, params: Record<string, unknown>) {
  return confirmations.consume({
    token,
    userId: USER,
    integration: INTEGRATION,
    actionId: ACTION,
    params,
  });
}

describe("confirmation parameter binding", () => {
  beforeEach(() => {
    confirmations = createConfirmationService(memoryConfirmationStore().store);
  });

  it("rejects a token replayed against a different nested value", async () => {
    const token = await issue({ campaign: { budget: 10 } });
    expect(await consume(token, { campaign: { budget: 10000 } })).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("rejects a token replayed against a different array element", async () => {
    const token = await issue({ items: [{ id: "a" }] });
    expect(await consume(token, { items: [{ id: "b" }] })).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("accepts identical nested parameters serialised in a different key order", async () => {
    const token = await issue({ campaign: { name: "x", budget: 10 }, mode: "safe" });
    // Phase 13 — the summary is no longer echoed back: it holds parameter
    // values, and nothing the user typed is kept in the confirmation store.
    expect(await consume(token, { mode: "safe", campaign: { budget: 10, name: "x" } })).toEqual({
      ok: true,
    });
  });

  it("rejects a different top-level value", async () => {
    const token = await issue({ amount: 10 });
    expect(await consume(token, { amount: 11 })).toEqual({ ok: false, reason: "mismatch" });
  });
});
