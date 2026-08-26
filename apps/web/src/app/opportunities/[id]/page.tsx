"use client";

// ---------------------------------------------------------------------------
// Phase 11.9B — Opportunity Detail / Human Review Panel
//
// Shows all 10 human-review sections for a single opportunity:
//   1. WHAT WAS DETECTED
//   2. WHAT JARVIS THINKS IS HAPPENING (Diagnosis)
//   3. WHAT IT RECOMMENDS
//   4. WHY
//   5. EXPECTED IMPACT
//   6. RISK
//   7. HISTORICAL EVIDENCE
//   8. OPPORTUNITY SCORE
//   9. LIMITATIONS
//  10. CURRENT STATE / TARGET STATE
//
// Language guardrails enforced throughout:
//   "Recommended because…" (NEVER "JARVIS guarantees…")
//   "Historical evidence suggests…" (NEVER "This will improve…")
//   "Expected impact (not a guarantee)"
//   "Confidence: HIGH/MEDIUM/LOW"
//
// "Review & Enter Approval Flow" → navigates to /approvals
// Does NOT trigger execution. Does NOT write anything.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  getOpportunity,
  type OpportunityQueueItemDetail,
} from "@/lib/api";

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SectionHeader({ icon, title, tag }: { icon: string; title: string; tag?: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <span className="text-xl">{icon}</span>
      <h2 className="font-semibold text-gray-100 text-sm uppercase tracking-wider">{title}</h2>
      {tag && (
        <span className="rounded-full bg-white/10 text-gray-400 px-2 py-0.5 text-xs font-medium">
          {tag}
        </span>
      )}
    </div>
  );
}

function Section({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-white/10 bg-white/5 p-5 ${className}`}>
      {children}
    </div>
  );
}

function Pill({ label, value, color = "text-white" }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-lg bg-white/5 p-3 text-center">
      <p className="text-xs text-gray-400 mb-0.5">{label}</p>
      <p className={`text-sm font-semibold ${color}`}>{value}</p>
    </div>
  );
}

const RISK_COLORS: Record<string, string> = {
  LOW: "text-green-400", MEDIUM: "text-yellow-400", HIGH: "text-red-400",
};
const CONF_COLORS: Record<string, string> = {
  HIGH: "text-green-400", MEDIUM: "text-yellow-400", LOW: "text-red-400",
};
const SEV_COLORS: Record<string, string> = {
  CRITICAL: "text-red-400", HIGH: "text-orange-400", MEDIUM: "text-yellow-400", LOW: "text-blue-400",
};
const PRIORITY_COLORS: Record<string, string> = {
  CRITICAL: "bg-red-500/20 text-red-300 border-red-500/40",
  HIGH:     "bg-orange-500/20 text-orange-300 border-orange-500/40",
  MEDIUM:   "bg-yellow-500/20 text-yellow-300 border-yellow-500/40",
  LOW:      "bg-blue-500/20 text-blue-300 border-blue-500/40",
  IGNORE:   "bg-gray-600/20 text-gray-400 border-gray-600/40",
};

function formatActionType(action: string) {
  return action.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function OpportunityDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = typeof params?.id === "string" ? params.id : "";

  const [opp, setOpp] = useState<OpportunityQueueItemDetail | null>(null);
  const [staleWarning, setStaleWarning] = useState<{
    isStale: boolean; reasons: string[]; message: string;
  } | null>(null);
  const [approvalHandoff, setApprovalHandoff] = useState<{
    approvalId: string | null; approvalRoute: string; message: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    void (async () => {
      setLoading(true);
      setError(null);
      const res = await getOpportunity(id);
      if (res.success && res.opportunity) {
        setOpp(res.opportunity);
        setStaleWarning(res.staleWarning ?? null);
        setApprovalHandoff(res.approvalHandoff ?? null);
      } else {
        setError(res.error?.message ?? "Opportunity not found");
      }
      setLoading(false);
    })();
  }, [id]);

  if (loading) {
    return (
      <main className="mx-auto max-w-3xl p-6 flex items-center gap-3 text-gray-400">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-indigo-400 border-t-transparent" />
        <span>Loading opportunity…</span>
      </main>
    );
  }

  if (error || !opp) {
    return (
      <main className="mx-auto max-w-3xl p-6 space-y-4">
        <button
          onClick={() => router.back()}
          className="text-sm text-indigo-400 hover:text-indigo-300"
        >
          ← Back to queue
        </button>
        <div
          data-testid="detail-error"
          className="rounded-xl border border-red-500/30 bg-red-500/10 px-5 py-4"
        >
          <p className="text-sm font-semibold text-red-400">Opportunity not found</p>
          <p className="text-sm text-red-300 mt-1">
            {error ?? "The requested recommendation could not be loaded."}
          </p>
        </div>
      </main>
    );
  }

  const isExpired = opp.displayStatus === "EXPIRED";
  const isTerminal = ["EXECUTED", "FAILED", "REJECTED"].includes(opp.displayStatus);

  return (
    <main className="mx-auto max-w-3xl space-y-5 p-6">
      {/* Back nav */}
      <button
        onClick={() => router.back()}
        className="text-sm text-indigo-400 hover:text-indigo-300 transition-colors"
      >
        ← Back to queue
      </button>

      {/* Page title */}
      <div className="space-y-2">
        <div className="flex items-center gap-3 flex-wrap">
          <span
            className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-bold ${
              PRIORITY_COLORS[opp.priority] ?? PRIORITY_COLORS.IGNORE
            }`}
          >
            {opp.priority} PRIORITY
          </span>
          {opp.conflicted && (
            <span
              data-testid="conflict-warning"
              className="rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40 px-3 py-1 text-xs font-bold"
            >
              ⚠ CONFLICTED
            </span>
          )}
          {(isExpired || isTerminal) && (
            <span className="rounded-full bg-gray-600/30 text-gray-400 px-3 py-1 text-xs font-bold">
              {opp.displayStatus}
            </span>
          )}
        </div>
        <h1 className="text-2xl font-bold text-white">
          {formatActionType(opp.actionType)}
        </h1>
        <p className="text-sm text-gray-400">
          {opp.entityType} · <span className="font-mono">{opp.entityId}</span>
        </p>
        <p className="text-xs text-gray-500">
          Recommendation ID: <span className="font-mono">{opp.recommendationId}</span>
        </p>
      </div>

      {/* Stale warning */}
      {staleWarning?.isStale && (
        <div
          data-testid="stale-warning"
          className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-5 py-4"
        >
          <p className="text-sm font-semibold text-amber-400 mb-1">
            ⚠ Stale State Warning
          </p>
          <p className="text-sm text-amber-300">{staleWarning.message}</p>
          {staleWarning.reasons.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {staleWarning.reasons.map((r) => (
                <li key={r} className="text-xs text-amber-400 font-mono">{r}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Conflict detail */}
      {opp.conflicted && (
        <div
          data-testid="conflict-detail"
          className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-5 py-4"
        >
          <p className="text-sm font-semibold text-amber-400 mb-1">⚠ Conflict Detected</p>
          <p className="text-sm text-amber-300">
            This recommendation conflicts with the following:
          </p>
          <ul className="mt-2 space-y-1">
            {opp.conflictWith.map((cId) => (
              <li key={cId}>
                <Link
                  href={`/opportunities/${cId}`}
                  className="font-mono text-xs text-amber-400 hover:text-amber-300 underline"
                >
                  {cId}
                </Link>
              </li>
            ))}
          </ul>
          <p className="text-xs text-amber-200 mt-2">
            Do not silently choose one. Review both recommendations before deciding.
          </p>
        </div>
      )}

      {/* ── SECTION 1: WHAT WAS DETECTED ── */}
      <Section>
        <SectionHeader icon="🔍" title="What Was Detected" tag="FACT" />
        {opp.anomalies.length === 0 ? (
          <p className="text-sm text-gray-400">No anomalies recorded.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="anomalies-table">
              <thead>
                <tr className="border-b border-white/10 text-left text-xs text-gray-400 uppercase tracking-wider">
                  <th className="pb-2 pr-4">Metric</th>
                  <th className="pb-2 pr-4">Severity</th>
                  <th className="pb-2 pr-4">Direction</th>
                  <th className="pb-2 pr-4">Deviation</th>
                  <th className="pb-2">Detected</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {opp.anomalies.map((a, i) => (
                  <tr key={i}>
                    <td className="py-2 pr-4 font-mono text-white">{a.metric}</td>
                    <td className={`py-2 pr-4 font-semibold ${SEV_COLORS[a.severity] ?? "text-white"}`}>
                      {a.severity}
                    </td>
                    <td className="py-2 pr-4 text-gray-300">
                      {a.direction.replace(/_/g, " ")}
                    </td>
                    <td className="py-2 pr-4 text-gray-300">
                      {a.percentDeviation !== null
                        ? `${Math.round(Math.abs(a.percentDeviation))}%`
                        : "—"}
                    </td>
                    <td className="py-2 text-xs text-gray-500">
                      {new Date(a.detectedAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* ── SECTION 2: WHAT JARVIS THINKS ── */}
      <Section>
        <SectionHeader icon="🧠" title="What JARVIS Thinks Is Happening" tag="INFERENCE" />
        {opp.diagnosisCategory && (
          <p className="text-sm text-indigo-300 font-semibold mb-2">
            {opp.diagnosisCategory.replace(/_/g, " ")}
          </p>
        )}
        <p className="text-sm text-gray-300 leading-relaxed">{opp.reason}</p>
        <p className="text-xs text-gray-500 mt-2 italic">
          This is an inference based on detected patterns — not a confirmed root cause.
        </p>
      </Section>

      {/* ── SECTION 3: WHAT IT RECOMMENDS ── */}
      <Section>
        <SectionHeader icon="📋" title="What It Recommends" tag="RECOMMENDATION" />
        <p className="text-sm text-gray-300 mb-3">
          Recommended because: {opp.explanation}
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg bg-white/5 p-3">
            <p className="text-xs text-gray-400 mb-1">Action</p>
            <p className="text-sm font-semibold text-white">
              {formatActionType(opp.actionType)}
            </p>
          </div>
          <div className="rounded-lg bg-white/5 p-3">
            <p className="text-xs text-gray-400 mb-1">Target</p>
            <p className="text-sm font-mono text-white truncate">{opp.entityId}</p>
          </div>
        </div>
      </Section>

      {/* ── SECTION 4 & 5: WHY + EXPECTED IMPACT ── */}
      <Section>
        <SectionHeader icon="💡" title="Why + Expected Impact" />
        <div className="space-y-3">
          {opp.positiveFactors.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-green-400 mb-1">
                Supporting factors:
              </p>
              <ul className="space-y-1">
                {opp.positiveFactors.map((f) => (
                  <li key={f} className="text-sm text-gray-300 flex gap-2">
                    <span className="text-green-400">+</span> {f}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {opp.negativeFactors.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-red-400 mb-1">
                Caution factors:
              </p>
              <ul className="space-y-1">
                {opp.negativeFactors.map((f) => (
                  <li key={f} className="text-sm text-gray-300 flex gap-2">
                    <span className="text-red-400">−</span> {f}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="rounded-lg bg-white/5 p-3">
            <p className="text-xs text-gray-400 mb-1">
              Expected impact (not a guarantee):
            </p>
            <p className="text-sm font-semibold text-white">
              {opp.expectedImpact === "IMPACT_UNKNOWN"
                ? "Cannot be estimated from available data"
                : opp.expectedImpact}
            </p>
          </div>
        </div>
      </Section>

      {/* ── SECTION 6: RISK ── */}
      <Section>
        <SectionHeader icon="⚠️" title="Risk" />
        <div className="flex items-center gap-3 mb-2">
          <span className={`text-2xl font-bold ${RISK_COLORS[opp.risk] ?? "text-white"}`}>
            {opp.risk}
          </span>
          <span className="text-sm text-gray-400">risk level</span>
        </div>
        <p className="text-sm text-gray-300">{opp.riskNote}</p>
        <p className="text-xs text-gray-400 mt-2">
          Reversibility: <strong className="text-gray-300">{opp.reversibility.replace(/_/g, " ")}</strong>
        </p>
      </Section>

      {/* ── SECTION 7: HISTORICAL EVIDENCE ── */}
      <Section>
        <SectionHeader icon="📊" title="Historical Evidence" tag="HISTORICAL EVIDENCE" />
        <div className="grid grid-cols-2 gap-3 mb-3 sm:grid-cols-4">
          <Pill
            label="Sample Size"
            value={String(opp.historicalSampleSize)}
          />
          <Pill
            label="Quality"
            value={opp.sampleQuality ?? "—"}
          />
          <Pill
            label="Consistency"
            value={opp.historicalConsistency?.replace(/_/g, " ") ?? "—"}
          />
          <Pill
            label="Contradictory"
            value={String(opp.contradictoryEvidenceCount)}
            color={opp.contradictoryEvidenceCount > 0 ? "text-red-400" : "text-green-400"}
          />
        </div>
        {opp.historicalNote ? (
          <p className="text-sm text-gray-300 leading-relaxed">
            Historical evidence suggests: {opp.historicalNote}
          </p>
        ) : (
          <p className="text-sm text-gray-400">No relevant historical evidence available.</p>
        )}
        {opp.historicalLimitations.length > 0 && (
          <div className="mt-3">
            <p className="text-xs text-gray-500 font-semibold mb-1">Evidence limitations:</p>
            <ul className="space-y-0.5">
              {opp.historicalLimitations.map((l) => (
                <li key={l} className="text-xs text-gray-500 font-mono">{l}</li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      {/* ── SECTION 8: OPPORTUNITY SCORE ── */}
      <Section>
        <SectionHeader icon="🎯" title="Opportunity Score" />
        <div className="flex items-end gap-2 mb-3">
          <span className="text-4xl font-bold text-white">{opp.score}</span>
          <span className="text-gray-400 mb-1">/100</span>
          <span
            className={`ml-2 rounded-full border px-3 py-1 text-xs font-bold ${
              PRIORITY_COLORS[opp.priority] ?? PRIORITY_COLORS.IGNORE
            }`}
          >
            {opp.priority}
          </span>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Pill label="Severity" value={opp.severity} color={SEV_COLORS[opp.severity] ?? "text-white"} />
          <Pill label="Confidence" value={opp.confidence} color={CONF_COLORS[opp.confidence] ?? "text-white"} />
          <Pill label="Urgency" value={opp.urgency} />
        </div>
        <p className="text-xs text-gray-500 mt-3 italic">
          Score version {opp.scoringVersion}. Calculated at{" "}
          {new Date(opp.calculatedAt).toLocaleString()}.
          Scores express relative opportunity priority — not success probability.
        </p>
      </Section>

      {/* ── SECTION 9: LIMITATIONS ── */}
      <Section>
        <SectionHeader icon="⚡" title="Limitations" tag="UNCERTAINTY" />
        {opp.limitations.length === 0 ? (
          <p className="text-sm text-gray-400">No specific limitations recorded.</p>
        ) : (
          <ul className="space-y-1">
            {opp.limitations.map((l) => (
              <li key={l} className="text-xs text-gray-400 font-mono">{l}</li>
            ))}
          </ul>
        )}
      </Section>

      {/* ── SECTION 10: CURRENT STATE / TARGET STATE ── */}
      <Section>
        <SectionHeader icon="🔄" title="Current State vs Target State" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <p className="text-xs font-semibold text-blue-400 mb-2 uppercase tracking-wider">
              Current State
            </p>
            <pre className="rounded-lg bg-black/30 p-3 text-xs text-gray-300 overflow-x-auto whitespace-pre-wrap font-mono">
              {JSON.stringify(opp.currentState, null, 2)}
            </pre>
          </div>
          <div>
            <p className="text-xs font-semibold text-indigo-400 mb-2 uppercase tracking-wider">
              Proposed Target State
            </p>
            <pre className="rounded-lg bg-black/30 p-3 text-xs text-gray-300 overflow-x-auto whitespace-pre-wrap font-mono">
              {JSON.stringify(opp.proposedState, null, 2)}
            </pre>
          </div>
        </div>
      </Section>

      {/* ── APPROVAL REQUIREMENTS ── */}
      <Section>
        <SectionHeader icon="🔐" title="Approval Requirements" />
        <div className="space-y-2 text-sm text-gray-300">
          <div className="flex gap-2">
            <span className="text-green-400">✓</span>
            <span>Requires human approval before any action</span>
          </div>
          <div className="flex gap-2">
            <span className="text-green-400">✓</span>
            <span>Approval is bound to your user account</span>
          </div>
          <div className="flex gap-2">
            <span className="text-green-400">✓</span>
            <span>Parameters are hash-protected against tampering</span>
          </div>
          <div className="flex gap-2">
            <span className="text-green-400">✓</span>
            <span>Stale-state protection: live state will be re-verified before execution</span>
          </div>
          <div className="flex gap-2">
            <span className="text-green-400">✓</span>
            <span>
              Tool: <span className="font-mono">{opp.approvalRequirements.boundToTool}</span>
            </span>
          </div>
          <div className="flex gap-2">
            <span className={new Date(opp.approvalRequirements.expiresAt) < new Date() ? "text-red-400" : "text-yellow-400"}>⏱</span>
            <span>
              Expires:{" "}
              <span className={new Date(opp.approvalRequirements.expiresAt) < new Date() ? "text-red-400 font-semibold" : ""}>
                {new Date(opp.approvalRequirements.expiresAt).toLocaleString()}
              </span>
            </span>
          </div>
        </div>
      </Section>

      {/* Preconditions */}
      {opp.preconditions.length > 0 && (
        <Section>
          <SectionHeader icon="📌" title="Preconditions" />
          <ul className="space-y-1">
            {opp.preconditions.map((p) => (
              <li key={p} className="text-xs text-gray-400 font-mono">{p}</li>
            ))}
          </ul>
        </Section>
      )}

      {/* ── APPROVAL HANDOFF ── */}
      <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/10 px-5 py-5">
        <p className="text-sm font-semibold text-indigo-300 mb-2">
          Next Step: Enter Approval Flow
        </p>
        <p className="text-sm text-gray-300 mb-4">
          {approvalHandoff?.message ??
            "To act on this recommendation, submit it to the existing approval flow via the JARVIS chat interface."}
        </p>

        {!isExpired && !isTerminal ? (
          approvalHandoff?.approvalId ? (
            <Link
              href={approvalHandoff.approvalRoute}
              data-testid="view-approval-link"
              className="inline-block rounded-lg bg-indigo-600 text-white px-5 py-2.5 text-sm font-semibold hover:bg-indigo-500 transition-colors"
            >
              View Existing Approval Request →
            </Link>
          ) : (
            <Link
              href="/approvals"
              data-testid="go-to-approvals-link"
              className="inline-block rounded-lg bg-indigo-600 text-white px-5 py-2.5 text-sm font-semibold hover:bg-indigo-500 transition-colors"
            >
              Go to Approvals →
            </Link>
          )
        ) : (
          <p className="text-sm text-gray-400 italic">
            This recommendation is {opp.displayStatus.toLowerCase()} and cannot be approved.
          </p>
        )}

        <p className="text-xs text-gray-500 mt-3">
          Viewing this recommendation does not approve it. Approval requires your
          explicit action in the approval flow.
        </p>
      </div>

      {/* Metadata footer */}
      <div className="text-xs text-gray-600 space-y-1 pb-6">
        <p>Created: {new Date(opp.createdAt).toLocaleString()}</p>
        <p>Diagnosis: <span className="font-mono">{opp.diagnosisId}</span></p>
        <p>Anomalies: {opp.anomalyCount}</p>
      </div>
    </main>
  );
}
