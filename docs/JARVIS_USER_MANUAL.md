# JARVIS

## AI-Powered Marketing Intelligence & Controlled Automation System

---

### What is JARVIS?

JARVIS is a personal AI operating system for digital marketers and team leaders. It combines conversational AI, marketing data analysis, performance diagnosis, optimization recommendations, controlled execution, and outcome measurement into a single integrated platform.

JARVIS connects to your Meta (Facebook/Instagram) advertising accounts, ingests performance data, calculates marketing KPIs, detects anomalies, diagnoses causes, recommends actions, and — with your explicit approval — executes changes on your behalf.

JARVIS is **not** an autonomous ad optimizer. It is a human-in-the-loop intelligence system. Every execution requires your approval. Every outcome is measured and recorded as evidence for future decisions.

### What problem does JARVIS solve?

Digital marketers face a recurring cycle:

1. **Data overload.** Campaign data spans dozens of metrics across multiple accounts, campaigns, ad sets, and ads. Manually scanning this data is slow and error-prone.

2. **Diagnosis gaps.** When performance degrades (rising CPA, falling CTR), the root cause is rarely obvious. Marketers spend hours cross-referencing data to understand *why*.

3. **Decision delay.** Even when a diagnosis exists, translating it into a specific, safe action takes time. Which campaign? Which metric threshold? What budget change? What are the risks?

4. **No feedback loop.** After taking action, marketers rarely measure whether it actually worked. The same mistakes repeat. Institutional knowledge is lost.

5. **Execution risk.** Making changes to live advertising campaigns carries real financial risk. A wrong pause, an oversized budget increase, or a duplicate action can waste money.

JARVIS addresses each of these problems systematically.

### Why existing marketing workflows are insufficient?

Most marketers rely on:

- **Dashboards** (Meta Ads Manager, Google Analytics) that show data but do not diagnose or recommend.
- **Manual analysis** that is slow, subjective, and does not scale.
- **Third-party tools** that may automate bidding but offer no transparency, no safety controls, and no outcome measurement.
- **Gut instinct** that is inconsistent and not backed by evidence.

None of these provide the complete loop: observe → understand → diagnose → recommend → approve → execute → measure → learn.

### How JARVIS solves the problem

JARVIS implements an integrated intelligence pipeline:

1. **Observe** — Ingests performance data from Meta advertising accounts.
2. **Understand** — Normalizes raw metrics into standard marketing KPIs (CTR, CPC, CPM, CPA, ROAS, CVR, Frequency).
3. **Diagnose** — Detects statistical anomalies and uses AI to analyze possible causes with evidence-backed reasoning.
4. **Recommend** — Generates specific, actionable recommendations with confidence levels and risk assessments.
5. **Approve** — Routes every recommendation through a human approval gate. No action executes without your consent.
6. **Execute** — Carries out approved actions through the Meta Graph API with idempotency, timeout protection, and crash recovery.
7. **Measure** — After execution, measures whether the action actually produced the expected result.
8. **Learn** — Records outcomes as historical evidence that improves future diagnosis, recommendations, and confidence scores.

### JARVIS philosophy

JARVIS is built on several non-negotiable principles:

- **AI is not an unquestionable authority.** JARVIS uses AI (large language models) for diagnosis — generating hypotheses about what might be causing observed anomalies. But every hypothesis is labeled as inference, not fact. Facts (measured data) are always separated from inference (AI reasoning).

- **Facts are separated from inference.** When JARVIS says "CPA increased by 23%," that is a fact derived from measured data. When it says "this is likely caused by audience saturation," that is an inference that should be evaluated, not blindly trusted.

- **Recommendations are separated from execution.** JARVIS may recommend "Pause campaign X." But recommendation and execution are distinct steps. The recommendation carries a confidence level. The execution carries safety controls. They are never merged.

- **Execution requires safety controls.** Every execution is: (a) approved by a human, (b) bound to specific parameters via a cryptographic hash, (c) recorded in a durable execution journal, (d) protected against duplicate execution, (e) monitored for timeout and crash recovery, and (f) reconciled against the actual Meta platform state.

- **Outcomes are measured after actions.** JARVIS does not assume an action worked. After execution, it measures the relevant metrics over a defined window and classifies the outcome as positive, negative, neutral, inconclusive, or not measurable.

- **Historical outcomes are evidence, not guarantees.** JARVIS records every measured outcome. When similar situations arise in the future, historical outcomes serve as evidence to inform confidence. But past results never guarantee future performance.

- **Autonomous optimization is not assumed.** JARVIS does not automatically optimize your campaigns. Every change requires your explicit approval. The system is designed to assist your decision-making, not replace it.

---

## How to Use JARVIS

JARVIS is accessed through a conversational interface (chat). You ask questions in natural language, and JARVIS responds with data, analysis, recommendations, and — when you choose — executes actions on your behalf.

### Getting Started

**Prerequisites:**
- A JARVIS account (created by your administrator)
- A connected Meta advertising account with valid access tokens
- A modern web browser

**Basic interaction:**
1. Log in to the JARVIS web interface.
2. Start a conversation.
3. Ask questions about your advertising performance.

### Example Conversations

#### Example 1: "Why is my CPA increasing?"

**What you ask:**
> "Why is my CPA increasing?"

**What JARVIS does:**
1. Reads your Meta performance data for the relevant accounts and time windows.
2. Calculates CPA (Cost Per Acquisition) by comparing total spend to total conversions.
3. Compares the current period to the previous period.
4. Detects the anomaly: CPA increased by 23%, which crosses the statistical significance threshold.
5. Analyzes contributing factors: which campaigns, ad sets, or ads are driving the increase.
6. Generates a diagnosis with evidence-backed reasoning.
7. Presents the findings with clear separation between facts and inferences.

**What you see:**
```
FACT: Your account-level CPA increased from $42.18 to $51.88 (+23.0%)
      over the last 7 days compared to the previous 7 days.

FACT: Campaign "Spring Sale" accounts for 68% of the CPA increase.
      Its CPA rose from $35.20 to $58.40.

INFERENCE: The CPA increase coincides with a 34% rise in frequency
           (1.2 → 1.6), suggesting potential audience saturation.

RECOMMENDATION: Consider pausing "Spring Sale" or reducing its budget.
                Confidence: MEDIUM
                Historical evidence: 3 similar patterns, 2 resolved
                positively when budget was reduced.
```

**Permissions required:** Meta READ access
**Approval required:** No (analysis only)
**Meta WRITE occurs:** No

---

#### Example 2: "Which ad should I investigate first?"

**What you ask:**
> "Which ad should I investigate first?"

**What JARVIS does:**
1. Scans all active ads across your connected accounts.
2. Calculates anomaly scores for each ad's key metrics.
3. Runs diagnosis on the top anomalies.
4. Generates recommendations for the most actionable items.
5. Scores each opportunity by business importance.
6. Ranks them by priority.

**What you see:**
```
PRIORITY 1 — CRITICAL
Campaign: "Summer Promo" | Ad: "Video Ad - Variant B"
Metric: CTR dropped 41% (0.82% → 0.48%)
Diagnosis: Creative fatigue — ad has been shown 2.3M times with
           declining engagement over 12 days.
Recommendation: Pause this ad and test a new creative variant.
Confidence: HIGH (5 historical examples with similar patterns)

PRIORITY 2 — HIGH
Campaign: "Brand Awareness" | Ad: "Carousel - Collection"
Metric: CPA increased 28% ($38 → $49)
Diagnosis: Audience overlap with "Retargeting" campaign.
Recommendation: Adjust audience exclusions.
Confidence: MEDIUM (2 historical examples, mixed results)

PRIORITY 3 — MEDIUM
Campaign: "Lead Gen" | Ad: "Form Ad - Primary"
Metric: Conversions dropped 15%
Diagnosis: Landing page bounce rate increased (inferred from
           click-through to conversion gap).
Recommendation: Review landing page experience.
Confidence: LOW (no direct landing page data available)
```

**Permissions required:** Meta READ access
**Approval required:** No (analysis only)
**Meta WRITE occurs:** No

---

#### Example 3: "Did the last recommendation actually work?"

**What you ask:**
> "Did the last recommendation actually work?"

**What JARVIS does:**
1. Retrieves the most recent executed recommendation.
2. Loads the baseline metrics captured at execution time.
3. Measures post-action metrics over the defined measurement window.
4. Classifies the outcome.

**What you see:**
```
RECOMMENDATION: Pause "Spring Sale" campaign
EXECUTED: 2026-08-20 14:32 UTC
APPROVED BY: You

BASELINE (at execution):
  CPA: $58.40 | CTR: 0.48% | Spend/day: $320

POST-ACTION (7-day measurement window):
  CPA: $41.20 (-29.5%) | CTR: 0.71% (+47.9%) | Spend/day: $0 (paused)

OUTCOME: POSITIVE
Confidence: HIGH
Primary metric: CPA (lower is better)
Direction: Met threshold (29.5% improvement ≥ 5% materiality)

NOTES: Spend redirected to "Retargeting" campaign which shows
       improved performance. Total account spend unchanged.
```

**Permissions required:** None (internal data)
**Approval required:** No (measurement only)
**Meta WRITE occurs:** No

---

#### Example 4: "Execute this recommendation"

**What you ask:**
> "Execute this recommendation" (after reviewing a specific recommendation)

**What JARVIS does:**
1. Presents the recommendation details for final review.
2. Requests your explicit approval.
3. On approval, creates a durable execution record.
4. Executes the action via the Meta Graph API.
5. Verifies the result.
6. Records the outcome for future measurement.

**What you see:**
```
RECOMMENDATION TO EXECUTE:
  Action: Pause Campaign
  Target: "Spring Sale" (campaign ID: 120234567890)
  Risk: LOW (can be resumed at any time)
  Idempotency: Already paused? Will be a no-op.

APPROVAL REQUIRED
  Parameter hash: a3f2b8c1...
  This approval is bound to EXACTLY this action on this campaign.
  It cannot be reused for any other action.

[Approve] [Reject] [View Details]
```

After approval:
```
EXECUTION STATUS:
  Approved: ✓
  Executed: ✓ (Meta API returned success)
  Verified: ✓ (Campaign status confirmed PAUSED)
  Approval consumed: ✓ (Cannot be reused)
  Outcome measurement scheduled: ✓
```

**Permissions required:** Meta READ + Meta WRITE access
**Approval required:** Yes (explicit human approval)
**Meta WRITE occurs:** Yes (single targeted write)

---

#### Example 5: "Analyze my account"

**What you ask:**
> "Analyze my account"

**What JARVIS does:**
1. Ingests recent performance data from the connected Meta account.
2. Calculates all canonical KPIs.
3. Compares to the previous period.
4. Detects anomalies.
5. Provides a summary.

**What you see:**
```
ACCOUNT ANALYSIS — Last 7 days vs Previous 7 days

SPEND:        $4,280  (was $3,950)  +8.4%
IMPRESSIONS:  892,000 (was 845,000) +5.6%
CLICKS:       12,340  (was 11,800)  +4.6%
CTR:          1.38%   (was 1.40%)   -1.4%
CPC:          $0.347  (was $0.335)  +3.6%
CPM:          $4.80   (was $4.67)   +2.8%
CONVERSIONS:  412     (was 398)     +3.5%
CPA:          $10.39  (was $9.92)   +4.7%
ROAS:         3.21    (was 3.38)    -5.0%

ANOMALIES DETECTED: 2
  1. CPA increased beyond warning threshold (+4.7%, z-score: 2.1)
  2. ROAS decreased beyond warning threshold (-5.0%, z-score: 2.3)

OVERALL QUALITY: COMPLETE (all expected records present)
```

**Permissions required:** Meta READ access
**Approval required:** No (analysis only)
**Meta WRITE occurs:** No

---

### Understanding JARVIS Responses

JARVIS clearly labels its responses:

| Label | Meaning |
|-------|---------|
| **FACT** | Derived directly from measured data. Verified against source. |
| **INFERENCE** | Generated by AI analysis. Reasonable but not proven. |
| **HYPOTHESIS** | Possible explanation with supporting evidence. May be wrong. |
| **RECOMMENDATION** | Suggested action with confidence level and risk assessment. |
| **CONFIDENCE** | How certain JARVIS is about the recommendation (LOW/MEDIUM/HIGH). |
| **EVIDENCE** | Specific data points or historical outcomes supporting the analysis. |

### What JARVIS Cannot Currently Do

- **Autonomous optimization.** JARVIS will never change your campaigns without your explicit approval.
- **Guarantee business outcomes.** JARVIS can measure whether past actions worked, but cannot guarantee future results.
- **Make causal claims from historical data.** Historical correlations inform confidence but are not proof of causation.
- **Replace marketing expertise.** JARVIS augments your judgment with data and analysis. It does not replace your domain knowledge.
- **A/B test automatically.** Controlled experimentation is planned for a future phase.
- **Manage multiple ad platforms.** Currently Meta (Facebook/Instagram) is the only supported advertising platform.
- **Access landing page or website data.** JARVIS works with Meta advertising metrics only. Website analytics are not integrated.

---

## Safety & Security

### Approval System

Every action that modifies your advertising campaigns requires explicit human approval:

- **One-time use.** Once an approval is consumed (used for an execution), it cannot be reused.
- **Parameter-bound.** An approval for "Increase budget to $500" cannot be used to authorize "Increase budget to $5,000."
- **Time-limited.** Approvals expire after a defined window. Expired approvals are rejected.
- **Account-isolated.** An approval for Account A cannot be applied to Account B.
- **User-isolated.** Only the user who granted the approval can use it.

### Execution Journal

Every execution is recorded in a durable journal:

- **Idempotent.** Duplicate executions are prevented. If you accidentally approve the same action twice, only the first will execute.
- **Lease-based.** Only one process can execute a given action at a time, preventing race conditions.
- **Crash-recoverable.** If a process crashes mid-execution, the system detects the stale execution and safely recovers it.
- **Timeout-protected.** If a Meta API call takes too long, the system cancels the request rather than risking duplicate execution.

### Secret Protection

- API keys, tokens, and passwords are never logged, included in error messages, or stored in plaintext.
- Error messages are automatically redacted to remove sensitive patterns (API keys, tokens, JWTs).
- Meta access tokens are redacted in all diagnostic output.

### What JARVIS Does NOT Do

- JARVIS never retries an action with an UNKNOWN outcome automatically.
- JARVIS never sends the same write request again if the previous response was lost (timeout after potential transmission).
- JARVIS never executes against accounts or campaigns you have not authorized.
- JARVIS never bypasses the approval system for write operations.
- JARVIS never stores or transmits secrets in plaintext.

---

## Architecture Overview

For detailed technical architecture, see [JARVIS Architecture Document](./JARVIS_ARCHITECTURE.md).

For the capability matrix, see [JARVIS Capability Matrix](./JARVIS_CAPABILITY_MATRIX.md).

For phase-by-phase history, see the [Phase Documents](./phases/).

For system diagrams, see [Diagrams](./diagrams/).

---

## Glossary

| Term | Definition |
|------|-----------|
| **KPI** | Key Performance Indicator — standardized marketing metric (CTR, CPC, CPA, etc.) |
| **Anomaly** | A metric value that deviates significantly from its statistical baseline |
| **Diagnosis** | AI-generated analysis of possible causes for an observed anomaly |
| **Recommendation** | A specific, actionable suggestion to address a diagnosed issue |
| **Confidence** | How certain the system is about a recommendation (LOW/MEDIUM/HIGH) |
| **Priority** | The relative business importance of a recommendation (CRITICAL/HIGH/MEDIUM/LOW/IGNORE) |
| **paramsHash** | Cryptographic hash binding an approval to exact execution parameters |
| **stateHash** | Hash of an external entity's state at the time of recommendation |
| **Execution Journal** | Durable record of every execution attempt and its outcome |
| **Outcome** | Measured result of a completed action, compared to baseline |
| **Historical Evidence** | Past outcomes used to inform future confidence and recommendations |
| **Opportunity Score** | Deterministic ranking of recommendations by business importance |
| **Reconciliation** | Verifying execution result against the actual Meta platform state |
| **Measurement Window** | The period after execution during which outcomes are measured |

---

*Document version: 1.0*
*Last updated: 2026-08-25*
