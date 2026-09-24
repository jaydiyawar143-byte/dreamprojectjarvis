# JARVIS Skill System V1 — Discovery

> **DISCOVERY ONLY. NO CODE WAS WRITTEN.** Every claim below was read out of the
> repository on 2026-09-23 and is cited to a file. Sections marked **CURRENT**
> exist today; **PROPOSED** does not exist and is not built.
>
> Task Engine V2 (V2.1 / V2.2 / V2.3) is accepted and was not touched.
>
> **S3 note.** Skill-aware planning is built, on **Flow C**: skill context is
> composed into the message after agent selection, as prose, and the model's
> tool definitions are untouched. Two things this document only guessed at were
> settled by tracing the running code: there is no single "planner" — the MODEL
> plans the conversational path, and `TaskPlannerService` plans the task path —
> and `Orchestrator.buildToolSystemPrompt` / `validateToolPlan` /
> `parseToolPlan` are reached only by tests, so S3 was deliberately NOT built
> on them.
>
> **Superseded in part.** Phases S1 and S2 have since been implemented. Where
> this document says PROPOSED and the built thing differs, the built thing is
> authoritative: see [`JARVIS_SKILL_SYSTEM_V1.md`](./JARVIS_SKILL_SYSTEM_V1.md).
>
> Corrections this document needs, established by the S1 census and the S2
> membership audit against the real registry and allowlists:
>
> - The orphan set was never 5. It was 8 allowlisted tools, and 9 counting
>   `system.echo`. S2 resolved it: `google.accounts` / `google.campaigns` /
>   `google.insights` are now members of the advertising skill, and the rest are
>   recorded as intentional orphans in `SKILL_UNLISTED_TOOLS`.
> - `knowledge.search` is a **phantom**. Nothing in this build declares it; the
>   curated phrase gated on it could never render, and S2 removed it. Knowledge
>   retrieval is an orchestrator step, not a tool.
> - The advertising skill's `google.ads.` prefix came from confusing an
>   INTEGRATION ACTION id (`google.ads.accounts`, which carries its own
>   `toolId: "google.accounts"`) with a registry tool id. Two namespaces.
> - The `task.` / `tasks.` split is **deliberate**, not a typo: JARVIS's own
>   work queue versus the user's to-do list. Both tools say so themselves.
>
> Question 2 in §14 was answered: membership stays **code**. Question 3 was
> answered: the compile-time allowlist stays **absolute** — S2 changed no policy.

---

## 0. The headline finding

**There is no runtime `Skill` object — and the repository says so explicitly.**
`grep -rn "Skill\b"` across `apps/api/src` and `packages/*/src` returns **zero
identifiers**. [`docs/SKILLS.md`](../SKILLS.md) opens with:

> "JARVIS has no runtime object called a 'skill'. … Adding a capability means
> adding a tool, granting it to an agent, or — rarely — adding an agent. **It
> never means creating a `skills/` folder.**"

`AGENTS.md` carries the same prohibition. So a Skill System must be a **model
over** the existing tool + agent architecture, never a parallel loader.

**But a partial Skill System already exists, and it is better than expected.**
Three layers already do most of what Steps 1–12 ask for:

| Layer | File | What it already is |
|---|---|---|
| Derived capability truth | `capability-service.ts` | one capability per tool, with live availability |
| Capability vocabulary | `types/capability.ts` | 8-state availability, group, access, reason, requiredAction |
| **Outcome grouping** | `capability-presentation.ts` | **`CapabilityGoalGroup` — a proto-skill** |

`CapabilityGoalGroup` is the thing to build on. It is not named "skill", but it
is an outcome with a title, a summary, derived example phrasings and a live
count of the tools behind it. **Preserve and promote it; do not compete with
it.**

---

## 1. Current architecture map (CURRENT)

```
USER REQUEST
  │
  ├─ apps/web/src/app/chat            Next.js UI
  ▼
  apps/api/src/routes/chat.ts         HTTP → SessionContext; owns the
  │                                   pending-action + work-request branches
  ▼
  packages/agents/src/intent-detector.ts        CONFIRM/REJECT/MODIFY
  packages/agents/src/work-request-detector.ts  EXECUTE/SCHEDULE/PLAN_ONLY/
  │                                             NEEDS_TIME/NONE
  ▼
  packages/agents/src/orchestrator.ts  turn orchestration
  packages/agents/src/agent-router.ts  which domain agent answers
  ▼
  packages/agents/src/domain-agent.ts + agents/   the reasoning specialist
  │
  ▼
  packages/agents/src/tool-planner.ts  model proposes tool calls
  packages/agents/src/agent-policy.ts  AGENT_POLICIES — the ALLOWLIST
  ▼
  packages/tools/src/registry.ts       ToolRegistry (in-process, per boot)
  packages/tools/src/executor.ts       ToolExecutor — the ONLY side-effect path
  ▼
  packages/tools/src/tools/*.ts        BaseTool subclasses
  ▼
  packages/meta-graph | google-ads | google-workspace | whatsapp | n8n | browser
  ▼
  External system
```

| Layer | Package | Responsibility | In → Out | Persistence |
|---|---|---|---|---|
| Route | `apps/api` | HTTP ↔ session | request → JSON | `Conversation`, `Message` |
| Detectors | `packages/agents` | pure classification | string → union | none |
| Orchestrator / Router | `packages/agents` | pick the agent | context → agent | none |
| Agent | `packages/agents` | reason in a domain | context → tool calls | none |
| **Policy** | `packages/agents` | **allowlist per agent** | compile-time | **none — hard-coded** |
| Registry | `packages/tools` | hold `ITool` instances | boot-time `register()` | **none — in-process** |
| Executor | `packages/tools` | permission, approval, deadline, audit | request → result | **`AuditLog`** |
| Tool | `packages/tools` | one operation | params → `ToolResult` | via provider |
| Provider | `packages/*` | talk to the vendor | typed call → HTTP | provider-specific |

**Two facts that shape everything below:** the registry is **in-process and
rebuilt every boot**, and the policy is **compile-time**. Nothing about "what
JARVIS can do" is persisted anywhere.

---

## 2. Tool registry audit (CURRENT)

`ITool` ([`packages/core/src/types/tool.ts:104`](../../packages/core/src/types/tool.ts)):

```ts
id, name, description, category, risk, parameters,
requiresApproval, requiredPermissions, version, enabled,
execute(), validate()
```

- `ToolCategory` = `database | communication | marketing | research | file | integration | system`
- `RiskLevel` = `READ_ONLY | LOW_IMPACT | EXTERNAL_SIDE_EFFECT | HIGH_IMPACT | FINANCIAL`
- `ToolPermission` = `read | write | execute | admin`
- `ToolParameter` = `{ name, type, description, required, defaultValue }`

| Field a Skill System needs | Present? | Where it lives today |
|---|---|---|
| name / id | ✅ | `ITool.id`, `.name` |
| description | ✅ | `ITool.description` |
| category | ✅ | `ITool.category` (7 technical buckets) |
| **input schema** | ⚠️ **partial** | `ToolParameter[]` — `type` is a bare `string`, not JSON Schema or Zod |
| **output schema** | ❌ **missing** | `ToolResult` is untyped per tool |
| permissions | ✅ | `requiredPermissions` |
| **provider** | ❌ | not on the tool; known only by constructor injection |
| **integration** | ⚠️ **derived** | inferred from id prefix in `capability-catalog.ts` |
| side-effect class | ✅ | `RiskLevel` |
| **idempotency** | ⚠️ | only on `ToolExecution` for journal-aware tools; **not** on `ITool` |
| availability | ⚠️ **derived** | `CapabilityService`, not stored on the tool |
| auth requirement | ⚠️ **derived** | via integration state |
| required config | ⚠️ | in `INTEGRATION_CATALOG`, not on the tool |
| risk level | ✅ | `ITool.risk` |
| **timeout** | ⚠️ | executor-wide 30 s default; per-tool only via `request.timeoutMs` |
| **agent ownership** | ⚠️ **inverted** | agents list tools; tools don't know their agents |
| **related tools** | ❌ | nothing |
| **examples** | ❌ | nothing on the tool; `youCanAsk` is synthesised at answer time |

**Deliberate design, not an oversight:** `capability-catalog.ts` states that a
tool needs *no* entry to be visible — it is grouped by id prefix and labelled
from its own description, because "a lookup table that must be edited for a new
tool to be visible would reproduce exactly [the hand-written-list bug]".

**Consequence for skills:** tool→integration is currently a **string-prefix
convention** (`meta.`, `gmail.`, `maps.`). It works, and it is the single
weakest joint in the model.

---

## 3. Agent audit (CURRENT)

Live roster, from the API's own boot log:

| Agent | Domain | Tools | Explicit capability model? |
|---|---|---|---|
| `conversational-assistant` | general | 73 | **Yes** — `description` + explicit `allowedTools` |
| `meta-ads-agent` | meta-ads | 27 | Yes |
| `analytics-agent` | analytics | 22 | Yes |
| `location-agent` | location | 20 | Yes |
| `knowledge-agent` | knowledge | 5 | Yes |

Each policy in [`agent-policy.ts`](../../packages/agents/src/agent-policy.ts)
carries `domain`, `description` and `allowedTools`, composed from named groups
(`META_READ_TOOLS`, `CAPABILITY_TOOLS`, `SELF_TOOLS`, …). Descriptions are
real, e.g. *"Meta Ads domain expert: read, analyze, recommend, propose
approval-gated writes"*.

- **Explicit, not implicit.** The allowlist is data, frozen with `Object.freeze`.
- **Hard-coded, not persisted.** Compile-time only.
- **Agents ≈ domains, not outcomes.** `meta-ads-agent` owns *a subject area*;
  it is not "pause a campaign".

> **FINDING — a vestigial persistence layer.** `model Agent` exists in Prisma
> with `name, description, category, status, config, tools Json`. The **only**
> code that touches it is `packages/db/src/seed.ts`. Nothing reads it. It is
> already roughly Skill-shaped and already disagrees with the runtime roster.
> Reusing it without reconciling that drift would inherit the bug.

---

## 4. Existing self-knowledge (CURRENT)

| Question | Answer |
|---|---|
| Where does capability info come from? | **Derived at request time** from three live sources: `toolRegistry.getAll()`, `allowedToolIds` (the policy union), and `integrations.listIntegrations(userId)` |
| Static or dynamic? | **Dynamic**, per user, per request |
| Knows availability? | **Yes** — 8 states: `EXECUTABLE`, `REQUIRES_CONFIRMATION`, `NOT_CONNECTED`, `PERMISSION_MISSING`, `NOT_CONFIGURED`, `NEEDS_REAUTH`, `DISABLED`, `PLANNED` |
| Knows dependencies? | **Partially** — the gating integration and Google sub-scope; not tool→tool |
| Knows newly added tools? | **Yes, automatically** — registry-driven, no catalogue edit needed |
| Knows newly added integrations? | **Yes** via `INTEGRATION_CATALOG` + live state |
| Persists learned knowledge? | **No. Nothing is persisted.** Recomputed every time |

Surfaces: `self.describe`, `capabilities.list`, `capabilities.connected`,
`capabilities.integration`, `capabilities.permissions` (tools), plus
`apps/api/src/routes/capabilities.ts` (REST).

**The raw-dump fix is real and is the proto-skill.**
[`capability-presentation.ts`](../../packages/core/src/capability-presentation.ts)
documents the original bug — the model was handed four flat arrays and read out
34 bullet points including raw ids like `integration.list` — and replaces it
with `buildCapabilityBriefing()` producing:

```ts
CapabilityGoalGroup { id, title, summary, youCanAsk[], capabilityCount, approvalCount }
CapabilityBriefing  { intro, groups[], examples[], approvalNote }
```

`GOAL_GROUPS` maps id prefixes to outcomes (e.g. `advertising` ← `meta.`,
`google.ads.`, `adwords.`). **This is a Skill in everything but name, lifetime
and addressability.**

---

## 5. MCP findings (CURRENT)

**MCP does not exist in this repository.** No `modelcontextprotocol` dependency,
no `mcp` source file, no client, no server, no transport, no registration path.

Consequences: there is no native/MCP tool distinction to preserve, and no
existing security boundary to honour. Any future MCP tool would have to enter
`ToolRegistry` and pass through `ToolExecutor` like everything else — which is
the right shape, but **it would arrive with no agent policy granting it**, and
`CapabilityService` skips any tool no policy allows. **A dynamically discovered
tool would therefore be invisible and unreachable until an allowlist changed —
and allowlists are compile-time.** That is the single hardest blocker for
dynamic capability sources, and it is a *policy* problem, not an MCP problem.

---

## 6. Database findings (CURRENT)

27 Prisma models. Relevant ones:

| Model | Could represent | Verdict |
|---|---|---|
| `Agent` | skill/agent definition | **Vestigial** — seeded, never read (§3) |
| `Integration` | integration state | **Reuse as-is** — live, already drives availability |
| `ToolExecution` | execution history | **Reuse, but not universal** — journal-aware tools only |
| `AuditLog` | execution evidence | **Reuse** — universal; `action:"tool.execute"`, `metadata.executionId` |
| `Memory`, `KnowledgeDocument/Chunk` | learned knowledge | Different domain (user documents), not skill knowledge |
| `N8nWorkflow`, `N8nExecution` | workflow | **External** workflows in n8n, not JARVIS-defined |
| `Task` | a unit of work | **Reuse** — Task Engine V2; a skill run should become a Task |

**No model represents a skill, a capability, tool metadata, or a JARVIS-defined
workflow.** No schema change is proposed in this phase.

---

## 7. Concept distinctions — verified against the code

| Concept | Definition | Exists today? | Where |
|---|---|---|---|
| **TOOL** | "What single operation can I execute?" | ✅ **First-class** | `ITool`, `ToolRegistry` |
| **CAPABILITY** | "What can I accomplish?" | ⚠️ **Exists, but = one tool** | `CapabilityView` is per tool id |
| **SKILL** | "What outcome can I provide, using one or more tools?" | ⚠️ **Proto only** | `CapabilityGoalGroup` — presentation-time, not addressable |
| **AGENT** | "How do I reason about this domain?" | ✅ **First-class** | `AGENT_POLICIES`, `DomainAgent` |
| **INTEGRATION** | "Which external system am I connected to?" | ✅ **First-class** | `INTEGRATION_CATALOG`, `Integration` model |
| **PROVIDER** | "Which implementation performs the call?" | ✅ **Exists, unnamed** | `packages/meta-graph`, `google-ads`, … — injected, never declared on the tool |
| **WORKFLOW** | "Which sequence produces the outcome?" | ⚠️ **Two partials** | `ToolStep[]`/`dependsOn` in `tool-planner`; `N8nWorkflow` is *external* |

### Where the repository conflates them

1. **CAPABILITY ≡ TOOL.** `CapabilityView.id` is "the registry tool id where one
   exists". So "capability" currently means "one callable operation", not "an
   outcome". This is *the* gap a Skill fills.
2. **SKILL ≡ AGENT + ALLOWLIST.** `SKILLS.md` says so outright. But an agent is
   a *domain*, and a skill is an *outcome*; `meta-ads-agent` holds many skills.
3. **PROVIDER is invisible to the model.** A tool never declares its provider;
   it is closed over in the constructor. Tool→integration is recovered by
   **string-prefix matching**.
4. **WORKFLOW is split.** The planner can express dependencies (`dependsOn`) but
   Task Planner V1 deliberately emits **exactly one** action; multi-step is
   unbuilt. `N8nWorkflow` is someone else's workflow engine.

---

## 8. Gap analysis

### Already exists — reuse directly

- `ToolRegistry` + `ITool` — the operation layer. **Do not duplicate.**
- `ToolExecutor` — permission, approval, shutdown gate, deadline, audit. **The only execution path.**
- `AGENT_POLICIES` — the allowlist and the reachability truth.
- `CapabilityService` — derived availability across 8 states, per user.
- `INTEGRATION_CATALOG` + `Integration` — connection state and required config.
- `AuditLog` — universal execution evidence (`metadata.executionId`).
- Task Engine V2 — durable claim, recovery, `UNRESOLVED`. **A skill run should become a Task.**

### Partially exists — adapt

- **`CapabilityGoalGroup` → the Skill.** Promote from presentation artifact to
  addressable model. It already has title, summary, `youCanAsk`, counts.
- **`GOAL_GROUPS` prefix map → skill membership.** Replace prefix matching with
  declared tool membership.
- **`ToolStep` / `dependsOn` → execution strategy.** The vocabulary for a
  multi-tool skill exists in `tool-planner.ts`; nothing emits it yet.
- **`model Agent`** — Skill-shaped and dead. Reconcile or ignore; do not
  silently adopt.

### Missing — genuinely new

1. A **Skill identity** — stable id, addressable, versioned.
2. **Declared tool membership** (skill → tools), replacing prefix inference.
3. **Declared provider/integration on the tool**, replacing prefix inference.
4. **Output schemas**, so one tool's result can feed another.
5. **Skill-level availability** — derived from the *weakest* member tool.
6. **Prerequisites** beyond the gating integration.
7. **Persistence** for anything learned.
8. **Multi-step execution** — Task Planner V1 emits one action by design.

### Should NOT be built

- ❌ A `skills/` folder or loader — forbidden by `SKILLS.md` and `AGENTS.md`.
- ❌ A second execution engine. **Skill → Planner/Agent → ToolExecutor → Tool.**
- ❌ A second capability deriver. Extend `CapabilityService`.
- ❌ A second tool registry, or MCP tools bypassing `ToolExecutor`.
- ❌ A JARVIS workflow engine competing with n8n.
- ❌ A hand-written feature list. The bug `capability-presentation.ts` fixed.

---

## 9. PROPOSED minimum Skill model

Derived from what the repository can actually supply today. Fields with no
repository evidence are deliberately excluded.

```
Skill
  id              stable slug, e.g. "meta-ads.campaign-management"
  title           user-facing outcome        ← CapabilityGoalGroup.title
  summary         one sentence               ← CapabilityGoalGroup.summary
  toolIds         DECLARED membership        ← replaces GOAL_GROUPS.prefixes
  integration     gating integration id|null ← INTEGRATION_CATALOG
  agentId         which domain agent reasons ← AGENT_POLICIES
  examples        derived phrasings          ← CapabilityGoalGroup.youCanAsk
```

**Derived at read time, never stored:**

```
  availability    weakest member tool's CapabilityAvailability
  requiresApproval  any member tool requiresApproval
  reason / requiredAction  ← CapabilityService
```

**Deliberately excluded from V1:** `version`, `enabled`, `confidence`,
`successRate`, `source`, `prerequisites` beyond the integration. None has a
source of truth in the repository yet; adding them now would be inventing data.

**The execution rule, non-negotiable:**

```
Skill  →  Planner / Agent  →  ToolExecutor  →  Tool
```

A Skill **selects and explains**; it never executes.

---

## 10. PROPOSED skill discovery flow

> *"Can you manage my Meta Ads?"*

```
1. detect a capability question (intent-detector, exists)
2. CapabilityService.report(userId)                       (exists)
3. match the request against skill titles/examples        (NEW — matching only)
4. resolve the skill's declared toolIds → CapabilityViews (NEW — a join)
5. availability = weakest member                           (NEW — a fold)
6. answer from facts, never from a prompt claim
```

Yielding, entirely from live state:

```
Skill          Meta Ads Management
Integration    meta — CONNECTED
Tools          meta.campaigns.list, meta.insights, meta.campaign.pause …
Availability   EXECUTABLE (2 tools REQUIRE_CONFIRMATION)
Missing        none
```

Step 6 is the whole point, and it is the lesson
`capability-presentation.ts` already learned: **a prompt cannot know what is
registered, connected or permitted.**

---

## 11. Future self-learning compatibility

| Future capability | Compatible? | Blocker |
|---|---|---|
| Discover newly added tools | ✅ | none — registry-driven already |
| Discover MCP tools | ⚠️ | **compile-time allowlist** (§5), not MCP itself |
| Detect new integrations | ✅ | `INTEGRATION_CATALOG` + live state |
| Learn successful combinations | ❌ | no persistence; `AuditLog` has per-execution rows but no skill correlation |
| Learn failed approaches | ⚠️ | `AuditLog` has results; nothing aggregates them |
| Skill confidence | ❌ | no store |
| Versioning | ❌ | no store |
| Skill health | ⚠️ | derivable *now* from member availability |
| Deprecation | ❌ | no store |
| Recommendations | ❌ | needs confidence first |

**The single structural blocker for learning is that nothing about capability is
persisted.** Everything is recomputed per request — which is exactly why the
current answer is always true, and exactly why it cannot improve.

**The single structural blocker for dynamic tools is the compile-time
allowlist**, which is a deliberate security property (a tool no policy grants is
unreachable), not an accident. Loosening it is a security decision, not a
refactor.

---

## 12. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Skills become a second execution engine | Enforce Skill → Planner → ToolExecutor; no `execute()` on a Skill |
| R2 | A hand-written skill list drifts from reality | Membership declared, **availability always derived** |
| R3 | Prefix-based membership breaks on a renamed tool | Declare `toolIds`; fail loudly on an unknown id |
| R4 | Competing with `CapabilityGoalGroup` | **Promote it**, don't parallel it |
| R5 | Adopting `model Agent` inherits its drift | Reconcile with `AGENT_POLICIES` first, or leave it |
| R6 | Dynamic tools silently unreachable | Treat the allowlist as an explicit design decision |
| R7 | Skills become a `skills/` folder | Forbidden — `SKILLS.md`, `AGENTS.md` |
| R8 | Persisted skills contradict the running build | Persist only *learned* facts; derive structure |

---

## 13. Recommended implementation phases (PROPOSED)

| Phase | Scope | Schema? |
|---|---|---|
| **S1** | Declare tool→integration and tool→provider **on the tool**, replacing prefix inference. Pure metadata. | no |
| **S2** | Promote `CapabilityGoalGroup` into an addressable `Skill` with declared `toolIds`; availability folded from members. | no |
| **S3** | Skill discovery: match a request to a skill; answer from derived facts. | no |
| **S4** | Skill explanation: *"I can do X because I have skill Y using tools A/B/C"* and the inverse for missing capability. | no |
| **S5** | Skill execution: a skill run **becomes a Task** and goes through the existing planner + executor. | no |
| **S6** | Multi-step skills using `ToolStep`/`dependsOn`. Needs **output schemas** (S1'). | no |
| **S7** | Persistence + learning: skill outcome correlation over `AuditLog`. | **yes** |
| **S8** | Dynamic sources (MCP). Needs the allowlist decision first. | likely |

S1–S4 need **no schema change and no new execution path** — they are metadata,
a fold, and a join over things that already exist.

---

## 14. Open questions for you

1. **Is a Skill user-visible or internal?** Changes whether it needs a UI and a
   stable public id.
2. **Who declares skill membership** — code, like `AGENT_POLICIES`, or data?
   Code preserves the compile-time security property; data enables learning.
3. **Should the compile-time allowlist stay absolute?** It is the blocker for
   every dynamic source, and it is a genuine security boundary.
4. **Reconcile or retire `model Agent`?** It is dead and Skill-shaped.
5. **Is multi-step in scope?** Task Planner V1 emits one action *deliberately*;
   changing that reopens decisions V1 settled.

---

## Appendix — files inspected

```
packages/core/src/types/capability.ts          packages/core/src/capability-catalog.ts
packages/core/src/capability-presentation.ts   packages/core/src/types/tool.ts
packages/core/src/integration-catalog.ts       packages/core/src/types/task.ts
packages/agents/src/agent-policy.ts            packages/agents/src/  (15 modules)
packages/tools/src/registry.ts                 packages/tools/src/executor.ts
packages/tools/src/tools/capability-tools.ts   packages/tools/src/tools/n8n-tools.ts
packages/db/prisma/schema.prisma (27 models)   packages/db/src/seed.ts
packages/db/src/repositories/audit-repository.ts
apps/api/src/services/capabilities/capability-service.ts
apps/api/src/routes/capabilities.ts            apps/api/src/routes/chat.ts
apps/api/src/services/self-knowledge/self-knowledge-service.ts
docs/SKILLS.md                                 AGENTS.md
```

Live evidence: the API boot log's `agent_registration` line (5 agents, tool
counts) and the running Postgres schema.
