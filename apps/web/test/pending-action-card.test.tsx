// ---------------------------------------------------------------------------
// Audit F2 / F7 (Phase 14) — the chat's confirmation card.
//
//   F7  A memory action is labelled in words ("Correct Memory"), not by its
//       raw tool id ("memory.correct").
//   F2  The card confirms and cancels the action it SHOWS (its own id), and
//       claims success only when the server says that action ran and
//       succeeded. A card for an action that is no longer waiting says so.
// ---------------------------------------------------------------------------

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return { ...actual, confirmPendingAction: vi.fn(), rejectPendingActionApi: vi.fn() };
});

import * as api from "../src/lib/api";
import { PendingActionCard, type PendingActionData } from "../src/components/pending-action-card";

const mocked = vi.mocked(api);
const ts = () => new Date().toISOString();
const ok = <T,>(data: T) => ({ success: true as const, data, timestamp: ts() });
const refused = (code: string, message: string) => ({ success: false as const, error: { code, message }, timestamp: ts() });

const action = (toolId: string, over: Partial<PendingActionData> = {}): PendingActionData => ({
  id: "pa-7",
  toolId,
  action: "Run it",
  params: {},
  riskLevel: "HIGH_IMPACT",
  state: "WAITING_CONFIRMATION",
  approvalId: "pa-7",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  ...over,
});

const message = () => screen.getByTestId("pending-action-message").textContent ?? "";
const card = () => screen.getByTestId("pending-action-card");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Audit F7 — a memory action is named in words", () => {
  it.each([
    ["memory.correct", "Correct Memory"],
    ["memory.forget", "Forget Memory"],
    ["memory.forget_all", "Forget All Memories"],
  ])("%s is shown as “%s”, never by its tool id", (toolId, label) => {
    render(<PendingActionCard pendingAction={action(toolId)} conversationId="conv-1" />);
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.queryByText(toolId)).toBeNull();
  });

  it("the existing Meta labels are unchanged", () => {
    render(<PendingActionCard pendingAction={action("meta.campaign.pause")} conversationId="conv-1" />);
    expect(screen.getByText("Pause Campaign")).toBeTruthy();
  });
});

describe("Audit F2 — the card answers its own action, and claims only what the server confirmed", () => {
  it("Confirm sends the card's own action id, and says it ran only when it ran and succeeded", async () => {
    mocked.confirmPendingAction.mockResolvedValue(ok({ pendingAction: {}, executionResult: { status: "completed", result: { success: true } } }));
    render(<PendingActionCard pendingAction={action("memory.forget")} conversationId="conv-1" />);

    fireEvent.click(screen.getByTestId("confirm-button"));

    await waitFor(() => expect(card().getAttribute("data-state")).toBe("EXECUTED"));
    expect(mocked.confirmPendingAction).toHaveBeenCalledWith("pa-7", "conv-1");
    expect(message()).toBe("Executed successfully!");
  });

  it("a card for an action that is no longer waiting (409) says nothing was changed — never success", async () => {
    mocked.confirmPendingAction.mockResolvedValue(
      refused("PENDING_ACTION_MISMATCH", "That is no longer the action waiting for your confirmation, so nothing was changed. Answer the latest request instead.")
    );
    render(<PendingActionCard pendingAction={action("memory.correct")} conversationId="conv-1" />);

    fireEvent.click(screen.getByTestId("confirm-button"));

    await waitFor(() => expect(card().getAttribute("data-state")).toBe("FAILED"));
    expect(message()).toMatch(/no longer the action waiting/);
    expect(message()).not.toMatch(/success|executed/i);
  });

  it("a Confirm that lost to another answer (409 already resolved) is shown in the server's words — never as success", async () => {
    mocked.confirmPendingAction.mockResolvedValue(refused("PENDING_ACTION_ALREADY_RESOLVED", "That action was already cancelled or replaced, so nothing was confirmed or run."));
    render(<PendingActionCard pendingAction={action("meta.campaign.pause")} conversationId="conv-1" />);

    fireEvent.click(screen.getByTestId("confirm-button"));

    await waitFor(() => expect(card().getAttribute("data-state")).toBe("FAILED"));
    expect(message()).toBe("That action was already cancelled or replaced, so nothing was confirmed or run.");
  });

  it("an action the server ran but which failed shows the tool's own reason, not “undefined” and not success", async () => {
    mocked.confirmPendingAction.mockResolvedValue(
      ok({ pendingAction: {}, executionResult: { status: "failed", result: { success: false, error: "That memory changed after you chose it, so nothing was changed." } } })
    );
    render(<PendingActionCard pendingAction={action("memory.correct")} conversationId="conv-1" />);

    fireEvent.click(screen.getByTestId("confirm-button"));

    await waitFor(() => expect(card().getAttribute("data-state")).toBe("FAILED"));
    expect(message()).toBe("That memory changed after you chose it, so nothing was changed.");
  });

  it.each([
    ["no execution at all", { pendingAction: {} }],
    ["an execution still waiting for approval", { pendingAction: {}, executionResult: { status: "approval_pending" } }],
    ["an execution that timed out", { pendingAction: {}, executionResult: { status: "timeout", error: "The tool timed out." } }],
  ])("approved but not run (%s) is never reported as executed", async (_label, data) => {
    mocked.confirmPendingAction.mockResolvedValue(ok(data as never));
    render(<PendingActionCard pendingAction={action("meta.campaign.pause")} conversationId="conv-1" />);

    fireEvent.click(screen.getByTestId("confirm-button"));

    await waitFor(() => expect(card().getAttribute("data-state")).toBe("FAILED"));
    expect(message()).not.toMatch(/success|executed/i);
  });

  it("Cancel sends the card's own action id; a refusal is shown in the server's words, never as cancelled", async () => {
    mocked.rejectPendingActionApi.mockResolvedValue(refused("PENDING_ACTION_MISMATCH", "That is no longer the action waiting for your confirmation, so nothing was changed."));
    render(<PendingActionCard pendingAction={action("memory.forget")} conversationId="conv-1" />);

    fireEvent.click(screen.getByTestId("reject-button"));

    await waitFor(() => expect(card().getAttribute("data-state")).toBe("FAILED"));
    expect(mocked.rejectPendingActionApi).toHaveBeenCalledWith("pa-7", "conv-1");
    expect(message()).toMatch(/no longer the action waiting/);
    expect(message()).not.toMatch(/^Cancelled/);
  });
});
