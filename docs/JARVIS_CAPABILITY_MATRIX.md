# JARVIS Capability Matrix

What JARVIS can actually do, as of the code in this repository. Verified against the source on 2026-09-16 (ledger P0-3).

Nothing is listed as implemented without a code path behind it. Where a capability is limited, the limit is written down rather than softened. Capabilities are described the way a person would ask for them; the internal tool identifiers live in [SKILLS.md](./SKILLS.md), which is the companion document for developers.

**Sources:** `packages/agents/src/agent-policy.ts` (who may call what), `apps/api/src/services/container.ts` (what is actually registered at startup), `apps/api/src/index.ts` (which routes mount), `packages/core/src/capability-catalog.ts` (the user-facing wording), and the risk register in [JARVIS_MASTER_AUDIT_AND_DEVELOPMENT_LEDGER.md](./JARVIS_MASTER_AUDIT_AND_DEVELOPMENT_LEDGER.md).

---

## How to read the status column

| Status | Meaning |
|---|---|
| **Implemented** | Wired into the running system and reachable by a user today |
| **Partially implemented** | Present and working, with a stated limit |
| **Approval required** | Implemented, but every run stops for a human decision before anything outside JARVIS changes |
| **Not connected** | The code ships and registers itself only when the matching credentials or an explicit opt-in exist. Without them the capability is absent, and JARVIS says so instead of guessing |
| **Planned / not implemented** | Not in this repository |

"Approval required" is not a weaker form of implemented. It is the design: the allowlist decides who may *propose* an action, and the approval gate decides whether it *runs*.

---

## Conversation and agents

| Capability | Status | Notes |
|---|---|---|
| Conversational assistant | Implemented | The general assistant; every request that no domain owns lands here |
| Meta Ads specialist | Implemented | Owns advertising questions about Meta |
| Analytics specialist | Implemented | Reads advertising performance; holds no write capability |
| Knowledge specialist | Implemented | Answers from your documents; the retrieval happens before the agent runs |
| Google Ads specialist | Not connected | Registers only when Google Ads is configured |
| Automation specialist | Not connected | Registers only when n8n is configured |
| Messaging specialist | Not connected | Registers only when WhatsApp is configured |
| Browser specialist | Not connected | Registers only when browsing is switched on and a Chrome exists |
| Location specialist | Implemented | Maps capabilities register unconditionally, so this agent is effectively always present |

Nine agents in total. When an agent is not registered, the request falls through to the general assistant rather than failing silently.

---

## Advertising

| Capability | Status | Notes |
|---|---|---|
| Read Meta ad accounts, campaigns, ad sets, ads | Implemented | |
| Read Meta performance insights | Implemented | |
| Pause or resume a Meta campaign, ad set or ad | Approval required | |
| Change a Meta campaign or ad set budget | Approval required | Bounded: maximum value, and caps on how far a single change may move it |
| Create a Meta campaign | Approval required | Verified against mocks only; not exercised against a live account |
| Read Google Ads accounts, campaigns and insights | Not connected | Needs Google configured **and** an encryption key, because credentials are stored encrypted per user |
| Change anything in Google Ads | Planned / not implemented | No Google Ads write capability exists |
| Advertising beyond Meta and Google | Planned / not implemented | |

---

## Google Workspace

Registered whenever a Google connection is *possible*, so an unconnected user is told to connect rather than being handed an agent with nothing to offer.

| Capability | Status | Notes |
|---|---|---|
| List unread Gmail, search Gmail, read a message or thread | Implemented | Read-only. Requires the Gmail scope specifically — connecting Google for Ads alone is not enough |
| Search Drive, list recent files, read file details | Implemented | Read-only, Drive scope |
| List upcoming calendar events, read an event | Implemented | Read-only, Calendar scope |
| Prepare a Gmail draft, or a draft update | Approval required | JARVIS prepares; a person approves; only then does the write run |
| Request sending an email | Approval required | |
| Prepare a Drive folder, upload, move or rename | Approval required | |
| Prepare a calendar event, a change, or a deletion | Approval required | |

Ten write planners exist and no write executors: the tools handed to the model can only *plan*. Execution happens after approval, outside the model's reach.

---

## Maps and location

| Capability | Status | Notes |
|---|---|---|
| Search places, find places nearby, look up place details | Implemented | |
| Resolve an address to coordinates, and coordinates to an address | Implemented | |
| Compute a route, distance and travel time | Implemented | |
| Read your current location | Implemented | Location is supplied by you; it is not inferred |
| Monthly usage guard | Implemented | A spend guard caps map usage per month |

---

## Browser and computer control

| Capability | Status | Notes |
|---|---|---|
| Navigate, inspect, extract, screenshot | Not connected | Read-only browsing; mounts only when browsing is explicitly switched on and a Chrome is present |
| Click, type, select, submit, download, upload | Not connected, approval required | Each action stops for approval when browsing is enabled |

Browsing is never inferred from "a browser is installed". Where it may navigate is decided below the tool layer, so no prompt can widen it.

---

## Voice

| Capability | Status | Notes |
|---|---|---|
| Speak to JARVIS (speech to text) | Implemented | Mounts when voice is configured |
| JARVIS speaks back (text to speech) | Implemented | ElevenLabs when configured, otherwise the OpenAI voice |
| Voice status report | Implemented | |
| Approving a write by voice | Planned / not implemented | Deliberate: a voice session cannot confirm a write |

---

## Memory and knowledge

| Capability | Status | Notes |
|---|---|---|
| Long-term memory across conversations | Implemented | Needs an embedding provider; without one, memory switches off rather than degrading silently |
| Automatic memory extraction after a turn | Implemented | Runs after the reply, never blocking it |
| Upload a document | Implemented | PDF, DOCX, TXT and Markdown |
| Document text extraction, chunking and embedding | Implemented | |
| List, read and delete your documents | Implemented | |
| Semantic search across your documents | Implemented | |
| Answers grounded in your documents (RAG) | Implemented | Enabled only when an embedding provider exists; otherwise retrieval is off and JARVIS does not pretend to have read anything |
| Image understanding on upload | Implemented | An uploaded image is described and stored as searchable text |

---

## Dashboard and Command Center

| Capability | Status | Notes |
|---|---|---|
| Customisable widget grid | Implemented | Drag, resize, hide and restore; layout is saved |
| Weather | Implemented | |
| Market and crypto prices | Implemented | |
| Map, route and place widgets | Implemented | |
| This machine's telemetry | Implemented | |
| Current date and time, task list | Implemented | |
| Undo of a layout change surviving a refresh | Planned / not implemented | Layout history is in memory only |

---

## Integrations and self-knowledge

| Capability | Status | Notes |
|---|---|---|
| See what is connected | Implemented | |
| Check an integration's status, run a health check, test a connection | Implemented | |
| Review granted permissions, read the integration audit trail | Implemented | |
| Connect, configure, reconnect, enable or disable an account | Implemented | These write only to JARVIS's own encrypted store |
| Disconnect an account | Approval required | |
| Report what JARVIS can currently do | Implemented | Answered from the live tool registry, not from a written list |
| Mistake detection and self-diagnosis | Partially implemented | JARVIS classifies its own failures and says what failed; there is no self-repair |

---

## Automation and messaging

| Capability | Status | Notes |
|---|---|---|
| Trigger an n8n workflow | Not connected, approval required | Needs base URL, API key and callback secret. A workflow can do anything its author wired, so it is approval-gated |
| Send a WhatsApp message | Not connected, approval required | Needs the WhatsApp secrets; recipients must be authorised |
| Scheduled or recurring automation inside JARVIS | Planned / not implemented | Scheduling lives in n8n, not here |

---

## Safety, permissions and auditability

| Capability | Status | Notes |
|---|---|---|
| Human approval before anything outside JARVIS changes | Implemented | One execution authority; approvals are consumed atomically |
| Role-based permissions per agent and tool | Implemented | |
| Execution journal and idempotency | Implemented | A crash or timeout never reports success |
| Audit trail | Implemented | Every tool execution recorded |
| Secrets kept out of responses, logs and bundles | Implemented | Including provider error text, which is replaced by fixed messages |
| Account identifiers masked in replies | Implemented | |
| Autonomous action without approval | Planned / not implemented | By design, and not a roadmap item |

---

## Marketing intelligence pipeline

| Capability | Status | Notes |
|---|---|---|
| KPI calculation and performance aggregation | Implemented | |
| Anomaly detection | Implemented | |
| AI diagnosis of a performance problem | Implemented | Structured, schema-validated output |
| Recommendation generation | Partially implemented | Reachable through a standalone script; no user-facing route generates recommendations |
| Reading and executing a recommendation | Implemented, approval required | |
| Opportunity prioritisation and queue | Implemented | |
| Outcome measurement engine | Implemented | Engine, worker and the runtime record-creation path (`RecommendationExecutionService` baseline) are complete and tested; the worker is scheduled in the API process on `JARVIS_OUTCOME_WORKER_INTERVAL_MS` with an overlap guard and a clean drain — ledger R-32 |
| Historical outcome intelligence | Partially implemented | Matching relies on outcome records, which `RecommendationExecutionService` now creates at runtime for executed recommendation writes; category-based matching is covered by a product-level test |
| A/B experimentation | Planned / not implemented | |
| Automated bidding | Planned / not implemented | |
| Website or conversion analytics | Planned / not implemented | No landing-page or conversion data source |

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
| Social media content publishing or scheduling | Planned / not implemented |
| SEO research | Planned / not implemented |
| Competitor research | Planned / not implemented |
| Integrations beyond Meta, Google (Ads, Gmail, Drive, Calendar, Maps), WhatsApp and n8n | Planned / not implemented |
| Real-time multi-user collaboration | Planned / not implemented — roles exist, shared live editing does not |
| Self-improving or self-modifying prompts | Planned / not implemented — prompts are static and auditable |

---

*Document version: 3.0 — regenerated for ledger P0-3.*
*Verified against the repository on 2026-09-16.*
*Previous version (2.0, 2026-09-02) described the Meta-era pipeline only and predated Google Workspace, Maps, browser control, voice, the knowledge stack and the Command Center.*
