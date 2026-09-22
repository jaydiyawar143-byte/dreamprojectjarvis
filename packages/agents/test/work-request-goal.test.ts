// ---------------------------------------------------------------------------
// SCHEDULE goals carry the WORK, not the WHEN.
//
// THE BUG THIS PINS. `detectWorkRequest` consumed "In 3 minutes" to produce
// the schedule instant, but left it in `goal`. The goal becomes the task's
// title and description, and the planner is asked to plan that text — so the
// model saw "In 3 minutes check my system status" and read two actions: wait,
// then check. It answered `requiresMultipleActions: true` and the task was
// refused before it could be scheduled.
//
// It failed twice over, which is why the fix belongs here and not in the
// caller: the feasibility check refused the schedule up front, AND the
// scheduler re-plans from the task's STORED title at execution time, so the
// same refusal would have come back three minutes later. Cleaning the goal in
// the detector means the task is stored clean and both reads are correct.
//
// `matched` is deliberately NOT cleaned — the confirmation message quotes what
// the user said, and that is only useful verbatim.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { detectWorkRequest } from "../src/work-request-detector.js";

/** 09:30 IST — early enough that every evening time below is still ahead. */
const NOW = new Date("2026-09-23T04:00:00.000Z");

const detect = (message: string, now: Date = NOW) => detectWorkRequest(message, now);

/** The SCHEDULE branch, narrowed, so a wrong type fails loudly rather than late. */
function scheduled(message: string, now: Date = NOW) {
  const result = detect(message, now);
  expect(result.type, message).toBe("SCHEDULE");
  if (result.type !== "SCHEDULE") throw new Error("not scheduled");
  return result;
}

describe("SCHEDULE — the temporal phrase is removed from the goal", () => {
  it("1. strips a relative phrase", () => {
    expect(scheduled("In 3 minutes check my system status").goal).toBe(
      "check my system status"
    );
  });

  it("2. strips a leading bare clock", () => {
    expect(scheduled("At 5 PM check the weather in Balaghat").goal).toBe(
      "check the weather in Balaghat"
    );
  });

  it("3. strips 'Today' together with the clock it belongs to", () => {
    expect(scheduled("Today at 10:45 PM check my system status.").goal).toBe(
      "check my system status."
    );
  });

  it("4. strips 'Tomorrow' together with the clock it belongs to", () => {
    expect(scheduled("Tomorrow at 10 AM check my system status").goal).toBe(
      "check my system status"
    );
  });

  it("5. strips the Hinglish day word and 'baje' clock", () => {
    expect(scheduled("Kal 5 baje system status check karo").goal).toBe(
      "system status check karo"
    );
  });

  it("6. keeps `matched` as the user said it", () => {
    expect(scheduled("In 3 minutes check my system status").matched).toBe("In 3 minutes");
    expect(scheduled("At 5 PM check the weather in Balaghat").matched).toBe("At 5 PM");
    expect(scheduled("Today at 10:45 PM check my system status.").matched).toBe("at 10:45 PM");
    expect(scheduled("Kal 5 baje system status check karo").matched).toBe("5 baje");
  });

  it("9. leaves enough for a confirmation that quotes the phrase and the work", () => {
    const r = scheduled("Tomorrow at 10 AM check my system status");
    // What the conversation service composes: the echo, and the cleaned work.
    expect(`Scheduled "${r.goal}" for ${r.matched}`).toBe(
      'Scheduled "check my system status" for at 10 AM'
    );
    expect(r.at.toISOString()).toBe("2026-09-24T04:30:00.000Z");
  });
});

describe("SCHEDULE — stripping is adjacent-only, never a guess", () => {
  it("removes a day word that FOLLOWS the clock", () => {
    expect(scheduled("Check my system status tomorrow at 10 am").goal).toBe(
      "Check my system status"
    );
  });

  it("removes only the day word touching the phrase, keeping a meaningful one", () => {
    // The first `tomorrow` is the schedule; the second is what the work is
    // about. A blanket strip would silently change the request.
    expect(scheduled("Tomorrow at 9 AM send the report about tomorrow's meeting").goal).toBe(
      "send the report about tomorrow's meeting"
    );
  });

  it("normalises the whitespace the removal leaves behind", () => {
    const r = scheduled("Tomorrow  at  10  AM   check   my  system  status");
    expect(r.goal).toBe("check my system status");
    expect(r.goal).not.toMatch(/\s{2,}/);
    expect(r.goal).not.toMatch(/^\s|\s$/);
  });

  it("never yields an empty goal", () => {
    for (const message of [
      "In 3 minutes check my system status",
      "At 5 PM check the weather in Balaghat",
      "Kal 5 baje system status check karo",
    ]) {
      expect(scheduled(message).goal.length).toBeGreaterThan(0);
    }
  });

  it("the cleaned goal no longer reads as a second action", () => {
    // The property the planner cares about: no residual time expression.
    for (const message of [
      "In 3 minutes check my system status",
      "In 2 hours check my system status",
      "At 5 PM check the weather in Balaghat",
      "Today at 10:45 PM check my system status.",
      "Tomorrow at 10 AM check my system status",
    ]) {
      const { goal } = scheduled(message);
      expect(goal, message).not.toMatch(/\bin\s+\d+\s*(minute|hour)/i);
      expect(goal, message).not.toMatch(/\b\d{1,2}(:\d{2})?\s*(am|pm)\b/i);
      expect(goal, message).not.toMatch(/^\s*(today|tomorrow|aaj|kal)\b/i);
    }
  });
});

describe("every other outcome is untouched", () => {
  it("7. an immediate imperative keeps its goal verbatim", () => {
    const r = detect("Check my system status.");
    expect(r.type).toBe("EXECUTE");
    if (r.type !== "EXECUTE") return;
    expect(r.goal).toBe("Check my system status.");
  });

  it("8. NEEDS_TIME keeps the whole message, vague word included", () => {
    const r = detect("Check my system status later");
    expect(r.type).toBe("NEEDS_TIME");
    if (r.type !== "NEEDS_TIME") return;
    // Nothing was consumed, so nothing is removed: the caller is asking the
    // user to restate this, and a trimmed echo would be confusing.
    expect(r.goal).toBe("Check my system status later");
  });

  it("an explicit time that cannot be used still asks rather than executing", () => {
    // 20:00 IST — "today at 6 pm" has gone.
    const evening = new Date("2026-09-23T14:30:00.000Z");
    const r = detect("Check my system status today at 6 PM", evening);
    expect(r.type).toBe("NEEDS_TIME");
    if (r.type !== "NEEDS_TIME") return;
    expect(r.goal).toBe("Check my system status today at 6 PM");
  });

  it("PLAN_ONLY keeps its goal verbatim", () => {
    const r = detect("Check my system status, plan banao execute mat karo");
    expect(r.type).toBe("PLAN_ONLY");
    if (r.type !== "PLAN_ONLY") return;
    expect(r.goal).toBe("Check my system status, plan banao execute mat karo");
  });

  it("informational turns are still NONE", () => {
    for (const message of [
      "What is blockchain?",
      "How do I check a website at 10 am?",
      "I was reading about web.fetch today",
      "Kya 5 baje report ready hoti hai?",
    ]) {
      expect(detect(message).type, message).toBe("NONE");
    }
  });

  it("recording a task is still not performing one", () => {
    expect(detect("Create a task to check my system status tomorrow at 10 am").type).toBe(
      "NONE"
    );
  });
});
