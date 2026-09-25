// ---------------------------------------------------------------------------
// S6 — the objective evaluation panel.
//
// The panel is a PRESENTER for GET /activity/trace/:traceId/evaluation. These
// tests check that it asks for the right trace at the right time and renders
// what comes back as a fixed mapping — never that it computes anything. Three
// rules are asserted repeatedly because they are the point of the feature:
//
//   1. Closed costs nothing. A conversation of fifty replies makes no request
//      until someone opens a panel.
//   2. Nothing is derived. No count, total, percentage, score or verdict.
//   3. Nothing internal leaks. Fact refs, approval and task ids, tool ids and
//      raw server error text never reach the page.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return { ...actual, getObjectiveEvaluation: vi.fn() };
});

import * as api from "../src/lib/api";
import type {
  ApiResponse,
  ConversationMessage,
  Objective,
  ObjectiveAssessment,
  ObjectiveEvaluation,
} from "../src/lib/api";
import { ObjectiveEvaluationPanel } from "../src/components/objective-evaluation-panel";
import { MessageList } from "../src/components/message-list";

const mockedGet = vi.mocked(api.getObjectiveEvaluation);

const TRACE = "trace-7f3a";
const AS_OF = "2026-09-25T10:15:30.000Z";
const AS_OF_LATER = "2026-09-25T10:20:45.000Z";

function ok(data: ObjectiveEvaluation): ApiResponse<ObjectiveEvaluation> {
  return { success: true, data, timestamp: new Date().toISOString() };
}

function fail(code: string, message: string): ApiResponse<ObjectiveEvaluation> {
  return { success: false, error: { code, message }, timestamp: new Date().toISOString() };
}

function objective(index: number, text: string, evidenceClass: Objective["evidenceClass"] = "RETRIEVE"): Objective {
  return { objectiveId: `${TRACE}#${index}`, text, evidenceClass, skills: [] };
}

/** `status` and `rule` are plain strings so a test can send a value the contract does not know. */
function assessment(index: number, status: string, rule: string, missing?: string): ObjectiveAssessment {
  return {
    objectiveId: `${TRACE}#${index}`,
    status,
    rule,
    evidence: [],
    ...(missing ? { missing } : {}),
  } as ObjectiveAssessment;
}

function evaluation(over: Partial<ObjectiveEvaluation> = {}): ObjectiveEvaluation {
  return {
    traceId: TRACE,
    bound: true,
    objectives: [objective(0, "check my system status")],
    assessments: [assessment(0, "EVIDENCED", "RETRIEVE_READ_PROVEN")],
    facts: [],
    missing: [],
    feedback: null,
    asOf: AS_OF,
    ...over,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const toggle = () => screen.getByRole("button", { name: /objective evaluation/i });

/** Opens the panel and waits for the first request to settle. */
async function openPanel() {
  fireEvent.click(toggle());
  await waitFor(() => expect(screen.queryByTestId("loading-state")).not.toBeInTheDocument());
}

/** Everything the panel shows, minus the as-of timestamp (a date is not a count). */
function textWithoutTimestamp(container: HTMLElement): string {
  const clone = container.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("time").forEach((node) => node.remove());
  return clone.textContent ?? "";
}

beforeEach(() => {
  mockedGet.mockReset();
});

// ---------------------------------------------------------------------------
// Disclosure and fetching
// ---------------------------------------------------------------------------

describe("S6 panel — disclosure and fetching", () => {
  it("1. is closed by default", () => {
    render(<ObjectiveEvaluationPanel traceId={TRACE} />);

    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("objective-evaluation-body")).not.toBeInTheDocument();
  });

  it("2. makes no request while closed", async () => {
    render(<ObjectiveEvaluationPanel traceId={TRACE} />);
    await new Promise((r) => setTimeout(r, 0));

    expect(mockedGet).not.toHaveBeenCalled();
  });

  it("3. opening fetches once, using the exact traceId", async () => {
    mockedGet.mockResolvedValue(ok(evaluation()));
    render(<ObjectiveEvaluationPanel traceId={TRACE} />);

    await openPanel();

    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(mockedGet).toHaveBeenCalledTimes(1);
    expect(mockedGet).toHaveBeenCalledWith(TRACE);
    expect(screen.getByTestId("objective-evaluation-body")).toBeInTheDocument();
  });

  it("3b. closing and reopening fetches again", async () => {
    mockedGet.mockResolvedValue(ok(evaluation()));
    render(<ObjectiveEvaluationPanel traceId={TRACE} />);

    await openPanel();
    fireEvent.click(toggle());
    expect(screen.queryByTestId("objective-evaluation-body")).not.toBeInTheDocument();
    await openPanel();

    expect(mockedGet).toHaveBeenCalledTimes(2);
    expect(mockedGet).toHaveBeenNthCalledWith(2, TRACE);
  });

  it("3c. the toggle is a native button, so keyboard and touch can reach it", () => {
    render(<ObjectiveEvaluationPanel traceId={TRACE} />);

    expect(toggle().tagName).toBe("BUTTON");
    expect(toggle()).toHaveAttribute("type", "button");
    expect(toggle().getAttribute("aria-controls")).toBeTruthy();
  });

  it("4. shows the loading state while the request is in flight", async () => {
    const pending = deferred<ApiResponse<ObjectiveEvaluation>>();
    mockedGet.mockReturnValue(pending.promise);
    render(<ObjectiveEvaluationPanel traceId={TRACE} />);

    fireEvent.click(toggle());

    expect(screen.getByTestId("loading-state")).toHaveAttribute("role", "status");
    pending.resolve(ok(evaluation()));
    await screen.findByText("check my system status");
    expect(screen.queryByTestId("loading-state")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Objective presentation
// ---------------------------------------------------------------------------

describe("S6 panel — objective presentation", () => {
  it("5. renders objective.text exactly as sent", async () => {
    const text = "iska plan banao,  Execute MAT karo — and send it to  Ravi";
    mockedGet.mockResolvedValue(ok(evaluation({ objectives: [objective(0, text)] })));
    render(<ObjectiveEvaluationPanel traceId={TRACE} />);

    await openPanel();

    expect(screen.getByTestId("objective-text").textContent).toBe(text);
  });

  it("6. renders evidenceClass as sent", async () => {
    mockedGet.mockResolvedValue(
      ok(evaluation({ objectives: [objective(0, "send the report", "EXTERNAL_WRITE")] }))
    );
    render(<ObjectiveEvaluationPanel traceId={TRACE} />);

    await openPanel();

    expect(screen.getByTestId("objective-class").textContent).toBe("EXTERNAL_WRITE");
  });

  it.each([
    ["7", "EVIDENCED", "Evidenced", "ok"],
    ["8", "AWAITING_APPROVAL", "Awaiting approval", "warn"],
    ["9", "BLOCKED", "Blocked", "danger"],
    ["10", "NOT_ATTEMPTED", "Not attempted", "neutral"],
    ["11", "NOT_EVALUABLE", "Not evaluable", "info"],
  ])("%s. %s is presented as the fixed label %s", async (_n, status, label, tone) => {
    mockedGet.mockResolvedValue(
      ok(
        evaluation({
          assessments: [
            assessment(0, status, "RESPONSE_ONLY", status === "NOT_EVALUABLE" ? "RESPONSE_MEANING" : undefined),
          ],
        })
      )
    );
    render(<ObjectiveEvaluationPanel traceId={TRACE} />);

    await openPanel();

    const dot = screen.getByTestId("status-dot");
    expect(dot.textContent).toBe(label);
    expect(dot).toHaveAttribute("data-tone", tone);
  });

  it.each(["PARTIALLY_DONE", "constructor"])(
    "12. an unknown status (%s) renders its raw value, neutrally",
    async (status) => {
      mockedGet.mockResolvedValue(ok(evaluation({ assessments: [assessment(0, status, "RESPONSE_ONLY")] })));
      render(<ObjectiveEvaluationPanel traceId={TRACE} />);

      await openPanel();

      const dot = screen.getByTestId("status-dot");
      expect(dot.textContent).toBe(status);
      expect(dot).toHaveAttribute("data-tone", "neutral");
    }
  );

  it("13. renders the rule as sent", async () => {
    mockedGet.mockResolvedValue(
      ok(evaluation({ assessments: [assessment(0, "AWAITING_APPROVAL", "WRITE_AWAITING_APPROVAL")] }))
    );
    render(<ObjectiveEvaluationPanel traceId={TRACE} />);

    await openPanel();

    expect(screen.getByTestId("objective-rule").textContent).toBe("WRITE_AWAITING_APPROVAL");
  });

  it("14. renders an assessment's missing code and the top-level missing codes", async () => {
    mockedGet.mockResolvedValue(
      ok(
        evaluation({
          objectives: [objective(0, "tell me a joke", "COMPOSE"), objective(1, "check my tasks")],
          assessments: [
            assessment(0, "NOT_EVALUABLE", "RESPONSE_ONLY", "RESPONSE_MEANING"),
            assessment(1, "EVIDENCED", "RETRIEVE_READ_PROVEN"),
          ],
          missing: ["ROW_LIMIT", "OBJECTIVE_CLASS"],
        })
      )
    );
    render(<ObjectiveEvaluationPanel traceId={TRACE} />);

    await openPanel();

    const [notEvaluable, evidenced] = screen.getAllByTestId("objective-item");
    expect(within(notEvaluable!).getByTestId("objective-missing").textContent).toBe("RESPONSE_MEANING");
    expect(within(evidenced!).queryByTestId("objective-missing")).not.toBeInTheDocument();

    const topLevel = screen.getByTestId("evaluation-missing");
    expect(within(topLevel).getByText("ROW_LIMIT")).toBeInTheDocument();
    expect(within(topLevel).getByText("OBJECTIVE_CLASS")).toBeInTheDocument();
  });

  it("14b. no top-level missing section when the list is empty", async () => {
    mockedGet.mockResolvedValue(ok(evaluation({ missing: [] })));
    render(<ObjectiveEvaluationPanel traceId={TRACE} />);

    await openPanel();

    expect(screen.queryByTestId("evaluation-missing")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Neutral states
// ---------------------------------------------------------------------------

describe("S6 panel — neutral states", () => {
  it("15. bound:false says no request text is linked, and lists no objectives", async () => {
    mockedGet.mockResolvedValue(
      ok(evaluation({ bound: false, objectives: [], assessments: [], missing: ["REQUEST_TEXT"] }))
    );
    render(<ObjectiveEvaluationPanel traceId={TRACE} />);

    await openPanel();

    expect(screen.getByText("No request text is linked to this trace.")).toBeInTheDocument();
    expect(screen.queryByTestId("objective-item")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("evaluation-missing")).getByText("REQUEST_TEXT")).toBeInTheDocument();
  });

  it("16. bound:true with zero objectives shows a neutral empty state", async () => {
    mockedGet.mockResolvedValue(ok(evaluation({ objectives: [], assessments: [] })));
    render(<ObjectiveEvaluationPanel traceId={TRACE} />);

    await openPanel();

    expect(screen.getByTestId("empty-state")).toBeInTheDocument();
    expect(screen.queryByTestId("objective-item")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("17. a 404 is a neutral message, not an error", async () => {
    mockedGet.mockResolvedValue(fail("NOT_FOUND", "No activity for that request"));
    render(<ObjectiveEvaluationPanel traceId={TRACE} />);

    await openPanel();

    expect(screen.getByText("No evaluation is available for this reply.")).toBeInTheDocument();
    expect(screen.queryByTestId("error-state")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("No activity for that request")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Errors, retry, refresh
// ---------------------------------------------------------------------------

describe("S6 panel — errors, retry and refresh", () => {
  it.each([
    ["INTERNAL_ERROR", "PrismaClientKnownRequestError: SELECT * FROM AuditLog failed"],
    ["NETWORK_ERROR", "Network request failed"],
    ["AUTHENTICATION_REQUIRED", "Authentication required"],
    ["INVALID_REQUEST", "A traceId is required"],
  ])("18. %s shows fixed frontend wording, never the server's message", async (code, message) => {
    mockedGet.mockResolvedValue(fail(code, message));
    const { container } = render(<ObjectiveEvaluationPanel traceId={TRACE} />);

    await openPanel();

    expect(screen.getByTestId("error-state")).toBeInTheDocument();
    expect(screen.getByText("The evaluation could not be loaded right now.")).toBeInTheDocument();
    expect(container.textContent).not.toContain(message);
    expect(container.innerHTML).not.toContain(code);
  });

  it("18b. a success envelope without data is treated as an error, with the same fixed wording", async () => {
    mockedGet.mockResolvedValue({ success: true, timestamp: new Date().toISOString() });
    render(<ObjectiveEvaluationPanel traceId={TRACE} />);

    await openPanel();

    expect(screen.getByTestId("error-state")).toBeInTheDocument();
    expect(screen.getByText("The evaluation could not be loaded right now.")).toBeInTheDocument();
  });

  it("19. retry asks again and shows the evaluation once it loads", async () => {
    mockedGet
      .mockResolvedValueOnce(fail("INTERNAL_ERROR", "boom"))
      .mockResolvedValueOnce(ok(evaluation()));
    render(<ObjectiveEvaluationPanel traceId={TRACE} />);

    await openPanel();
    fireEvent.click(screen.getByTestId("error-retry"));

    await screen.findByText("check my system status");
    expect(mockedGet).toHaveBeenCalledTimes(2);
    expect(mockedGet).toHaveBeenNthCalledWith(2, TRACE);
    expect(screen.queryByTestId("error-state")).not.toBeInTheDocument();
  });

  it("20. refresh refetches explicitly and shows the returned asOf", async () => {
    const second = deferred<ApiResponse<ObjectiveEvaluation>>();
    mockedGet
      .mockResolvedValueOnce(ok(evaluation({ asOf: AS_OF })))
      .mockReturnValueOnce(second.promise);
    const { container } = render(<ObjectiveEvaluationPanel traceId={TRACE} />);

    await openPanel();
    const asOf = () => container.querySelector("[data-testid='evaluation-as-of'] time");
    expect(asOf()).toHaveAttribute("dateTime", AS_OF);

    const refresh = screen.getByRole("button", { name: /refresh/i });
    fireEvent.click(refresh);
    expect(refresh).toBeDisabled();

    second.resolve(
      ok(
        evaluation({
          asOf: AS_OF_LATER,
          assessments: [assessment(0, "BLOCKED", "WRITE_ATTEMPTS_STOPPED")],
        })
      )
    );
    await waitFor(() => expect(asOf()).toHaveAttribute("dateTime", AS_OF_LATER));
    expect(screen.getByTestId("status-dot").textContent).toBe("Blocked");
    expect(mockedGet).toHaveBeenCalledTimes(2);
    expect(mockedGet).toHaveBeenNthCalledWith(2, TRACE);
    expect(screen.getByRole("button", { name: /refresh/i })).not.toBeDisabled();
  });

  it("20b. a null asOf renders no timestamp", async () => {
    mockedGet.mockResolvedValue(ok(evaluation({ asOf: null })));
    const { container } = render(<ObjectiveEvaluationPanel traceId={TRACE} />);

    await openPanel();

    expect(container.querySelector("time")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Safety and scale
// ---------------------------------------------------------------------------

describe("S6 panel — safety and scale", () => {
  it("21. never renders internal ids, facts, feedback or any derived verdict", async () => {
    mockedGet.mockResolvedValue(
      ok(
        evaluation({
          objectives: [
            {
              objectiveId: `${TRACE}#0`,
              text: "send the campaign report",
              evidenceClass: "EXTERNAL_WRITE",
              skills: ["gmail-SKILLSECRET"],
            },
            objective(1, "check my tasks"),
            objective(2, "tell me a joke", "COMPOSE"),
          ],
          assessments: [
            {
              objectiveId: `${TRACE}#0`,
              status: "AWAITING_APPROVAL",
              rule: "WRITE_AWAITING_APPROVAL",
              evidence: ["audit:REFSECRET1"],
            },
            {
              objectiveId: `${TRACE}#1`,
              status: "EVIDENCED",
              rule: "RETRIEVE_READ_PROVEN",
              evidence: ["audit:REFSECRET2"],
            },
            {
              objectiveId: `${TRACE}#2`,
              status: "NOT_EVALUABLE",
              rule: "RESPONSE_ONLY",
              evidence: [],
              missing: "RESPONSE_MEANING",
            },
          ],
          facts: [
            {
              ref: "audit:REFSECRET1",
              kind: "APPROVAL_REQUESTED",
              at: AS_OF,
              toolId: "google.gmail.TOOLSECRET",
              approvalId: "APPROVALSECRET",
              result: "pending",
            },
            { ref: "audit:REFSECRET2", kind: "TOOL_RESULT", at: AS_OF, toolId: "task.TOOLSECRET", result: "success" },
            {
              ref: "audit:REFSECRET3",
              kind: "PROVIDER_RESULT",
              at: AS_OF,
              action: "integration.ACTIONSECRET",
              code: "CODESECRET",
              result: "failure",
            },
            {
              ref: "audit:REFSECRET4",
              kind: "TOOL_REFUSED",
              at: AS_OF,
              toolId: "x.TOOLSECRET",
              refusal: "POLICY",
              result: "rejected",
            },
            { ref: "message:REFSECRET5#taskId", kind: "TASK_CREATED", at: AS_OF, taskId: "TASKSECRET" },
          ],
          feedback: "HELPFUL",
        })
      )
    );
    const { container } = render(<ObjectiveEvaluationPanel traceId={TRACE} />);

    await openPanel();

    const html = container.innerHTML;
    for (const secret of ["SECRET", "audit:", "message:", TRACE, "HELPFUL", "POLICY", "TOOL_RESULT", "APPROVAL_REQUESTED"]) {
      expect(html).not.toContain(secret);
    }

    const text = textWithoutTimestamp(container);
    expect(text).not.toMatch(
      /confidence|score|percent|%|grade|overall|success rate|recommend|ranking|rank\b|winner|verdict|total|jarvis thinks/i
    );
    // No "2 of 3", "2/3" or bare tallies anywhere outside the timestamp.
    expect(text).not.toMatch(/\d/);
  });

  it("22. long objective text is rendered in full and allowed to wrap", async () => {
    const unbroken = "x".repeat(320);
    const long = `${"please pull every campaign metric for the last quarter and ".repeat(30)}${unbroken}`;
    mockedGet.mockResolvedValue(ok(evaluation({ objectives: [objective(0, long)] })));
    render(<ObjectiveEvaluationPanel traceId={TRACE} />);

    await openPanel();

    const node = screen.getByTestId("objective-text");
    expect(node.textContent).toBe(long);
    // overflow-wrap:anywhere, not break-word: only "anywhere" also lowers the
    // element's MIN-CONTENT width. With break-word, an unbroken URL still sets
    // the chat column's minimum width and a phone-sized screen overflows. That
    // was observed in the browser at 390px before the fix.
    expect(node.className).toContain("[overflow-wrap:anywhere]");
    expect(node.className).toContain("whitespace-pre-wrap");
    expect(node.className).toContain("min-w-0");
  });

  it("22b. every code can wrap too, so the panel never sets a minimum width wider than a phone", async () => {
    mockedGet.mockResolvedValue(
      ok(
        evaluation({
          assessments: [assessment(0, "NOT_EVALUABLE", "ROW_LIMIT_ABSENCE_UNPROVEN", "UNRECORDED_WRITE_PATH")],
          missing: ["OBJECTIVE_CLASS"],
        })
      )
    );
    render(<ObjectiveEvaluationPanel traceId={TRACE} />);

    await openPanel();

    const codes = [
      screen.getByTestId("objective-class"),
      screen.getByTestId("objective-rule"),
      screen.getByTestId("objective-missing"),
      ...within(screen.getByTestId("evaluation-missing")).getAllByTestId("missing-code"),
    ];
    expect(codes).toHaveLength(4);
    for (const node of codes) {
      expect(node.className).toContain("[overflow-wrap:anywhere]");
    }
  });

  it("23. eight objectives all render, in order, with no count anywhere", async () => {
    const texts = Array.from({ length: 8 }, (_, i) => `objective ${"abcdefgh"[i]} of the request`);
    const statuses = [
      "EVIDENCED",
      "AWAITING_APPROVAL",
      "BLOCKED",
      "NOT_ATTEMPTED",
      "NOT_EVALUABLE",
      "EVIDENCED",
      "BLOCKED",
      "NOT_ATTEMPTED",
    ];
    mockedGet.mockResolvedValue(
      ok(
        evaluation({
          objectives: texts.map((t, i) => objective(i, t)),
          assessments: statuses.map((s, i) =>
            assessment(i, s, "RESPONSE_ONLY", s === "NOT_EVALUABLE" ? "RESPONSE_MEANING" : undefined)
          ),
        })
      )
    );
    const { container } = render(<ObjectiveEvaluationPanel traceId={TRACE} />);

    await openPanel();

    const items = screen.getAllByTestId("objective-item");
    expect(items).toHaveLength(8);
    items.forEach((item, i) => {
      expect(within(item).getByTestId("objective-text").textContent).toBe(texts[i]);
    });
    expect(screen.getAllByTestId("status-dot")).toHaveLength(8);
    expect(textWithoutTimestamp(container)).not.toMatch(/\d/);
  });
});

// ---------------------------------------------------------------------------
// Attachment to the message list
// ---------------------------------------------------------------------------

describe("S6 panel — message list attachment", () => {
  const at = "2026-09-25T10:00:00Z";

  it("24. an assistant message with a traceId gets exactly one panel, after the approval card and before the footer", async () => {
    mockedGet.mockResolvedValue(ok(evaluation()));
    const messages: ConversationMessage[] = [
      { id: "u1", role: "user", content: "send the report", createdAt: at, metadata: { traceId: TRACE } },
      {
        id: "a1",
        role: "assistant",
        content: "I need your approval first.",
        createdAt: at,
        metadata: {
          traceId: TRACE,
          requestId: "req-browser-only",
          approval: { approvalId: "ap-1", summary: "Send the report" },
        },
      },
    ];
    render(<MessageList messages={messages} loading={false} sending={false} />);

    const panels = screen.getAllByTestId("objective-evaluation");
    expect(panels).toHaveLength(1);
    const panel = panels[0]!;

    const bubble = screen.getByText("I need your approval first.").closest(".rounded-2xl") as HTMLElement;
    expect(bubble).toContainElement(panel);

    const approval = within(bubble).getByText("Send the report");
    const copy = within(bubble).getByTitle("Copy");
    expect(approval.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panel.compareDocumentPosition(copy) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Not hover-only: no ancestor hides it until the pointer arrives.
    for (let node: HTMLElement | null = toggle(); node; node = node.parentElement) {
      expect(node.className).not.toMatch(/\bopacity-0\b/);
    }

    expect(mockedGet).not.toHaveBeenCalled();
    await openPanel();
    expect(mockedGet).toHaveBeenCalledTimes(1);
    expect(mockedGet).toHaveBeenCalledWith(TRACE);
  });

  it("25. an assistant message without a traceId gets no panel, even with a requestId", () => {
    const messages: ConversationMessage[] = [
      { id: "a1", role: "assistant", content: "Hello!", createdAt: at, metadata: { requestId: "req-browser-only" } },
      { id: "a2", role: "assistant", content: "No metadata at all", createdAt: at },
      { id: "a3", role: "assistant", content: "Odd metadata", createdAt: at, metadata: { traceId: 42 } },
      { id: "a4", role: "assistant", content: "Empty trace", createdAt: at, metadata: { traceId: "" } },
    ];
    render(<MessageList messages={messages} loading={false} sending={false} />);

    expect(screen.queryByTestId("objective-evaluation")).not.toBeInTheDocument();
  });

  it("26. a user message with a traceId gets no panel", () => {
    const messages: ConversationMessage[] = [
      { id: "u1", role: "user", content: "check my system status", createdAt: at, metadata: { traceId: TRACE } },
    ];
    render(<MessageList messages={messages} loading={false} sending={false} />);

    expect(screen.queryByTestId("objective-evaluation")).not.toBeInTheDocument();
  });
});
