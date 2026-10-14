# JARVIS HTTP API

Everything below is served by `apps/api` under `/api/v1`. Verified against the code on 2026-09-17; the memory and project routes were added in Phase 14, on 2026-10-08, and the marketing routes in Phase 15, on 2026-10-12.

- **Mounts:** `apps/api/src/index.ts` · **Handlers:** `apps/api/src/routes/*.ts`
- **Authentication:** unless a table says otherwise, send `Authorization: Bearer <access token>`. Data is always scoped to that token's user; a user id in a body or path is ignored.
- **Errors:** JSON with a stable machine-readable `code`, for example `INTEGRATION_NOT_CONFIGURED`.

---

## Always mounted

### Auth — `/api/v1/auth` · `auth.ts`

| Method | Path | Access token |
|---|---|---|
| POST | `/register` | not required |
| POST | `/login` | not required |
| POST | `/refresh` | not required — refresh token in the body, or the HttpOnly cookie |
| POST | `/logout` | not required |
| GET | `/me` | required |

### Health — `/api/v1/health` · `health.ts`

| Method | Path | Access token |
|---|---|---|
| GET | `/` | not required |
| GET | `/live` | not required |
| GET | `/ready` | not required |
| GET | `/integrations` | required — defined inline in `index.ts` |
| POST | `/integrations/check` | required — defined inline in `index.ts` |

### Conversation

| Router | Mount | Endpoints |
|---|---|---|
| `chat.ts` | `/api/v1/chat` | `POST /` |
| `conversations.ts` | `/api/v1/conversations` | `GET /`, `GET /:id` |
| `agents.ts` | `/api/v1/agents` | `GET /` |
| `activity.ts` | `/api/v1/activity` | `GET /`, `GET /trace/:traceId`, `POST /trace/:traceId/feedback`, `GET /trace/:traceId/evaluation` |
| `capabilities.ts` | `/api/v1/capabilities` | `GET /`, `GET /connected`, `GET /permissions`, `GET /:integration` |

### Objective evaluation — `GET /api/v1/activity/trace/:traceId/evaluation` · `activity.ts`

Added 2026-09-25 (Skill System S6). Read-only: it executes nothing, writes nothing and approves nothing.

For one of the caller's requests, it reports what the user asked for and what the evidence the server recorded proves about each part. The request is the user's own words, split into objectives by fixed rules. The response has no score, no confidence and no overall success flag.

- **Access token:** required. Without one, or with an invalid one: `401 AUTHENTICATION_REQUIRED`.
- **`:traceId`:** the `traceId` returned by `POST /api/v1/chat`. It is taken from the path only; a trace id in the query string, the body or a header is ignored. Empty after trimming, or longer than 64 characters: `400 INVALID_REQUEST`.
- **`200`:** `{ success: true, data, timestamp }`, where `data` is the evaluation: `traceId`, `bound`, `objectives`, `assessments`, `facts`, `missing`, `feedback`, `asOf`. Each assessment's `status` is `EVIDENCED`, `AWAITING_APPROVAL`, `BLOCKED`, `NOT_ATTEMPTED` or `NOT_EVALUABLE`. A `NOT_EVALUABLE` assessment always names what is missing. A trace for which the caller has records but no bound request comes back `200` with `bound: false`, its facts listed and no objectives.
- **`404 NOT_FOUND`:** the caller has no records for that trace id. A trace belonging to another user gets the same answer as one that does not exist.
- **Other failures:** `500 INTERNAL_ERROR` with a fixed message; the detail stays in the server log.

Tool parameters, free-text audit fields and the assistant's reply text are never part of the response. `feedback` is the user's own 👍/👎 signal, copied as recorded; it never changes a status.

### Approvals and actions

| Router | Mount | Endpoints |
|---|---|---|
| `approvals.ts` | `/api/v1/approvals` | `GET /`, `GET /:id`, `POST /:id/approve`, `POST /:id/reject` |
| `pending-actions.ts` | `/api/v1/pending-actions` | `GET /`, `POST /:id/confirm`, `POST /:id/reject`, `POST /:id/modify` — `:id` must be the action waiting in the conversation (`409 PENDING_ACTION_MISMATCH` otherwise; nothing changes). Answers that arrive together for the same action are resolved by one conditional write: exactly one wins, the others get `409 PENDING_ACTION_ALREADY_RESOLVED` and change nothing |
| `recommendations.ts` | `/api/v1/recommendations` | `GET /`, `GET /:id`, `POST /:id/execute` |
| `outcomes.ts` | `/api/v1` | `GET /recommendations/:id/outcome`, `GET /outcomes/:id` |
| `opportunities.ts` | `/api/v1/opportunities` | `GET /`, `GET /:id` |
| `analysis.ts` | `/api/v1/analysis` | `POST /` (`{ dryRun }`) — runs the shared on-demand account analysis (service + voice + button, parity-tested) |
| `google-writes.ts` | `/api/v1/integrations/google/writes` | `POST /plan`, `GET /:approvalId`, `POST /:approvalId/execute` |

`analysis.ts` accepts only `{ dryRun }`. The ad account is ALWAYS the server-configured `META_AD_ACCOUNT_ID`; a client-supplied account id is never read.

`outcomes.ts` is mounted at the `/api/v1` root, so one `/recommendations/*` path is served by a different router from the rest. No path collides.

### Knowledge — `/api/v1/knowledge` · `knowledge.ts`

`POST /documents`, `POST /images`, `GET /documents`, `GET /documents/:id`, `GET /documents/:id/chunks`, `DELETE /documents/:id`, `POST /search`

### Memory — `/api/v1/memories` · `memory.ts`

Added 2026-10-08 (Phase 14). The memory screen's API: a second way of reaching the one service the chat's memory commands use. See [MEMORY.md](./MEMORY.md#user-controls-the-api-and-the-screen).

| Method | Path | What it does |
|---|---|---|
| GET | `/` | A page of the caller's memories, newest first (ties by id). `?limit=1..50` (default 20) · `?offset=` · `?project=all\|personal\|<project id>` · `?q=<text>` · `?includeExpired=true` |
| GET | `/status` | `learningPaused`, `controlsReadable` (false: the stored controls are corrupt — nothing is learned or recalled), `vetoedSources`, `active`, `expired`, `retention { days, purgeGraceDays }`, `correctionAvailable` |
| GET | `/:id` | One memory |
| POST | `/learning/pause` | Stop learning. Deletes nothing |
| POST | `/learning/resume` | Start learning again |
| POST | `/:id/forget` | **Asks** for the memory to be forgotten: `202` with `{ pendingAction, conversationId, summary }` |
| POST | `/:id/correction` | **Asks** for it to be changed. Body `{ statement }`, 1–500 characters: `202` with `{ pendingAction, conversationId, summary }` |

- **A memory is returned as:** `id`, `type`, `content`, `confidence` (0–0.95) and `confidenceLevel` (`HIGH` / `MEDIUM` / `LOW`), `createdAt`, `updatedAt`, `expiresAt`, `expired`, `projectId` (null for a personal memory) and `projectName`, `legacy`, and `provenance` — `source` (`USER` / `LEGACY`), `statements`, `conversations`, `firstStatedAt`, `lastStatedAt`, `revisions`. Never the vector, the raw metadata, or a message, conversation or trace id.
- **Forgetting and correcting change nothing by themselves.** Each creates the same HIGH_IMPACT pending action the chat creates (`memory.forget`, `memory.correct`); the caller confirms it with `POST /api/v1/pending-actions/:id/confirm` and `{ conversationId }`, or cancels it with `/reject`. A new request cancels one that was never confirmed, and the old request's id then gets `409 PENDING_ACTION_MISMATCH` — it can never confirm or cancel the new one. A memory action cannot be modified (`409 PENDING_ACTION_NOT_MODIFIABLE`). **There is no `DELETE`, `PUT` or `PATCH` on a memory.**
- **`404 MEMORY_NOT_FOUND` / `404 PROJECT_NOT_FOUND`:** not the caller's, or does not exist — the same answer for both.
- **`422 MEMORY_NOT_LEARNABLE`:** the statement could not be stored as a memory on its own (a task, a goal, a secret, a grant of authority, a question). Nothing is saved or proposed.
- **`400 INVALID_REQUEST`:** a bad `limit`, `offset` or `statement`. **`503`:** confirmations, or the memory writer, are not available on this deployment.

### Projects — `/api/v1/projects` · `projects.ts`

Added 2026-10-08 (Phase 14). A project is a scope for memory: a name, owned by the caller.

| Method | Path | What it does |
|---|---|---|
| GET | `/` | The caller's own projects, by name |
| POST | `/` | Creates one. Body `{ name, description? }`; `201`. A duplicate name, an empty or over-long name, or more than 100 projects: `400 INVALID_REQUEST` |

There is no rename and no delete: deleting a project deletes its memories, and nothing in Phase 14 asks for that.

**A conversation's project.** `POST /api/v1/chat` accepts `projectId` on the request that **creates** a conversation. It must be one of the caller's own projects (`404 PROJECT_NOT_FOUND` otherwise) and is then fixed: a later request that names a different project gets `409 PROJECT_MISMATCH`.

### Marketing — `/api/v1/marketing` · `marketing.ts`

Added 2026-10-12 (Phase 15). The Marketing page's API. **The router implements nothing**: every endpoint below turns the request into one tool call and runs it through `ToolExecutor` — the same tool, with the same id, the marketing agent proposes in chat — so a button and a sentence pass one permission check, one approval gate and one audit row. See [MARKETING.md](./MARKETING.md).

| Method | Path | Tool it runs | What it does |
|---|---|---|---|
| GET | `/status` | — (reads the registry) | What this deployment can do, and what the caller's role could run: `research { available, reason }`, `publishing { available, channels, reason }`, `adAccount { available }`, `caller { canEdit, canResearch, canPublish, canResolve }`. `publishing.reason` says whether publishing is switched off (`MARKETING_PUBLISH_ENABLED`) or not configured |
| GET | `/campaigns` | `marketing.campaign.list` | The caller's campaign workspaces. `?projectId=` · `?includeArchived=true` |
| POST | `/campaigns` | `marketing.campaign.create` | Creates a workspace. `201`. Body: `name`, `objective?`, `brief?`, `channels?`, `startDate?`, `endDate?`, `status?`, `metaCampaignIds?` |
| GET | `/campaigns/:id` | `marketing.campaign.get` | One workspace: the campaign, content counts by status, what is coming up, the latest report and research |
| PATCH | `/campaigns/:id` | `marketing.campaign.update` | Changes the fields sent |
| GET | `/content` | `marketing.content.list` | The content calendar. `?from=&to=` (YYYY-MM-DD, default the next 30 days) · `?campaign=` · `?status=` · `?channel=` · `?limit=1..100` · `?projectId=`. A list shows copy shortened to 280 characters |
| POST | `/content` | `marketing.content.plan` | Saves drafts. `201`. Body `{ campaign?, items: [{ title, channel, body?, link?, notes?, format?, scheduledDate?, scheduledTime?, status? }] }`. **It publishes nothing** |
| GET | `/content/:id` | `marketing.content.list` | One item, whole — `data.item` |
| PATCH | `/content/:id` | `marketing.content.update` | Edits a draft, moves it, or marks it ready. `status` may be `IDEA`, `DRAFT`, `READY` or `ARCHIVED` — **never `PUBLISHED`** |
| POST | `/content/:id/mark-published` | `marketing.content.mark_published` | Records that the **user** posted it. Body `{ url?, publishedOn? }`. Stored as `REPORTED_BY_USER`, never as verified |
| GET | `/content/:id/publish` | `marketing.publish.prepare` | The publish check — a read. Whether it can be published, where, and with exactly which parameters. `?targetId=`. While an earlier publish of the item is unconfirmed, `publishParams` carries `earlierAttempt` — the identity of that attempt, never its text — and `warning` says that asking again only looks: those are the parameters of a look, not of a send |
| POST | `/content/:id/publish` | (the publish flow) | Body `{}` or `{ targetId }`: **asks** — `202` with the approval to decide. Body `{ approvalId }`: **publishes**, for an approval the caller has approved |
| POST | `/content/:id/publish/resolve` | `marketing.publish.resolve` | A person's decision that a publish whose outcome is not known did **not** happen. Body `{ decision: "NOT_PUBLISHED" }` — the only decision there is. The server looks for the post once more: found with the item's text → `200 { resolution: "FOUND_PUBLISHED" }` and it is recorded as published; not found → `200 { resolution: "CLEARED" }` and the item can be edited and published again; a post from the attempt is there with other text → `409 CONFLICT`; the Page cannot be checked → `502 PROVIDER_FAILED`; nothing to settle → `409 CONFLICT`. **Before it looks**, the item must still hold exactly the words the attempt sent, and the Page the attempt went to must still be one the connection can read: otherwise `409 CONFLICT`, nothing is looked for and nothing is cleared. So too if the attempt under its claim is not the one it checked a moment before — that attempt was settled and the item sent again in between: `409 CONFLICT`, and the newer attempt is left as it is. A post that is already another item's is never taken for this one's. The decision's audit row is written in the same transaction as the change: if it cannot be written, `503 UNAVAILABLE` and **nothing was cleared or recorded**. It posts nothing, and no agent can call it |
| GET | `/research` | `marketing.research.list` | Saved research. `?kind=SEO_AUDIT\|COMPETITOR_SNAPSHOT` · `?campaign=` · `?projectId=` |
| GET | `/research/:id` | `marketing.research.list` | One result, with where and when the page was read |
| POST | `/research/seo-audit` | `marketing.seo.audit` | Reads one public page and audits it. `201`. Body `{ url, campaign? }` |
| POST | `/research/competitor` | `marketing.competitor.analyze` | Reads a competitor's page; compares it with `ownUrl` when given, and with the last saved reading of the same page. `201`. Body `{ competitorUrl, ownUrl?, campaign? }` |
| GET | `/reports` | `marketing.report.list` | Saved reports. `?campaign=` · `?projectId=` |
| POST | `/reports` | `marketing.report.generate` | Reads the data and saves a report. `201`. Body `{ kind?: PERFORMANCE\|CLIENT, campaign?, from?, to?, title?, compare? }`. At most 90 days; default the last 30 complete days |
| GET | `/reports/:id` | `marketing.report.get` | One report and its document |
| GET | `/reports/:id/export` | `marketing.report.get` | The report as a file. `?format=html\|md`. Sent as an attachment with `nosniff` and a sandboxing CSP; never rendered in this origin |
| GET | `/recommendations` | `marketing.recommendations` | Advice derived from the workspace. Every item carries `executed: false` |

- **The caller is the token.** A user id, a role, a conversation id or an agent id in the body or the query is ignored. Only the named fields of a body reach a tool; anything else a client sends is dropped.
- **Refusals** keep the service's own sentence: `400 INVALID` (including a page address the reader's policy will not open — private, loopback, a non-web port, off the allowlist), `403 FORBIDDEN` (the role may not run that tool) or `403 OUT_OF_SCOPE`, `404 NOT_FOUND` (not the caller's, another project's, or does not exist — one answer for all three), `409 CONFLICT` or `409 LIMIT`, `429 RATE_LIMITED` (too many page reads, reports or publish checks in ten minutes; the slot is taken before the provider is called, so nothing was read), `502 PROVIDER_FAILED` (a page could not be reached or was not HTML, or a provider failed), `503 UNAVAILABLE` (this deployment did not register that tool — publishing is switched off or not configured, page reads are off — or a limit could not be checked), `504 TIMEOUT`.
- **Publishing.** `POST /content/:id/publish` never accepts the text of a post, a target name or a link — what is posted is read from the saved item on the server. Its answers:

  | HTTP | `status` / `error.code` | Meaning |
  |---|---|---|
  | `200` | `PUBLISHED`, `published: true` | Posted **and read back from the Page**. `alreadyPublished: true` when an earlier attempt had posted it and nothing new was sent |
  | `202` | `APPROVAL_REQUIRED`, `published: false` | An approval is waiting. `ask` is `REQUESTED`, `WAITING` or `EXPIRED`; `params` and `summary` are the exact text and Page it is bound to — and, when `params.earlierAttempt` is present, the one earlier attempt this approval is to **look** for. Such an approval can never send: the Approvals API shows it as a look. Decide it with `POST /api/v1/approvals/:id/approve` or `/reject` |
  | `409` | `NOT_READY` | It cannot be published as it stands. `reason` is set when the tool refused after the approval: `STALE` (the saved text is no longer the approved text, or no longer what an unconfirmed earlier attempt sent; **or the item is no longer in the state the approval was made for** — an approval to look whose attempt has since been settled, an approval to send for an item that has since become unconfirmed, or an approval to look that names an attempt which is no longer the one outstanding. Nothing was sent; ask again), `TARGET_REFUSED` (including a retry that names another Page than the unconfirmed attempt's), `IN_PROGRESS`, `NOT_READY` |
  | `409` | `DECLINED` | The approval was rejected. Nothing was posted |
  | `404` / `403` / `503` | `NOT_FOUND` / `FORBIDDEN` / `UNAVAILABLE` | Not the caller's item or approval / the role cannot publish / publishing is switched off or not configured on this server. **No approval is created** |
  | `429` | `RATE_LIMITED` | Too many publish checks in ten minutes. The provider was not asked and **no approval is created** |
  | `502` | `FAILED` | Nothing was published. `reason` says why |
  | `502` | `UNCONFIRMED` | **The outcome of a publish is not known.** The item is not marked published, cannot be edited, and nothing more is sent for it until it is settled. `reason` is the specific outcome and `sentNothing` says whether THIS request sent anything: `AMBIGUOUS_OUTCOME`, `VERIFY_FAILED`, `VERIFY_MISMATCH`, `VERIFY_NO_TEXT`, `RECORD_FAILED`, `POST_RECORDED_ELSEWHERE` — the post that was read back is already another item's, so this one is not marked published — (`sentNothing: false` — a post went out); `NOT_FOUND_ON_PAGE`, `RECONCILE_MISMATCH` (`sentNothing: true` — a retry that only looked for the earlier post). Settle it with `POST /content/:id/publish/resolve`, or record it with `/mark-published` |

  Every non-`200` answer carries `published: false`. `published` is `true` in exactly one case.
- **Google Ads** is never read by any of these endpoints. A report records whether it could have been, and why not.

### Dashboard

| Router | Mount | Endpoints |
|---|---|---|
| `dashboard.ts` | `/api/v1/dashboard` | `GET /summary`, `GET /status`, `GET /meta/account`, `GET /meta/overview`, `GET /meta/timeseries`, `GET /meta/campaigns` |
| `command-center.ts` | `/api/v1/command-center` | `GET /weather`, `GET /markets/crypto`, `GET /markets/indices`, `GET /geo/search`, `GET /geo/route`, `GET /geo/autocomplete`, `GET /geo/place/:placeId`, `POST /geo/location`, `DELETE /geo/location`, `GET /geo/reverse`, `GET /maps/config`, `GET /maps/usage`, `GET /system`, `GET /tasks`, `POST /tasks`, `PATCH /tasks/:id`, `DELETE /tasks/:id`, `GET /preferences`, `PUT /preferences`, `GET /capabilities` |

**Two "capabilities" endpoints, two jobs.** `/api/v1/command-center/capabilities` says which dashboard widgets this deployment can feed. `/api/v1/capabilities/*` describes integrations and what JARVIS can do with them.

### Integrations

| Router | Mount | Endpoints |
|---|---|---|
| `integrations.ts` | `/api/v1/integrations` | `GET /catalog`, `GET /`, `GET /:integration`, `POST /:integration/test`, `POST /:integration/refresh`, `POST /:integration/connect`, `PUT /:integration/config`, `POST /:integration/validate`, `GET /:integration/permissions`, `GET /:integration/health`, `GET /:integration/audit`, `POST /:integration/reconnect`, `POST /:integration/enable`, `POST /:integration/disable`, `DELETE /:integration`, `POST /:integration/actions/:action` |
| `google-workspace.ts` | `/api/v1/workspace` | `GET /gmail/unread`, `GET /gmail/search`, `GET /gmail/messages/:id`, `GET /gmail/threads/:id`, `GET /drive/search`, `GET /drive/recent`, `GET /drive/files/:id`, `GET /calendar/upcoming`, `GET /calendar/events/:id` |

The integrations router is the REST arm of the single integration command service described in `AGENTS.md`.

---

## Mounted only when configured

When the condition is not met the router is **not mounted at all**; the API logs a `*_routes_disabled` event at startup and every path under it returns 404.

| Router | Mount | Condition | Endpoints |
|---|---|---|---|
| `whatsapp.ts` | `/api/v1/whatsapp` | all four `WHATSAPP_*` secrets set | `GET /webhook`, `POST /webhook` — no access token; verified by the Meta challenge and `X-Hub-Signature-256` · `GET /messages` |
| `n8n.ts` | `/api/v1/n8n` | `N8N_BASE_URL`, `N8N_API_KEY`, `N8N_CALLBACK_SECRET` set | `POST /callback` — no access token; verified by `X-Jarvis-Signature` HMAC · `GET /workflows`, `GET /executions`, `GET /executions/:id` |
| `voice.ts` | `/api/v1/voice` | voice configuration valid | `GET /status`, `POST /transcribe`, `POST /speak` |
| `credentials.ts` | `/api/v1/credentials` | `JARVIS_ENCRYPTION_KEY` set | `GET /`, `PUT /:provider`, `POST /:provider/test`, `DELETE /:provider` |
| `google-auth.ts` | `/api/v1/google` | `JARVIS_ENCRYPTION_KEY` set | `GET /status`, `POST /connect`, `POST /disconnect` · `GET /callback` — no access token; authenticated by consuming a single-use OAuth state |
| `google-signin.ts` | `/api/v1/auth/google` | Google sign-in configured | `GET /status`, `GET /start`, `GET /callback` — the sign-in flow, no access token; state is HMAC-signed and compared in constant time |

WhatsApp and n8n mount **before** the JSON body parser, because their signatures cover the raw request bytes.

---

## Realtime

Socket.IO on the API's port. The handshake must carry an access token in `auth.token` or an `Authorization: Bearer` header; it is verified by the same `TokenService` as HTTP. Connections that do not authenticate in time are dropped. The system-telemetry stream lives in `apps/api/src/socket/system-stream.ts`.

## Logging

Each request writes one access-log line. Values of `code`, `state`, `token`, `access_token`, `refresh_token`, `id_token`, `client_secret`, `key`, `api_key`, `apikey`, `password` and `hub.verify_token` in the query string or referrer are replaced with `REDACTED` (`apps/api/src/middleware/access-log.ts`).
