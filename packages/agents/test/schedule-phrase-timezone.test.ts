// ---------------------------------------------------------------------------
// Schedule-phrase parsing — the zone is a parameter, not the process's.
//
// THE POINT OF THIS FILE. A previous version resolved wall-clock phrases with
// `Date.prototype.setHours`, which reads whatever zone the process inherited.
// On a container with no TZ — UTC — "10:45 PM" became 22:45Z instead of
// 22:45 IST, five and a half hours away from what was meant. A real scheduled
// task sat in the database not firing, and nothing in the code or the tests
// said anything was wrong, because the tests ran on a machine that happened to
// be in the right zone.
//
// So every assertion here is on an ABSOLUTE INSTANT, never on a local field.
// A test that asserts `getHours() === 22` passes in Mumbai and fails in London
// and teaches nothing; `toISOString() === "…T17:15:00.000Z"` is the same fact
// everywhere, which is the only kind of fact worth pinning here.
//
// `process.env.TZ` is also mutated below and the answers re-checked. That
// assertion is deliberately trivial to satisfy — the implementation never
// reads the process zone — and it is here so that a future change which
// reintroduces `setHours` fails loudly instead of silently.
// ---------------------------------------------------------------------------

import { describe, it, expect, afterAll } from "vitest";
import {
  parseSchedulePhrase,
  mentionsVagueTime,
  mentionsExplicitTime,
  SCHEDULE_ZONE,
} from "../src/schedule-phrase.js";

/** The exact moment the real failing task was created. */
const NOW = new Date("2026-09-22T17:12:43.719Z"); // 22:42:43 IST

const iso = (message: string, now: Date = NOW): string | null => {
  const parsed = parseSchedulePhrase(message, now);
  return parsed ? parsed.at.toISOString() : null;
};

const ORIGINAL_TZ = process.env.TZ;
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe("schedule phrase — the scheduling zone is stated, not inherited", () => {
  it("names one zone and does not read it from the environment", () => {
    expect(SCHEDULE_ZONE).toBe("Asia/Kolkata");
  });

  it("resolves the exact instant that the live defect got wrong", () => {
    // 2026-09-22 10:45 PM IST is 17:15Z. The UTC-container bug produced
    // 22:45Z — the same digits, 5h30m later, firing at 04:15 IST.
    expect(iso("Today at 10:45 PM check my system status.")).toBe("2026-09-22T17:15:00.000Z");
  });

  it("gives the SAME instant whatever zone the process runs in", () => {
    const message = "Today at 10:45 PM check my system status.";
    const answers = new Set<string>();

    for (const zone of ["UTC", "Asia/Kolkata", "America/New_York", "Pacific/Auckland"]) {
      process.env.TZ = zone;
      answers.add(parseSchedulePhrase(message, NOW)!.at.toISOString());
    }

    expect([...answers]).toEqual(["2026-09-22T17:15:00.000Z"]);
  });

  it("accepts an explicit zone argument, and honours it", () => {
    const message = "Today at 10:45 PM check my system status.";
    // 22:45 in New York on the same calendar day is a different instant.
    const kolkata = parseSchedulePhrase(message, NOW, "Asia/Kolkata");
    const utc = parseSchedulePhrase(message, NOW, "UTC");

    expect(kolkata!.at.toISOString()).toBe("2026-09-22T17:15:00.000Z");
    expect(utc!.at.toISOString()).toBe("2026-09-22T22:45:00.000Z");
    // The parameter is real: two zones, two instants, from one sentence.
    expect(kolkata!.at.getTime()).not.toBe(utc!.at.getTime());
  });
});

describe("schedule phrase — existing behaviour, pinned as instants", () => {
  it("tomorrow at 10 AM is 04:30Z the next day", () => {
    expect(iso("Tomorrow at 10 AM check my system status")).toBe("2026-09-23T04:30:00.000Z");
  });

  it("a bare clock that has passed rolls to tomorrow", () => {
    // 17:12Z is 22:42 IST, so 5 PM IST today is gone.
    expect(iso("At 5 PM check the weather in Balaghat")).toBe("2026-09-23T11:30:00.000Z");
  });

  it("a bare clock still to come stays today", () => {
    // 06:00Z is 11:30 IST, so 5 PM IST is still ahead.
    const morning = new Date("2026-09-22T06:00:00.000Z");
    expect(iso("At 5 PM check the weather in Balaghat", morning)).toBe("2026-09-22T11:30:00.000Z");
  });

  it("a named day that has passed is refused, never rolled forward", () => {
    // 20:00 IST = 14:30Z; "today at 6 pm" is gone and must not become tomorrow.
    const evening = new Date("2026-09-22T14:30:00.000Z");
    expect(iso("Today at 6 PM check my system status", evening)).toBeNull();
  });

  it("keeps the Hinglish forms working", () => {
    // "kal 5 baje" — tomorrow, and a bare hour below 8 means the evening.
    expect(iso("Kal 5 baje system status check karo")).toBe("2026-09-22T23:30:00.000Z");
  });

  it("a relative phrase is measured from the caller's instant", () => {
    expect(iso("In 30 minutes check my system status")).toBe("2026-09-22T17:42:43.719Z");
    expect(iso("In 2 hours check my system status")).toBe("2026-09-22T19:12:43.719Z");
  });

  it("rolls the month and the year correctly", () => {
    // 31 Dec 23:00 IST -> "tomorrow at 10 AM" is 1 Jan of the next year.
    const newYearsEve = new Date("2026-12-31T17:30:00.000Z"); // 23:00 IST
    expect(iso("Tomorrow at 10 AM check my system status", newYearsEve)).toBe(
      "2027-01-01T04:30:00.000Z"
    );
  });

  it("reads 'today' as the date in the SCHEDULING zone, not the process's", () => {
    // 19:00Z on the 22nd is already 00:30 IST on the 23rd. "Today at 10 AM"
    // therefore means the 23rd in IST — a process on UTC would say the 22nd,
    // which has passed, and refuse.
    const afterIstMidnight = new Date("2026-09-22T19:00:00.000Z");
    expect(iso("Today at 10 AM check my system status", afterIstMidnight)).toBe(
      "2026-09-23T04:30:00.000Z"
    );
  });

  it("refuses an hour or minute out of range", () => {
    expect(iso("At 25:00 check my system status")).toBeNull();
    expect(iso("At 10:75 check my system status")).toBeNull();
  });

  it("leaves the vague and explicit-time predicates intact", () => {
    expect(mentionsVagueTime("Check my system status later")).toBe(true);
    expect(mentionsVagueTime("Check my system status")).toBe(false);
    expect(mentionsExplicitTime("Today at 1:50 PM check my system status")).toBe(true);
    expect(mentionsExplicitTime("Check the top 5 campaigns")).toBe(false);
  });
});
