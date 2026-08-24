// ---------------------------------------------------------------------------
// PHASE 11.6B — STAGE 1: pre-flight + deterministic target selection +
// legitimate Phase 11.5 recommendation pipeline -> durable PROPOSED row.
//
// READS ONLY. Zero Meta writes occur in this stage.
// Stops WITHOUT writing when no safe target / valid recommendation exists.
// ---------------------------------------------------------------------------

import {
  aggregatePerformanceRecords,
  comparePerformanceSummaries,
  detectAnomalies,
  buildEvidencePackage,
  DiagnosisEngine,
  RecommendationEngine,
} from "@jarvis/core";
import type { NormalizedPerformanceRecord } from "@jarvis/core";
import { OpenAIAdapter } from "@jarvis/ai-openai";
import { prisma } from "@jarvis/db";
import {
  ACCOUNT_ID,
  API_VERSION,
  accountDate,
  buildStack,
  ensureMarketingAccount,
  ensureSmokeUser,
  loadState,
  makeLiveStatePort,
  saveState,
  tally,
  type SmokeState,
} from "./lib.js";

interface CandidateRow {
  date: string;
  spend: number;
  impressions: number;
  clicks: number;
  reach: number;
}

async function main(): Promise<void> {
  const state = {} as SmokeState;
  state.stage = "propose";
  state.startedAt = new Date().toISOString();

  console.log("PHASE 11.6B — STAGE 1: PROPOSE (reads only)");
  console.log(`account=${ACCOUNT_ID} apiVersion=${API_VERSION}`);

  // ---------------- pre-flight ----------------
  if (!process.env.META_ACCESS_TOKEN || !ACCOUNT_ID || !API_VERSION) {
    throw new Error("Pre-flight FAIL: META_* env incomplete");
  }
  const stack = buildStack();
  const userId = await ensureSmokeUser();
  state.userId = userId;
  await prisma.$queryRaw`SELECT 1`;
  console.log("pre-flight: env OK, DB OK");

  // Account authorization + attributes through the production read tool.
  const accountsRes = await stack.executor.execute({
    toolId: "meta.accounts",
    params: {},
    userId,
    role: "member",
    traceId: crypto.randomUUID(),
  });
  if (accountsRes.status !== "completed" || !accountsRes.result?.success) {
    throw new Error(`meta.accounts failed: ${accountsRes.error ?? "unknown"}`);
  }
  const accounts = (accountsRes.result.data as { accounts?: Array<Record<string, unknown>> }).accounts ?? [];
  const mine = accounts.find((a) => String(a.accountId ?? a.id) === ACCOUNT_ID);
  if (!mine) throw new Error("configured account NOT authorized for this token");
  console.log(
    `authorization: OK currency=${mine.currency} tz=${mine.timezoneName ?? mine.timezone_name} status=${mine.accountStatus ?? mine.account_status}`
  );
  const currency = String(mine.currency ?? "INR");
  const tz = String(mine.timezoneName ?? "America/Los_Angeles");
  state.account = {
    id: ACCOUNT_ID,
    currency,
    timezone: tz,
    status: Number(mine.accountStatus ?? mine.account_status ?? 0),
  };

  await ensureMarketingAccount(userId);

  // ---------------- inventory (READ) ----------------
  const readList = async (toolId: string, listKey: string): Promise<Array<Record<string, unknown>>> => {
    const res = await stack.executor.execute({
      toolId,
      params: { accountId: ACCOUNT_ID, limit: 100 },
      userId,
      role: "member",
      traceId: crypto.randomUUID(),
    });
    if (res.status !== "completed" || !res.result?.success) return [];
    const payload = res.result.data as Record<string, unknown>;
    return Array.isArray(payload?.[listKey]) ? (payload[listKey] as Array<Record<string, unknown>>) : [];
  };

  const campaigns = await readList("meta.campaigns", "campaigns");
  const adSets = await readList("meta.adsets", "adSets");
  const ads = await readList("meta.ads", "ads");
  console.log(`inventory: campaigns=${campaigns.length} adSets=${adSets.length} ads=${ads.length}`);
  state.inventoryBaseline = {
    campaigns: campaigns.length,
    adSets: adSets.length,
    ads: ads.length,
    ids: {
      campaigns: campaigns.map((c) => String(c.campaignId)),
      adSets: adSets.map((a) => String(a.adSetId)),
      ads: ads.map((a) => String(a.adId)),
    },
  };
  saveState({ ...loadOrCreate(), ...state });

  // ---------------- daily insights for ALL ads (READ, one call) ----------------
  const start = accountDate(-14);
  const end = accountDate(0);
  const insRes = await stack.executor.execute({
    toolId: "meta.insights",
    params: { accountId: ACCOUNT_ID, startDate: start, endDate: end, level: "ad", timeIncrement: 1, limit: 500 },
    userId,
    role: "member",
    traceId: crypto.randomUUID(),
  });
  if (insRes.status !== "completed" || !insRes.result?.success) {
    throw new Error(`meta.insights failed: ${insRes.error ?? "unknown"}`);
  }
  const insightRows = (insRes.result.data as { insights?: Array<Record<string, unknown>> }).insights ?? [];
  console.log(`insights: ${insightRows.length} daily ad-level rows [${start}..${end}]`);

  // ---------------- deterministic target selection ----------------
  const activeAds = ads
    .filter((a) => String(a.status) === "ACTIVE")
    .map((a) => ({ id: String(a.adId), name: String(a.name), campaignId: String(a.campaignId), adSetId: String(a.adSetId) }))
    .sort((x, y) => x.id.localeCompare(y.id));

  let scanLevel: "AD" | "AD_SET" = "AD";
  let candidates = activeAds;
  if (candidates.length === 0) {
    scanLevel = "AD_SET";
    candidates = adSets
      .filter((a) => String(a.status) === "ACTIVE")
      .map((a) => ({ id: String(a.adSetId), name: String(a.name), campaignId: String(a.campaignId), adSetId: String(a.adSetId) }))
      .sort((x, y) => x.id.localeCompare(y.id));
  }
  console.log(`target scan: level=${scanLevel} activeCandidates=${candidates.length}`);
  for (const c of candidates) {
    console.log(`  candidate ${c.id} "${c.name}"`);
  }
  for (const [lvl, list] of [
    ["AD", ads] as const,
    ["AD_SET", adSets] as const,
    ["CAMPAIGN", campaigns] as const,
  ]) {
    for (const e of list) {
      console.log(`  entity level=${lvl} id=${String((e as Record<string, unknown>).adId ?? (e as Record<string, unknown>).adSetId ?? (e as Record<string, unknown>).campaignId)} status=${String((e as Record<string, unknown>).status)}`);
    }
  }

  const byEntity = new Map<string, CandidateRow[]>();
  for (const raw of insightRows) {
    const key = scanLevel === "AD" ? String(raw.adId ?? "") : String(raw.adsetId ?? "");
    if (!key) continue;
    const list = byEntity.get(key) ?? [];
    list.push({
      date: String(raw.dateStart ?? ""),
      spend: Number(raw.spend ?? 0) || 0,
      impressions: Math.round(Number(raw.impressions ?? 0)) || 0,
      clicks: Math.round(Number(raw.clicks ?? 0)) || 0,
      reach: Math.round(Number(raw.reach ?? 0)) || 0,
    });
    byEntity.set(key, list);
  }

  interface ScoredTarget {
    id: string;
    name: string;
    campaignId?: string;
    adSetId?: string;
    baseline: NormalizedPerformanceRecord[];
    current: NormalizedPerformanceRecord[];
    criticalCount: number;
    warningCount: number;
    maxDeviation: number;
  }
  const scored: ScoredTarget[] = [];

  for (const c of candidates) {
    const rows = (byEntity.get(c.id) ?? []).filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date));
    if (rows.length < 8) continue; // need >=7 baseline days + 1 current day
    rows.sort((a, b) => a.date.localeCompare(b.date));
    const currentDay = rows[rows.length - 1];
    if (currentDay.spend <= 0) continue;
    if (currentDay.date < accountDate(-3)) continue; // stale data — not eligible
    const baseDays = rows.slice(Math.max(0, rows.length - 11), -1).slice(-10);
    if (baseDays.length < 7) continue;

    const toNorm = (r: CandidateRow): NormalizedPerformanceRecord => ({
      accountId: ACCOUNT_ID,
      ...(scanLevel === "AD" ? { adId: c.id } : {}),
      ...(scanLevel === "AD_SET" ? { adSetId: c.id } : {}),
      ...(scanLevel === "AD_SET" && c.campaignId ? { campaignId: c.campaignId } : {}),
      date: r.date,
      spend: r.spend,
      impressions: r.impressions,
      clicks: r.clicks,
      reach: r.reach,
      conversions: 0,
      revenue: 0,
      currency,
      timezone: tz,
    });

    const baselineRecs = baseDays.map(toNorm);
    const currentRecs = [toNorm(currentDay)];
    const levelKey = scanLevel === "AD" ? "AD" : "AD_SET";

    const currentSummary = aggregatePerformanceRecords(currentRecs, {
      accountId: ACCOUNT_ID,
      level: levelKey,
      entityId: c.id,
      entityName: c.name,
      windowType: "custom",
      startDate: currentDay.date,
      endDate: currentDay.date,
      source: "meta-insights",
    });
    const previousSummary = aggregatePerformanceRecords(baselineRecs, {
      accountId: ACCOUNT_ID,
      level: levelKey,
      entityId: c.id,
      entityName: c.name,
      windowType: "custom",
      startDate: baseDays[0].date,
      endDate: baseDays[baseDays.length - 1].date,
      source: "meta-insights",
    });
    const comparison = comparePerformanceSummaries(currentSummary, previousSummary);
    const anomalies = detectAnomalies(baselineRecs, currentSummary);
    const negatives = anomalies.filter((a) => a.direction === "NEGATIVE_ANOMALY");
    const criticalCount = anomalies.filter((a) => a.severity === "CRITICAL").length;
    const warningCount = anomalies.filter((a) => a.severity === "WARNING").length;
    const maxDeviation = negatives.reduce((m, a) => Math.max(m, Math.abs(a.percentDeviation ?? 0)), 0);

    console.log(
      `scan ${c.id} "${c.name}" days=${rows.length} curSpend=${currentDay.spend.toFixed(2)} anomalies=${anomalies.length} CRITICAL=${criticalCount} WARNING=${warningCount} maxDev=${maxDeviation.toFixed(1)}%`
    );

    if (criticalCount === 0) continue; // pause gate: requires CRITICAL signal
    scored.push({
      id: c.id,
      name: c.name,
      campaignId: c.campaignId,
      adSetId: c.adSetId,
      baseline: baselineRecs,
      current: currentRecs,
      criticalCount,
      warningCount,
      maxDeviation,
    });
  }

  scored.sort((a, b) => b.maxDeviation - a.maxDeviation || a.id.localeCompare(b.id));

  if (scored.length === 0) {
    console.log("RESULT: NO_SAFE_TARGET — no ACTIVE entity exhibits a CRITICAL negative anomaly.");
    console.log("STOP WITHOUT WRITING (per spec §2/§3). No campaign/ad/ad-set will be created.");
    const s2 = loadState();
    s2.stage = "no-safe-target";
    saveState(s2);
    process.exit(2);
  }

  const chosen = scored[0];
  console.log(`TARGET SELECTED (deterministic): ${chosen.id} "${chosen.name}" maxDev=${chosen.maxDeviation.toFixed(1)}%`);

  // ---------------- evidence + REAL diagnosis + recommendation ----------------
  const pkg = buildEvidencePackage({
    accountId: ACCOUNT_ID,
    comparison: comparePerformanceSummaries(
      aggregatePerformanceRecords(chosen.current, {
        accountId: ACCOUNT_ID, level: scanLevel, entityId: chosen.id, entityName: chosen.name,
        windowType: "custom", startDate: chosen.current[0].date, endDate: chosen.current[0].date, source: "meta-insights",
      }),
      aggregatePerformanceRecords(chosen.baseline, {
        accountId: ACCOUNT_ID, level: scanLevel, entityId: chosen.id, entityName: chosen.name,
        windowType: "custom", startDate: chosen.baseline[0].date, endDate: chosen.baseline[chosen.baseline.length - 1].date, source: "meta-insights",
      })
    ),
    anomalies: detectAnomalies(chosen.baseline, aggregatePerformanceRecords(chosen.current, {
      accountId: ACCOUNT_ID, level: scanLevel, entityId: chosen.id, entityName: chosen.name,
      windowType: "custom", startDate: chosen.current[0].date, endDate: chosen.current[0].date, source: "meta-insights",
    })),
  });

  const adapter = new OpenAIAdapter();
  const engine = new DiagnosisEngine(adapter);
  let diagnosis = null;
  for (let attempt = 1; attempt <= 2 && !diagnosis; attempt++) {
    const out = await engine.diagnose(pkg, { userId, traceId: crypto.randomUUID() });
    if (out.status === "SUCCESS") {
      diagnosis = out.diagnosis;
      console.log(`diagnosis: SUCCESS id=${out.diagnosis.diagnosisId} category=${out.diagnosis.category} confidence=${out.diagnosis.confidence}`);
    } else {
      console.log(`diagnosis attempt ${attempt}: ${out.status}${"audit" in out ? JSON.stringify(out.audit).slice(0, 300) : ""}`);
    }
  }
  if (!diagnosis) {
    console.log("RESULT: DIAGNOSIS_UNVERIFIED — refusing to fabricate. STOP WITHOUT WRITING.");
    const s2 = loadState(); s2.stage = "diagnosis-unverified"; saveState(s2);
    process.exit(3);
  }

  await ensureMarketingAccount(userId);
  const liveState = makeLiveStatePort(stack.executor, userId);
  const recEngine = new RecommendationEngine(stack.recRepo, {
    loadState: (accountId, _level, entityId) => liveState(accountId, entityId),
  });
  const gen = await recEngine.generate({ userId, diagnosis, evidence: pkg });

  if (gen.status !== "CREATED") {
    console.log(`recommendation engine: ${gen.status} — no durable recommendation created. STOP WITHOUT WRITING.`);
    const s2 = loadState(); s2.stage = `engine-${gen.status.toLowerCase()}`; saveState(s2);
    process.exit(4);
  }

  const rec = gen.recommendation;
  console.log("RECOMMENDATION CREATED:");
  console.log(JSON.stringify({
    recommendationId: rec.recommendationId,
    actionType: rec.actionType,
    entityId: rec.entityId,
    entityLevel: rec.entityLevel,
    currentState: rec.currentState,
    proposedState: rec.proposedState,
    risk: rec.risk,
    confidence: rec.confidence,
    expiresAt: rec.expiresAt,
    reason: rec.reason.slice(0, 240),
  }, null, 2));

  // Metric snapshot provenance (best-effort; pipeline correctness never depends on it)
  for (const r of [...chosen.baseline, ...chosen.current]) {
    try {
      await prisma.metricSnapshot.upsert({
        where: { metric_snapshot_unique_key: { accountId: ACCOUNT_ID, level: scanLevel === "AD" ? "AD" : "AD_SET", entityId: chosen.id, dateStart: new Date(`${r.date}T00:00:00Z`), dateStop: new Date(`${r.date}T00:00:00Z`), periodType: "day" } },
        create: {
          accountId: ACCOUNT_ID, level: scanLevel === "AD" ? "AD" : "AD_SET", entityId: chosen.id, entityName: chosen.name,
          dateStart: new Date(`${r.date}T00:00:00Z`), dateStop: new Date(`${r.date}T00:00:00Z`), periodType: "day",
          spend: r.spend, impressions: BigInt(r.impressions), clicks: BigInt(r.clicks), reach: BigInt(r.reach),
          conversions: r.conversions, revenue: r.revenue,
        },
        update: {},
      });
    } catch (e) {
      console.log(`snapshot upsert skipped: ${(e as Error).message?.slice(0, 120)}`);
    }
  }

  const s = loadState();
  s.stage = "proposed";
  s.target = {
    kind: scanLevel,
    id: chosen.id,
    name: chosen.name,
    campaignId: chosen.campaignId,
    adSetId: chosen.adSetId,
    previousStatus: "ACTIVE",
  };
  s.recommendation = {
    recommendationId: rec.recommendationId,
    actionType: rec.actionType,
    paramsHash: rec.paramsHash,
    stateHash: rec.stateHash,
    expiresAt: rec.expiresAt,
  };
  saveState(s);

  console.log("\nSTAGE 1 COMPLETE — recommendation is PROPOSED and awaits EXPLICIT HUMAN APPROVAL.");
  console.log(`Real Meta GET requests so far: ${tally.get}; POST writes: ${tally.post}`);
  process.exit(0);
}

function loadOrCreate(): Partial<SmokeState> {
  try {
    return loadState();
  } catch {
    return { stage: "init", startedAt: new Date().toISOString() } as Partial<SmokeState>;
  }
}

main().catch((err) => {
  console.error(`PROPOSE FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
