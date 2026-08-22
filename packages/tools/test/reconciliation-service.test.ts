// PHASE 10.5 — ReconciliationService orchestration (mocked Meta, memory journal).
// Proves: UNKNOWN lifecycle safety, isolation guards, single-winner claims,
// crash recovery, idempotency, audit trails and secret redaction.
// NO real Meta writes occur anywhere in this suite.
import { describe, it, expect } from "vitest";
import { MemoryExecutionJournal } from "../src/execution-journal.js";
import {
  ReconciliationService,
  parseCreateCampaignEvidence,
} from "../src/reconciliation.js";
import type {
  ExecutionJournalPort,
  ExecutionReconciler,
  ReconciliationEvidence,
  ReconciliationResult,
} from "@jarvis/core";
import type { IAuditRepository } from "@jarvis/core";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeReconciler implements ExecutionReconciler {
  calls: ReconciliationEvidence[] = [];
  constructor(
    public impl: (e: ReconciliationEvidence) => Promise<ReconciliationResult> | ReconciliationResult
  ) {}
  async reconcile(evidence: ReconciliationEvidence): Promise<ReconciliationResult> {
    this.calls.push(evidence);
    return this.impl(evidence);
  }
}

function makeAuthorizer(allowedUser = "user-1", allowedAccount = "act_111") {
  const calls: Array<{ userId: string; accountId: string }> = [];
  return {
    calls,
    authorizer: {
      async isAuthorized(userId: string, accountId: string): Promise<boolean> {
        calls.push({ userId, accountId });
        return userId === allowedUser && accountId === allowedAccount;
      },
    },
  };
}

function makeAudit() {
  const entries: Array<Record<string, unknown>> = [];
  const audit: Pick<IAuditRepository, "create"> = {
    async create(entry) {
      entries.push(entry as unknown as Record<string, unknown>);
      return { ...entry, id: "audit-1", timestamp: new Date() } as never;
    },
  };
  return { audit, entries };
}

const CREATE_KEY = "meta.campaign.create:act_111:proposal:Summer Sale:OUTCOME_SALES";

async function seedUnknown(
  journal: ExecutionJournalPort,
  overrides: {
    executionKey?: string;
    userId?: string;
    toolId?: string;
    paramsHash?: string | undefined;
  } = {}
): Promise<string> {
  const rec = await journal.begin({
    userId: overrides.userId ?? "user-1",
    toolId: overrides.toolId ?? "meta.campaign.create",
    idempotencyKey: overrides.executionKey ?? CREATE_KEY,
    paramsHash: overrides.paramsHash === undefined ? "hash-123" : overrides.paramsHash,
    provider: "meta-ads",
    traceId: "trace-seed",
  });
  const claimed = await journal.claimForExecution(rec.executionId, {
    ownerId: "seed",
    leaseMs: 60_000,
  });
  if (!claimed) throw new Error("seed claim failed");
  await journal.markUnknown(rec.executionId, {
    code: "AMBIGUOUS_OUTCOME",
    message: "seeded ambiguous outcome",
  });
  return rec.executionId;
}

function found(id = "cmp_100200300"): ReconciliationResult {
  return {
    outcome: "FOUND",
    authoritative: true,
    externalResourceId: id,
    reasonCode: "MATCHED_SINGLE_CANDIDATE",
  };
}

interface ServiceExtras {
  configuredAccountId?: string;
  leaseMs?: number;
  audit?: Pick<IAuditRepository, "create">;
}

function makeService(
  journal: ExecutionJournalPort,
  reconciler: ExecutionReconciler,
  extra: ServiceExtras = {}
): ReconciliationService {
  const { authorizer } = makeAuthorizer();
  return new ReconciliationService({
    journal,
    reconciler,
    authorizer,
    configuredAccountId: extra.configuredAccountId ?? "act_111",
    leaseMs: extra.leaseMs,
    audit: extra.audit,
  });
}

describe("Phase 10.5 — reconciliation lifecycle", () => {
  it("UNKNOWN -> FOUND -> SUCCEEDED with externalResourceId stored", async () => {
    const journal = new MemoryExecutionJournal();
    const id = await seedUnknown(journal);
    const svc = makeService(journal, new FakeReconciler(() => found()));
    const res = await svc.reconcile({ executionId: id, requestedByUserId: "user-1" });
    expect(res.status).toBe("SUCCEEDED");
    expect(res.outcome).toBe("FOUND");
    expect(res.externalResourceId).toBe("cmp_100200300");
    const rec = await journal.getById(id);
    expect(rec!.status).toBe("SUCCEEDED");
    expect(rec!.externalResourceId).toBe("cmp_100200300");
  });

  it("UNKNOWN -> authoritative NOT_FOUND -> SAFE_TO_RETRY (never auto-executes)", async () => {
    const journal = new MemoryExecutionJournal();
    const id = await seedUnknown(journal);
    const svc = makeService(
      journal,
      new FakeReconciler(() => ({
        outcome: "NOT_FOUND",
        authoritative: true,
        reasonCode: "NO_CANDIDATES",
      }))
    );
    const res = await svc.reconcile({ executionId: id, requestedByUserId: "user-1" });
    expect(res.status).toBe("SAFE_TO_RETRY");
    const rec = await journal.getById(id);
    expect(rec!.status).toBe("SAFE_TO_RETRY");
    // No automatic retry: SAFE_TO_RETRY can never be claimed for execution.
    expect(await journal.claimForExecution(id, { ownerId: "x" })).toBeNull();
  });

  it("UNCERTAIN keeps UNKNOWN", async () => {
    const journal = new MemoryExecutionJournal();
    const id = await seedUnknown(journal);
    const svc = makeService(
      journal,
      new FakeReconciler(() => ({ outcome: "UNCERTAIN", authoritative: false, reasonCode: "RATE_LIMITED" }))
    );
    const res = await svc.reconcile({ executionId: id, requestedByUserId: "user-1" });
    expect(res.status).toBe("UNKNOWN");
    expect((await journal.getById(id))!.status).toBe("UNKNOWN");
  });

  it("PROVIDER_ERROR (Meta 500) keeps UNKNOWN — never becomes NOT_FOUND", async () => {
    const journal = new MemoryExecutionJournal();
    const id = await seedUnknown(journal);
    const svc = makeService(
      journal,
      new FakeReconciler(() => ({
        outcome: "PROVIDER_ERROR",
        authoritative: false,
        reasonCode: "PROVIDER_INTERNAL_ERROR",
      }))
    );
    const res = await svc.reconcile({ executionId: id, requestedByUserId: "user-1" });
    expect(res.status).toBe("UNKNOWN");
    expect(res.outcome).toBe("PROVIDER_ERROR");
  });

  it("timeout classification keeps UNKNOWN — never interpreted as absence", async () => {
    const journal = new MemoryExecutionJournal();
    const id = await seedUnknown(journal);
    const svc = makeService(
      journal,
      new FakeReconciler(() => ({ outcome: "UNCERTAIN", authoritative: false, reasonCode: "TIMEOUT" }))
    );
    const res = await svc.reconcile({ executionId: id, requestedByUserId: "user-1" });
    expect(res.status).toBe("UNKNOWN");
    expect(res.reasonCode).toBe("TIMEOUT");
    expect((await journal.getById(id))!.status).toBe("UNKNOWN");
  });

  it("authentication failure keeps UNKNOWN", async () => {
    const journal = new MemoryExecutionJournal();
    const id = await seedUnknown(journal);
    const svc = makeService(
      journal,
      new FakeReconciler(() => ({
        outcome: "PROVIDER_ERROR",
        authoritative: false,
        reasonCode: "AUTHENTICATION_FAILED",
      }))
    );
    expect((await svc.reconcile({ executionId: id, requestedByUserId: "user-1" })).status).toBe("UNKNOWN");
  });
});

describe("Phase 10.5 — isolation guards", () => {
  it("wrong user is rejected before any provider query", async () => {
    const journal = new MemoryExecutionJournal();
    const id = await seedUnknown(journal);
    const reconciler = new FakeReconciler(() => found());
    const svc = makeService(journal, reconciler);
    const res = await svc.reconcile({ executionId: id, requestedByUserId: "attacker" });
    expect(res.status).toBe("REFUSED");
    expect(res.reasonCode).toBe("AUTHORIZATION_FAILED");
    expect(reconciler.calls.length).toBe(0);
    expect((await journal.getById(id))!.status).toBe("UNKNOWN");
  });

  it("unknown execution id is refused", async () => {
    const journal = new MemoryExecutionJournal();
    const svc = makeService(journal, new FakeReconciler(() => found()));
    const res = await svc.reconcile({ executionId: "does-not-exist", requestedByUserId: "user-1" });
    expect(res.status).toBe("REFUSED");
  });

  it("account mismatch against configured account refuses pre-query", async () => {
    const journal = new MemoryExecutionJournal();
    const id = await seedUnknown(journal); // key carries act_111
    const reconciler = new FakeReconciler(() => found());
    const svc = makeService(journal, reconciler, { configuredAccountId: "act_999" });
    const res = await svc.reconcile({ executionId: id, requestedByUserId: "user-1" });
    expect(res.status).toBe("REFUSED");
    expect(res.reasonCode).toBe("ACCOUNT_MISMATCH");
    expect(reconciler.calls.length).toBe(0);
    expect((await journal.getById(id))!.status).toBe("UNKNOWN");
  });

  it("unauthorized account (authorizer denies) refuses pre-query", async () => {
    const journal = new MemoryExecutionJournal();
    const id = await seedUnknown(journal);
    const reconciler = new FakeReconciler(() => found());
    const { authorizer } = makeAuthorizer("user-1", "act_other");
    const svc = new ReconciliationService({
      journal,
      reconciler,
      authorizer,
      configuredAccountId: "act_111",
    });
    const res = await svc.reconcile({ executionId: id, requestedByUserId: "user-1" });
    expect(res.status).toBe("REFUSED");
    expect(reconciler.calls.length).toBe(0);
  });

  it("missing paramsHash refuses (fail-closed binding)", async () => {
    const journal = new MemoryExecutionJournal();
    const id = await seedUnknown(journal, { paramsHash: null });
    const reconciler = new FakeReconciler(() => found());
    const svc = makeService(journal, reconciler);
    const res = await svc.reconcile({ executionId: id, requestedByUserId: "user-1" });
    expect(res.status).toBe("REFUSED");
    expect(res.reasonCode).toBe("PARAMS_HASH_MISSING");
    expect(reconciler.calls.length).toBe(0);
  });

  it("unsupported tool remains UNKNOWN and is refused", async () => {
    const journal = new MemoryExecutionJournal();
    const id = await seedUnknown(journal, {
      toolId: "meta.campaign.pause",
      executionKey: "meta.campaign.pause:act_111:c123:PAUSED",
    });
    const reconciler = new FakeReconciler(() => found());
    const svc = makeService(journal, reconciler);
    const res = await svc.reconcile({ executionId: id, requestedByUserId: "user-1" });
    expect(res.status).toBe("REFUSED");
    expect(res.reasonCode).toBe("UNSUPPORTED_OPERATION");
    expect(reconciler.calls.length).toBe(0);
    expect((await journal.getById(id))!.status).toBe("UNKNOWN");
  });

  it("reconciliation target account derives from the durable key, never caller input", async () => {
    const journal = new MemoryExecutionJournal();
    const id = await seedUnknown(journal);
    const reconciler = new FakeReconciler((e) => {
      expect(e.accountId).toBe("act_111");
      expect(e.resource.name).toBe("Summer Sale");
      expect(e.resource.objective).toBe("OUTCOME_SALES");
      return found();
    });
    const svc = makeService(journal, reconciler);
    await svc.reconcile({ executionId: id, requestedByUserId: "user-1" });
    expect(reconciler.calls[0]!.accountId).toBe("act_111");
  });
});

describe("Phase 10.5 — concurrency, leases, crash recovery", () => {
  it("concurrent reconciliations are single-winner; provider queried once", async () => {
    const journal = new MemoryExecutionJournal();
    const id = await seedUnknown(journal);
    let providerCalls = 0;
    const reconciler = new FakeReconciler(() => {
      providerCalls++;
      return found();
    });
    const svc = makeService(journal, reconciler);
    const [a, b] = await Promise.all([
      svc.reconcile({ executionId: id, requestedByUserId: "user-1" }),
      svc.reconcile({ executionId: id, requestedByUserId: "user-1" }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["NOT_ELIGIBLE", "SUCCEEDED"]);
    expect(providerCalls).toBe(1);
    expect((await journal.getById(id))!.status).toBe("SUCCEEDED");
  });

  it("crash during RECONCILING: stale lease recovers to UNKNOWN (never FAILED), then re-reconciles", async () => {
    const journal = new MemoryExecutionJournal();
    const id = await seedUnknown(journal);
    let release!: () => void;
    const gate = new Promise<ReconciliationResult>((resolve) => {
      release = () => resolve(found("cmp_after_crash"));
    });
    const svc = makeService(journal, new FakeReconciler(() => gate), { leaseMs: 50 });

    const pending = svc.reconcile({ executionId: id, requestedByUserId: "user-1" });
    while ((await journal.getById(id))!.status !== "RECONCILING") {
      await new Promise((r) => setTimeout(r, 5));
    }

    // Simulated crash: lease expires while the worker hangs.
    const recovered = await svc.recoverStaleReconciliations({
      now: new Date(Date.now() + 60_000),
    });
    expect(recovered.recovered.map((r) => r.executionId)).toContain(id);
    expect((await journal.getById(id))!.status).toBe("UNKNOWN");

    // Original worker wakes up — its lease was revoked, so it must not finalize.
    release();
    const lost = await pending;
    expect(lost.status).toBe("NOT_ELIGIBLE");
    expect((await journal.getById(id))!.status).toBe("UNKNOWN");

    // A fresh attempt now resolves cleanly.
    const again = await svc.reconcile({ executionId: id, requestedByUserId: "user-1" });
    expect(again.status).toBe("SUCCEEDED");
    expect(again.externalResourceId).toBe("cmp_after_crash");
  });
});

describe("Phase 10.5 — idempotency", () => {
  it("second reconciliation of a SUCCEEDED record is a no-op", async () => {
    const journal = new MemoryExecutionJournal();
    const id = await seedUnknown(journal);
    const reconciler = new FakeReconciler(() => found());
    const svc = makeService(journal, reconciler);
    await svc.reconcile({ executionId: id, requestedByUserId: "user-1" });
    const second = await svc.reconcile({ executionId: id, requestedByUserId: "user-1" });
    expect(second.status).toBe("NOT_ELIGIBLE");
    expect(reconciler.calls.length).toBe(1);
    const rec = await journal.getById(id);
    expect(rec!.status).toBe("SUCCEEDED");
    expect(rec!.reconciliationAttempts).toBe(1);
  });

  it("second reconciliation of a SAFE_TO_RETRY record mutates nothing", async () => {
    const journal = new MemoryExecutionJournal();
    const id = await seedUnknown(journal);
    const svc = makeService(
      journal,
      new FakeReconciler(() => ({ outcome: "NOT_FOUND", authoritative: true, reasonCode: "NO_CANDIDATES" }))
    );
    await svc.reconcile({ executionId: id, requestedByUserId: "user-1" });
    const second = await svc.reconcile({ executionId: id, requestedByUserId: "user-1" });
    expect(second.status).toBe("NOT_ELIGIBLE");
    const rec = await journal.getById(id);
    expect(rec!.status).toBe("SAFE_TO_RETRY");
    expect(rec!.reconciliationAttempts).toBe(1);
  });
});

describe("Phase 10.5 — audit + redaction", () => {
  it("every attempt writes an audit record with required fields and no secrets", async () => {
    const journal = new MemoryExecutionJournal();
    const id = await seedUnknown(journal);
    const { audit, entries } = makeAudit();
    const svc = makeService(
      journal,
      new FakeReconciler(() => ({
        outcome: "FOUND",
        authoritative: true,
        externalResourceId: "cmp_ok",
        detail: "matched access_token=EAASUPERSECRET123 value",
      })),
      { audit }
    );
    const res = await svc.reconcile({ executionId: id, requestedByUserId: "user-1", traceId: "tr-1" });

    expect(entries.length).toBe(1);
    const entry = entries[0]!;
    expect(entry.action).toBe("tool.execution.reconcile");
    expect(entry.result).toBe("success");
    expect(entry.traceId).toBe("tr-1");
    const params = entry.parameters as Record<string, unknown>;
    expect(params.previousStatus).toBe("UNKNOWN");
    expect(params.outcome).toBe("FOUND");
    expect(typeof params.durationMs).toBe("number");
    expect((entry.metadata as Record<string, unknown>).executionId).toBe(id);
    // Redaction: neither the response nor the audit may carry the token.
    expect(JSON.stringify(entry)).not.toContain("EAASUPERSECRET123");
    expect(res.detail).not.toContain("EAASUPERSECRET123");
  });

  it("uncertain attempts are audited as failures", async () => {
    const journal = new MemoryExecutionJournal();
    const id = await seedUnknown(journal);
    const { audit, entries } = makeAudit();
    const svc = makeService(
      journal,
      new FakeReconciler(() => ({ outcome: "UNCERTAIN", authoritative: false, reasonCode: "RATE_LIMITED" })),
      { audit }
    );
    await svc.reconcile({ executionId: id, requestedByUserId: "user-1" });
    expect(entries[0]!.result).toBe("failure");
  });

  it("refusals are audited as rejected", async () => {
    const journal = new MemoryExecutionJournal();
    const id = await seedUnknown(journal);
    const { audit, entries } = makeAudit();
    const svc = makeService(journal, new FakeReconciler(() => found()), { audit });
    await svc.reconcile({ executionId: id, requestedByUserId: "attacker" });
    expect(entries[0]!.result).toBe("rejected");
  });
});

describe("Phase 10.5 — evidence parsing", () => {
  it("parses create keys including names that contain colons", () => {
    expect(parseCreateCampaignEvidence("meta.campaign.create:act_42:proposal:Q3: Push:OUTCOME_SALES")).toEqual({
      accountId: "act_42",
      campaignName: "Q3: Push",
      objective: "OUTCOME_SALES",
    });
  });

  it("rejects non-create or malformed keys", () => {
    expect(parseCreateCampaignEvidence("meta.campaign.pause:act_42:c1:PAUSED")).toBeNull();
    expect(parseCreateCampaignEvidence("meta.campaign.create:not_an_account:proposal:N:O")).toBeNull();
    expect(parseCreateCampaignEvidence("meta.campaign.create:act_42:proposal:X")).toBeNull();
  });
});
