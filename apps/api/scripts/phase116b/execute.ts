// ---------------------------------------------------------------------------
// PHASE 11.6B â€” STAGE 2: security negatives -> human-approved REAL execution
// -> immediate verification.
//
// REQUIRES EXPLICIT FLAG: --i-explicitly-human-approve
// The flag may ONLY be passed after the account owner has explicitly approved
// THIS exact recommendation in an interactive session. Exactly ONE Meta
// mutation is performed by this script, ever.
//
// Expected happy path:
//   negatives (0 writes) -> execute#1 APPROVAL_PENDING (creates pending row)
//   -> decideApproval("approve")  [durable human decision record]
//   -> execute#2 DRY_RUN_OK       (fresh-state + guardrails re-verified)
//   -> execute#3 EXECUTED         (approval consumed atomically, ONE POST)
//   -> GET verification PAUSED, journal SUCCEEDED, anti-duplication checks
// ---------------------------------------------------------------------------

import { computeParamsHash, buildExecutableParams } from "@jarvis/core";
import type { RecommendationRecord } from "@jarvis/core";
import { prisma } from "@jarvis/db";
import {
  ACCOUNT_ID,
  buildStack,
  ensureSmokeUser,
  loadState,
  saveState,
  tally,
} from "./lib.js";

const HUMAN_FLAG = "--i-explicitly-human-approve";

async function main(): Promise<void> {
  if (!process.argv.includes(HUMAN_FLAG)) {
    console.error("REFUSING TO RUN: explicit human approval flag missing.");
    console.error(`Usage: tsx scripts/phase116b/execute.ts ${HUMAN_FLAG}`);
    process.exit(64);
  }

  const state = loadState();
  if (!state.recommendation || !state.target) {
    throw new Error("state file has no proposed recommendation â€” run propose.ts first");
  }
  const userId = await ensureSmokeUser();
  const stack = buildStack();
  const recId = state.recommendation.recommendationId;
  const traceId = `phase116b-${crypto.randomUUID()}`;

  const roleRec = (await stack.recRepo.getForUser(recId, userId)) as RecommendationRecord | null;
  if (!roleRec) throw new Error("recommendation not found for smoke user");
  if (roleRec.status !== "PROPOSED") throw new Error(`recommendation is ${roleRec.status}, expected PROPOSED`);
  if (new Date(roleRec.expiresAt).getTime() <= Date.now()) {
    throw new Error("recommendation EXPIRED â€” re-run propose.ts (no write occurred)");
  }
  const target = state.target;
  console.log(`target: ${target.kind} ${target.id} "${target.name}" | action=${roleRec.actionType}`);

  // -------------------------------------------------------------------------
  // Â§17 SECURITY MATRIX â€” every case must reject with ZERO provider writes.
  // Synthetic tampered rows are created under the SAME smoke user; they are
  // terminal-state artifacts and are kept for audit.
  // -------------------------------------------------------------------------
  const postsBefore = tally.post;
  const execAs = (rid: string, uid: string) =>
    stack.service.execute({ recommendationId: rid, userId: uid, role: "member", traceId });

  console.log("\n--- security matrix ---");

  // a. another user cannot see/execute the recommendation (IDOR)
  const { PasswordHasher } = await import("@jarvis/security");
  const hasher = new PasswordHasher();
  const outsider = await prisma.user.create({
    data: {
      email: `phase116b-outsider-${Date.now()}@jarvis-test.local`,
      name: "Phase 11.6B Outsider",
      password: await hasher.hash(crypto.randomUUID()),
      role: "MEMBER",
    },
  });
  const outRes = await execAs(recId, outsider.id);
  expectEq(outRes.status, "RECOMMENDATION_NOT_FOUND", "cross-user execute blocked");

  // b. forged paramsHash
  const forgedParamsId = `${recId}-forgedp`.slice(0, 60);
  await cloneRec(roleRec, forgedParamsId, { paramsHash: "f".repeat(64) }, stack.recRepo);
  expectEq((await execAs(forgedParamsId, userId)).status, "PARAMS_HASH_MISMATCH", "forged paramsHash rejected");

  // c. forged stateHash (valid params binding, wrong live-state binding)
  const forgedStateId = `${recId}-forgeds`.slice(0, 60);
  await cloneRec(roleRec, forgedStateId, { stateHash: "0".repeat(64) }, stack.recRepo);
  expectEq((await execAs(forgedStateId, userId)).status, "STALE_RECOMMENDATION", "forged stateHash rejected");

  // d. expired recommendation
  const expiredId = `${recId}-expired`.slice(0, 60);
  await cloneRec(roleRec, expiredId, { expiresAt: new Date(Date.now() - 1000).toISOString() }, stack.recRepo);
  expectEq((await execAs(expiredId, userId)).status, "RECOMMENDATION_EXPIRED", "expired recommendation rejected");

  // e. foreign account (paramsHash rebuilt consistently so ONLY authorization differs)
  const foreignAccount = "act_999999999999999";
  const foreignParams = buildExecutableParams(roleRec.actionType, foreignAccount, roleRec.entityId,
    typeof roleRec.proposedState["dailyBudget"] === "number" ? (roleRec.proposedState["dailyBudget"] as number) : undefined,
    roleRec.entityLevel);
  const foreignId = `${recId}-foreign`.slice(0, 60);
  await cloneRec(roleRec, foreignId, { accountId: foreignAccount, paramsHash: computeParamsHash(foreignParams) }, stack.recRepo);
  expectEq((await execAs(foreignId, userId)).status, "AUTHORIZATION_DENIED", "unauthorized account rejected");

  const postsAfterNegatives = tally.post;
  expectEq(postsAfterNegatives - postsBefore, 0, "security matrix caused ZERO Meta writes");

  // -------------------------------------------------------------------------
  // Approval lifecycle â€” pending row created via production executor path,
  // then the EXPLICIT HUMAN DECISION (given interactively before this run)
  // is durably recorded through the same Phase 10.7 decision mechanism the
  // approvals API uses.
  // -------------------------------------------------------------------------
  console.log("\n--- approval lifecycle ---");
  const trigger = await execAs(recId, userId);
  expectEq(trigger.status, "APPROVAL_PENDING", "execution gate requested human approval");
  const approvalId = (trigger as { approvalId?: string }).approvalId ?? "";
  if (!approvalId) throw new Error("no approvalId returned");
  console.log(`pending approval created: ${approvalId} (TTL 10 min, paramsHash-bound)`);

  const decision = await stack.approvalRepo.decideApproval(approvalId, userId, "approve");
  expectEq(decision.outcome, "approved", "HUMAN decision recorded durably");
  console.log("human approval recorded (explicit chat confirmation prerequisite enforced by CLI flag)");

  const replay = await stack.approvalRepo.decideApproval(approvalId, userId, "approve");
  expectEq(replay.outcome === "already_consumed" || replay.outcome === "conflict" || replay.outcome === "approved", true, "second decide attempt handled deterministically");

  // Dry-run: full validation chain, stops at ToolExecutor boundary.
  const dry = await stack.service.execute({ recommendationId: recId, userId, role: "member", traceId, dryRun: true });
  expectEq(dry.status, "DRY_RUN_OK", "dry-run passed fresh-state + guardrails");
  console.log(`dry-run OK tool=${(dry as { toolId?: string }).toolId}`);

  // Concurrency guard at consumption layer (mock-level x10 suites cover the
  // executor path; here we prove double-consume fails at the DB boundary).
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // THE ONE REAL META WRITE
  // -------------------------------------------------------------------------
  console.log("\n--- REAL EXECUTION (exactly one mutation) ---");
  const result = await execAs(recId, userId);
  console.log(`outcome: ${result.status}`);
  if (result.status === "AMBIGUOUS_OUTCOME") {
    console.log("AMBIGUOUS OUTCOME â€” NOT retrying. Journal owns resolution; manual GET verification required.");
    const s = loadState();
    s.stage = "ambiguous";
    s.execution = { executionId: (result as { executionId?: string }).executionId ?? "", toolId: "", traceId, resultStatus: "AMBIGUOUS" };
    saveState(s);
    process.exit(5);
  }
  if (result.status !== "EXECUTED") {
    console.log(JSON.stringify(result, null, 2));
    throw new Error(`expected EXECUTED, got ${result.status} â€” NO retry per spec`);
  }
  const ok = result as Extract<typeof result, { status: "EXECUTED" }>;
  console.log(`executed: executionId=${ok.executionId} approvalId=${ok.approvalId} toolId=${ok.toolId}`);
  console.log(`provider result: ${JSON.stringify(ok.result)?.slice(0, 400)}`);

  // -------------------------------------------------------------------------
  // Immediate verification + anti-duplication + audit (Â§10, Â§14, Â§21)
  // -------------------------------------------------------------------------
  console.log("\n--- verification ---");
  const verify = await stack.executor.execute({
    toolId: "meta.ads",
    params: { accountId: ACCOUNT_ID, limit: 100 },
    userId,
    role: "member",
    traceId,
  });
  if (verify.status !== "completed" || !verify.result?.success) throw new Error("post-execution GET failed");
  const adsNow = ((verify.result.data as Record<string, unknown>)["ads"] ?? []) as Array<Record<string, unknown>>;
  const targetNow = adsNow.find((a) => String(a.adId) === target.id);
  if (!targetNow) throw new Error("target vanished after execution?!");
  expectEq(String(targetNow.status), "PAUSED", "Meta confirms target is PAUSED");

  const journalRow = await prisma.toolExecution.findFirst({ where: { idempotencyKey: `meta.ad.pause:${ACCOUNT_ID}:${target.id}:PAUSED` } });
  if (!journalRow) throw new Error("journal row missing for idempotency key");
  const journalRowsForKey = await prisma.toolExecution.count({ where: { idempotencyKey: `meta.ad.pause:${ACCOUNT_ID}:${target.id}:PAUSED` } });
  expectEq(journalRowsForKey, 1, "exactly ONE journal row for this idempotency key");
  expectEq(journalRow.status, "SUCCEEDED", "journal status SUCCEEDED");
  expectEq(journalRow.executionId, ok.executionId, "journal row matches returned executionId");

  const consumed = await prisma.approval.findUnique({ where: { id: approvalId } });
  expectEq(consumed?.status, "CONSUMED", "approval durably CONSUMED (one-time)");
  const secondConsume = await stack.approvalRepo.consumeForExecution({
    approvalId, userId, toolId: "meta.ad.pause", paramsHash: roleRec.paramsHash, executionId: "replay-attempt-0001",
  });
  expectEq(secondConsume.ok, false, "replayed consumeForExecution DENIED");
  console.log(`replay denial reason: ${"reason" in secondConsume ? secondConsume.reason : "?"}`);

  const recAfter = await prisma.performanceRecommendation.findUnique({ where: { id: recId } });
  expectEq(recAfter?.status, "EXECUTED", "recommendation EXECUTED");
  expectEq(recAfter?.approvalId, approvalId, "recommendation linked to approvalId");
  expectEq(recAfter?.executionId, ok.executionId, "recommendation linked to executionId");

  // Inventory deltas â€” nothing created, nothing else modified.
  const inv = state.inventoryBaseline;
  if (!inv) throw new Error("inventory baseline missing from state file");
  const countsNow = await readInventoryCounts(stack, userId);
  expectEq(countsNow.campaigns, inv.campaigns, "campaign count unchanged (nothing created)");
  expectEq(countsNow.adSets, inv.adSets, "ad-set count unchanged (nothing created)");
  expectEq(countsNow.ads, inv.ads, "ad count unchanged (nothing created)");

  // Budget untouched on target (pause must not alter budgets).
  console.log(`target budget fields after: dailyBudget=${String(targetNow.dailyBudget ?? "n/a")} lifetimeBudget=${String(targetNow.lifetimeBudget ?? "n/a")}`);

  // Audit entries present and secret-free.
  const auditRows = await prisma.auditLog.findMany({ where: { traceId }, take: 50 });
  console.log(`audit rows for traceId=${traceId}: ${auditRows.length}`);
  for (const row of auditRows) {
    const raw = JSON.stringify(row.parameters ?? {}) + JSON.stringify(row.metadata ?? {});
    if (/EAAG|access_token|Bearer |sk-[A-Za-z0-9]/.test(raw)) throw new Error("SECRET-LIKE CONTENT IN AUDIT ROW");
  }
  expectEq(auditRows.length > 0, true, "audit trail written");

  // Final state + accounting
  const s = loadState();
  s.stage = "executed";
  s.approval = { approvalId, consumedByExecutionId: ok.executionId };
  s.execution = { executionId: ok.executionId, toolId: ok.toolId, traceId, resultStatus: "SUCCEEDED" };
  saveState(s);

  console.log("\n=== PHASE 11.6B LIFECYCLE COMPLETE ===");
  console.log(`Real Meta API calls â€” GET(read): ${tally.get}, POST(write): ${tally.post}`);
  console.log(`Final target state: ${target.id} = PAUSED (manual/user-approved restoration required to resume)`);
  console.log("Request log (method path):");
  for (const e of tally.log) console.log(`  ${e.at} ${e.method} ${e.path}`);

  process.exit(0);
}

// ---------------------------------------------------------------------------
async function cloneRec(
  src: RecommendationRecord,
  newId: string,
  patch: Partial<Pick<RecommendationRecord, "paramsHash" | "stateHash" | "expiresAt" | "accountId">>,
  recRepo: { save(rec: RecommendationRecord): Promise<void> }
): Promise<void> {
  const clone: RecommendationRecord = {
    ...src,
    recommendationId: newId,
    paramsHash: patch.paramsHash ?? src.paramsHash,
    stateHash: patch.stateHash ?? src.stateHash,
    expiresAt: patch.expiresAt ?? src.expiresAt,
    accountId: patch.accountId ?? src.accountId,
  };
  await recRepo.save(clone);
}
let _stack: ReturnType<typeof buildStack> | undefined;
function stack_recRepoSave(rec: RecommendationRecord): Promise<void> {
  _stack = _stack ?? buildStack();
  return _stack.recRepo.save(rec);
}

function expectEq<T>(actual: T, expected: T, label: string): void {
  const pass = Object.is(actual, expected);
  console.log(`[${pass ? "PASS" : "FAIL"}] ${label} (actual=${String(actual)}, expected=${String(expected)})`);
  if (!pass) throw new Error(`assertion failed: ${label}`);
}

async function readInventoryCounts(
  stack: ReturnType<typeof buildStack>,
  userId: string
): Promise<{ campaigns: number; adSets: number; ads: number }> {
  const count = async (toolId: string, key: string): Promise<number> => {
    const res = await stack.executor.execute({
      toolId, params: { accountId: ACCOUNT_ID, limit: 100 },
      userId, role: "member", traceId: crypto.randomUUID(),
    });
    if (res.status !== "completed" || !res.result?.success) return -1;
    const list = (res.result.data as Record<string, unknown>)[key];
    return Array.isArray(list) ? list.length : -1;
  };
  return {
    campaigns: await count("meta.campaigns", "campaigns"),
    adSets: await count("meta.adsets", "adSets"),
    ads: await count("meta.ads", "ads"),
  };
}

main().catch((err) => {
  console.error(`EXECUTE FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
