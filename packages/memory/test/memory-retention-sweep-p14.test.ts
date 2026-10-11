// ---------------------------------------------------------------------------
// Audit F3 (Phase 14) — the retention sweep makes progress through EVERY user.
//
// Each sweep visits at most MEMORY_RETENTION.sweepUsers users. It used to ask
// for "the first N users" every time, so users whose purge kept failing stayed
// first in line and could keep everyone after them waiting forever. A sweep
// now continues after the last user the previous sweep visited, and starts
// over from the first once it reaches the end — so every eligible user is
// visited within a bounded number of sweeps, whatever fails.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { MEMORY_RETENTION } from "@jarvis/core";
import { MemoryRetentionSweep } from "../src/memory-retention-sweep.js";

const LIMIT = MEMORY_RETENTION.sweepUsers;

/** Candidate users in id order, as the repository returns them, honouring the cursor. */
function candidatesOf(users: string[]) {
  const asked: Array<string | undefined> = [];
  const candidates = async (_before: Date, limit: number, after?: string) => {
    asked.push(after);
    return users.filter((id) => after === undefined || id > after).slice(0, limit);
  };
  return { candidates, asked };
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `user-${String(i).padStart(3, "0")}`);

describe("Audit F3 — repeated sweeps reach every eligible user, even when every purge fails", () => {
  it("each sweep continues after the last user the previous one visited, and starts over after the end", async () => {
    const users = ids(LIMIT * 2 + 20);
    const { candidates } = candidatesOf(users);
    const visits: string[][] = [];
    const sweep = new MemoryRetentionSweep({
      candidates,
      purge: async (userId) => {
        visits.at(-1)!.push(userId);
        throw new Error("purge failed");
      },
    });

    for (let pass = 0; pass < 4; pass++) {
      visits.push([]);
      expect((await sweep.sweep()).failed).toBe(visits.at(-1)!.length);
    }

    expect(visits.map((v) => v.length)).toEqual([LIMIT, LIMIT, 20, LIMIT]);
    expect(new Set(visits.slice(0, 3).flat())).toEqual(new Set(users));
    expect(visits[3]![0]).toBe(users[0]);
  });

  it("when the previous sweep ended exactly on the last user, the next one starts over at once instead of doing nothing", async () => {
    const users = ids(LIMIT);
    const { candidates, asked } = candidatesOf(users);
    const sweep = new MemoryRetentionSweep({ candidates, purge: async () => 1 });

    expect((await sweep.sweep()).users).toBe(LIMIT);
    expect((await sweep.sweep()).users).toBe(LIMIT);
    expect(asked).toEqual([undefined, users[LIMIT - 1], undefined]);
  });

  it("a sweep that finds fewer than a full page starts the next one from the first user", async () => {
    const { candidates, asked } = candidatesOf(ids(3));
    const sweep = new MemoryRetentionSweep({ candidates, purge: async () => 0 });

    await sweep.sweep();
    await sweep.sweep();

    expect(asked).toEqual([undefined, undefined]);
  });
});
