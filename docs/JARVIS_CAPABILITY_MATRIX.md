# JARVIS Capability Matrix

What JARVIS can actually do, as of the code in this repository. Verified against the source on 2026-10-05, at commit `68628c0`.

Nothing is listed as implemented without a code path behind it. Where a capability is limited, the limit is written down rather than softened. Capabilities are described the way a person would ask for them; the internal tool identifiers live in [SKILLS.md](./SKILLS.md), which is the companion document for developers.

**Sources:** `packages/agents/src/agent-policy.ts` (who may call what, and what scheduled work may run), `apps/api/src/services/container.ts` (what is actually registered at startup, and on which condition), `apps/api/src/index.ts` (which routes mount), `packages/core/src/mcp-manifest.ts` (the reviewed MCP servers), `packages/core/src/capability-catalog.ts` (the user-facing wording), the test files named in the **Tested** column, and the risk register in [JARVIS_MASTER_AUDIT_AND_DEVELOPMENT_LEDGER.md](./JARVIS_MASTER_AUDIT_AND_DEVELOPMENT_LEDGER.md).

---

## How to read this matrix

| Status | Meaning |
|---|---|
| **Implemented** | Wired into the running system and reachable by a user today |
| **Partially implemented** | Present and working, with a stated limit |
| **Approval required** | Implemented, but every run stops for a human decision before anything outside JARVIS changes |
| **Not connected** | The code ships and registers itself only when the matching credentials or an explicit opt-in exist. Without them the capability is absent, and JARVIS says so instead of guessing |
| **Planned / not implemented** | Not in this repository |

"Approval required" is not a weaker form of implemented. It is the design: the allowlist decides who may *propose* an action, and the approval gate decides whether it *runs*.

| Column | Meaning |
|---|---|
| **Execution Path** | How a request reaches the outside world. Every tool call — from chat, from a dashboard button or from a scheduled task — runs through the one `ToolExecutor` |
| **Approval** | What has to happen before it runs. "None" means read-only |
| **Agent Scope** | Which agents' allowlists hold it: GA = `conversational-assistant`, Meta = `meta-ads-agent`, Analytics, Knowledge, Google Ads, Automation, Communication, Browser, Location. "All" means every agent |
| **Tested** | Representative test files, by name. Not an exhaustive list |

---

## Conversation and agents

| Capability | Status | Execution Path | Approval | Agent Scope | Tested |
|---|---|---|---|---|---|
| Conversational assistant | Implemented | chat route → orchestrator → GA; every request no domain owns lands here | — | GA | `sprint6-orchestration`, `capability-routing-e2e` |
| Meta Ads specialist | Implemented | registers always; its Meta tools exist only with Meta credentials | writes: approval | Meta | `meta-ads-agent`, `sprint6-specialized-agents` |
| Analytics specialist | Implemented | read-only agent; no write tool in its allowlist | None | Analytics | `sprint6-specialized-agents`, `meta-analytics-chat-access` |
| Knowledge specialist | Implemented | the orchestrator retrieves passages before the agent runs; the agent holds no search tool | None | Knowledge | `orchestrator-knowledge-rag` |
| Google Ads specialist | Not connected | registers only when `google.accounts` is registered | writes: approval | Google Ads | `sprint6-agent-wiring` |
| Automation specialist | Not connected | registers only when `n8n.trigger` is registered | approval | Automation | `sprint6-agent-wiring`, `n8n-tools` |
| Messaging specialist | Not connected | registers only when `whatsapp.send` is registered | approval | Communication | `sprint6-agent-wiring`, `whatsapp-tools` |
| Browser specialist | Not connected | registers only when browsing is switched on and a Chrome exists | actions: approval | Browser | `sprint7-browser-agent` |
| Location specialist | Implemented | the maps tools register unconditionally, so this agent is effectively always present | None | Location | `v3-google-maps` |
| Write-intent gate | Implemented | orchestrator, in front of every non-read-only tool call in the chat path: a write the user did not ask for is refused, never executed, and audited | — | All | `write-intent-gate`, `orchestrator-write-intent` |

Nine agents in total. When an agent is not registered, the request falls through to the general assistant rather than failing silently. One agent runs per request: a request that needs two agents' tools ("check my ads and WhatsApp me the summary") is not possible.

---

## Advertising — Meta and Google Ads

| Capability | Status | Execution Path | Approval | Agent Scope | Tested |
|---|---|---|---|---|---|
| Read Meta ad accounts, campaigns, ad sets, ads | Not connected | `meta.*` tools → `ToolExecutor` → `meta-graph`; registered only with `META_ACCESS_TOKEN` and `META_AD_ACCOUNT_ID` | None | GA, Meta, Analytics | `meta-ads`, `container-wiring-meta-tools` |
| Read Meta performance insights | Not connected | as above | None | GA, Meta, Analytics | `meta-insights-date-range` |
| Pause or resume a Meta campaign, ad set or ad | Approval required | approval row → `ToolExecutor` claims the journal and consumes the approval atomically → Meta | approval | GA, Meta | `meta-ads-write`, `approval-flow-regression` |
| Change a Meta campaign or ad set budget | Approval required | as above; bounded by a maximum value and caps on how far one change may move it | approval | GA, Meta | `meta-ads-budget` |
| Create a Meta campaign | Approval required | as above. Verified against mocks only; not exercised against a live account | approval | GA, Meta | `meta-ads-campaign` |
| Read Google Ads accounts, campaigns and insights | Not connected | `google.*` tools → `google-ads`; registered only when Google is configured **and** `JARVIS_ENCRYPTION_KEY` is set. The live grant lacks the `adwords` scope — ledger R-6 | None | GA, Google Ads, Analytics | `google-ads-tools` |
| Change anything in Google Ads | Planned / not implemented | No Google Ads write tool exists | — | — | — |
| Advertising beyond Meta and Google | Planned / not implemented | | — | — | — |

---

## Marketing intelligence pipeline

| Capability | Status | Execution Path | Approval | Agent Scope | Tested |
|---|---|---|---|---|---|
| KPI calculation, aggregation, anomaly detection | Implemented | pure engines in `packages/core` | — | — | `kpi-engine`, `performance-aggregator`, `anomaly-engine` |
| Recommendation generation and confidence | Implemented | used by the on-demand analysis below | — | — | `recommendation-engine`, `recommendation-confidence` |
| On-demand account analysis | Not connected | one shared `AnalysisGenerator` behind the `meta.analyze` tool and `POST /api/v1/analysis`; reads through `ToolExecutor`, diagnoses through the model, persists one PROPOSED recommendation. Needs Meta credentials and an AI provider | None — dry-run, read-only | GA, Meta, Analytics | `analysis-parity`, `analysis-generator`, `meta-analysis-tool` |
| Reading and executing a recommendation | Approval required | `RecommendationExecutionService` → approval → `ToolExecutor` | approval | REST and dashboard | `recommendation-bridge`, `phase116a-bridge-pg.integration` |
| Opportunity prioritisation and queue | Implemented | `/api/v1/opportunities` | — | REST and dashboard | `opportunity-scoring`, `opportunities` |
| Outcome measurement | Implemented | records created after an executed recommendation write; `OutcomeWorker` re-measures them on a background interval (`JARVIS_OUTCOME_WORKER_INTERVAL_MS`) — ledger R-32 | — | background | `outcome-engine`, `outcome-worker-scheduler`, `phase117b-outcome-pg.integration` |
| Historical outcome intelligence | Partially implemented | matching relies on outcome records, created at runtime only for executed recommendation writes | — | — | `historical-outcome-engine`, `phase118a-outcome-pg.integration` |
| A/B experimentation, automated bidding | Planned / not implemented | | — | — | — |
| Website or conversion analytics | Planned / not implemented | No landing-page or conversion data source | — | — | — |

---

## Google Workspace

Registered whenever a Google connection is *possible* (the Google OAuth client and `JARVIS_ENCRYPTION_KEY`), so an unconnected user is told to connect rather than being handed an agent with nothing to offer.

| Capability | Status | Execution Path | Approval | Agent Scope | Tested |
|---|---|---|---|---|---|
| List unread Gmail, search Gmail, read a message or thread | Implemented | Workspace tools → `GoogleWorkspaceTaskService` → Google. Requires the Gmail scope specifically | None | GA, Google Ads | `google-workspace`, `google-workspace-parity` |
| Search Drive, list recent files, read file details | Implemented | as above, Drive scope | None | GA, Google Ads | `google-workspace` |
| List upcoming calendar events, read an event | Implemented | as above, Calendar scope | None | GA, Google Ads | `google-workspace` |
| Prepare a Gmail draft or draft update; request sending | Approval required | `google.plan.*` tools only **plan**: they create an approval row. After a person approves it, `GoogleWriteService.execute()` runs the write from the REST layer and reads it back | approval | GA, Google Ads | `google-write-approval`, `gmail-approval-execution`, `gmail-draft-verification` |
| Prepare a Drive folder, upload, move or rename | Approval required | as above | approval | GA, Google Ads | `google-write-approval`, `google-write-verification` |
| Prepare a calendar event, a change or a deletion | Approval required | as above | approval | GA, Google Ads | `google-write-approval` |

Ten write planners exist and no write executors: the tools handed to the model can only *plan*. Write scopes are added only through a separate, explicit upgrade (`google-oauth-scope-boundary`).

---

## Maps and location

| Capability | Status | Execution Path | Approval | Agent Scope | Tested |
|---|---|---|---|---|---|
| Search places, find places nearby, look up place details | Implemented | `maps.*` tools, registered unconditionally | None | GA, Location | `v3-maps-places-location`, `maps-tools` |
| Resolve an address to coordinates, and coordinates to an address | Implemented | as above | None | GA, Location | `v3-google-maps` |
| Compute a route, distance and travel time | Implemented | as above | None | GA, Location | `v3-google-maps` |
| Read your current location | Implemented | location is supplied by you; it is not inferred | None | GA, Location | `v3-maps-places-location` |
| Monthly usage guard | Implemented | a spend guard caps map usage per month | — | — | `v3-maps-usage-guard` |

---

## Browser and computer control

| Capability | Status | Execution Path | Approval | Agent Scope | Tested |
|---|---|---|---|---|---|
| Navigate, inspect, extract, screenshot | Not connected | `browser.*` read tools → `ToolExecutor` → `packages/browser`; mounts only when browsing is explicitly switched on and a Chrome is present. Where it may navigate is decided below the tool layer (domain allowlist, IP rules) | None | Browser | `sprint7-browser-tools`, `navigation-policy`, `ip-rules` |
| Click, type, select, submit, download, upload | Not connected, approval required | `browser.*` action tools, each through the approval gate | approval | Browser | `sprint7-browser-tools`, `sprint7-browser-wiring` |
| Understanding a screenshot | Planned / not implemented | A screenshot is stored and referenced by id; nothing interprets it | — | — | — |
| Desktop control, file operations, launching applications | Planned / not implemented | | — | — | — |

---

## Voice

| Capability | Status | Execution Path | Approval | Agent Scope | Tested |
|---|---|---|---|---|---|
| Speak to JARVIS (speech to text) | Implemented | `/api/v1/voice/transcribe`, mounted when voice is configured; it turns speech into text and runs no tool itself | — | — | `sprint8-voice-routes`, `voice` |
| JARVIS speaks back (text to speech) | Implemented | ElevenLabs when configured, otherwise the OpenAI voice | — | — | `elevenlabs-voice-provider`, `voice-provider` |
| Voice status report | Implemented | | — | — | `sprint8-voice-foundation` |
| Approving a write by voice | Planned / not implemented | Deliberate: a voice session cannot confirm a write | — | — | — |

---

## Memory and knowledge

| Capability | Status | Execution Path | Approval | Agent Scope | Tested |
|---|---|---|---|---|---|
| Long-term memory across conversations | Implemented | orchestrator recall before the agent runs (pgvector); needs an embedding provider, without which memory switches off rather than degrading silently | — | All, through the orchestrator | `orchestrator-memory-recall-s7`, `memory-vector-recall-s7-pg.integration`, `sprint-1.1d-memory-e2e` |
| Learning from conversation, with a learning gate | Implemented | after the reply, never blocking it: learning gate (L1–L1c) → provenance from the user's own message (L2) → validation (L3) → evidence and corroboration instead of duplicates (L4). See [MEMORY.md](./MEMORY.md) | — | All, through the orchestrator | `learning-candidate-s7`, `learning-provenance-l2`, `learning-validation-l3`, `learning-evidence-l4`, `memory-learning-gate-s7-pg.integration` |
| See, forget, correct, veto, pause and resume what JARVIS remembers | Implemented | chat memory commands (English and Hinglish), handled before any agent runs. Listing never goes through the model. Forgetting becomes a pending action, then `ToolExecutor` runs `memory.forget` / `memory.forget_all` and hard-deletes | forget: approval — typed "yes" or the button; forget-all needs the exact phrase; never by voice | `memory.list`: GA. The forgetting tools are on no allowlist: no agent can delete | `memory-command-detector-l5`, `chat-memory-l5`, `memory-tools-l5`, `memory-l5-pg.integration` |
| A memory screen or memory REST endpoints | Planned / not implemented | Memory is managed through chat only | — | — | — |
| Memory scoped to a project or client | Planned / not implemented | Memories belong to a user; there is no project model | — | — | — |
| Upload a document | Implemented | `/api/v1/knowledge`: PDF, DOCX, TXT and Markdown | — | — | `knowledge-api` |
| Document text extraction, chunking and embedding | Implemented | `packages/memory` | — | — | `document-chunking`, `document-embedding` |
| List, read and delete your documents | Implemented | `/api/v1/knowledge` | — | — | `knowledge-api`, `knowledge-panel` |
| Semantic search across your documents | Implemented | | — | — | `knowledge-retrieval` |
| Answers grounded in your documents (RAG) | Implemented | enabled only when an embedding provider exists; otherwise retrieval is off and JARVIS does not pretend to have read anything | — | Knowledge, through the orchestrator | `orchestrator-knowledge-rag` |
| Image understanding on upload | Implemented | an uploaded image is described by the vision model and stored as searchable text | — | — | no test found |

---

## Work tasks and scheduling

| Capability | Status | Execution Path | Approval | Agent Scope | Tested |
|---|---|---|---|---|---|
| Ask JARVIS to do a piece of work, and follow it | Implemented | `task.*` tools and `/api/v1/tasks`; the dashboard's JARVIS Work section. A different thing from your to-do list (`tasks.list`) | — | GA | `core-v1-task-lifecycle`, `task-conversation-v11` |
| Plan and run a task | Implemented | `TaskPlannerService` proposes one tool call from the registry, limited to the schedulable tools → `TaskExecutionService` → `ToolExecutor`, with the requesting user's role | an approval-gated tool is **not** run: the task fails with "needs your approval" | every agent's tools except MCP | `task-planner-v1`, `task-execution-v1`, `core-v1-task-executor-policy` |
| Schedule a task for one future time | Implemented | a time phrase in chat or `POST /api/v1/tasks/:id/schedule` → the scheduler loop claims the due task once (durable claim) → planned at run time → run as above | as above | as above | `scheduler-v1`, `schedule-endpoint-offset`, `schedule-phrase-timezone`, `task-engine-v21-durable-claim` |
| Recover a task interrupted by a restart | Implemented | an abandoned claim or run is recovered, or marked UNRESOLVED when it cannot be known whether it ran | — | — | `task-engine-v22-claim-recovery`, `task-engine-v23-running-recovery`, `task-engine-v23-unresolved-state` |
| Recurring schedules, cron, automatic retry | Planned / not implemented | Scheduling is one-time only; a failed task is final | — | — | — |
| Your own to-do list | Implemented | `tasks.list` | None | GA | `command-center-task-visibility` |

---

## Evaluation

| Capability | Status | Execution Path | Approval | Agent Scope | Tested |
|---|---|---|---|---|---|
| What happened during a request — agent, skills, tools, how it ended | Implemented | `GET /api/v1/activity/trace/:traceId`, derived from the audit rows. An observer: it can run no tool | — | — | `execution-outcome-s5` |
| Rate an answer 👍 or 👎 | Implemented | `POST /api/v1/activity/trace/:traceId/feedback`. Recorded only; nothing reads it back into how JARVIS decides | — | — | `execution-outcome-s5` |
| What each objective of a request proves | Implemented | `GET /api/v1/activity/trace/:traceId/evaluation`, read-only; shown in the activity view | — | — | `objective-evaluation-service-s6`, `objective-evaluation-route-s6`, `objective-evaluation-panel` |

---

## MCP — reviewed external tool servers

| Capability | Status | Execution Path | Approval | Agent Scope | Tested |
|---|---|---|---|---|---|
| Date arithmetic and unit conversion through reviewed MCP servers | Not connected — off unless `JARVIS_MCP_ENABLED=true` | reviewed manifest (`MCP_MANIFEST`) → one connection per server → ToolRegistry as `mcp.<server>.<tool>` → the general assistant's grant, derived from the manifest → `ToolExecutor` → MCP runtime (`packages/mcp`) → stdio server | None — READ_ONLY; needs `read` and `execute`, so OWNER and ADMIN only | GA only; never in scheduled or background tasks | `mcp-pilot-e2e-s8`, `mcp-multi-server-s8`, `mcp-policy-s8`, `tool-budget-s8`, `pilot-s8` |
| Health of each server | Not connected (as above) | Integration Center Test Connection runs `verify()` on every server; the capability report shows a server whose last start or check failed as unavailable | — | — | `verify-s8`, `mcp-integration-s8`, `mcp-capability-presentation-s8` |

- **Two reviewed servers, four tools:** `dates` (`days_between`, `day_of_week`) and `units` (`convert_length`, `convert_temperature`). Each is pinned by fingerprint in the manifest.
- **No dynamic discovery.** A server's live listing never registers or describes anything. A listing that differs from the review fails that server closed.
- **Isolation.** Each server has its own connection, process, breaker and verification state. One server failing, drifting or being refused never touches another.
- **Budget.** The general assistant's native tools plus the most MCP tools allowed must stay within `MAX_TOOLS_PER_MODEL_REQUEST` (128); a census test holds it.
- **Not implemented:** write tools, remote transports, per-user servers or credentials, per-server capability labels, per-agent MCP grants. See [packages/mcp/README.md](../packages/mcp/README.md).

---

## Dashboard and Command Center

| Capability | Status | Execution Path | Approval | Agent Scope | Tested |
|---|---|---|---|---|---|
| Customisable widget grid | Implemented | drag, resize, hide and restore; the layout is saved | — | — | `dashboard`, `dashboard-optimizer` |
| Weather, markets, maps, this machine's telemetry, clocks, task list | Implemented | `/api/v1/dashboard` and the widget providers in the API | — | — | `v3-widgets`, `dashboard-api` |
| Approvals inbox | Implemented | `/approvals` page over `/api/v1/approvals` and `/api/v1/pending-actions` | it is the approval step | — | `approvals` |
| Undo of a layout change surviving a refresh | Planned / not implemented | layout history is in memory only | — | — | — |

---

## Integrations and self-knowledge

| Capability | Status | Execution Path | Approval | Agent Scope | Tested |
|---|---|---|---|---|---|
| See what is connected; check status, run a health check, test a connection | Implemented | `integration.*` tools and the Integrations page reach the **same** `IntegrationCommandService`. Needs `JARVIS_ENCRYPTION_KEY` | None | every agent except Knowledge and Browser | `integration-command-parity`, `integration-control-center`, `integration-health` |
| Review granted permissions, read the integration audit trail | Implemented | as above | None | every agent except Knowledge and Browser | `integration-control-center` |
| Connect, configure, reconnect, enable or disable an account | Implemented | as above; writes only to JARVIS's own encrypted store | — | GA, Google Ads | `integration-write-security` |
| Disconnect an account | Approval required | as above | approval | GA, Google Ads | `integration-write-security` |
| An integration action that writes outside JARVIS | Implemented | `IntegrationCommandService` refuses it unless the integration is connected, then demands a confirmation and hands it to `ToolExecutor` | confirmation — two minutes, single use, bound to the exact parameters; never by voice | through the integration tools and the Integrations page | `integration-write-security` |
| Report what JARVIS can currently do | Implemented | `capabilities.*` tools, answered from the live tool registry, not from a written list | None | All | `capability-discovery`, `capability-routing-e2e` |
| Report what JARVIS is — build, environment, model | Implemented | `self.describe`, derived from the running process | None | All | `sprint6-agent-wiring` |
| Mistake detection and self-diagnosis | Partially implemented | JARVIS classifies its own failures and says what failed | — | — | — |
| Self-repair | Planned / not implemented | | — | — | — |

---

## Automation and messaging

| Capability | Status | Execution Path | Approval | Agent Scope | Tested |
|---|---|---|---|---|---|
| Trigger an n8n workflow | Not connected, approval required | `n8n.trigger` → `ToolExecutor` → `packages/n8n`. Needs base URL, API key and callback secret. A workflow can do anything its author wired, so it is approval-gated | approval | Automation | `n8n-tools`, `n8n-integration` |
| Send a WhatsApp message | Not connected, approval required | `whatsapp.send` → `packages/whatsapp`. Needs the WhatsApp secrets; recipients must be authorised | approval | Communication | `whatsapp-tools`, `whatsapp-integration` |
| Building an n8n workflow from JARVIS | Planned / not implemented | JARVIS triggers pre-registered workflows only | — | — | — |

---

## Safety, permissions and auditability

| Capability | Status | Execution Path | Approval | Agent Scope | Tested |
|---|---|---|---|---|---|
| Human approval before anything outside JARVIS changes | Implemented | one execution authority, `ToolExecutor`; approvals are consumed atomically with the execution claim | — | All | `tool-approval`, `approval-flow-regression`, `phase103-approval-pg.integration` |
| Role-based permissions per agent and tool | Implemented | four roles; the executor checks the caller's role | — | All | `sprint6-security`, `sprint9-security` |
| Execution journal and idempotency | Implemented | a crash or timeout never reports success | — | All | `execution-journal`, `phase102-concurrency-pg.integration` |
| Audit trail | Implemented | every tool execution recorded | — | All | `sprint9-audit-redaction` |
| Secrets kept out of responses, logs and bundles | Implemented | including provider error text, which is replaced by fixed messages | — | All | `output-sanitizer`, `sprint9-audit-redaction` |
| Account identifiers masked in replies | Implemented | | — | All | `output-sanitizer` |
| Autonomous action without approval | Planned / not implemented | By design, and not a roadmap item | — | — | — |

---

## Present in the code, not reachable

Five tool classes are written and tested but never registered, so no agent can call them at runtime: CSV analysis, document analysis, PDF generation, web research, and a system echo used for diagnostics. CSV analysis is additionally *granted* to two agents by policy, so the grant currently points at something that is not registered. Wiring any of them in is a capability decision — see `CODEBASE_AUDIT.md`, D-6.

---

## Planned / not implemented

Listed because they are commonly assumed. None of these exist in this repository, and none is claimed anywhere in the product.

| Capability | Status |
|---|---|
| Sales CRM, lead pipelines, deal tracking | Planned / not implemented — JARVIS is not a sales CRM |
| Workspace or project-management integrations (task boards, sprints, tickets) | Planned / not implemented |
| Social media content planning, publishing or scheduling; content calendars | Planned / not implemented |
| SEO research | Planned / not implemented |
| Competitor research | Planned / not implemented |
| Client report generation | Planned / not implemented — the PDF generator is not registered |
| Integrations beyond Meta, Google (Ads, Gmail, Drive, Calendar, Maps), WhatsApp, n8n and the two reviewed MCP servers | Planned / not implemented |
| Real-time multi-user collaboration | Planned / not implemented — roles exist, shared live editing does not |
| Self-improving or self-modifying prompts | Planned / not implemented — prompts are static and auditable |

---

*Document version: 4.0 — regenerated in the Phase 12 documentation reconciliation (backlog A-7, ledger R-2): added work tasks and scheduling, memory learning and management (S7.2), evaluation (S5, S6), the write-intent gate and MCP (S8), and the Execution Path, Approval, Agent Scope and Tested columns.*
*Verified against the repository on 2026-10-05, commit `68628c0`.*
*Previous versions: 3.1 (2026-09-17, ledger P0-3 and R-33); 2.0 (2026-09-02), which described the Meta-era pipeline only.*
