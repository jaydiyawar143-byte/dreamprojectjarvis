# JARVIS UI V2 — Auth, Orb, Sidebar & Credential Center

**Final verdict: JARVIS UI V2 — PASS** (with three qualifications recorded in
[Known issues](#known-issues); one of them, Google sign-in, could not be
verified against Google's live servers because this deployment has no OAuth
client credentials.)

Date: 2026-09-08 · Branch: `main` · Stack verified: localhost (:3000/:3001) and
Docker (:3100/:3101)

**Revision 2 — Final visual direction.** The dashboard is now a full-screen
command centre (the BI panels moved to the pages that own them), the Orb is a
four-layer parallax field, the design language is glass, the sidebar scrollbar
is gone, and Browser has a real page. See the Revision 2 sections at the end.

---

## 1. Audit first — what was actually there

The brief said not to code blindly, so the existing architecture was mapped
before anything changed. Five findings shaped every decision that follows.

| Finding | Consequence |
|---|---|
| Tokens lived in `sessionStorage` | This *was* the "log in every time" bug. `sessionStorage` is cleared when the tab closes, by definition. |
| Google sign-in did not exist | `routes/google-auth.ts` is the Google **Ads** connector — every endpoint requires an existing session. Sign-in was new work. |
| `OAuthState.userId` is a required FK to `User` | That table cannot hold state for a *sign-in*, where no user exists yet. Forced a different (and standard) design. |
| `EncryptionService` (AES-256-GCM, versioned envelopes) already existed and was unused | The Credential Center had a correct primitive to build on; no crypto was invented. |
| `VOICE_APPROVAL_POLICY.requiresOnScreenConfirmation` already enforced "voice cannot approve" | The rule was preserved, not reimplemented. |

Two further discoveries changed the shape of the work:

- **The dashboard was a static mockup.** Hard-coded agent names, invented
  confidence percentages ("94%"), a frozen clock ("03:56"), "3 pending". None
  of it came from the API, and five dashboard tests had been failing against it
  at `HEAD` before this sprint started. That was verified by stashing all work
  and re-running the suite on a clean tree.
- **Meta credentials bind at boot.** `createMetaToolRegistry` reads
  `process.env` once, when the container is constructed, and bakes the result
  into a global tool registry.

---

## 2. Persistent login

### What changed

The refresh token moved out of JavaScript's reach entirely, into an **HttpOnly
cookie**. The access token is now held in a module variable and nothing else —
not `localStorage`, not `sessionStorage`, not a readable cookie.

```
login  ──▶ API sets  Set-Cookie: jarvis_rt=…; HttpOnly; SameSite=Lax; Path=/api/v1/auth
       └─▶ body carries accessToken + expiresIn only  (no refreshToken)

reload ──▶ POST /auth/refresh   (no token in body — the browser attaches the cookie)
       └─▶ new accessToken in memory, session restored
```

That single change fixes both problems at once: the session now **survives a
closed tab** (a cookie persists; `sessionStorage` cannot), and an XSS on the app
can no longer read a 7-day credential.

### Design decisions worth stating

- **Additive, not a rewrite.** Programmatic clients (the skill driver, the 23
  API test suites) still post `refreshToken` in the body and still receive it
  back. Only a caller that opts in with `X-Auth-Mode: cookie` gets cookie
  transport, and for that caller the token is *withheld* from the response body.
  Returning both would have defeated the purpose.
- **`AUTH_COOKIE_NAME` is configurable, and is now actually set.** Cookies are
  scoped by host and ignore the port, so `localhost:3001` (local) and
  `localhost:3101` (Docker) would otherwise share one `jarvis_rt` — signing into
  one would silently invalidate the other, since they run separate databases.
  `docker-compose.yml` sets `AUTH_COOKIE_NAME: jarvis_rt_docker`; verified that
  the two stacks now issue `jarvis_rt` and `jarvis_rt_docker` respectively.
- **"Remember me" is honest.** Unticked issues a *session* cookie with no
  `Max-Age`. The client restates the preference on every refresh, because an
  HttpOnly cookie cannot report back whether the browser is holding it as a
  session or persistent one — and the default is "session", so a caller that
  says nothing can never silently upgrade a deliberately temporary login.
- **Legacy tokens are purged.** A browser upgrading from the previous build is
  still holding a real refresh token in `sessionStorage`. Importing the API
  module now deletes it; leaving it would have preserved the exact exposure the
  cookie was introduced to remove.
- **Logout now actually logs out.** The previous `logout()` only cleared the
  in-memory copy — the refresh token stayed valid in the database for its full
  seven days. It now revokes server-side and clears the cookie, and clears local
  state even if the call fails.

### Verified

```
Set-Cookie: jarvis_rt=…; Max-Age=604800; Path=/api/v1/auth; HttpOnly; SameSite=Lax
login body tokens keys:            [ 'accessToken', 'expiresIn' ]      ← no refreshToken
refresh using ONLY the cookie:     success: true                        ← persistence works
legacy body-mode login:            [ 'accessToken','refreshToken','expiresIn' ] ← unbroken
refresh with no session:           401 (was 400)
```

**LOGIN → CLOSE TAB → REOPEN → STILL AUTHENTICATED** is satisfied by the cookie
surviving tab closure and `bootstrapSession()` redeeming it on load.

---

## 3. Google sign-in

Implemented as **OpenID Connect, authorization code + PKCE**, server-side.

- `GET /api/v1/auth/google/start` — issues a signed, HttpOnly state cookie
  carrying a CSRF nonce and the PKCE verifier, then redirects to Google.
- `GET /api/v1/auth/google/callback` — validates state, exchanges the code with
  the client secret over TLS, validates the ID token's claims, and establishes
  **the same HttpOnly session cookie the password flow uses**.

Decisions:

- **State lives in a signed cookie, not `OAuthState`.** That table's `user_id`
  is a NOT NULL foreign key; during sign-in there is no user yet, so there is no
  row to write. This needed no schema change to a table other flows depend on.
- **No token is ever put in a URL.** The redirect carries only a status. Query
  strings end up in history, in `Referer`, and in server logs.
- **Account linking is by *verified* email**, which prevents duplicate accounts.
  An unverified Google address is rejected outright — linking on one would let
  anyone who can name an address claim the JARVIS account that owns it.
- **Availability is a server fact.** The routes mount only when
  `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` exist; the login screen *asks*
  (`/auth/google/status`) rather than trusting a build-time flag that could
  disagree. With no credentials configured the button is not shown at all —
  preserving the previous build's promise never to render a control that cannot
  work.
- **ID token signature is not checked against Google's JWKS**, deliberately. The
  token is not accepted from the browser; it is fetched by the server over TLS
  from Google's token endpoint, authenticated with the client secret. OpenID
  Connect Core §3.1.3.7 explicitly permits TLS server validation in place of
  signature checking for exactly this case. `iss`, `aud`, `exp` and
  `email_verified` are still validated, because TLS proves *who sent* the token,
  not *what it says*.

### Verified (with a throwaway API on :3002 using dummy credentials)

```
/status                        {"enabled":true}
/start  → 302 accounts.google.com/o/oauth2/v2/auth
         ?response_type=code&scope=openid+email+profile
         &code_challenge=…&code_challenge_method=S256&prompt=select_account
         Set-Cookie: jarvis_oauth_state=…; HttpOnly; SameSite=Lax; Max-Age=600
user cancelled  → 302 /login?error=google_cancelled
forged state    → 302 /login?error=google_state_invalid
?next=https://evil.example/pwn  → stored as "/dashboard"   ← open redirect neutralised
```

**Not verified:** the live round trip to Google's servers, which requires real
OAuth client credentials. See [Known issues](#known-issues).

---

## 4. Post-login redirect

`/` and both auth forms now land on **`/dashboard`** (`router.replace`, so a
route the user could not open never becomes a back-button destination). Every
existing route remains directly reachable; `RequireAuth` and the route layouts
are untouched.

The committed skill driver was updated to match — it waited for `**/chat` after
login and would otherwise have broken, taking the project's own tooling with it.

---

## 5. Agent Credential Center

`SETTINGS → CONNECTIONS` (`/settings/connections`), the editable counterpart to
the read-only `/integrations`.

### Three rules

1. **Secrets go in; they do not come back.** The API never returns a stored
   secret. Responses carry a mask. There is no endpoint that reveals one —
   "show it again" is a feature whose only true beneficiary is whoever steals
   the session. Show/Hide reveals only what was typed *this session*, and is
   disabled when the box is empty.
2. **Status is observed, never assumed.** Saving makes a provider
   `CONFIGURED`. Only a **real call to the provider that succeeded** produces
   `CONNECTED`. Those are different words on purpose.
3. **A provider gets a form only if the backend can accept one.**

| Provider | Kind | Why |
|---|---|---|
| Meta Ads | `form` | User-supplied credentials, stored encrypted, verifiable against the Graph API. |
| Google Ads | `oauth` | Established by consent; there is no secret to type. |
| WhatsApp | `server-managed` | Its webhook must verify Meta's signature before any session exists, so it is env-configured at boot. |
| n8n | `server-managed` | Its callback authenticates an HMAC over the raw body; likewise env-configured at boot. |

Rendering editable boxes for WhatsApp or n8n would have been exactly the fake
connected state the brief rules out: the value would be stored and would do
nothing. They are shown read-only, with the reason.

**Browser is deliberately absent** — the browser agent exists server-side, but
there is no credential surface for it and no `/browser` page, so listing it
would have been a fake capability.

### Storage

Per-user rows in the existing `UserSetting` table (unique on `[userId, key]`,
namespaced `credential:<provider>`) — **no migration required**, which mattered
given the migration defect described in §11. Values are AES-256-GCM envelopes
produced by the existing `EncryptionService`. The repository layer deliberately
does not encrypt: keeping the key out of persistence means one place holds
plaintext. `Integration` was **not** used, for the reason its own schema comment
gives — it is global rather than per-user and cannot express tenant isolation.

### Verified against the live API and the real Meta Graph API

```
PUT  /credentials/meta   → status: CONFIGURED
                           values: {"accessToken":"••••••••••••","adAccountId":"act_2478566669291624"}
POST /credentials/meta/test
                         → {"status":"CONNECTED",
                            "detail":"Credentials verified against the Meta Graph API. 1 account(s) visible."}
bad token → test         → {"status":"INVALID",
                            "detail":"Invalid OAuth access token - Cannot parse access token"}
bad account id → save    → INVALID_REQUEST {"adAccountId":["must be digits, optionally prefixed with act_"]}

Postgres row: credential:meta | v1:_b3lD-ro5euV_OJR:HSSfztOd-3bHwMM8MQTQmQ:05sebg…
raw token present in stored value?  NO  ← encrypted at rest
```

Audit entries are written for update / test / remove, recording **field names
only** — a value there would put a live token in the audit log.

---

## 6. The Orb

`three.js` used directly rather than react-three-fiber: disposal stays explicit
(an orb leaking a WebGL context on every route change would degrade the whole
app), and the render loop stays out of React's reconciler, so an audio-rate
animation never triggers a re-render.

### Architecture

```
orb-state.ts    pure, no React, no three.js — the contract BOTH renderers implement
   │            (this is what makes the 2D fallback a real substitute)
   ├─ webgl-orb.tsx   6,000-point shell + 1,400-point core, custom GLSL,
   │                  additive blending, two materials so the core runs hot
   ├─ canvas-orb.tsx  460 points carried in 3D and hand-projected each frame,
   │                  painter's-algorithm sorted — still a volume, not a pulsing div
   └─ jarvis-orb.tsx  picks a renderer, owns the audio taps, maps system state
```

Particles are seeded by **inverse-CDF sampling**; two uniform angles would clump
at the poles and show as two bright spots. The shell uses high radial jitter on
purpose: a thin shell accumulates far more particles along a view ray at the
limb, which additive blending turns into a bright ring with a hole.

The point-size constant is **calibrated, not guessed**. The first implementation
used a perspective constant of 300, which produced ~20px points that fused into
a plasma blob. It is now 46 — roughly two device pixels for a typical particle,
six for the rare large motes.

### Audio reactivity — real, not simulated

Analysis reads **the same microphone stream the recorder is using** and **the
same element the reply plays through**, via `AnalyserNode`. Bands are mapped to
different behaviours so speech looks like speech rather than like a volume
meter:

| Band | Drives |
|---|---|
| RMS level | overall scale, brightness, point size |
| Bass | core swell |
| Mid | outward shell displacement |
| Treble | high-frequency jitter / sparkle |

Attack is fast (a syllable lands) and release is slower (it does not strobe
between words).

**Two rules keep this from breaking voice.** `createMediaElementSource` is
irreversible and single-use, and it re-routes the element away from the
speakers — so the reply element is tapped **only once playback is already
running on a running context**, the source is cached per element, and it is
always wired straight through to `destination`. The microphone tap is read-only
and never stops, mutes or reconfigures a track. Everything degrades to *no
reactivity*, never to *no audio*.

### Voice state mapping

| Voice state | Orb state | Look |
|---|---|---|
| `idle` | idle | slow drift, calm breathing |
| `requesting-permission`, `listening` | listening | particles gather; **full audio gain** |
| `transcribing` | processing | fast internal churn |
| `processing` | processing / executing | violet churn, or orbital motion when a tool runs |
| `speaking` | speaking | **full audio gain**, driven by the reply |
| `error` | error | controlled red |
| `permission-denied`, `unsupported` | idle | *not* an error — typing still works |

Priority is resolved in one place: **offline** outranks everything (claiming to
be "thinking" over a dead connection is a lie), and **awaiting-approval**
outranks all activity, because it is the only state blocked on a human and must
not be buried under a spinner.

Only `listening` and `speaking` have `audioResponse: 1`. If idle reacted at full
gain, room noise would keep the Orb permanently lit and state would stop meaning
anything — this is asserted by a test.

### Verified against a real turn

The Orb is wired to real system events, not to a timer. Driving the command
centre through a genuine agent turn and reading the Orb's own screen-reader
status line:

```
before: "JARVIS status: Ready"
during: "JARVIS status: Thinking"     ← real turn in flight
after:  "JARVIS status: Ready"
reply:  "ORB OK"                       ← returned through the real agent stack
```

### Performance

- Device pixel ratio capped at 1.75.
- The loop **stops** when the tab is hidden or the canvas scrolls out of view
  (`IntersectionObserver` + `visibilitychange`).
- Full disposal on unmount: geometries, both materials, renderer, and
  `forceContextLoss()` — browsers cap live WebGL contexts (commonly 16), and
  without this enough route changes silently stop the orb rendering at all.
- Uniforms ease toward targets frame-rate-independently, so a state change costs
  nothing extra.
- `prefers-reduced-motion` damps motion rather than removing it, so state stays
  readable. Guarded for absent `matchMedia`.
- WebGL is detected by **actually requesting a context** (a driver can refuse
  one on hardware that claims support), and the context is released immediately.
- `three` is code-split to `/dashboard`: **139 kB** there, ~3 kB on other routes.

---

## 7. Sidebar

Collapsed icon rail by default; expands on hover **and on keyboard focus**. The
reveal is pure CSS (`group-hover` / `group-focus-within`) — a JS `mouseenter`
handler would strand tab users on a permanently collapsed rail, since pointer
events do not fire for tab navigation.

The rail **expands over** the content rather than pushing it; the spacer keeps
the collapsed width. Reflowing a dashboard on hover moves the thing the user was
reaching for.

Labels stay in the DOM at all times and are only faded, so a screen reader still
announces "Dashboard" rather than an unlabelled icon. On mobile the existing
drawer is used unchanged — hover is not a gesture there.

### Measured, not assumed

```
collapsed 64px → hover 256px → leave 64px → keyboard focus 256px
label present while collapsed: "Dashboard"
```

### Navigation, regrouped

`Command` (Dashboard, Assistant) · `Intelligence` (Opportunities, Knowledge
Base, Meta Ads) · `Capabilities` (Agents, Automations, Integrations) · `Control`
(Approvals, Activity) · `System` (Health, Settings).

Every entry points at a page that exists. **"Browser" is deliberately omitted** —
there is no `/browser` route, and a nav entry pointing at nothing is a dead link
the sidebar advertises. A test asserts its absence.

---

## 8. Dashboard → command centre

The Orb, one input and a live status readout come **first**; the figures sit
beneath them.

The command centre does **not** own a second chat pipeline — submitting calls
the same `useChatStore.sendMessage` the assistant page uses, so agent routing,
memory, tool allowlists, approvals and audit stay in one place. The status
readout reads the real chat store and the real voice state machine; the approval
line appears only when a pending action genuinely exists in the conversation.

**Every fabricated figure was removed.** The static mockup is gone and the real,
API-backed panels are restored. This is what makes the five dashboard tests pass
again — a dashboard that invents its own numbers is worse than no dashboard,
because it is believed.

Meta panels now correctly show `—` and "Meta returned no rows for these dates.
Nothing has been substituted." rather than zeros.

---

## 9. Security — preserved

| Guarantee | Status |
|---|---|
| **Voice can never approve a write** | **Preserved.** `VOICE_APPROVAL_POLICY` untouched; the command centre reads the same pending-action source, so the Orb and the voice rule cannot disagree. |
| Authentication / authorization | Strengthened (HttpOnly cookie, real logout, rotation on refresh). |
| Tenant isolation | Preserved. Credentials are per-user rows keyed on `userId`. |
| ToolExecutor / approval boundaries | **Untouched.** No change to the write-authorization path. |
| Browser security, Meta write restrictions | Untouched. |
| Socket authentication | Untouched. |
| Audit logging | Extended — credential update/test/remove, field names only. |
| Secrets in browser storage | **None.** Asserted by tests in two suites. |
| Secrets in the shipped client bundle | **None.** The production build was scanned for the live `META_ACCESS_TOKEN`, `JARVIS_ENCRYPTION_KEY`, `JWT_SECRET` and `OPENAI_API_KEY` — all absent. The only inlined value is the non-secret `NEXT_PUBLIC_API_URL`. |
| Secrets in logs | The Google token-exchange error body is deliberately never logged (it can echo the client secret). Encryption errors carry static messages only. |

Additional hardening found and fixed along the way: an **open redirect** in the
OAuth `next` parameter (neutralised and tested), and a **CSRF/replay** window on
the state cookie (single-use, cleared before any outcome).

---

## 10. Test, typecheck, build

| Gate | Result |
|---|---|
| Web tests | **203 passed / 203** (11 files) — was 178 tests with **25 failing** at the start |
| API tests | **648 passed / 648** (23 files) |
| `npx turbo typecheck` | **31/31 successful** |
| `npx turbo build` (production) | **17/17 successful** |
| Full stack smoke (`driver.mjs smoke`) | API health, auth, real `gpt-4o-mini` turn, 5 endpoints, real UI chat |
| Responsive (measured) | mobile 390px and tablet 834px: no horizontal overflow, mic + input reachable, Orb scaled (265px / 384px) |
| Docker stack (production image) | Rebuilt and re-verified: cookie login sets `jarvis_rt_docker`, `/credentials` returns real per-provider status, Google correctly 404s unprovisioned, web + connections page 200, Orb renders identically |

New tests: `test/orb.test.tsx` (15) and `test/credentials.test.tsx` (8).

**Tests that were changed, and why.** `auth-session.test.tsx` and `api.test.ts`
asserted the *old* storage contract — the very thing this sprint removes.
Synchronous token hydration is gone and cannot come back, because obtaining an
access token now requires a network round trip. The guarantees were rewritten
rather than deleted:

- `RequireAuth` still holds protected children back until the session resolves —
  this is what actually prevents the original B1 defect.
- An early request still **succeeds**, via transparent refresh-and-retry.
- **New:** no credential of any kind is written to web storage.
- **New:** simultaneous 401s share **one** refresh — each rotates the token
  server-side, so racing refreshes would invalidate one another and log the user
  out.

---

## 11. Known issues

1. **Google sign-in is unverified against Google's live servers.** This
   deployment has no `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`. Everything up to
   and including the redirect was verified with dummy credentials — URL
   construction, PKCE `S256`, state cookie, cancellation, forged state, open
   redirect — but the code exchange and ID-token validation have not run against
   a real Google response. To activate: create an OAuth client with redirect URI
   `http://localhost:3001/api/v1/auth/google/callback`, set both variables, and
   restart. The button appears on its own.

2. **Stored Meta credentials apply at the next service restart.** The agent tool
   registry binds `process.env` once at container construction. This is reported
   honestly in the UI ("In use: stored (applies at next service restart)")
   rather than glossed over. Re-binding a global, approval-gated tool registry
   per request is a change to the **write-authorization path**, which the brief
   explicitly put out of scope. Test Connection verifies the stored credentials
   for real regardless.

3. **A pre-existing migration defect still blocks fresh databases.**
   `20260824010000_phase117b_outcome_worker` adds enum values `SCHEDULED` /
   `COLLECTING` and then uses `SCHEDULED` as a column default **in the same
   transaction**; Postgres rejects this (`55P04`). It fails on every new volume
   and takes the six migrations after it down with it. It was recovered
   non-destructively for the container database during this session. Not fixed
   here — editing the migration changes its checksum and would trip drift
   detection against the already-migrated local database, so it wants a
   deliberate `migrate resolve` on both. **This is unrelated to UI V2 and
   predates it.**

Minor, expected, non-defects:

- A `401` in the browser console on the login page is the session probe asking
  "do I have a session?" with no cookie. Correct and unavoidable in this
  architecture. The `404`s are `/favicon.ico` (there is no favicon) and
  `/auth/google/status` when Google is unprovisioned.
- `.env` now contains a generated `JARVIS_ENCRYPTION_KEY`. **Production must use
  its own distinct key** — credentials encrypted under this one cannot be read
  without it. It is not committed (`.env` is gitignored); `.env.example` already
  documented both variables.

---

## 12. Files changed

**New — API**
`apps/api/src/lib/auth-cookies.ts` · `apps/api/src/routes/google-signin.ts` ·
`apps/api/src/routes/credentials.ts`

**New — packages**
`packages/db/src/repositories/credential-repository.ts`

**New — web**
`apps/web/src/components/orb/{orb-state.ts,webgl-orb.tsx,canvas-orb.tsx,jarvis-orb.tsx}` ·
`apps/web/src/components/dashboard/command-center.tsx` ·
`apps/web/src/lib/voice/audio-analyser.ts` ·
`apps/web/src/app/auth/google/page.tsx` ·
`apps/web/src/app/settings/connections/page.tsx` ·
`apps/web/test/{orb.test.tsx,credentials.test.tsx}`

**Modified — API / packages**
`apps/api/src/index.ts` (mount Google sign-in + credentials) ·
`apps/api/src/routes/auth.ts` (cookie transport, real logout, 401 on no session) ·
`packages/security/src/auth-service.ts` (`loginWithVerifiedIdentity`) ·
`packages/config/src/index.ts` (Google sign-in config gate) ·
`packages/db/src/index.ts`

**Modified — web**
`src/lib/api.ts` · `src/lib/auth.tsx` · `src/lib/voice/{voice-store,audio-capture,audio-playback}.ts` ·
`src/app/page.tsx` · `src/app/dashboard/page.tsx` · `src/app/settings/page.tsx` ·
`src/components/auth/{auth-experience,auth-console,social-auth}.tsx` ·
`src/components/dashboard/{dashboard-shell,dashboard-sidebar,nav}.ts[x]` ·
`package.json` (+`three`, +`@types/three`)

**Modified — tests & tooling**
`apps/web/test/{api,auth-session,dashboard,knowledge-panel}.test.*` ·
`docker-compose.yml` (isolated session cookie for the container stack) ·
`.claude/skills/run-jarvis/driver.mjs` (login now lands on `/dashboard`;
`seedAuth` is now a documented no-op, since seeding `sessionStorage` no longer
establishes anything) · `pnpm-lock.yaml` · `.env` (encryption key, untracked)

---

## Verdict

**JARVIS UI V2 — PASS**

All twenty sections are implemented and verified against the running stack, with
the three qualifications above stated plainly rather than papered over. The
sprint additionally repaired five dashboard tests that were already failing at
`HEAD`, removed a page of fabricated metrics, and closed a real
refresh-token-in-`sessionStorage` exposure.

---

# Revision 2 — Final visual direction

## 13. The dashboard is now only a command centre

Orb, one input, one status line, and an approval panel **only when something is
genuinely waiting on a human**. Nothing else.

The queue counts, four Meta KPIs and two charts that sat beneath the Orb were
not deleted — every one of them already existed on the page that owns it:

| Was on the dashboard | Now lives at |
|---|---|
| Pending approvals | `/approvals` |
| Open opportunities | `/opportunities` |
| Documents | `/knowledge` |
| Spend · Impressions · Clicks · ROAS, both charts | `/meta-ads` (identical `StatPanel`s and `ChartPanel`s) |
| Conversations | `/chat` |

Test coverage moved with them rather than being dropped: the dashboard's copies
duplicated assertions that `meta-panel.test.tsx` already makes — *"renders KPI
cards from real totals"*, *"writes an em dash for a metric Meta did not
report"*, *"says the deployment has no account rather than showing zeros"*,
*"offers a retry when the metric endpoints all fail"*. The duplicates went; the
guarantees stayed. A new dashboard test asserts the BI surface is **absent**, so
it cannot quietly grow back.

## 14. The Orb, rebuilt in four layers

| Layer | Radius | Role | Motion |
|---|---|---|---|
| `core` | 0.72 | dense, hot energy source; bass swells it | counter-rotates x1.7 |
| `shell` | 1.62 | the body; mid frequencies push it outward | baseline |
| `halo` | 2.25 | sparse atmosphere | x0.45, half tilt |
| `orbital` | 1.98 | flattened, tilted band | x2.4, precesses |

Rotating four clouds at **different rates about different axes** is what
produces parallax; one cloud, however dense, always reads flat. Each layer has
its own `uIntensity` so the core genuinely reads as a core.

**A performance bug found by looking at it.** The Orb rendered as thin dust on a
perfectly capable machine. The cause was my own budget heuristic: it stepped
down whenever `hardwareConcurrency <= 4`, and the test machine reports 4 cores
with 16 GB — so it was drawing **45%** of the particles for no reason. That was
the wrong question to ask: drawing points is GPU/fill-rate work, not CPU work.
The heuristic now keys on viewport size and reported memory, defaults to the
full budget, and leaves the real safety nets (pixel-ratio cap, visibility pause)
unconditional. Five tests pin the policy, including a named regression guard.

## 15. Glassmorphism

Three utilities in `globals.css`: `.glass-panel` (translucent gradient plus
`backdrop-filter`), `.glass-edge` (a single hairline top highlight — ringing all
four sides reads as a selection state), and `.orb-atmosphere` (a soft radial
floor behind the Orb). The composer, the approval panel and the approval card
all use them. One accent family, low-opacity borders; no neon.

`ApprovalCard` was restyled onto the same language and picked up two fixes while
there: its status badge used to render the literal internal string **"idle"**,
which now reads *"Awaiting decision"*, and **Reject now precedes Approve** —
Approve is the irreversible one and should not sit where the hand lands first.

## 16. Scrollbars and overflow

`.no-scrollbar` on the sidebar nav removes the ornament while leaving wheel,
trackpad, touch and keyboard scrolling untouched. Applied to one deliberately
chosen container, not globally: hiding the scrollbar on a long document removes
the only cue that there is more to read.

A **real horizontal-overflow regression** was found by measuring rather than
eyeballing — a 1440px viewport was producing a 1688px page. The cause was
`.orb-atmosphere`, inset negatively so its blur has room to fall off. It is now
clipped by its own container, which fixes it at the source instead of relying on
the global `overflow-x` guard to hide the symptom.

```
desktop  docScrollWidth 1440  bodyScrollWidth 1440  innerWidth 1440
mobile   docScrollWidth  390  bodyScrollWidth  390  innerWidth  390
sidebar  scrollbar gutter 0px, scrollbar-width: none
```

## 17. Browser

You listed Browser under CAPABILITIES twice. There is a real `browser-agent` in
the registry, but no `/browser` page — so rather than drop the item again or add
a dead link, `/browser` now exists and reports the agent's **live** registration
state. On this deployment that is `UNAVAILABLE`, and the page says so plainly
along with what would switch it on (`BROWSER_ENABLED=true`).

It offers **no controls** by design: browsing runs through the assistant so each
action passes the approval gate and lands in the audit trail. A "go to URL" box
would be a second route to the same side effects that skipped both.

## 18. Approval, verified against a real record

`ApprovalCard` is **reused, not reimplemented** — the command centre renders the
same component as `/approvals`, so there is exactly one decision path. That is
what keeps "voice can never approve" true.

The approvals API now returns the tool's **real declared risk**, read from the
same registry that gates execution, so the panel can say how much is at stake.
An unknown tool reports nothing rather than a guessed default — verified
accidentally when a fixture named a tool that does not exist and the badge
correctly stayed blank.

Verified by seeding a genuine pending approval into the dev database:

```
orb status : "JARVIS status: Waiting for your approval"   <- Orb turns amber
readout    : "An action is waiting for your decision. Voice cannot approve it"
panel      : meta.campaign.budget.update - SPENDS MONEY - AWAITING DECISION
             Expires ... - Parameters (2) - REJECT - APPROVE
footer     : "VOICE CAN NEVER APPROVE AN ACTION"
```

The fixture was removed afterwards. The six pending approvals still in the
database predate this session and belong to other users — the driver's dashboard
correctly showed none, which is tenant isolation working.

## 19. Voice reactivity, proven with real audio

Driven through Chrome's fake capture device, which emits an actual tone, with
`AnalyserNode.getByteTimeDomainData` instrumented to observe what the Orb is
being fed (app code untouched):

```
before : "JARVIS status: Ready"
during : "JARVIS status: Listening"      <- 143 analyser reads
                                            peak amplitude 128 (max deviation)
after  : "JARVIS status: Thinking"
```

Non-zero audio, sampled continuously, driving a visibly different Orb. Not a
looping animation.

That test also caught a copy bug of my own: the hint read *"hold the microphone
to speak"*, but `MicButton` is click-to-**toggle** (`onClick`), not
push-to-talk. The copy now says "tap", which is what actually works.

## 20. Revision 2 gates

| Gate | Result |
|---|---|
| Web tests | **209 passed / 209** (11 files) |
| API tests | **648 passed / 648** (23 files) |
| `npx turbo typecheck` | **31/31 successful** |
| `npx turbo build` | **17/17 successful** |
| Horizontal overflow | none, desktop and mobile (measured) |
| Sidebar scrollbar | none; rail still 64px to 256px on hover **and** keyboard focus |
| Orb voice reactivity | 143 analyser reads, peak amplitude 128 |
| Approval safety | one shared `ApprovalCard`; voice path unchanged |
| Mobile / tablet | drawer nav, Orb scaled, mic and input reachable |

## Revision 2 files

**New:** `apps/web/src/app/browser/{page,layout}.tsx`

**Rewritten:** `components/orb/webgl-orb.tsx` (four layers, budget fix) ·
`components/dashboard/command-center.tsx` (approval panel, glass) ·
`app/dashboard/page.tsx` (command centre only)

**Modified:** `app/globals.css` (glass, scrollbar and overflow utilities) ·
`components/approval-card.tsx` (glass, risk badge, button order, "idle" label) ·
`components/dashboard/{nav.ts,dashboard-sidebar.tsx}` (Browser entry,
`.no-scrollbar`) · `apps/api/src/routes/approvals.ts` (returns real `risk`) ·
`lib/api.ts` (`risk` on `ApprovalRecord`) ·
`test/{dashboard,orb}.test.tsx`

---

## Verdict, revision 2

**JARVIS UI V2 — PASS**

The three qualifications from revision 1 stand unchanged: Google sign-in is
complete but has never talked to Google (no OAuth credentials here); stored Meta
credentials apply at the next restart; and the pre-existing enum migration
defect still blocks fresh databases.
