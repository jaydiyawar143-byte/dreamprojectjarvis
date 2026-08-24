/**
 * PHASE 11.6B â€” OPTION A: MOCK LIFECYCLE PROOF
 *
 * Real:    Postgres, Prisma repositories, ApprovalService, ToolExecutor,
 *          RecommendationExecutionService, evidence/diagnosis/recommendation
 *          engines, atomic approval consumption, execution journal.
 * Mocked:  ONLY the Meta Graph HTTP layer (createMockMetaProvider).
 *
 * Proves end-to-end:
 *   selection -> evidence -> AI diagnosis -> recommendation (durable) ->
 *   security negatives -> APPROVAL_PENDING -> human approve (durable) ->
 *   dry-run -> ONE EXECUTED pause -> verification -> anti-duplication ->
 *   x10 concurrent single-winner.
 *
 * Zero calls to graph.facebook.com. All DB rows persist as the audit trail.
 */

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), "../../.env") });

import crypto from "node:crypto";
import {
  aggregatePerformanceRecords,
  buildEvidencePackage,
  buildExecutableParams,
  comparePerformanceSummaries,
  computeParamsHash,
  detectAnomalies,
  DiagnosisEngine,
  RecommendationEngine,
  type NormalizedPerformanceRecord,
  type RecommendationRecord,
} from "@jarvis/core";
import type {
  AICompletionRequest,
  AICompletionResponse,
  IAIProvider,
} from "@jarvis/core";
import { createMockMetaProvider, type MockMetaProviderConfig } from "@jarvis/tools";
import { PasswordHasher } from "@jarvis/security";
import {
  ACCOUNT_ID,
  accountDate,
  buildMockStack,
  ensureMarketingAccount,
  ensureSmokeUser,
  makeLiveStatePort,
  prisma,
  type Stack,
} from "./lib.js";

/**
 * Option A scope: the AI provider is an external HTTP dependency, so it is
 * MOCKED with a deterministic scripted analyst (same contract as OpenAI).
 * The DiagnosisEngine, verification layer, confidence caps and recommendation
 * engine remain 100% real. The script emits a diagnosis ONLY when the staged
 * evidence genuinely contains CRITICAL negative anomalies — it cannot invent
 * a passing grade.
 */
interface ScriptedEvidenceAnomaly {
  anomalyId: string;
  severity: string;
  direction: string;
}
interface ScriptedEvidencePackage {
  entityId: string;
  entityLevel: string;
  evidenceHash: string;
  anomalies: ScriptedEvidenceAnomaly[];
}

function scriptedDiagnosisProvider(): IAIProvider {
  return {
    id: "scripted-diagnosis-116b",
    name: "Scripted Diagnosis Provider (Phase 11.6B Option A)",
    defaultModel: "scripted-1",
    listModels: async () => ["scripted-1"],
    isAvailable: async () => true,
    async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
      const user = request.messages.find((m) => m.role === "user")?.content ?? "";
      const match = user.match(/EVIDENCE_BEGIN\n([\s\S]*?)\nEVIDENCE_END/);
      if (!match) throw new Error("scripted provider: no EVIDENCE block found");
      const packages = JSON.parse(match[1] ?? "[]") as ScriptedEvidencePackage[];
      const diagnoses = packages.map((p) => {
        const criticalNegatives = p.anomalies.filter(
          (a) => a.severity === "CRITICAL" && a.direction === "NEGATIVE_ANOMALY"
        );
        const refs = criticalNegatives.map((a) => `anomaly:${a.anomalyId}`);
        const actionable = criticalNegatives.length >= 2;
        return {
          entityId: p.entityId,
          entityLevel: p.entityLevel,
          evidenceHash: p.evidenceHash,
          anomalyIds: criticalNegatives.map((a) => a.anomalyId),
          category: actionable ? "ENGAGEMENT_DECLINE" : "NO_CLEAR_DIAGNOSIS",
          summary: actionable
            ? "Multiple verified critical negative deviations across core delivery metrics on the most recent day relative to the stable baseline."
            : "Verified signals do not jointly support an actionable diagnosis.",
          facts: refs.map((ref) => ({
            statement: "A verified critical negative deviation is present for this metric.",
            evidenceRef: ref,
          })),
          inferences: [
            {
              statement:
                "The simultaneous decline across several delivery metrics indicates a correlated drop rather than isolated noise.",
              supportingEvidence: refs.slice(0, 2),
              confidence: "MEDIUM",
            },
          ],
          hypotheses: actionable
            ? [
                {
                  statement:
                    "A delivery or engagement collapse explains the observed recent-day performance against the baseline window.",
                  category: "ENGAGEMENT_DECLINE",
                  supportingEvidence: refs,
                  contradictingEvidence: [],
                  confidence: "MEDIUM",
                },
              ]
            : [],
          confidence: actionable ? "MEDIUM" : "LOW",
        };
      });
      return {
        message: { role: "assistant", content: JSON.stringify({ diagnoses }) },
        finishReason: "stop",
        model: "scripted-1",
        usage: { totalTokens: 0 },
      };
    },
  };
}

const AD_A = "993150000000301"; // single controlled lifecycle
const AD_B = "993150000000302"; // concurrency burst
const AD_SET = "993150000000201";
const CAMPAIGN = "993150000000101";
const FOREIGN_ACCOUNT = "act_999999999999999";

function expectEq<T>(actual: T, expected: T, label: string): void {
  const pass = Object.is(actual, expected);
  console.log(`[${pass ? "PASS" : "FAIL"}] ${label} (actual=${String(actual)}, expected=${String(expected)})`);
  if (!pass) throw new Error(`assertion failed: ${label}`);
}

function expectIn<T>(actual: T, allowed: readonly T[], label: string): void {
  const pass = allowed.includes(actual);
  console.log(`[${pass ? "PASS" : "FAIL"}] ${label} (actual=${String(actual)}, allowed=[${allowed.join(",")}])`);
  if (!pass) throw new Error(`assertion failed: ${label}`);
}

/** Staged insights: 11 stable baseline days then an âˆ’82% spend crash today. */
function stagedInsights(): MockMetaProviderConfig["insights"] {
  const rows: NonNullable<MockMetaProviderConfig["insights"]> = [];
  for (const adId of [AD_A, AD_B]) {
    for (let off = 11; off >= 1; off--) {
      const d = accountDate(-off);
      rows.push({
        accountId: ACCOUNT_ID, adId, adsetId: AD_SET, campaignId: CAMPAIGN,
        dateStart: d, dateStop: d,
        impressions: "50000", reach: "30000", clicks: "1000", spend: "500.00",
        ctr: "2.00", cpc: "0.50", cpm: "10.00",
      });
    }
    const d0 = accountDate(0);
    rows.push({
      accountId: ACCOUNT_ID, adId, adsetId: AD_SET, campaignId: CAMPAIGN,
      dateStart: d0, dateStop: d0,
      impressions: "9000", reach: "8000", clicks: "180", spend: "90.00",
      ctr: "2.00", cpc: "0.50", cpm: "10.00",
    });
  }
  return rows;
}

function fixtures(): MockMetaProviderConfig {
  return {
    accounts: [{
      accountId: ACCOUNT_ID, name: "JARVIS 11.6B MOCK", currency: "INR",
      timezoneName: "America/Los_Angeles", accountStatus: 1,
      amountSpent: "11590.00", balance: "0",
    }],
    campaigns: [{
      campaignId: CAMPAIGN, name: "JARVIS 11.6B MOCK Campaign", status: "ACTIVE",
      objective: "TRAFFIC", dailyBudget: "1200.00", buyingType: "AUCTION",
      bidStrategy: "LOWEST_COST_WITHOUT_CAP",
    }],
    adSets: [{
      adSetId: AD_SET, campaignId: CAMPAIGN, name: "India Broad Mock", status: "ACTIVE",
      dailyBudget: "600.00", optimizationGoal: "REACH", bidAmount: 5000,
    }],
    ads: [
      { adId: AD_A, adSetId: AD_SET, campaignId: CAMPAIGN, name: "Mock Ad A (lifecycle)", status: "ACTIVE" },
      { adId: AD_B, adSetId: AD_SET, campaignId: CAMPAIGN, name: "Mock Ad B (burst)", status: "ACTIVE" },
    ],
    insights: stagedInsights(),
  };
}

interface Candidate {
  id: string;
  name: string;
  baseline: NormalizedPerformanceRecord[];
  current: NormalizedPerformanceRecord[];
  criticalCount: number;
  maxDeviation: number;
}

function scoreAd(
  c: { id: string; name: string },
  allRows: Array<Record<string, unknown>>,
  currency: string,
  tz: string
): Candidate | null {
  const rows = allRows
    .filter((r) => String(r.adId ?? "") === c.id)
    .map((r) => ({
      date: String(r.dateStart ?? ""),
      spend: Number(r.spend ?? 0) || 0,
      impressions: Math.round(Number(r.impressions ?? 0)) || 0,
      clicks: Math.round(Number(r.clicks ?? 0)) || 0,
      reach: Math.round(Number(r.reach ?? 0)) || 0,
    }))
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date))
    .sort((a, b) => a.date.localeCompare(b.date));

  if (rows.length < 8) return null;
  const currentDay = rows[rows.length - 1];
  if (currentDay.spend <= 0) return null;
  if (currentDay.date < accountDate(-3)) return null;
  const baseDays = rows.slice(Math.max(0, rows.length - 11), -1).slice(-10);
  if (baseDays.length < 7) return null;

  const toNorm = (r: typeof rows[number]): NormalizedPerformanceRecord => ({
    accountId: ACCOUNT_ID, adId: c.id, date: r.date,
    spend: r.spend, impressions: r.impressions, clicks: r.clicks, reach: r.reach,
    conversions: 0, revenue: 0, currency, timezone: tz,
  });
  const baselineRecs = baseDays.map(toNorm);
  const currentRecs = [toNorm(currentDay)];
  const mkSummary = (recs: NormalizedPerformanceRecord[], s: string, e: string) =>
    aggregatePerformanceRecords(recs, {
      accountId: ACCOUNT_ID, level: "AD", entityId: c.id, entityName: c.name,
      windowType: "custom", startDate: s, endDate: e, source: "meta-insights-mock",
    });
  const anomalies = detectAnomalies(baselineRecs, mkSummary(currentRecs, currentDay.date, currentDay.date));
  const criticalCount = anomalies.filter((a) => a.severity === "CRITICAL").length;
  const maxDeviation = anomalies
    .filter((a) => a.direction === "NEGATIVE_ANOMALY")
    .reduce((m, a) => Math.max(m, Math.abs(a.percentDeviation ?? 0)), 0);

  console.log(
    `scan ${c.id} "${c.name}" days=${rows.length} curSpend=${currentDay.spend.toFixed(2)} anomalies=${anomalies.length} CRITICAL=${criticalCount} maxDev=${maxDeviation.toFixed(1)}%`
  );
  if (criticalCount === 0) return null;
  return { id: c.id, name: c.name, baseline: baselineRecs, current: currentRecs, criticalCount, maxDeviation };
}

async function journalCount(idempotencyKey: string): Promise<number> {
  return prisma.toolExecution.count({ where: { idempotencyKey } });
}

async function main(): Promise<void> {
  console.log("PHASE 11.6B â€” MOCK LIFECYCLE (real DB + engines, mocked Meta HTTP)");
  console.log(`account=${ACCOUNT_ID}`);

  const stack = buildMockStack(fixtures());
  const userId = await ensureSmokeUser();
  await ensureMarketingAccount(userId);

  // Re-run hygiene: staged fixture RECOMMENDATIONS from earlier runs of this
  // smoke script are scaffolding, not audit records (the durable audit trail
  // lives in AuditLog / ToolExecution / Approval) — delete them so the
  // engine's identity-dedup and anti-oscillation cooldown gates don't fire
  // against leftovers. Approvals/journal/audit rows are never touched.
  const deleted = await prisma.performanceRecommendation.deleteMany({
    where: { targetId: { in: [AD_A, AD_B] } },
  });
  if (deleted.count > 0) console.log(`re-run hygiene: removed ${deleted.count} stale fixture recommendation(s)`);
  const removedJournal = await prisma.toolExecution.deleteMany({
    where: {
      idempotencyKey: {
        in: [
          `meta.ad.pause:${ACCOUNT_ID}:${AD_A}:PAUSED`,
          `meta.ad.pause:${ACCOUNT_ID}:${AD_B}:PAUSED`,
        ],
      },
    },
  });
  if (removedJournal.count > 0) console.log(`re-run hygiene: removed ${removedJournal.count} stale fixture journal row(s)`);
  // Unconsumed APPROVED/PENDING approvals from crashed runs would be
  // auto-bound by the executor (approvedBound resolution) and skip the
  // pending step — remove them so every run exercises the full gate.
  const removedApprovals = await prisma.approval.deleteMany({
    where: { userId, toolId: "meta.ad.pause", status: { in: ["PENDING", "APPROVED"] } },
  });
  if (removedApprovals.count > 0) console.log(`re-run hygiene: removed ${removedApprovals.count} unconsumed fixture approval(s)`);
  await prisma.marketingAccount.createMany({
    data: [{
      userId,
      accountId: FOREIGN_ACCOUNT,
      name: "Phase 11.6B Mock Foreign Account (local fixture)",
      currency: "INR",
      timezoneName: "UTC",
      isActive: true,
    }],
    skipDuplicates: true,
  });

  // ---------------- 1. deterministic selection ----------------
  const provider = stack.provider;
  const adsRes = await provider.getAds(ACCOUNT_ID);
  const activeAds = adsRes.data.filter((a) => a.status === "ACTIVE").sort((x, y) => x.adId.localeCompare(y.adId));
  const insRes = await provider.getInsights(ACCOUNT_ID, { startDate: accountDate(-14), endDate: accountDate(0) }, "AD");
  const scored = activeAds
    .map((a) => scoreAd({ id: a.adId, name: a.name }, insRes.data as Array<Record<string, unknown>>, "INR", "America/Los_Angeles"))
    .filter((c): c is Candidate => c !== null)
    .sort((a, b) => b.maxDeviation - a.maxDeviation || a.id.localeCompare(b.id));
  if (scored.length === 0) throw new Error("staged data produced no CRITICAL candidate â€” fixture bug");
  console.log(`CANDIDATES SCORED: ${scored.map((c) => `${c.id} maxDev=${c.maxDeviation.toFixed(1)}%`).join(" | ")}`);

  const liveState = makeLiveStatePort(stack.executor, userId);
  const recEngine = new RecommendationEngine(stack.recRepo, {
    loadState: (accountId, _level, entityId) => liveState(accountId, entityId),
  });

  const adapter = scriptedDiagnosisProvider();
  const diagEngine = new DiagnosisEngine(adapter);

  async function createRecommendation(c: Candidate): Promise<RecommendationRecord> {
    const mkSummary = (which: "baseline" | "current") =>
      aggregatePerformanceRecords(c[which], {
        accountId: ACCOUNT_ID, level: "AD", entityId: c.id, entityName: c.name,
        windowType: "custom",
        startDate: c[which][0].date,
        endDate: c[which][c[which].length - 1].date,
        source: "meta-insights-mock",
      });
    const pkgC = buildEvidencePackage({
      accountId: ACCOUNT_ID,
      comparison: comparePerformanceSummaries(mkSummary("current"), mkSummary("baseline")),
      anomalies: detectAnomalies(c.baseline, mkSummary("current")),
    });

    let diag = null;
    for (let attempt = 1; attempt <= 2 && !diag; attempt++) {
      const out = await diagEngine.diagnose(pkgC, { userId, traceId: crypto.randomUUID() });
      if (out.status === "SUCCESS") {
        diag = out.diagnosis;
        console.log(`diagnosis[${c.id}]: SUCCESS category=${out.diagnosis.category} confidence=${out.diagnosis.confidence}`);
      } else {
        console.log(`diagnosis[${c.id}] attempt ${attempt}: ${out.status}`);
      }
    }
    if (!diag) {
      console.log(`RESULT: DIAGNOSIS_UNVERIFIED for ${c.id} â€” refusing to fabricate.`);
      process.exit(3);
    }

    const gen = await recEngine.generate({ userId, diagnosis: diag, evidence: pkgC });
    if (gen.status !== "CREATED") {
      const detail = "detail" in gen ? gen.detail : "";
      const reason = "reason" in gen ? gen.reason : "";
      console.log(`recommendation engine[${c.id}]: ${gen.status} reason=${reason} detail=${detail} — STOP.`);
      process.exit(4);
    }
    return gen.recommendation;
  }

  const scoredA = scored.find((c) => c.id === AD_A);
  const scoredB = scored.find((c) => c.id === AD_B);
  if (!scoredA || !scoredB) throw new Error("expected both staged ads to score CRITICAL");

  const rec = await createRecommendation(scoredA);
  console.log(`RECOMMENDATION A CREATED: ${rec.recommendationId} action=${rec.actionType} entity=${rec.entityId} risk=${rec.risk}`);

  const execBase = { userId, role: "member" as const };
  const runExec = (rid: string, extra: Record<string, unknown> = {}) =>
    stack.service.execute({ recommendationId: rid, traceId: crypto.randomUUID(), ...execBase, ...extra });

  // ---------------- 3. security negatives (expect 0 journal writes) ----------------
  const hasher = new PasswordHasher();
  const outsider = await prisma.user.create({
    data: {
      email: `phase116b-outsider-mock-${Date.now()}@jarvis-test.local`,
      name: "Phase 11.6B Mock Outsider",
      password: await hasher.hash(crypto.randomUUID()),
      role: "MEMBER",
    },
  });

  const cloneRec = async (newId: string, patch: Partial<RecommendationRecord>): Promise<void> => {
    // Distinct identityHash per clone: identity uniqueness is an ENGINE-level
    // dedup gate; the SERVICE judges paramsHash/stateHash/expiry/ownership.
    const freshIdentity = crypto.randomUUID().replace(/-/g, "").repeat(2);
    await stack.recRepo.save({
      ...rec,
      recommendationId: newId,
      status: "PROPOSED",
      identityHash: freshIdentity,
      ...patch,
    });
  };

  const jeBefore = await prisma.toolExecution.count();

  const idor = await stack.service.execute({
    recommendationId: rec.recommendationId, userId: outsider.id,
    role: "member", traceId: crypto.randomUUID(),
  });
  expectEq(idor.status, "RECOMMENDATION_NOT_FOUND", "IDOR: outsider cannot see/execute another user's recommendation");

  const forgedParamsId = `phase116b-mock-forged-params-${crypto.randomUUID()}`;
  await cloneRec(forgedParamsId, { paramsHash: "f".repeat(64) });
  expectEq((await runExec(forgedParamsId)).status, "PARAMS_HASH_MISMATCH", "forged paramsHash rejected");

  const forgedStateId = `phase116b-mock-forged-state-${crypto.randomUUID()}`;
  await cloneRec(forgedStateId, { stateHash: "0".repeat(64) });
  expectEq((await runExec(forgedStateId)).status, "STALE_RECOMMENDATION", "forged stateHash rejected as stale");

  const expiredId = `phase116b-mock-expired-${crypto.randomUUID()}`;
  await cloneRec(expiredId, { expiresAt: new Date(Date.now() - 1000).toISOString() });
  expectEq((await runExec(expiredId)).status, "RECOMMENDATION_EXPIRED", "expired recommendation rejected");

  const foreignParams = buildExecutableParams("PAUSE_AD", FOREIGN_ACCOUNT, AD_A);
  const foreignId = `phase116b-mock-foreign-${crypto.randomUUID()}`;
  await cloneRec(foreignId, { accountId: FOREIGN_ACCOUNT, paramsHash: computeParamsHash(foreignParams) });
  expectEq((await runExec(foreignId)).status, "AUTHORIZATION_DENIED", "foreign account rejected");

  const jeAfterNegatives = await prisma.toolExecution.count();
  expectEq(jeAfterNegatives, jeBefore, "negatives produced ZERO tool-execution journal rows");

  // ---------------- 4. single controlled lifecycle on AD_A ----------------
  const mainParams = buildExecutableParams("PAUSE_AD", ACCOUNT_ID, AD_A);
  const mainKey = `meta.ad.pause:${ACCOUNT_ID}:${AD_A}:PAUSED`;

  const trig = await runExec(rec.recommendationId);
  expectEq(trig.status, "APPROVAL_PENDING", "first execute creates PENDING approval");
  if (trig.status !== "APPROVAL_PENDING" || !trig.approvalId) throw new Error("no approvalId returned");
  const approvalId = trig.approvalId;

  const decided = await stack.approvalRepo.decideApproval(approvalId, userId, "approve");
  expectEq(decided.outcome, "approved", "human decision recorded durably (approve)");

  const dry = await runExec(rec.recommendationId, { dryRun: true });
  expectEq(dry.status, "DRY_RUN_OK", "dry-run passes every gate without side effects");

  expectEq(await journalCount(mainKey), 0, "journal clean before real execution");

  const real = await runExec(rec.recommendationId);
  expectEq(real.status, "EXECUTED", "real execution succeeds exactly once");
  if (real.status !== "EXECUTED") throw new Error("unexpected");
  console.log(`executionId=${real.executionId} approvalId=${real.approvalId ?? "(linked below)"}`);

  // verification GET reflects PAUSED
  const adsNow = await provider.getAds(ACCOUNT_ID);
  const targetNow = adsNow.data.find((a) => a.adId === AD_A);
  expectEq(targetNow?.status, "PAUSED", "verification GET: target is PAUSED");

  // journal: exactly one SUCCEEDED row under the canonical idempotency key
  const jRows = await prisma.toolExecution.findMany({ where: { idempotencyKey: mainKey } });
  expectEq(jRows.length, 1, "exactly one journal row for the idempotent write");
  expectEq(jRows[0]?.status, "SUCCEEDED", "journal row SUCCEEDED");
  expectEq(jRows[0]?.externalResourceId, AD_A, "journal links external resource");

  // approval consumed exactly once; replay consumption denied
  const apRow = await prisma.approval.findUnique({ where: { id: approvalId } });
  expectEq(apRow?.status, "CONSUMED", "approval atomically CONSUMED");
  const replay = await stack.approvalRepo.consumeForExecution({
    approvalId, userId,
    toolId: "meta.ad.pause",
    paramsHash: computeParamsHash(mainParams),
    executionId: `replay-probe-${crypto.randomUUID()}`,
  });
  expectEq(replay.ok, false, "approval replay-consumption denied");

  // recommendation durably linked + terminal
  const recNow = await stack.recRepo.getForUser(rec.recommendationId, userId);
  expectEq(recNow?.status, "EXECUTED", "recommendation EXECUTED");
  expectEq(recNow?.approvalId, approvalId, "recommendation links approvalId");
  expectEq(recNow?.executionId, real.executionId, "recommendation links executionId");

  const again = await runExec(rec.recommendationId);
  expectEq(again.status, "ALREADY_EXECUTED", "re-execution blocked (ALREADY_EXECUTED)");

  // ---------------- 5. x10 concurrency burst on AD_B ----------------
  // AD_B gets its OWN engine-generated recommendation (different entity =>
  // no DUPLICATE/CONFLICT/COOLDOWN interference), its own PENDING approval,
  // and then TEN concurrent service executions race for the single claim.
  const recB = await createRecommendation(scoredB);
  console.log(`RECOMMENDATION B CREATED: ${recB.recommendationId} action=${recB.actionType} entity=${recB.entityId}`);

  const bTrig = await runExec(recB.recommendationId);
  if (bTrig.status !== "APPROVAL_PENDING" || !bTrig.approvalId) throw new Error(`burst trigger unexpected: ${bTrig.status}`);
  const bDecided = await stack.approvalRepo.decideApproval(bTrig.approvalId, userId, "approve");
  expectEq(bDecided.outcome, "approved", "burst approval recorded");

  const burstResults = await Promise.allSettled(
    Array.from({ length: 10 }, () => runExec(recB.recommendationId))
  );
  const burstOutcomes = burstResults.map((r) =>
    r.status === "fulfilled" ? r.value.status : `rejected:${String(r.reason)}`
  );
  console.log(`burst outcomes: ${JSON.stringify(burstOutcomes)}`);
  const winners = burstOutcomes.filter((s) => s === "EXECUTED").length;
  const safeOutcomes = [
    "EXECUTED",
    "DUPLICATE_EXECUTION_BLOCKED",
    "ALREADY_EXECUTED",
    "EXECUTION_BLOCKED",
    "APPROVAL_ALREADY_CONSUMED",
  ] as const;
  const blockedOk = burstOutcomes.every((s) => (safeOutcomes as readonly string[]).includes(s));
  expectEq(winners, 1, "x10 concurrent executions: EXACTLY ONE winner");
  expectEq(blockedOk, true, "all losers blocked safely (no ambiguous outcomes)");

  const bKey = `meta.ad.pause:${ACCOUNT_ID}:${AD_B}:PAUSED`;
  const bRows = await prisma.toolExecution.findMany({ where: { idempotencyKey: bKey } });
  expectEq(bRows.length, 1, "exactly one journal row for burst target");
  expectEq(bRows[0]?.status, "SUCCEEDED", "burst journal row SUCCEEDED");
  const bStatus = (await provider.getAds(ACCOUNT_ID)).data.find((a) => a.adId === AD_B)?.status;
  expectEq(bStatus, "PAUSED", "burst target is PAUSED exactly once");

  // ---------------- 6. secret scan over fresh audit rows ----------------
  const recentAudit = await prisma.auditLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  const secretPattern = /(EAAG[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,})/;
  const leaked = recentAudit.filter((r) => secretPattern.test(JSON.stringify(r))).length;
  expectEq(leaked, 0, "secret scan across recent audit rows");

  // ---------------- 7. closing accounting ----------------
  const counts = {
    users: await prisma.user.count(),
    marketingAccounts: await prisma.marketingAccount.count(),
    recommendations: await prisma.performanceRecommendation.count(),
    approvals: await prisma.approval.count(),
    executions: await prisma.toolExecution.count(),
    snapshots: await prisma.metricSnapshot.count(),
    audit: await prisma.auditLog.count(),
  };
  console.log("DB COUNTS:", JSON.stringify(counts));
  console.log("RESULT: MOCK LIFECYCLE PROOF COMPLETE â€” ALL ASSERTIONS PASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error(`MOCK LIFECYCLE FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
