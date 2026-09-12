# Integrations

How JARVIS connects to external providers, how you operate those connections
(by clicking or by speaking), and what the system guarantees about both.

---

## The rule

> **Every integration must support both JARVIS command control and manual
> frontend control through the same backend integration service.**

```
  Frontend button ──┐
                    ├──► IntegrationCommandService ──► permission / rate limit
  JARVIS command  ──┘              │                   / validation / audit
                                   ▼
                            IntegrationGateway
                                   ▼
                          External provider API
                                   ▼
                    Result + audit event + health update
```

There is one implementation of every integration operation, in
`apps/api/src/services/integrations/command-service.ts`. The REST router and the
JARVIS tools are both thin translators onto it. Neither can perform a check the
other skips, because the checks are not in either of them.

`apps/api/test/integration-command-parity.test.ts` proves it by instrumenting a
single service instance and asserting both arms arrive there.

---

## Supported integrations

| ID | Name | Configured by | Connection test |
|---|---|---|---|
| `google` | Google (Ads, Gmail, Drive, Calendar, YouTube, Sheets, Docs) | OAuth consent + stored Ads config | Reads the stored connection and its expiry |
| `google-maps` | Google Maps Platform | Server environment | Real geocode through the usage guard |
| `meta` | Meta Ads | Encrypted form credentials | `GET /me/adaccounts` via Graph API |
| `whatsapp` | WhatsApp Business Cloud API | Server environment | Reads the phone number's own metadata |
| `n8n` | n8n Automations | Server environment | `GET /api/v1/workflows?limit=1` |

Every connection test is a **read**. Testing a connection never sends a message,
triggers a workflow or changes a campaign.

---

## The operations

Each is available as a button, as a JARVIS command, and as an HTTP endpoint.

| Operation | JARVIS tool | HTTP | UI control |
|---|---|---|---|
| List everything | `integration.list` | `GET /api/v1/integrations` | Integrations page |
| Status | `integration.status` | `GET /api/v1/integrations/:id` | Card + drawer |
| Health | `integration.health` | `GET /api/v1/integrations/:id/health` | Card status dot |
| Connect | `integration.connect` | `POST /api/v1/integrations/:id/connect` | **Connect** |
| Configure | `integration.configure` | `PUT /api/v1/integrations/:id/config` | **Save configuration** |
| Validate config | `integration.validate` | `POST /api/v1/integrations/:id/validate` | **Validate** |
| Test connection | `integration.test` | `POST /api/v1/integrations/:id/test` | **Test Connection** |
| Permissions | `integration.permissions` | `GET /api/v1/integrations/:id/permissions` | Drawer → Active permissions |
| Reconnect | `integration.reconnect` | `POST /api/v1/integrations/:id/reconnect` | **Reauthorize** / **Reconnect** |
| Enable | `integration.enable` | `POST /api/v1/integrations/:id/enable` | **Enable** |
| Disable | `integration.disable` | `POST /api/v1/integrations/:id/disable` | **Disable** |
| Disconnect | `integration.disconnect` | `DELETE /api/v1/integrations/:id` | **Disconnect** (confirms first) |
| Activity | `integration.audit` | `GET /api/v1/integrations/:id/audit` | Drawer → Recent activity |
| Run an action | — (domain tools) | `POST /api/v1/integrations/:id/actions/:action` | — |
| Catalogue | — | `GET /api/v1/integrations/catalog` | Form rendering |

### Example commands

JARVIS accepts English, Hindi and the Hinglish mixture people actually type:

```
JARVIS, Google account connect karo.
JARVIS, Gmail connection test karo.
JARVIS, Drive ka status batao.
JARVIS, Google Ads accounts list karo.
JARVIS, YouTube integration reconnect karo.
JARVIS, Google Maps API configuration validate karo.
JARVIS, is integration ko disconnect karo.
JARVIS, active permissions dikhao.
```

Names are resolved by `resolveIntegrationAlias()`: "gmail", "drive", "calendar",
"youtube", "sheets", "docs" and "adwords" all resolve to `google`; "maps" and
"naksha" resolve to `google-maps` (checked **before** the bare "google" match,
so a Maps request never becomes an Ads one).

**If the request is ambiguous, JARVIS asks.** "Disconnect karo" with no subject
produces a question, not a guess — and the service is never called while the
question is outstanding.

---

## Status model

Two axes, deliberately never collapsed into one:

**`connection` — is it set up?** A fact about stored configuration, knowable
without touching the network.

`CONNECTED` · `NOT_CONNECTED` · `PARTIAL` · `NEEDS_REAUTH` · `DISABLED`

**`health` — does it work?** Knowable only after a real provider call.

| Health | Meaning | UI label |
|---|---|---|
| `CONNECTED` | A real call succeeded | Connected |
| `DEGRADED` | Reachable but not fully working | Degraded |
| `UNVERIFIED` | Configured, nothing verified yet | **Not checked** |
| `ERROR` | The last verification failed | Error |
| `NEEDS_REAUTH` | The provider rejected the grant | Reauthorization needed |
| `CONFIG_REQUIRED` | Partially configured | Configuration required |
| `NOT_CONNECTED` | Nothing configured | Not connected |
| `DISABLED` | Switched off | Disabled |

**Credentials existing is not a connection.** A saved token reports `UNVERIFIED`
until a test actually succeeds. The list endpoint does not call five external
APIs on page load; it reports configuration plus the last verified result.

---

## Google

### Progressive permissions

Scopes are requested in stages. `scopesForConnect()` **cannot** produce a write
scope — there is no argument to it that could.

1. **Initial connection** — identity (`openid`, `email`, `profile`) plus
   read-only scopes for the services the user selected. Defaults to Ads alone.
2. **Additional services** — requested only when the user asks for them.
3. **Write scopes** — only through `scopesForWriteUpgrade()`, an explicit,
   separate decision.
4. **Destructive actions** — confirmed every time, at execution.

Authorization decisions read **granted** scopes, never requested ones: Google
may grant fewer than were asked for.

| Service | Read scope | Write scope (separate grant) | Tools exist? |
|---|---|---|---|
| Ads | `auth/adwords` | — (Google publishes one scope; read-only enforced on our side) | **Yes** |
| Gmail | `auth/gmail.readonly` | `auth/gmail.send` | Not yet |
| Drive | `auth/drive.readonly` | `auth/drive.file` | Not yet |
| Calendar | `auth/calendar.readonly` | `auth/calendar.events` | Not yet |
| YouTube | `auth/youtube.readonly`, `auth/yt-analytics.readonly` | `auth/youtube.upload` | Not yet |
| Sheets | `auth/spreadsheets.readonly` | `auth/spreadsheets` | Not yet |
| Docs | `auth/documents.readonly` | `auth/documents` | Not yet |

Drive uses `drive.readonly`, not `drive` — the narrow scope still lists and
reads; the broad one additionally permits deletion.

Services marked "Not yet" can be connected, but this repository has no tools
that use them. The UI says so rather than implying JARVIS can already read your
mail.

### Google Ads needs more than OAuth

**Gmail OAuth alone is not sufficient for Google Ads.** It additionally requires:

| Field | What it is |
|---|---|
| `adsDeveloperToken` | Issued to your Google Ads **manager** account |
| `adsCustomerId` | The account to query — ten digits, dashes stripped automatically |
| `adsLoginCustomerId` | The manager (MCC) account, only when reaching a client account through one |

Configure these in the drawer, or:

```
JARVIS, Google ka developer token aur customer ID configure karo.
```

### Google Maps

Two keys with genuinely different jobs, reported independently:

| Key | Used by | Restriction | Consequence if missing |
|---|---|---|---|
| `GOOGLE_MAPS_BROWSER_KEY` | The browser, to render the map | **HTTP referrer** | The interactive map cannot render |
| `GOOGLE_MAPS_SERVER_KEY` | The server: Places, Routes, Geocoding | **IP address** | Those fall back to OpenStreetMap |

The browser key is **public by design** — anyone can read it from the page
source. Restricting it by referrer is what makes that acceptable. The server key
is never sent to the browser.

A browser-key-only deployment is reported as `PARTIAL`, not "configured" —
otherwise the page would hide that every distance on screen came from
OpenStreetMap.

`GOOGLE_MAPS_MONTHLY_LIMIT` caps requests so a loop cannot run up a bill. The
connection test goes through that same guard, so testing cannot bypass the
ceiling.

---

## Environment variables

Document the names; never the values.

### Required for integration management at all

| Variable | Purpose |
|---|---|
| `JARVIS_ENCRYPTION_KEY` | AES-256-GCM key for credentials at rest. **Without it the integration command service is `null`** and the API says so rather than storing secrets in plaintext. |

### Google OAuth

| Variable | Purpose |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth client id |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret |
| `GOOGLE_REDIRECT_URI` | Absolute callback URL; read from server config, never from a request |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Ads developer token (may also be stored per user) |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | Optional manager account, ten digits |

### Google Maps

| Variable | Purpose |
|---|---|
| `GOOGLE_MAPS_BROWSER_KEY` | Referrer-restricted key for map rendering |
| `GOOGLE_MAPS_SERVER_KEY` | IP-restricted key for Places / Routes / Geocoding |
| `GOOGLE_MAPS_MONTHLY_LIMIT` | Monthly request ceiling (default 70000) |

> These are the repository's existing names. The product spec referred to
> `GOOGLE_MAPS_BROWSER_API_KEY` / `GOOGLE_MAPS_SERVER_API_KEY`; the shorter
> existing names were kept so no deployment breaks.

### Meta, WhatsApp, n8n

| Variable | Purpose |
|---|---|
| `META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID`, `META_GRAPH_API_VERSION` | Meta Ads fallback credentials |
| `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` | WhatsApp Cloud API |
| `N8N_BASE_URL`, `N8N_API_KEY`, `N8N_CALLBACK_SECRET` | n8n |

---

## Security

### Secrets

- Encrypted at rest with AES-256-GCM envelopes.
- **Never returned to a client** — not even to the operator who typed them. A
  stored secret comes back as `hasValue: true` plus a fixed mask, never a
  prefix. There is no "reveal" endpoint.
- The UI posts the mask back for an untouched field, which the server reads as
  "unchanged" rather than overwriting a working token with dots.
- Never logged, never placed in an audit row, never echoed in an error message.
- The encryption key lives only in
  `apps/api/src/services/integrations/build.ts`. The command service receives a
  `CredentialPort` of plain objects and has no key at all.

### OAuth

- PKCE (S256) on every flow, even though this is a confidential client.
- Single-use `state` bound to the initiating user, consumed atomically — a
  replayed code finds no row.
- The redirect URI comes from server configuration, never from the request.
- Consent expires after 10 minutes.

### Rate limits

Counted per user in an audit-backed window, so limits hold across processes.

| Verb | Limit |
|---|---|
| `testConnection` | 20 / min |
| `connect`, `reconnect` | 10 / min |
| `configure` | 30 / min |
| `executeAction` | 30 / min |

Plain status reads are **not** limited — they cost nothing external, and
throttling them would break the dashboard without protecting anything.

### External writes

```
Plan → Explain → Confirm → Execute → Audit → Verify → Report
```

- A write action returns **428 Precondition Required** with a plain-English
  summary naming the specific target, plus a confirmation token.
- The token is bound to `(user, integration, action, SHA-256 of params)`. A
  confirmation for "pause campaign A" **cannot** be replayed to pause campaign
  B. It is single-use and expires in two minutes.
- Parameter key order does not affect the hash, so a confirmation issued to the
  UI validates for the agent and vice versa.
- **A voice session cannot confirm a write at all.** No token is even issued —
  speech is a fine way to ask for a write and not a fine way to authorize one.
- Execution then goes through `ToolExecutor`: permission check, approval gate,
  execution journal, audit. The command service *gates*; it never executes.

### Audit

Every command is recorded — **reads and writes, successes and failures**,
including refusals and throttled attempts. Rows carry the integration, the
outcome and the **source** (`frontend` / `jarvis` / `system`), so a voice action
is distinguishable from a click. They never carry a credential.

### Tenant isolation

`req.auth.userId` is the only user id that reaches the service. No route accepts
one as a parameter, and no tool takes one, so a user cannot name, enumerate or
act on anybody else's connections.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "Integration management is unavailable" (503) | `JARVIS_ENCRYPTION_KEY` not set | Set it and restart |
| Card stuck on "Not checked" | Nobody has run a test | Click **Test Connection**, or say "test karo" |
| `NEEDS_REAUTH` | Provider refused the refresh — grant revoked or expired | **Reauthorize** (the card offers only this; a Test would fail again) |
| Google Ads 401 with valid OAuth | Missing developer token or customer ID | Configure them in the drawer |
| Distances look wrong / attributed to OpenStreetMap | `GOOGLE_MAPS_SERVER_KEY` not set | Set it, or accept the OSM fallback |
| Map does not render but routing works | `GOOGLE_MAPS_BROWSER_KEY` not set | Set it |
| Maps requests blocked | Monthly ceiling reached | Raise `GOOGLE_MAPS_MONTHLY_LIMIT` or wait for the reset |
| "Unknown configuration field" | Typo'd field name | An ignored key would be a silent no-op, so it is rejected instead |
| Saving blanked a secret | Should not happen — the mask sentinel prevents it | Re-enter the secret; report it |
| 429 | Rate limit | Wait; the window is one minute |
| 428 on an action | Confirmation required | Confirm the summary and retry with the token |

### Disconnect vs Disable

- **Disable** switches the integration off and **keeps the credentials**.
  Re-enabling needs no second consent round trip. This is what most people mean
  by "turn it off".
- **Disconnect** removes the credentials and revokes the token at the provider.
  It is irreversible from JARVIS — reconnecting requires granting consent again.
  Both the UI and the JARVIS tool confirm before doing it.

Disconnect revokes at the provider first (best effort), then locally. Local
revocation happens **even if the provider is unreachable**: a network blip must
not leave a user unable to stop JARVIS holding a credential they asked it to
forget.

---

## Known limitations

- **Meta credentials bind at container build.** Credentials saved through the UI
  are stored and can be verified, but the running agent keeps using the
  server-configured account until the service restarts. Reported honestly in
  `effectiveSource` rather than glossed over.
- **Gmail, Drive, Calendar, YouTube, Sheets and Docs have no tools yet.** The
  OAuth foundation, scope model and permission reporting are in place; the
  provider clients are not. Marked `implemented: false` in the catalogue.
- **Health checks are cached in memory for 10 minutes**, per user, and lost on
  restart. That is correct: after a restart, nothing has been verified.
- **Confirmation tokens are in memory.** Persisting them would create a durable,
  replayable write permit — the opposite of what they are for.
- **`google-maps` API restrictions are not read back from Google.** Verifying
  them would cost a request per API; the UI states the required restriction
  instead.
