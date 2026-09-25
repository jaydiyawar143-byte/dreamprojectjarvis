# JARVIS HTTP API

Everything below is served by `apps/api` under `/api/v1`. Verified against the code on 2026-09-17.

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
| `pending-actions.ts` | `/api/v1/pending-actions` | `GET /`, `POST /:id/confirm`, `POST /:id/reject`, `POST /:id/modify` |
| `recommendations.ts` | `/api/v1/recommendations` | `GET /`, `GET /:id`, `POST /:id/execute` |
| `outcomes.ts` | `/api/v1` | `GET /recommendations/:id/outcome`, `GET /outcomes/:id` |
| `opportunities.ts` | `/api/v1/opportunities` | `GET /`, `GET /:id` |
| `analysis.ts` | `/api/v1/analysis` | `POST /` (`{ dryRun }`) — runs the shared on-demand account analysis (service + voice + button, parity-tested) |
| `google-writes.ts` | `/api/v1/integrations/google/writes` | `POST /plan`, `GET /:approvalId`, `POST /:approvalId/execute` |

`analysis.ts` accepts only `{ dryRun }`. The ad account is ALWAYS the server-configured `META_AD_ACCOUNT_ID`; a client-supplied account id is never read.

`outcomes.ts` is mounted at the `/api/v1` root, so one `/recommendations/*` path is served by a different router from the rest. No path collides.

### Knowledge — `/api/v1/knowledge` · `knowledge.ts`

`POST /documents`, `POST /images`, `GET /documents`, `GET /documents/:id`, `GET /documents/:id/chunks`, `DELETE /documents/:id`, `POST /search`

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
