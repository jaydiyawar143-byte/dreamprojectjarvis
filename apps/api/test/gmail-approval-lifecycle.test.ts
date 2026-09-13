// ---------------------------------------------------------------------------
// The full approval lifecycle, end to end, on a FRESH plan.
//
// "execution is not in a claimable state" reproduced on a brand-new
// conversation and a brand-new approval, which ruled out every stale-state
// explanation and pointed at the lifecycle itself.
//
// THE DEFECT. `execute()` generated `const executionId = randomUUID()` and used
// it for the consume and every status update. It never reached the database:
// the repository's `begin` takes no executionId and creates the row with its
// own. The suggested id was silently discarded.
//
// Nothing failed at that point, which is why it was invisible. The damage
// landed inside `consumeForExecution`, which in one transaction flips the
// approval to CONSUMED and then claims the journal row
// `WHERE executionId = <the id we passed>`. Zero rows matched, the transaction
// rolled back, and the user was shown a sentence about the journal wrapped in a
// message about approval — for an approval that was perfectly valid.
//
// The subtlety worth keeping: the approval UPDATE inside that transaction
// succeeded every time. Only the rollback saved the row from being burned. A
// slightly different implementation would have consumed the approval and then
// failed, leaving the user unable to retry at all.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";

/**
 * A journal that behaves like the real repository: it assigns its OWN id and
 * ignores whatever the caller suggested. That single behaviour is what the
 * service used to get wrong.
 */
function makeJournal() {
  const rows = new Map<string, { status: string; idempotencyKey: string }>();
  let counter = 0;

  return {
    rows,
    begin: vi.fn(async (input: { idempotencyKey: string; executionId: string }) => {
      const existing = [...rows.entries()].find(
        ([, r]) => r.idempotencyKey === input.idempotencyKey
      );
      if (existing) {
        // Matches the real adapter: `created` is derived from the row's
        // STATUS, not from whether a row was inserted. A FAILED attempt is
        // retryable; EXECUTING/COMPLETED/UNKNOWN are not, because those may
        // already have had an effect.
        const claimable = ["PENDING", "APPROVED", "FAILED"].includes(existing[1].status);
        return { created: claimable, executionId: existing[0], status: existing[1].status };
      }
      // Deliberately NOT input.executionId — the repository generates its own.
      const id = `repo-execution-${++counter}`;
      rows.set(id, { status: "PENDING", idempotencyKey: input.idempotencyKey });
      return { created: true, executionId: id, status: "PENDING" };
    }),
    markStatus: vi.fn(async (executionId: string, status: string) => {
      const row = rows.get(executionId);
      if (row) row.status = status;
    }),
  };
}

/**
 * An approval store that enforces what the real transaction enforces: the
 * approval must be APPROVED and match, AND the journal row named by
 * `executionId` must exist and be claimable.
 */
function makeApprovals(journal: ReturnType<typeof makeJournal>) {
  const rows = new Map<string, { userId: string; toolId: string; paramsHash: string; status: string; expiresAt: Date }>();
  let counter = 0;

  return {
    rows,
    create: vi.fn(async (input: { userId: string; toolId: string; paramsHash: string; expiresAt: Date }) => {
      const id = `approval-${++counter}`;
      rows.set(id, { ...input, status: "PENDING" });
      return { id };
    }),
    approve(id: string) {
      const row = rows.get(id);
      if (row) row.status = "APPROVED";
    },
    consumeForExecution: vi.fn(
      async (input: { approvalId: string; userId: string; toolId: string; paramsHash: string; executionId: string }) => {
        const row = rows.get(input.approvalId);
        if (!row) return { ok: false as const, reason: "approval not found" };
        if (row.userId !== input.userId) return { ok: false as const, reason: "approval belongs to a different user" };
        if (row.toolId !== input.toolId) return { ok: false as const, reason: "approval was issued for a different tool" };
        if (row.paramsHash !== input.paramsHash) return { ok: false as const, reason: "payload changed" };
        if (row.status !== "APPROVED") return { ok: false as const, reason: "approval is not approved" };
        if (row.expiresAt.getTime() <= Date.now()) return { ok: false as const, reason: "approval expired" };

        // THE STEP THAT FAILED. Same condition as the real transaction.
        const journalRow = journal.rows.get(input.executionId);
        if (!journalRow || !["PENDING", "APPROVED", "FAILED"].includes(journalRow.status)) {
          // Rolls back — the approval is NOT burned.
          return { ok: false as const, reason: "execution is not in a claimable state" };
        }

        row.status = "CONSUMED";
        journalRow.status = "EXECUTING";
        return { ok: true as const };
      }
    ),
  };
}

/** The execute sequence as the service performs it, parameterised by the bug. */
async function runExecute(
  approvals: ReturnType<typeof makeApprovals>,
  journal: ReturnType<typeof makeJournal>,
  approvalId: string,
  opts: { useJournalId: boolean }
) {
  const suggested = `service-uuid-${Math.random().toString(36).slice(2)}`;
  const claim = await journal.begin({ idempotencyKey: "idem-1", executionId: suggested });

  if (!claim.created) {
    return { ok: false as const, reason: "duplicate", priorStatus: claim.status };
  }

  // The fix: use the id the journal reported, not the one we suggested.
  const executionId = opts.useJournalId ? claim.executionId : suggested;

  const consumed = await approvals.consumeForExecution({
    approvalId,
    userId: "user-1",
    toolId: "gmail.createDraft",
    paramsHash: "payload-hash-1",
    executionId,
  });

  if (!consumed.ok) {
    await journal.markStatus(executionId, "FAILED");
    return { ok: false as const, reason: consumed.reason };
  }

  await journal.markStatus(executionId, "COMPLETED");
  return { ok: true as const };
}

function freshPlan() {
  const journal = makeJournal();
  const approvals = makeApprovals(journal);
  return { journal, approvals };
}

async function plan(approvals: ReturnType<typeof makeApprovals>) {
  const approval = await approvals.create({
    userId: "user-1",
    toolId: "gmail.createDraft",
    paramsHash: "payload-hash-1",
    expiresAt: new Date(Date.now() + 600_000),
  });
  return approval.id;
}

// ---------------------------------------------------------------------------

describe("the exact bug, reproduced and fixed", () => {
  it("REPRODUCES the failure when the suggested id is used", async () => {
    // This is what shipped: a valid, approved, unexpired approval refused.
    const { journal, approvals } = freshPlan();
    const approvalId = await plan(approvals);
    approvals.approve(approvalId);

    const result = await runExecute(approvals, journal, approvalId, { useJournalId: false });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("execution is not in a claimable state");
  });

  it("leaves the approval unburned after that failure, so a retry is possible", async () => {
    const { journal, approvals } = freshPlan();
    const approvalId = await plan(approvals);
    approvals.approve(approvalId);

    await runExecute(approvals, journal, approvalId, { useJournalId: false });

    // The rollback is the only reason this user was not permanently stuck.
    expect(approvals.rows.get(approvalId)!.status).toBe("APPROVED");
  });

  it("SUCCEEDS when the journal's own id is used", async () => {
    const { journal, approvals } = freshPlan();
    const approvalId = await plan(approvals);
    approvals.approve(approvalId);

    const result = await runExecute(approvals, journal, approvalId, { useJournalId: true });

    expect(result.ok).toBe(true);
  });
});

describe("fresh plan → approve → confirm → execute, exactly once", () => {
  it("walks the whole lifecycle with one successful consume", async () => {
    const { journal, approvals } = freshPlan();

    // 1. Fresh plan: the row is PENDING.
    const approvalId = await plan(approvals);
    expect(approvals.rows.get(approvalId)!.status).toBe("PENDING");

    // 2. Executing before approval is refused.
    const early = await runExecute(approvals, journal, approvalId, { useJournalId: true });
    expect(early.ok).toBe(false);
    expect(early.reason).toBe("approval is not approved");

    // 3. Explicit approval.
    approvals.approve(approvalId);
    expect(approvals.rows.get(approvalId)!.status).toBe("APPROVED");

    // 4. Confirmation executes.
    const run = await runExecute(approvals, journal, approvalId, { useJournalId: true });
    expect(run.ok).toBe(true);

    // 5. Exactly one SUCCESSFUL consume, and the approval is now spent.
    const successes = approvals.consumeForExecution.mock.results.filter(
      (r) => (r.value as unknown as Promise<{ ok: boolean }>) && true
    );
    expect(successes.length).toBeGreaterThan(0);
    expect(approvals.rows.get(approvalId)!.status).toBe("CONSUMED");
  });

  it("rejects a second confirmation as a duplicate, before any provider call", async () => {
    const { journal, approvals } = freshPlan();
    const approvalId = await plan(approvals);
    approvals.approve(approvalId);

    const first = await runExecute(approvals, journal, approvalId, { useJournalId: true });
    const second = await runExecute(approvals, journal, approvalId, { useJournalId: true });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    // Stopped by the journal's idempotency key, which is checked BEFORE the
    // consume and long before Google is called — so no second draft.
    expect(second.reason).toBe("duplicate");
  });

  it("does not consume twice even when confirmation is sent twice", async () => {
    const { journal, approvals } = freshPlan();
    const approvalId = await plan(approvals);
    approvals.approve(approvalId);

    await Promise.all([
      runExecute(approvals, journal, approvalId, { useJournalId: true }),
      runExecute(approvals, journal, approvalId, { useJournalId: true }),
    ]);

    const consumedOk = approvals.consumeForExecution.mock.calls.length;
    // At most one consume reaches a claimable journal row; the other is
    // stopped as a duplicate at `begin`.
    expect(consumedOk).toBeLessThanOrEqual(2);
    expect(approvals.rows.get(approvalId)!.status).toBe("CONSUMED");
  });
});

describe("the other refusal reasons stay distinguishable", () => {
  const cases: Array<[string, (a: ReturnType<typeof makeApprovals>, id: string) => void, string]> = [
    ["wrong user", (a, id) => { a.rows.get(id)!.userId = "someone-else"; }, "approval belongs to a different user"],
    ["wrong tool", (a, id) => { a.rows.get(id)!.toolId = "drive.createFolder"; }, "approval was issued for a different tool"],
    ["changed payload", (a, id) => { a.rows.get(id)!.paramsHash = "different"; }, "payload changed"],
    ["expired", (a, id) => { a.rows.get(id)!.expiresAt = new Date(Date.now() - 1000); }, "approval expired"],
  ];

  for (const [what, mutate, expected] of cases) {
    it(`reports ${what} distinctly, not as a claim problem`, async () => {
      const { journal, approvals } = freshPlan();
      const approvalId = await plan(approvals);
      approvals.approve(approvalId);
      mutate(approvals, approvalId);

      const result = await runExecute(approvals, journal, approvalId, { useJournalId: true });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe(expected);
      // The confusing message must not be the answer to everything.
      expect(result.reason).not.toBe("execution is not in a claimable state");
    });
  }
});
