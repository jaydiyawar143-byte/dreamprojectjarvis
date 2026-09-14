# JARVIS Codebase Audit and Cleanup Plan

**Date:** 2026-09-14
**Branch audited:** `feat/p1-3-eslint` (base `ec2e895`), with the uncommitted ESLint work present
**Scope:** this monorepo only. Nothing was deployed, no production system was touched, no secret value was printed.

This document has three parts:

1. **Audit** — what exists, what works, what is broken, duplicated, unused or risky, with the evidence for each claim.
2. **Cleanup plan** — the exact, ordered changes, each with its own verification.
3. **Cleanup results** — appended once the plan has been executed.

---

## How to read this

### Status labels

| Label | Meaning |
|---|---|
| 🟢 WORKING | Used, and verified to work |
| 🟡 DUPLICATE | Does a job something else already does |
| 🔴 BROKEN | Fails today |
| ⚠️ UNUSED | Exists and may work, but nothing reaches it |
| ⚠️ DEAD CODE | Unused **and** non-functional or superseded — proven safe to remove |
| ⚠️ SECURITY RISK | Exposes data, credentials or an attack surface |
| ⚠️ MISPLACED | Works, but lives somewhere a reader would not look |
| ❓ UNKNOWN | Evidence is not enough to decide; left alone |

### Evidence labels

Every factual claim carries one of these, so nothing here is mistaken for proof it is not.

| Label | Meaning |
|---|---|
| **RUN** | Verified by running a command during this audit |
| **READ** | Verified by reading the source; not executed |
| **INHERITED** | Taken from an earlier document without re-checking |
| **NOT VERIFIED** | Not checked |

---

# Part 1 — Audit

## 1. Summary for the owner

JARVIS is in far better shape than a "messy codebase" description suggests. It already has a clean, enforced structure. The problems are real but specific, and none of them requires rebuilding anything.

**What is good**

- The code is split into 18 separate workspaces with strict rules about who may depend on whom. The rules are enforced by the package manager, not just by convention. **READ**
- 4,609 automated tests pass today. **RUN**
- The write-safety design (approvals, confirmations, execution journal) is careful and deliberate. **READ**
- No live credential was found in the code or in its git history. **RUN**

**What is wrong, in order of seriousness**

1. **A full database backup is committed to git and pushed to GitHub.** It contains names, email addresses (6 of them real Gmail accounts), password hashes, refresh-token hashes, IP addresses and chat history. This is the most important finding in the audit and needs a decision from you. See §7, SEC-1.
2. **Six memory tests fail every time**, while the project ledger describes them as merely "flaky". See §8, B-1.
3. **OAuth sign-in codes are written to the server's request log.** See §7, SEC-2.
4. **Dead code that looks alive:** two memory classes that silently throw data away, four broken scratch scripts, unused packages, a superseded SQL file.
5. **Documentation that misleads:** the README describes folders that do not exist, the environment template tells you to use a file the API never reads, and 29 reports clutter the repository root.

**The one big decision this audit makes for you:** the codebase should **not** be moved into a single `src/` folder. §2 explains why with evidence. Every concept in the target architecture already has one obvious home; it is just named differently.

## 2. Architecture decision: keep the package structure

The brief's target tree is explicitly "a target, not a command", to be adapted when the technology requires it. The technology here requires it.

### Why a flat `src/` would make things worse

| Evidence | Consequence of flattening |
|---|---|
| Dependency rules are real package boundaries. `@jarvis/tools` depends only on `@jarvis/core`, so a tool *cannot* import the database or an HTTP client. **READ** (`packages/tools/package.json`) | In one `src/` tree any file can import any other, and the rule becomes a comment. |
| The workspace graph is acyclic: `core` and `config` are leaves; `tools → core`; `agents → core, tools`; `memory → ai-openai, core, db`; `db → core, security`. **READ** | Cycles would stop being impossible. |
| 4,609 tests and every build resolve `@jarvis/*` package names. **RUN** | Hundreds of import rewrites, for zero behavioural gain and real breakage risk. |
| Turborepo caches build, test and lint **per package**. **RUN** (lint: 84 ms fully cached) | One package means one cache key; every change rebuilds everything. |

### Where each target concept already lives

This table is the canonical map. It is also added to `AGENTS.md`, so coding agents find it first.

| Target concept | Canonical home in this repository | Notes |
|---|---|---|
| `apps/api` | `apps/api` | Express + Socket.IO. Routes, middleware, composition root. |
| `apps/web` | `apps/web` | Next.js 14 App Router. |
| `apps/worker` | *none* | No separate worker process exists. Not created. |
| `src/core` — the JARVIS brain | `packages/agents` | `orchestrator.ts`, `agent-router.ts`, `tool-planner.ts`, `intent-detector.ts`, `agent-policy.ts`, `temporal-context.ts`, `knowledge-context.ts`, `agents/` |
| *(contracts — not in the brief)* | `packages/core` | **Name collision:** here `core` means shared types and Zod contracts, with no I/O. It is not the brain. |
| `src/memory` | `packages/memory` | Storage and vector search live in `packages/db/src/repositories`. See `docs/MEMORY.md`. |
| `src/skills` | `packages/agents/src/agents` + allowlists in `agent-policy.ts` | JARVIS has no runtime "skill" object. A capability is a domain agent plus the tools it may call. See `docs/SKILLS.md`. |
| `src/tools` | `packages/tools` | Tools receive *ports*; they never call providers directly. |
| `src/integrations` | `packages/ai-openai`, `ai-anthropic`, `ai-elevenlabs`, `meta-graph`, `google-ads`, `google-workspace`, `whatsapp`, `n8n`, `browser` | One package per provider. Widget data providers are the exception — see I-24. |
| `src/database` | `packages/db` | One Prisma schema, one `PrismaClient`, 23 migrations, repositories. |
| `src/config` | `packages/config` | Plus a small `config.ts` inside each integration package. See §6. |
| `src/utils` | `packages/core/src/utils` | Generic, I/O-free helpers. |
| *(security — not in the brief)* | `packages/security` | Password hashing, JWT, encryption, RBAC, approvals, audit. |
| `tests/` | `test/` inside each workspace | Each workspace runs its own Vitest config. |
| `scripts/` | `apps/api/scripts/`, `.claude/skills/run-jarvis/` | |
| `docs/` | `docs/` | Reports consolidate into `docs/reports/` (Part 2, Task 8). |

**Also not created:** `src/skills/`, `src/utils/`, `apps/worker/`, `tests/unit|integration|e2e`. Creating empty or duplicate homes is exactly what the brief forbids.

## 3. Repository inventory

| Area | Count | Evidence |
|---|---|---|
| Tracked files | 961 — `packages` 431, `apps` 285, `.claude` 182, `docs` 21, root 42 | **RUN** `git ls-files` |
| Workspaces | 18 — 2 apps, 16 packages | **READ** |
| API route modules / endpoints | 24 modules, 116 endpoints | **READ** |
| Web pages / components | 21 pages, 70 components | **READ** |
| Database | 27 models, 11 enums, 23 migrations, 44 indexes, `vector(1536)` on 2 tables | **READ** `schema.prisma` |
| Tool modules / tool ids | 25 modules, ~60 tool ids | **READ** |
| Domain agents | 9 | **READ** `agent-policy.ts` |
| Test files | 181 — 164 run today, 17 in `@jarvis/db` | **RUN** |
| Root-level markdown | 32 — README, AGENTS, the ledger, and 29 reports | **RUN** |
| Environment files on disk | 4 — only `.env.example` is tracked | **RUN** |
| `process.env` reads in source | 141 across 14 workspaces | **RUN** |

### Test baseline before any cleanup — RUN

`npx turbo run test --concurrency=1 --continue --filter='!@jarvis/db'`

| Workspace | Passed | Failed | Skipped |
|---|---|---|---|
| tools | 734 | 0 | 0 |
| web | 552 | 0 | 0 |
| core | 541 | 0 | 0 |
| agents | 498 | 0 | 0 |
| memory | 453 | 0 | 0 |
| browser | 201 | 0 | 0 |
| meta-graph | 103 | 0 | 0 |
| google-ads | 82 | 0 | 0 |
| whatsapp | 76 | 0 | 0 |
| security | 73 | 0 | 0 |
| n8n | 65 | 0 | 0 |
| config | 28 | 0 | 0 |
| ai-elevenlabs | 24 | 0 | 0 |
| google-workspace | 20 | 0 | 0 |
| ai-openai | 16 | 0 | 0 |
| **api** | **1,143** | **6** | **8** |
| **Total** | **4,609** | **6** | **8** |

`ai-anthropic` has no tests. `@jarvis/db` needs a live Postgres and was not run; the ledger records 188 passed and 8 failed there (**INHERITED**).

Also **RUN** on this branch: typecheck 33/33, build 18/18, lint 18/18.

## 4. Findings by area

### 4.1 Backend — `apps/api`

| Item | Status | Evidence |
|---|---|---|
| Express app, 24 routers, DI container, graceful shutdown, `/health`, `/live`, `/ready` | 🟢 WORKING | 1,143 API tests pass. **RUN** |
| Every router except `health` applies auth middleware | 🟢 WORKING | **READ** |
| Unauthenticated endpoints verify on their own: WhatsApp webhook (HMAC signature and challenge), Google sign-in callback (HMAC-signed state, constant-time compare) | 🟢 WORKING | **READ** |
| Routes mounted only when configured: WhatsApp, n8n, voice, Google sign-in, `/credentials` and `/google` (need `JARVIS_ENCRYPTION_KEY`) | 🟢 WORKING | **READ** `index.ts:152-547` |
| Access log writes full URLs including OAuth `code` and `state` | ⚠️ SECURITY RISK | SEC-2 |
| Two `/capabilities` endpoints: `/api/v1/command-center/capabilities` (which widgets this deployment can feed) and `/api/v1/capabilities/*` (integration capabilities) | 🟢 WORKING — different jobs, similar names | **READ** |
| `/api/v1/recommendations/:id/outcome` is served by `outcomes.ts`, while the rest of `/recommendations/*` is served by `recommendations.ts` | ⚠️ MISPLACED — minor | I-25 |
| Widget providers (weather, market, geo, system monitor, maps) live in `apps/api/src/services/providers` | ⚠️ MISPLACED — acceptable | I-24 |
| `apps/api/test-auth.ts`, `test-orchestrator.ts`, `test-ai-provider.ts`, `test-openai-adapter.ts` | 🔴 BROKEN + ⚠️ DEAD CODE | I-08 |

### 4.2 Frontend — `apps/web`

| Item | Status | Evidence |
|---|---|---|
| 21 pages, 70 components, Zustand stores, widget system | 🟢 WORKING | 552 web tests pass. **RUN** |
| All HTTP goes through `src/lib/api.ts`; no stray `fetch()` | 🟢 WORKING | **RUN** grep |
| Only `NEXT_PUBLIC_API_URL` reaches the browser bundle | 🟢 WORKING | **RUN** grep |
| `/hero-preview` route and `components/ui/home-hero-landing-scroll-animation.tsx` | ⚠️ UNUSED — intent unclear | I-14 |
| Unused dependencies: `axios`, `class-variance-authority`, `motion`, `next-auth`, `zod`, `@jarvis/security` | ⚠️ DEAD CODE | I-11 |
| `isWidgetId` defined in both `widgets/layout.ts` and `widgets/registry.ts` | 🟢 WORKING — **not** a duplicate: layout also includes `orb` and `worldclock` | **RUN** |

### 4.3 The JARVIS brain — `packages/agents`

| Item | Status | Evidence |
|---|---|---|
| Orchestrator, router, tool planner, intent detector, policy | 🟢 WORKING | 498 tests. **RUN** |
| 9 domain agents, each with an explicit tool allowlist | 🟢 WORKING | **READ** `agent-policy.ts` |
| One system prompt for the assistant, built in `apps/api/src/services/container.ts`; separate prompts for diagnosis (`packages/core`) and memory extraction (`packages/memory`) | 🟢 WORKING — three prompts, three jobs, no competing copies | **RUN** grep |
| `MockAIProvider` exported from the production barrel | ⚠️ MISPLACED | I-23 |

### 4.4 Memory — `packages/memory`

The live memory system is one chain, wired in `apps/api/src/services/container.ts:1035-1082`. **READ**

```
PrismaMemoryRepository ─┐
OpenAIEmbeddingProvider ├─► Orchestrator ─ recall before a reply, extract after
MemoryExtractionService ┘
KnowledgeRetrievalService ─► Orchestrator ─ document search (RAG)
```

| Item | Status | Evidence |
|---|---|---|
| `PrismaMemoryRepository` (store, recall, list) | 🟢 WORKING | **READ**, memory tests **RUN** |
| `MemoryExtractionService` | 🟢 WORKING | **READ** |
| Chunking, embedding and retrieval services for documents | 🟢 WORKING | **READ** |
| `MemoryManager` — `store()` logs and discards, `recall()` always returns `[]` | ⚠️ DEAD CODE | I-04 |
| `KnowledgeBase` — `ingestDocument()` returns a random id, `query()` returns `[]` | ⚠️ DEAD CODE | I-05 |
| Deprecated `MemoryManager` interface in `packages/core/src/types/agent.ts` | ⚠️ DEAD CODE | I-06 |
| `MemoryEngine` — a real, tested wrapper that production does not use | ⚠️ UNUSED | I-07 |
| End-to-end memory tests | 🔴 BROKEN | B-1 |

**Competing memory managers:** after Task 3 exactly one runtime path remains. `MemoryEngine` is kept pending your decision (D-4), because it is tested and working, just unwired.

### 4.5 Tools — `packages/tools`

| Item | Status | Evidence |
|---|---|---|
| Registry, executor, execution journal, output sanitizer, startup recovery, reconciliation | 🟢 WORKING | 734 tests. **RUN** |
| 25 tool modules; one tool id per external operation, no per-agent copies | 🟢 WORKING | **READ** |
| Mock providers (`*-mock.ts`) exported from the production barrel, used by 30 test files | ⚠️ MISPLACED | I-23 |

### 4.6 Integrations

| Package | Status | Tests |
|---|---|---|
| `ai-openai` — chat, embeddings, vision, voice | 🟢 WORKING | 16 |
| `ai-elevenlabs` — text-to-speech | 🟢 WORKING | 24 |
| `ai-anthropic` — Claude adapter | ⚠️ UNUSED — imported by nothing, no tests | 0 — I-15 |
| `meta-graph` | 🟢 WORKING | 103 |
| `google-ads` | 🟢 WORKING in code; live grant lacks the `adwords` scope | 82 — B-4 |
| `google-workspace` | 🟢 WORKING | 20 |
| `whatsapp` | 🟢 WORKING | 76 |
| `n8n` | 🟢 WORKING | 65 |
| `browser` | 🟢 WORKING | 201 |

All AI SDK clients are constructed inside their adapter package, except two `new OpenAI()` calls in the dead memory stubs (I-04, I-05). **RUN**

### 4.7 Database — `packages/db`

| Item | Status | Evidence |
|---|---|---|
| One `PrismaClient`, in `packages/db/src/index.ts` | 🟢 WORKING | **RUN** grep; the only other two are in dead scratch scripts |
| Five raw SQL calls using Prisma's "Unsafe" variants, all for pgvector | 🟢 WORKING — parameterised with `$n` placeholders; column names are literals | **READ** |
| `fix-enums.sql` at the repository root | ⚠️ DEAD CODE | I-09 |
| `packages/db/.env` holding a copy of `DATABASE_URL` | 🟢 WORKING — required by the Prisma CLI | I-28 |

### 4.8 Authentication and authorisation — `packages/security`

| Item | Status | Evidence |
|---|---|---|
| scrypt passwords, JWT access tokens, hashed rotating refresh tokens | 🟢 WORKING | 73 tests. **RUN** |
| One verifier for HTTP and Socket.IO: both call `TokenService.verifyAccessToken` | 🟢 WORKING — no competing auth systems | **READ** |
| Refresh token optionally in an HttpOnly, `SameSite=Lax` cookie; access token header-only | 🟢 WORKING — CSRF does not apply to state-changing routes | **READ** `auth-cookies.ts` |
| `next-auth` installed in web, imported nowhere | ⚠️ DEAD CODE | I-11 |

### 4.9 Configuration and environment — see §6

### 4.10 Utilities

`packages/core/src/utils` holds genuinely generic helpers: parameter hashing, secret redaction, identifier masking. No business logic was found there. 🟢 **READ**

### 4.11 Tests

| Item | Status |
|---|---|
| 181 test files, colocated per workspace | 🟢 WORKING |
| `apps/api/test/sprint-1.1d-memory-e2e.test.ts`, 6 of 13 failing | 🔴 BROKEN — B-1 |
| No continuous integration anywhere; no `.github/` | ⚠️ SECURITY RISK — SEC-7 |

Tests are **not** moved into a root `tests/` folder: each workspace's Vitest config resolves paths from its own folder.

### 4.12 Scripts

| Item | Status |
|---|---|
| `apps/api/scripts/phase116b/*` — the Phase 11.6B real-account smoke test, cited by four documents | 🟢 WORKING, historical |
| `apps/api/scripts/phase116b/state.json` holds real account identifiers (not credentials) | ⚠️ SECURITY RISK — informational, I-26 |
| `.claude/skills/run-jarvis/*.mjs` — the browser driver used for dashboard verification | 🟢 WORKING |
| `.claude/skills/run-jarvis/backups/jarvis-data-20260903-154135.sql` | ⚠️ SECURITY RISK — SEC-1 |

### 4.13 Documentation

| Item | Status |
|---|---|
| `AGENTS.md` | 🟢 WORKING — accurate, but its layout table lists 8 of 18 workspaces |
| `README.md` — claims `packages/integrations/`, `docker/`, "Express/Fastify", and says to copy the template to `.env.local` | 🔴 BROKEN — all four claims are false. I-21 |
| `docs/ARCHITECTURE.md` — describes Fastify and Redis | ⚠️ DEAD CODE — superseded by `docs/JARVIS_ARCHITECTURE.md`. I-20 |
| `docs/JARVIS_ARCHITECTURE.md` | 🟢 WORKING, detailed pipeline history; its environment table lists four variables nothing reads |
| `docs/JARVIS_CAPABILITY_MATRIX.md` | 🟢 WORKING but stale — stops at Phase 11.9B |
| `docs/JARVIS-Project-Guide.doc` — the Master Development Document | 🟢 WORKING but stale — last updated 2026-08-22, after Phase 10.7 |
| 29 phase and sprint reports at the repository root | ⚠️ MISPLACED — I-19 |
| `docs/CONTRACTS.md`, `docs/INTEGRATIONS.md`, `docs/JARVIS_USER_MANUAL.md`, `docs/phases/*` | ❓ UNKNOWN — accuracy **NOT VERIFIED** |

### 4.14 Dependencies

Declared dependencies with no import anywhere in source, tests or config. **RUN**, then each checked by hand.

| Workspace | Dependency | Verdict |
|---|---|---|
| web | `axios`, `class-variance-authority`, `motion`, `next-auth`, `zod` | ⚠️ DEAD — remove |
| web | `@jarvis/security` (plus its `transpilePackages` entry) | ⚠️ DEAD — remove; a server-side crypto package has no place in the browser build |
| api | `jsonwebtoken`, `@types/jsonwebtoken` | ⚠️ DEAD once the scratch scripts go; `@jarvis/security` owns JWT |
| memory | `openai` | ⚠️ DEAD once the two stubs go |
| web | `jsdom`, `postcss`, `autoprefixer` | 🟢 false positives — used by Vitest and PostCSS config |
| web | `gsap`, `swiper` | ⚠️ UNUSED outside `/hero-preview` — decided with D-2 |

No circular dependency exists at package level. **READ**

## 5. Duplicate functionality

Functionality was compared by behaviour, not by name.

| Candidate | Verdict | Evidence | Action |
|---|---|---|---|
| `MemoryManager`, `KnowledgeBase` vs the live memory services | 🟡 + ⚠️ DEAD stubs | Zero references anywhere. **RUN** | Remove — Task 3 |
| `MemoryEngine` vs repositories used directly by the orchestrator | 🟡 overlapping | Tested; not wired. **RUN** | Keep — D-4 |
| `hashParams` in `confirmations.ts` vs `computeParamsHash` in `@jarvis/core` | 🟡 true duplicate, and the weaker one | Collides on nested objects and arrays; core does not. **RUN** | Migrate — Task 4 |
| `motion` vs `framer-motion` | 🟡 | `motion` has 0 importers, `framer-motion` 14. **RUN** | Remove `motion` — Task 6 |
| Two root `.env` loaders (`packages/config` and `apps/api/src/config/env.ts`) | 🟢 not a duplicate | Each covers a different working directory. **READ** | Keep; document — Task 7 |
| Two `isWidgetId` | 🟢 not a duplicate | Different id sets. **RUN** | Keep |
| Two `/capabilities` endpoints | 🟢 not a duplicate | Different purposes. **READ** | Keep; documented in `docs/API.md` |
| `redactSensitiveInfo` in google-ads, n8n, whatsapp vs core `redactSecrets` | 🟢 not a duplicate | Provider-specific token patterns. **READ** | Keep |
| `calculateRetryDelay` / `executeWithRetry` in ai-openai and ai-anthropic | 🟡 near-identical | Differ only in the error classifier and key pattern. **RUN** `diff` | Keep until D-3 decides `ai-anthropic` |
| `buildBaseUrl` in meta-graph and whatsapp | 🟡 same three-line shape | Different hosts and config types. **READ** | Keep — sharing it would add a cross-package dependency for three lines |
| `validateDateRange` in google-ads-tools and meta-ads-validators | 🟢 not a duplicate | Different signatures and contracts. **READ** | Keep |
| Per-provider `toJarvisError`, `extractError`, `isSuccessResponse` | 🟢 pattern | One adapter per provider. **READ** | Keep |
| Web `getWeather`, `listIntegrations`, … vs API services of the same name | 🟢 not a duplicate | Web versions are HTTP client wrappers. **READ** | Keep |
| `PrismaClient` ×3 | 🟡 | Two are in dead scratch scripts. **RUN** | Removed by Task 2 |
| `docs/ARCHITECTURE.md` vs `docs/JARVIS_ARCHITECTURE.md` | 🟡 | Legacy one has false claims. **RUN** | Archive the legacy file; write an accurate one — Tasks 8, 9 |

**Conclusion:** there are no competing memory managers once Task 3 lands, no competing auth systems, no competing database clients, no competing AI clients outside dead code, and no duplicate web-search or tool handlers.

## 6. Environment variables

### Files

| File | Tracked | Read by | Verdict |
|---|---|---|---|
| `.env` (root) | No — gitignored, never in history. **RUN** | API, all packages | 🟢 canonical |
| `.env.example` (root) | Yes — placeholders only. **RUN** | Humans | 🔴 incomplete and misleading — I-16 |
| `packages/db/.env` | No | Prisma CLI — looks for `.env` beside the schema | 🟢 required by the framework — I-28 |
| `apps/web/.env.local` | No | Next.js — reads env files from its own folder | 🟢 required by the framework — I-28 |

### Loading chain — READ

1. `@jarvis/config` calls `dotenv.config()` on import, which loads `./.env` from the working directory. This is what makes a launch **from the repository root** find the root `.env` — which is how the Dockerfile starts the API.
2. `apps/api/src/config/env.ts` loads `../../.env`, which is what makes a launch **from `apps/api`** find it (`pnpm dev`).
3. `env.ts` *also* tries `.env.development`, `.env.production`, `.env.staging` and `.env.local` inside `apps/api`. None exists. These lines only invite scattered env files — I-17.

### Centralised configuration

A central layer already exists — `getEnv()` and `getServerEnv()` in `packages/config` — but only 141 direct `process.env` reads remain scattered across 14 workspaces. They are **not** all migrated in this cleanup: many tests set `process.env.X` immediately before constructing a service, and reading configuration once at import time would break that isolation. The per-integration `create*Config(input)` functions — explicit input, `process.env` as fallback — are the pattern new code should follow. Migrating the remaining API-level reads is recommended follow-up work, not a cleanup step.

### Variable names

**Read by code but missing from `.env.example`:** `ANTHROPIC_API_KEY`, `API_PUBLIC_URL`, `AUTH_COOKIE_NAME`, `BROWSER_DOMAIN_ALLOWLIST`, `BROWSER_DOWNLOAD_DIR`, `BROWSER_ENABLED`, `BROWSER_HEADLESS`, `BROWSER_MAX_DOWNLOAD_BYTES`, `BROWSER_MAX_EXTRACT_CHARS`, `BROWSER_MAX_SESSIONS`, `BROWSER_NAVIGATION_TIMEOUT_MS`, `BROWSER_SESSION_TIMEOUT_MS`, `CHROME_PATH`, `CLAUDE_DEFAULT_MODEL`, `CLAUDE_MAX_RETRIES`, `CLAUDE_TIMEOUT_MS`, `GOOGLE_SIGNIN_REDIRECT_URI`, `JARVIS_ALLOW_LOCAL_ORIGIN`, `JARVIS_IN_CONTAINER`, `JARVIS_SHUTDOWN_GRACE_MS`, `OPENAI_DEFAULT_MODEL`, `OPENAI_MAX_RETRIES`, `OPENAI_STT_LANGUAGE`, `OPENAI_STT_MODEL`, `OPENAI_TIMEOUT_MS`, `OPENAI_TTS_INSTRUCTIONS`, `OPENAI_TTS_MODEL`, `OPENAI_TTS_SPEED`, `OPENAI_TTS_VOICE`, `OPENAI_VISION_MODEL`, `PORT`, `TRUST_PROXY`, `VOICE_ENABLED`, `VOICE_MAX_AUDIO_BYTES`, `VOICE_MAX_TTS_CHARS`. **RUN**

**Declared but read by nothing:** `REDIS_URL`, `GITHUB_TOKEN` — present in the template and the config schema only. **RUN**

**Named in `docs/JARVIS_ARCHITECTURE.md` but read by nothing:** `META_APP_ID`, `META_APP_SECRET`, `N8N_WEBHOOK_URL`, `REDIS_URL`. **RUN**

## 7. Security audit

### SEC-1 — Database backup committed and pushed · CRITICAL

**PERSONAL DATA AND PASSWORD HASHES FOUND — HISTORY PURGE AND PASSWORD RESET REQUIRED**

| | |
|---|---|
| File | `.claude/skills/run-jarvis/backups/jarvis-data-20260903-154135.sql` (603 KB) |
| In git since | commit `7b35c4f`, 2026-09-03 |
| Pushed | Yes — reachable from `origin/main`. **RUN** |
| Repository visibility | **NOT VERIFIED** — the GitHub CLI is not installed here |
| Contents, by column name only | `User`: 29 rows — email, name, **password hash**, role, last login. `RefreshToken`: 153 rows — token hash, user agent, **IP address**. `Message`: 215 rows of chat content. `Conversation` 56, `AuditLog` 517, `Approval` 38, `MarketingAccount` 2, `ToolExecution` 18. **RUN** |
| Real people | 6 users on `gmail.com`; the other 23 are test domains. **RUN** |
| Depended on by | Nothing. **RUN** |

Why removing the file is not enough: it stays readable in every clone and in GitHub's history. The cleanup plan stops tracking it and ignores the folder (Task 1). The history purge and the account actions are **your decisions** — D-1 — because they are destructive and outward-facing.

### SEC-2 — OAuth codes written to the access log · MEDIUM

`apps/api/src/index.ts:140` uses `morgan("combined")`, which writes the full request URL. Both Google callbacks (`/api/v1/google/callback`, `/api/v1/auth/google/callback`) receive `code` and `state` in the query string, and the WhatsApp webhook handshake receives `hub.verify_token`. Every sign-in therefore writes a live authorisation code to stdout. **READ** — the code path was traced; no log line was captured. **Fixed by Task 5.**

### SEC-3 — Confirmation hash cannot see nested values · LOW, latent

`hashParams` in `confirmations.ts` calls `JSON.stringify(params, Object.keys(params).sort())`. A replacer array doubles as an allowlist at every depth, so nested keys are dropped: `{campaign:{budget:10}}` and `{campaign:{budget:10000}}` hash identically. **RUN** against the built code. Current catalogue config fields are flat scalars and approval-gated writes pass a second, correct hash in `ToolExecutor`, so real-world reach is not proven. **Fixed by Task 4.**

### SEC-4 — Template activates a fake ElevenLabs key · LOW

`.env.example` sets `ELEVENLABS_API_KEY=your_server_side_api_key` and a voice id **uncommented**. Copying the template verbatim makes ElevenLabs "configured" with a placeholder key. **READ.** **Fixed by Task 7.**

### SEC-5 — Real account identifiers in a committed state file · INFORMATIONAL

`apps/api/scripts/phase116b/state.json` holds a user id, a Meta ad-account id and campaign ids from the Phase 11.6B live smoke test. Identifiers, not credentials. **RUN** (keys only). Left in place as evidence the reports cite; mask it if you prefer.

### SEC-6 — Per-process state · INFORMATIONAL, by design

Pending write confirmations and the per-IP rate limiter live in memory. For confirmations this is deliberate and correct — the file header explains that persisting them would create a durable, replayable write permit. **READ.** If the API is ever run as several instances, it needs sticky sessions.

### SEC-7 — No continuous integration · MEDIUM

No pipeline runs tests, secret scanning or dependency audits. SEC-1 is exactly the kind of mistake an automated secret scan catches before it leaves a laptop.

### SEC-8 — Lint carries no security rules · LOW

The ESLint baseline is correctness-only by design (ledger R-14).

### Checked and clean

| Check | Result |
|---|---|
| Hardcoded credentials in tracked source | None. The only secret-shaped string is a redaction *detector* regex. **RUN** |
| Credentials in git history | Two matches, both fake test fixtures; neither equals a live value. **RUN** — compared as booleans, values never printed |
| `.env` ever committed | Never. **RUN** |
| `.env.example` values | Placeholders only. **RUN** |
| SQL injection | All raw SQL parameterised. **READ** |
| Command execution | No `child_process` anywhere. **RUN** |
| File-path traversal | Download store and PDF generator both guard traversal and the root prefix. **READ** |
| Missing authentication | Every router authenticated except `health`; unauthenticated callbacks verify signatures or state. **READ** |
| CORS | A single configured origin, not a wildcard. **READ** |
| Client-side secrets | Only `NEXT_PUBLIC_API_URL`; the Maps browser key is served from an authenticated endpoint. **READ** |
| CSRF | Access token header-only; refresh cookie HttpOnly and `SameSite=Lax`. **READ** |

## 8. Broken functionality

| Id | What | Status | Evidence | In this cleanup |
|---|---|---|---|---|
| B-1 | 6 of 13 tests in `apps/api/test/sprint-1.1d-memory-e2e.test.ts` fail: system-prompt content and memory injection. The ledger calls this suite "flaky, 13/13 in isolation"; it fails identically in isolation on every run. | 🔴 BROKEN | **RUN** ×3, including with this branch's source edits reverted | **Not fixed during the cleanup** — debugging, not cleanup; ledger corrected. **Resolved 2026-09-14** on `fix/b1-memory-e2e`; see Part 3 §5. |
| B-2 | Four scratch scripts in `apps/api/` do not compile (18 TypeScript errors) and are excluded from every tsconfig | 🔴 BROKEN | **RUN** | Removed — Task 2 |
| B-3 | 8 Postgres integration tests fail in `@jarvis/db` | 🔴 BROKEN | **INHERITED** | Not in scope |
| B-4 | The live Google grant lacks the `adwords` scope, so Google Ads cannot work | 🔴 BROKEN | **INHERITED** | Needs a re-grant by you |
| B-5 | `.env.example` and the README tell you to use `.env.local`, which the API never reads | 🔴 BROKEN | **READ** | Fixed — Tasks 7, 9 |

## 9. Issue register

Each important issue: the file, what it is, why it exists, whether anything uses it, what depends on it, and what to do.

**I-01 · SEC-1 · Tracked database backup** — see §7.
- **Used / depended on by:** nothing. **Action:** stop tracking and ignore the folder (Task 1); purge history and reset the six real accounts (D-1).

**I-02 · SEC-2 · Access log**
- **File:** `apps/api/src/index.ts:140` · **Function:** `morgan("combined")`
- **What it does:** writes one line per request, URL included. **Why it exists:** operational request logging.
- **Used:** yes, on every request. **Depends on it:** operators reading stdout; no test asserts the format.
- **Action:** keep the same line layout, redact credential-bearing query values (Task 5).

**I-03 · SEC-3 · Duplicate parameter hash**
- **File:** `apps/api/src/services/integrations/confirmations.ts:57` · **Function:** `hashParams`
- **What it does:** hashes write parameters to bind a confirmation token. **Why it exists:** written before, and separately from, the approval system's canonical hash.
- **Used:** internally by `issueConfirmation` and `consumeConfirmation`. **Depends on it:** nothing outside the file.
- **Action:** use `computeParamsHash` from `@jarvis/core`; delete `hashParams` (Task 4). Safe to switch: hashes are only compared within one process's lifetime, so nothing persisted needs migrating.

**I-04 · `MemoryManager` stub**
- **File:** `packages/memory/src/memory-manager.ts` · **Class:** `MemoryManager`
- **What it does:** `store()` creates an embedding, then discards it and logs; `recall()` returns `[]`. **Why it exists:** the original scaffold, from before the memory engine was built.
- **Used:** no — zero references in source, tests, scripts or tooling. **RUN** **Depends on it:** only its export line.
- **Action:** delete (Task 3).

**I-05 · `KnowledgeBase` stub**
- **File:** `packages/memory/src/knowledge-base.ts` · **Class:** `KnowledgeBase`
- **What it does:** `ingestDocument()` returns a random UUID without storing anything; `query()` returns `[]`. **Why it exists:** original scaffold, superseded by the chunking, embedding and retrieval services.
- **Used:** no. **RUN** **Depends on it:** only its export line.
- **Action:** delete (Task 3).

**I-06 · Deprecated memory interface**
- **File:** `packages/core/src/types/agent.ts:67-74` · **Interface:** `MemoryManager`
- **What it does:** a type marked `@deprecated — use IMemoryStore`. **Used:** no; `AgentContext.memoryManager` is already typed `IMemoryStore`. **RUN**
- **Action:** delete (Task 3).

**I-07 · `MemoryEngine` not wired**
- **File:** `packages/memory/src/memory-engine.ts` · **Class:** `MemoryEngine`
- **What it does:** a validated facade over a memory store and an embedding provider. **Why it exists:** Sprint 1.1 memory work.
- **Used:** by `packages/memory/test/memory-engine.test.ts` and one assertion in `apps/api/test/sprint-1.1a-memory-wiring.test.ts`; **not** by production.
- **Action:** keep; decide whether it becomes the single entry point or is removed with its tests (D-4).

**I-08 · Broken scratch scripts**
- **Files:** `apps/api/test-auth.ts`, `test-orchestrator.ts`, `test-ai-provider.ts`, `test-openai-adapter.ts`
- **What they do:** hand-run smoke checks from the first backend commit (2026-08-17). `test-auth.ts` creates a real user in the database.
- **Used:** no script, config or document references them; excluded from `tsconfig` (`rootDir: ./src`); 18 compile errors. **RUN** Superseded by `apps/api/test/`.
- **Action:** delete (Task 2).

**I-09 · Superseded SQL**
- **File:** `fix-enums.sql` · **What it does:** adds `SCHEDULED` and `COLLECTING` to the `MeasurementState` enum.
- **Used:** no. Both values are already created by migration `20260824010000_phase117b_outcome_worker`. **RUN**
- **Action:** delete (Task 2). Git history keeps it.

**I-10 · Tracked build artefacts**
- **Files:** `apps/web/tsconfig.tsbuildinfo`, `packages/core/tsconfig.tsbuildinfo` · **Used:** regenerated by every build; they appear in `git diff` after each one.
- **Action:** stop tracking; ignore `*.tsbuildinfo` (Task 1).

**I-11 · Unused web dependencies** — see §4.14. **Action:** remove (Task 6).

**I-12 · `jsonwebtoken` in the API**
- **Used:** only by a dynamic import inside dead `apps/api/test-auth.ts`. JWT is owned by `@jarvis/security`, which declares it itself. **RUN**
- **Action:** remove with the scratch scripts (Task 2).

**I-13 · `openai` in `@jarvis/memory`**
- **Used:** only by the two stubs. Memory gets embeddings through `@jarvis/ai-openai`. **RUN** **Action:** remove (Task 3).

**I-14 · `/hero-preview`**
- **Files:** `apps/web/src/app/hero-preview/page.tsx`, `apps/web/src/components/ui/home-hero-landing-scroll-animation.tsx`
- **What it does:** a public preview route for a scroll-animation hero, added 2026-09-09 as the component's demo page. **Why it exists:** to preview an installed component.
- **Used:** not linked from any navigation; `gsap` and `swiper` are used only here.
- **Action:** **not removed** — whether you still want it is your call (D-2).

**I-15 · `@jarvis/ai-anthropic` unwired**
- **Used:** imported by nothing; zero tests; model ids a generation old. **Action:** keep — wire or remove (D-3).

**I-16 · Environment template** — see §6 and SEC-4. **Action:** rewrite with every name, no values, correct instructions (Task 7).

**I-17 · Extra env files in the loader**
- **File:** `apps/api/src/config/env.ts:5-14` · **Used:** the files it looks for do not exist. **RUN**
- **Action:** load only the root `.env` (Task 7).

**I-18 · Dead configuration names** — `REDIS_URL`, `GITHUB_TOKEN`. **Action:** remove from the template and the schema (Task 7).

**I-19 · Root-level reports**
- **Files:** 29 `PHASE_*`, `SPRINT_*` and `JARVIS_*_REPORT` markdown files, plus the ledger.
- **Used:** cited by the ledger, by each other by bare file name, and by two links in `docs/`. **RUN**
- **Action:** move — never delete — to `docs/reports/`; move the ledger into `docs/`; fix the two links (Task 8). Bare-name citations between reports keep working because the files stay together.

**I-20 · Legacy architecture document** — `docs/ARCHITECTURE.md`. **Action:** archive to `docs/archive/`, write an accurate replacement (Tasks 8, 9).

**I-21 · README** — four false claims. **Action:** rewrite (Task 9).

**I-22 · B-1** — see §8. **Action:** diagnose next, as its own task.

**I-23 · Test mocks in production barrels**
- **Files:** `packages/tools/src/tools/*-mock.ts`, `packages/agents/src/mock-ai-provider.ts`, exported from each `src/index.ts`.
- **Used:** by 30 test files; by no production code. **RUN**
- **Action:** keep for now. Moving them to a test-only entry point changes 30 test imports for no runtime benefit.

**I-24 · Widget data providers inside the API** — `apps/api/src/services/providers/`. Only the API uses them. **Action:** keep; move to a package only if a second consumer appears.

**I-25 · Split `/recommendations` routes** — `outcomes.ts` owns `GET /recommendations/:id/outcome`. No path collides. **READ** **Action:** documented in `docs/API.md`; not moved.

**I-26 · SEC-5** — see §7. **Action:** none by default.

**I-27 · SEC-7 · No CI** — **Action:** recommended as the next foundation task.

**I-28 · Framework-owned env files** — `packages/db/.env`, `apps/web/.env.local`. **Action:** keep; document why both exist (Tasks 7, 9).

## 10. Decisions that need you

These are left out of the plan on purpose: each is destructive, outward-facing, or a question of intent that the code cannot answer.

| Id | Decision | Recommendation |
|---|---|---|
| **D-1** | Purge the database backup from git history (rewrite plus force-push); reset passwords for the 6 real accounts; revoke all refresh tokens issued on or before 2026-09-03. Also: is the GitHub repository public? | Do it. If the repository is or ever was public, treat the password hashes as exposed. The refresh tokens in the dump carried a 7-day lifetime and have expired, but revoking them costs nothing. |
| **D-2** | Keep or remove `/hero-preview` and its component (and with them `gsap`, `swiper`) | Remove if the hero design is no longer being evaluated. |
| **D-3** | Wire `@jarvis/ai-anthropic` in, or remove it | Decide with the model-id refresh. |
| **D-4** | Make `MemoryEngine` the single memory entry point, or remove it and its tests | Decide when B-1 is diagnosed; both live in the same area. |
| **D-5** | Commit strategy: this branch holds the uncommitted ESLint work plus this cleanup | One commit for ESLint, then one per cleanup task. No commit is made without your say-so. |
| **D-6** | Five tested tool classes are never registered: `data.csv.analyze` (granted to two agents), `document.analyze`, `pdf.generate`, `web.research`, `system.echo`. Wire them in, or remove the grant and the classes. *Found during execution — see Part 3.* | Register `data.csv.analyze` or drop it from `ANALYSIS_TOOLS`; a grant that points at nothing misleads anyone reading the policy. Decide the other four with the capability roadmap. |

## 11. Corrections to earlier audit statements

Recorded transparently, per `docs/DOCUMENTATION_PROTOCOL.md`.

| Earlier statement | Correction | Evidence |
|---|---|---|
| Web audit page, 2026-09-14: "roughly 2,300 tests" | **4,609** passing outside `@jarvis/db`, plus 196 there | **RUN** baseline, §3 |
| Web audit page: "persist the confirmation store" (S-1) | Wrong. The store is in memory by deliberate design; persisting it would create a replayable write permit | **READ** `confirmations.ts:21-25` |
| Web audit page: "16 packages … 27 models, 9 enums" | 11 enums | **READ** `schema.prisma` |
| Ledger §8.1: memory e2e "flaky, 13/13 in isolation" | 6 of 13 fail deterministically | **RUN** ×3 |
| Ledger R-3: "no shared card primitive" | `widget-shell.tsx` is one, used by 7 of 8 widgets | **RUN** |

---

# Part 2 — Cleanup Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove proven dead code, duplicates and data exposure, give every capability one documented home, and leave every currently passing test passing.

**Architecture:** Keep the 18-workspace monorepo; clean inside it. Code tasks come first, each verified against the §3 baseline; file moves come next; documentation that describes the final state comes last.

**Tech Stack:** pnpm 9 workspaces, Turborepo 2, TypeScript 5, Vitest 4, Express 4, Next.js 14, Prisma 5.

**Spec:** Part 1 of this document, and the owner's brief *JARVIS Foundation Cleanup V1.0*.

**Plan location:** kept inside this audit rather than under `docs/superpowers/plans/`, because the brief asks for no new document that is not useful.

## Global Constraints

- No new features, no UI redesign, no replacement of a working system.
- No new dependency and no version change. Removing an unused dependency is allowed.
- Nothing is deleted without the proof recorded in §9.
- No existing test is removed.
- No secret value is printed, logged or written into any file.
- `AGENTS.md` invariants hold: one integration command service; `ToolExecutor` is the only execution authority; progressive Google scopes.
- Out of scope: the separate project at `D:\ai youtube agent`.
- **Commits:** each task ends with a *proposed* commit. It is run only after the owner approves committing (D-5).
- **Baseline to preserve:** §3 — 4,609 passed, 6 failed (B-1 only), 8 skipped; typecheck 33/33; build 18/18; lint 18/18.

---

### Task 1: Stop tracking personal data and build artefacts

**Files:**
- Modify: `.gitignore`
- Modify: `.claude/skills/run-jarvis/.gitignore`
- Untrack, keep on disk: `.claude/skills/run-jarvis/backups/jarvis-data-20260903-154135.sql`, `apps/web/tsconfig.tsbuildinfo`, `packages/core/tsconfig.tsbuildinfo`

**Interfaces:** none.

- [ ] **Step 1: Confirm all three files are tracked and exist**

Run: `git ls-files --error-unmatch .claude/skills/run-jarvis/backups/jarvis-data-20260903-154135.sql apps/web/tsconfig.tsbuildinfo packages/core/tsconfig.tsbuildinfo && ls -la .claude/skills/run-jarvis/backups/ apps/web/tsconfig.tsbuildinfo packages/core/tsconfig.tsbuildinfo`
Expected: three paths echoed, no error.

- [ ] **Step 2: Ignore build info** — in `.gitignore`, under `# Build outputs`, after `out/`:

```gitignore
# TypeScript incremental build state — regenerated by every build.
*.tsbuildinfo
```

- [ ] **Step 3: Ignore driver backups** — append to `.claude/skills/run-jarvis/.gitignore`:

```gitignore

# Database dumps taken while driving the stack. They contain real user rows —
# emails, password hashes, IP addresses, chat history — and must never be
# committed. Keep them local.
backups/
```

- [ ] **Step 4: Untrack without deleting**

Run: `git rm --cached .claude/skills/run-jarvis/backups/jarvis-data-20260903-154135.sql apps/web/tsconfig.tsbuildinfo packages/core/tsconfig.tsbuildinfo`

- [ ] **Step 5: Verify**

Run: `git ls-files | grep -E 'tsbuildinfo|run-jarvis/backups/' ; git check-ignore -v .claude/skills/run-jarvis/backups/jarvis-data-20260903-154135.sql apps/web/tsconfig.tsbuildinfo packages/core/tsconfig.tsbuildinfo ; ls .claude/skills/run-jarvis/backups/`
Expected: no tracked matches; each path reported as ignored; the dump still listed on disk.

- [ ] **Step 6: Proposed commit** — `chore: stop tracking database dump and tsbuildinfo artefacts`

> This does **not** remove the dump from git history. That is D-1.

---

### Task 2: Remove broken scratch scripts, superseded SQL, and the API's unused JWT dependency

**Files:**
- Delete: `apps/api/test-auth.ts`, `apps/api/test-orchestrator.ts`, `apps/api/test-ai-provider.ts`, `apps/api/test-openai-adapter.ts`, `fix-enums.sql`
- Modify: `apps/api/package.json` (via pnpm), `pnpm-lock.yaml`

**Interfaces:** none.

- [ ] **Step 1: Prove nothing references them**

Run: `git grep -n -E "test-auth|test-orchestrator|test-ai-provider|test-openai-adapter|fix-enums" -- ':!pnpm-lock.yaml' ':!docs/CODEBASE_AUDIT.md'`
Expected: no output.

- [ ] **Step 2: Prove no tsconfig includes them**

Run: `cat apps/api/tsconfig.json apps/api/tsconfig.test.json`
Expected: `include` covers `src/**` (and `test/**` for the test config), never the package root.

- [ ] **Step 3: Delete**

Run: `git rm apps/api/test-auth.ts apps/api/test-orchestrator.ts apps/api/test-ai-provider.ts apps/api/test-openai-adapter.ts fix-enums.sql`

- [ ] **Step 4: Remove the now-unused dependency**

Run: `pnpm remove --filter @jarvis/api jsonwebtoken @types/jsonwebtoken`
Then: `grep -rn "jsonwebtoken" apps/api/src apps/api/test apps/api/package.json`
Expected: only a comment in `apps/api/test/sprint8-voice-routes.test.ts`; nothing in `package.json`.

- [ ] **Step 5: Verify**

Run: `pnpm --filter @jarvis/api typecheck && pnpm --filter @jarvis/api exec vitest run`
Expected: typecheck passes; **1,143 passed, 6 failed (B-1 only), 8 skipped**.

- [ ] **Step 6: Proposed commit** — `chore(api): remove broken scratch scripts, superseded enum SQL, unused jsonwebtoken`

---

### Task 3: Remove the dead memory stubs

**Files:**
- Delete: `packages/memory/src/memory-manager.ts`, `packages/memory/src/knowledge-base.ts`
- Modify: `packages/memory/src/index.ts:1-2`
- Modify: `packages/core/src/types/agent.ts:67-75`
- Modify: `packages/memory/package.json` (via pnpm), `pnpm-lock.yaml`

**Interfaces:**
- Produces: `@jarvis/memory` no longer exports `MemoryManager` or `KnowledgeBase`; `@jarvis/core` no longer exports the type `MemoryManager`. No consumer exists (§9 I-04 to I-06).

- [ ] **Step 1: Prove zero references**

Run: `git grep -n -E "\b(MemoryManager|KnowledgeBase)\b" -- ':!*.md' ':!pnpm-lock.yaml'`
Expected: only `packages/core/src/types/agent.ts:71`, `packages/memory/src/index.ts:1-2`, and the two class files.

- [ ] **Step 2: Delete the stubs**

Run: `git rm packages/memory/src/memory-manager.ts packages/memory/src/knowledge-base.ts`

- [ ] **Step 3: Remove their exports** — delete these two lines from `packages/memory/src/index.ts`:

```ts
export { MemoryManager } from "./memory-manager.js";
export { KnowledgeBase } from "./knowledge-base.js";
```

- [ ] **Step 4: Remove the deprecated interface** — delete from `packages/core/src/types/agent.ts`:

```ts
/**
 * @deprecated Use IMemoryStore from @jarvis/core instead.
 * Kept for backward compatibility during migration.
 */
export interface MemoryManager {
  store(conversationId: string, content: string, metadata?: Record<string, unknown>): Promise<void>;
  recall(conversationId: string, query: string, limit?: number): Promise<string[]>;
}

```

- [ ] **Step 5: Remove the stubs' only dependency**

Run: `pnpm remove --filter @jarvis/memory openai`
Then: `grep -rnE "from ['\"]openai['\"]" packages/memory/src packages/memory/test`
Expected: no output.

- [ ] **Step 6: Verify**

Run: `npx turbo typecheck && npx turbo run test --concurrency=1 --continue --filter=@jarvis/core --filter=@jarvis/memory --filter=@jarvis/agents --filter=@jarvis/api`
Expected: typecheck 33/33; core 541, memory 453, agents 498; api 1,143 passed, 6 failed (B-1), 8 skipped.

- [ ] **Step 7: Proposed commit** — `refactor(memory): remove non-functional MemoryManager and KnowledgeBase stubs`

---

### Task 4: One canonical parameter hash for write confirmations

**Files:**
- Create: `apps/api/test/confirmation-params-binding.test.ts`
- Modify: `apps/api/src/services/integrations/confirmations.ts`

**Interfaces:**
- Consumes: `computeParamsHash(params: Record<string, unknown> | null | undefined): string` from `@jarvis/core` (`packages/core/src/utils/params-hash.ts`, exported via `packages/core/src/index.ts:49`).
- Produces: `issueConfirmation` and `consumeConfirmation` keep their exact signatures. `hashParams` is removed; it had no importer outside this file.

- [ ] **Step 1: Write the failing test** — `apps/api/test/confirmation-params-binding.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import type { IntegrationId } from "@jarvis/core";
import {
  issueConfirmation,
  consumeConfirmation,
  __resetConfirmations,
} from "../src/services/integrations/confirmations.js";

// A confirmation token is bound to the exact parameters that were described to
// the user. These cases pin that binding for nested values — a budget inside a
// campaign object — which a top-level-only hash cannot tell apart.

const USER = "user-binding-test";
const INTEGRATION = "meta" as IntegrationId;
const ACTION = "campaign.update";

function issue(params: Record<string, unknown>): string {
  return issueConfirmation({
    userId: USER,
    integration: INTEGRATION,
    actionId: ACTION,
    params,
    summary: "test summary",
    irreversible: true,
  }).token;
}

function consume(token: string, params: Record<string, unknown>) {
  return consumeConfirmation({
    token,
    userId: USER,
    integration: INTEGRATION,
    actionId: ACTION,
    params,
  });
}

describe("confirmation parameter binding", () => {
  beforeEach(() => __resetConfirmations());

  it("rejects a token replayed against a different nested value", () => {
    const token = issue({ campaign: { budget: 10 } });
    expect(consume(token, { campaign: { budget: 10000 } })).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("rejects a token replayed against a different array element", () => {
    const token = issue({ items: [{ id: "a" }] });
    expect(consume(token, { items: [{ id: "b" }] })).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("accepts identical nested parameters serialised in a different key order", () => {
    const token = issue({ campaign: { name: "x", budget: 10 }, mode: "safe" });
    expect(consume(token, { mode: "safe", campaign: { budget: 10, name: "x" } })).toEqual({
      ok: true,
      summary: "test summary",
    });
  });

  it("rejects a different top-level value", () => {
    const token = issue({ amount: 10 });
    expect(consume(token, { amount: 11 })).toEqual({ ok: false, reason: "mismatch" });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @jarvis/api exec vitest run test/confirmation-params-binding.test.ts`
Expected: **2 failed, 2 passed** — the nested-value and array cases return `{ ok: true }` today.

- [ ] **Step 3: Implement** — in `confirmations.ts`, replace the imports:

```ts
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  computeParamsHash,
  type IntegrationConfirmation,
  type IntegrationId,
} from "@jarvis/core";
```

Replace the whole `hashParams` block (its doc comment and function) with:

```ts
// Parameters are bound with the same canonical hash the approval system uses:
// `computeParamsHash` in @jarvis/core sorts keys at EVERY depth. The UI and the
// model may serialise one request in different key orders and still match,
// while a change to any nested value — a budget inside a campaign object —
// produces a different hash and the token is refused.
```

In `issueConfirmation`: `paramsHash: computeParamsHash(input.params),`
In `consumeConfirmation`: `const actual = Buffer.from(computeParamsHash(input.params), "hex");`

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm --filter @jarvis/api exec vitest run test/confirmation-params-binding.test.ts test/integration-write-security.test.ts test/integration-command-parity.test.ts`
Expected: all pass.

- [ ] **Step 5: Verify nothing else imported `hashParams`**

Run: `git grep -n "hashParams" -- ':!docs/*'`
Expected: no output.

- [ ] **Step 6: Full API suite**

Run: `pnpm --filter @jarvis/api typecheck && pnpm --filter @jarvis/api exec vitest run`
Expected: **1,147 passed** (1,143 + 4 new), 6 failed (B-1), 8 skipped.

- [ ] **Step 7: Proposed commit** — `fix(api): bind write confirmations with the canonical recursive params hash`

---

### Task 5: Redact credentials from the access log

**Files:**
- Create: `apps/api/src/middleware/access-log.ts`
- Create: `apps/api/test/access-log.test.ts`
- Modify: `apps/api/src/index.ts:5` and `apps/api/src/index.ts:140`

**Interfaces:**
- Produces: `redactUrlForLog(raw: string | undefined): string` and `accessLog(): RequestHandler`-compatible morgan middleware.

- [ ] **Step 1: Confirm no test depends on the stock format**

Run: `git grep -n -E "morgan|\"combined\"" -- apps/api/test`
Expected: no output.

- [ ] **Step 2: Write the failing test** — `apps/api/test/access-log.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { redactUrlForLog } from "../src/middleware/access-log.js";

describe("redactUrlForLog", () => {
  it("removes the OAuth code and state from a callback URL", () => {
    expect(
      redactUrlForLog("/api/v1/google/callback?code=4/0AbCdEf&state=s3cr3t&scope=email")
    ).toBe("/api/v1/google/callback?code=REDACTED&state=REDACTED&scope=email");
  });

  it("removes the WhatsApp verify token but keeps the challenge", () => {
    expect(
      redactUrlForLog(
        "/api/v1/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=abc&hub.challenge=123"
      )
    ).toBe(
      "/api/v1/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=REDACTED&hub.challenge=123"
    );
  });

  it("matches keys case-insensitively and when percent-encoded", () => {
    expect(redactUrlForLog("/x?Access_Token=t&%63ode=c")).toBe(
      "/x?Access_Token=REDACTED&%63ode=REDACTED"
    );
  });

  it("leaves URLs without sensitive keys untouched", () => {
    expect(redactUrlForLog("/api/v1/approvals?status=pending&limit=20")).toBe(
      "/api/v1/approvals?status=pending&limit=20"
    );
    expect(redactUrlForLog("/api/v1/health")).toBe("/api/v1/health");
  });

  it("redacts inside an absolute referrer URL", () => {
    expect(redactUrlForLog("http://localhost:3000/auth/google?code=abc")).toBe(
      "http://localhost:3000/auth/google?code=REDACTED"
    );
  });

  it("prints a dash when there is no value", () => {
    expect(redactUrlForLog(undefined)).toBe("-");
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm --filter @jarvis/api exec vitest run test/access-log.test.ts`
Expected: FAIL — cannot resolve `../src/middleware/access-log.js`.

- [ ] **Step 4: Implement** — `apps/api/src/middleware/access-log.ts`:

```ts
// ---------------------------------------------------------------------------
// Request access log, with credential-bearing query values removed.
//
// morgan's stock "combined" format writes the full request URL. Some requests
// carry a live credential in the query string: both Google OAuth callbacks
// receive `code` and `state`, and the WhatsApp webhook handshake receives
// `hub.verify_token`. The stock format wrote those values to stdout on every
// sign-in. This keeps the combined layout operators already parse and swaps
// only the URL and the referrer for redacted versions.
// ---------------------------------------------------------------------------

import type { IncomingMessage } from "node:http";
import morgan from "morgan";

const SENSITIVE_QUERY_KEYS = new Set([
  "code",
  "state",
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "client_secret",
  "key",
  "api_key",
  "apikey",
  "password",
  "hub.verify_token",
]);

const REDACTED = "REDACTED";

/** Replaces the value of every sensitive query parameter; keeps everything else. */
export function redactUrlForLog(raw: string | undefined): string {
  if (!raw) return "-";
  const queryStart = raw.indexOf("?");
  if (queryStart === -1) return raw;

  const pairs = raw
    .slice(queryStart + 1)
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq === -1) return pair;
      const rawKey = pair.slice(0, eq);
      let key: string;
      try {
        key = decodeURIComponent(rawKey.replace(/\+/g, " ")).toLowerCase();
      } catch {
        // An undecodable key cannot be classified, so its value is not logged.
        return `${rawKey}=${REDACTED}`;
      }
      return SENSITIVE_QUERY_KEYS.has(key) ? `${rawKey}=${REDACTED}` : pair;
    });

  return `${raw.slice(0, queryStart)}?${pairs.join("&")}`;
}

/** morgan's "combined" layout, with the URL and referrer passed through redaction. */
const REDACTED_COMBINED_FORMAT =
  ':remote-addr - :remote-user [:date[clf]] ":method :redacted-url HTTP/:http-version" :status :res[content-length] ":redacted-referrer" ":user-agent"';

export function accessLog() {
  morgan.token("redacted-url", (req: IncomingMessage) =>
    redactUrlForLog((req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url)
  );
  morgan.token("redacted-referrer", (req: IncomingMessage) => {
    const header = req.headers.referer ?? req.headers.referrer;
    return redactUrlForLog(Array.isArray(header) ? header[0] : header);
  });
  return morgan(REDACTED_COMBINED_FORMAT);
}
```

- [ ] **Step 5: Wire it in** — in `apps/api/src/index.ts`, replace line 5 `import morgan from "morgan";` with nothing, add next to the `requestId` import:

```ts
import { accessLog } from "./middleware/access-log.js";
```

and replace `app.use(morgan("combined"));` with `app.use(accessLog());`.

- [ ] **Step 6: Run and verify**

Run: `pnpm --filter @jarvis/api exec vitest run test/access-log.test.ts && pnpm --filter @jarvis/api typecheck && pnpm --filter @jarvis/api exec vitest run`
Expected: 6 new tests pass; typecheck passes; **1,153 passed** (1,147 + 6), 6 failed (B-1), 8 skipped.

- [ ] **Step 7: Proposed commit** — `fix(api): redact OAuth codes and webhook tokens from access logs`

---

### Task 6: Remove unused frontend dependencies

**Files:**
- Modify: `apps/web/package.json` (via pnpm), `apps/web/next.config.mjs`, `pnpm-lock.yaml`

**Interfaces:** none.

- [ ] **Step 1: Re-prove zero imports**

Run: `grep -rnE "['\"](axios|class-variance-authority|motion|next-auth|zod|@jarvis/security)(/[^'\"]*)?['\"]" apps/web/src apps/web/test apps/web/*.config.* apps/web/*.mjs`
Expected: only `apps/web/next.config.mjs` (the `transpilePackages` entry). `framer-motion` does not match `['"]motion`.

- [ ] **Step 2: Remove**

Run: `pnpm remove --filter @jarvis/web axios class-variance-authority motion next-auth zod @jarvis/security`

- [ ] **Step 3: Drop the dead transpile entry** — `apps/web/next.config.mjs`:

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@jarvis/core"],
};

export default nextConfig;
```

- [ ] **Step 4: Verify**

Run: `pnpm --filter @jarvis/web typecheck && pnpm --filter @jarvis/web build && pnpm --filter @jarvis/web exec vitest run`
Expected: typecheck passes; production build succeeds; **552 passed**.

- [ ] **Step 5: Proposed commit** — `chore(web): remove six unused dependencies`

---

### Task 7: One canonical environment configuration

**Files:**
- Modify: `apps/api/src/config/env.ts`
- Modify: `packages/config/src/index.ts:52-55`
- Rewrite: `.env.example`
- Modify: `docs/JARVIS_ARCHITECTURE.md` — append a correction under the environment table

**Interfaces:**
- Produces: `loadEnvironment()` unchanged. `BaseEnv` loses the unused optional keys `GITHUB_TOKEN` and `REDIS_URL`.

- [ ] **Step 1: Prove the extra env files and the dead names are unused**

Run: `ls apps/api/.env.development apps/api/.env.production apps/api/.env.staging apps/api/.env.local 2>&1 ; git grep -n -E "REDIS_URL|GITHUB_TOKEN" -- ':!docs/*' ':!pnpm-lock.yaml'`
Expected: four "No such file"; names only in `.env.example` and `packages/config/src/index.ts`.

- [ ] **Step 2: Load only the root `.env`** — `apps/api/src/config/env.ts` becomes:

```ts
import { config } from "dotenv";
import { resolve } from "path";
import { getServerEnv } from "@jarvis/config";

// ONE environment file: `.env` at the repository root.
//
// It is resolved from the working directory, which is `apps/api` under
// `pnpm dev` and `pnpm --filter`. When the process starts from the repository
// root instead (`node apps/api/dist/index.js`, as the Dockerfile does),
// `@jarvis/config` has already loaded `./.env` from there on import — so both
// launch styles read the same file. In containers the values arrive through
// compose `env_file`, and dotenv never overrides a variable that is already set.
config({ path: resolve(process.cwd(), "../../.env") });

export function loadEnvironment() {
  const env = getServerEnv();

  return {
    NODE_ENV: env.NODE_ENV,
    PORT: parseInt(process.env.API_PORT || process.env.PORT || "3001", 10),
    DATABASE_URL: env.DATABASE_URL,
    JWT_SECRET: env.JWT_SECRET,
    OPENAI_API_KEY: env.OPENAI_API_KEY,
    CORS_ORIGIN: env.CORS_ORIGIN,
    // Phase 10.6 — validated bounded grace period (safe default when the
    // variable is absent; .env is never modified by application code).
    SHUTDOWN_GRACE_MS: env.JARVIS_SHUTDOWN_GRACE_MS,
  };
}
```

- [ ] **Step 3: Remove dead schema keys** — delete from `packages/config/src/index.ts`:

```ts
  GITHUB_TOKEN: z.string().optional(),

  REDIS_URL: z.string().optional(),

```

- [ ] **Step 4: Rewrite `.env.example`** with, in order: a header saying *copy to `.env` at the repository root*, that `.env.local` / `.env.development` / `.env.production` are not read, and why `packages/db/.env` and `apps/web/.env.local` exist; the existing Required, Application, Google, credential encryption, Meta, n8n, WhatsApp, Google Maps and market-indices blocks **unchanged**; the GitHub and Redis blocks **removed**; the ElevenLabs block with every value line **commented out**; and new commented sections for AI models and retries, voice, sessions and runtime, browser automation, and the Anthropic adapter — marked as not wired — naming every variable listed in §6. Placeholders only, no real values. Defaults are shown only where verified in code: `OPENAI_DEFAULT_MODEL` gpt-4o, `OPENAI_TIMEOUT_MS` 30000, `OPENAI_MAX_RETRIES` 2, `OPENAI_VISION_MODEL` gpt-4o-mini, `CLAUDE_TIMEOUT_MS` 30000, `CLAUDE_MAX_RETRIES` 2, `JARVIS_SHUTDOWN_GRACE_MS` 30000, `AUTH_COOKIE_NAME` jarvis_rt, browser navigation 20000 ms, session 60000 ms, 2 sessions, 20000 extract characters, 10485760 download bytes.

- [ ] **Step 5: Verify the template is complete and value-free**

Run: `grep -oE '^[[:space:]]*#?[[:space:]]*[A-Z][A-Z0-9_]+=' .env.example | sed -E 's/^[[:space:]]*#?[[:space:]]*//; s/=$//' | sort -u > /tmp/ex.txt; grep -rhoE "process\.env\.[A-Z][A-Z0-9_]+" apps/api/src packages/*/src --include=*.ts | sed 's/process\.env\.//' | sort -u | comm -23 - /tmp/ex.txt ; grep -nE '^[A-Z_]+=.*(sk-[A-Za-z0-9]{20,}|EAA[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,})' .env.example`
Expected: the first list is empty or contains only `NODE_ENV`-style names already present; the second grep prints nothing.

- [ ] **Step 6: Correct the architecture doc transparently** — append below the environment table in `docs/JARVIS_ARCHITECTURE.md`:

```markdown
### Correction (added 2026-09-14)

Previous documentation listed `META_APP_ID`, `META_APP_SECRET`, `REDIS_URL` and `N8N_WEBHOOK_URL` as optional variables. This was incorrect: no code reads any of them.
The accurate, complete list is `.env.example` at the repository root.
Evidence: `git grep` for each name finds no reader — see `docs/CODEBASE_AUDIT.md` §6.
```

- [ ] **Step 7: Verify**

Run: `npx turbo typecheck && pnpm --filter @jarvis/config exec vitest run && pnpm --filter @jarvis/api exec vitest run`
Expected: typecheck 33/33; config 28; api 1,153 passed, 6 failed (B-1), 8 skipped.

- [ ] **Step 8: Proposed commit** — `chore(config): one root .env; complete, value-free template; drop unused names`

---

### Task 8: Consolidate reports and archive the legacy architecture document

**Files:**
- Move: 29 root reports → `docs/reports/`
- Move: `JARVIS_MASTER_AUDIT_AND_DEVELOPMENT_LEDGER.md` → `docs/`
- Move: `docs/ARCHITECTURE.md` → `docs/archive/ARCHITECTURE_LEGACY_2026-08.md`
- Modify: `docs/JARVIS_ARCHITECTURE.md:634-635`, `docs/JARVIS_USER_MANUAL.md:365`
- Modify: the ledger, a relocation note under its provenance note

**Interfaces:** none. Every report keeps its file name.

- [ ] **Step 1: Move the reports**

Run:
```bash
mkdir -p docs/reports docs/archive
git mv PHASE_*.md SPRINT_*.md JARVIS_COMMAND_CENTER_V3_FINAL_REPORT.md JARVIS_GOOGLE_MAPS_INTEGRATION_FINAL_REPORT.md JARVIS_GOOGLE_MAPS_USAGE_GUARD_REPORT.md JARVIS_UI_V2_AUTH_ORB_FINAL_REPORT.md docs/reports/
git mv JARVIS_MASTER_AUDIT_AND_DEVELOPMENT_LEDGER.md docs/
git mv docs/ARCHITECTURE.md docs/archive/ARCHITECTURE_LEGACY_2026-08.md
```

- [ ] **Step 2: Fix the links that change**

In `docs/JARVIS_ARCHITECTURE.md` and `docs/JARVIS_USER_MANUAL.md`, replace `](../SPRINT_2_META_ADS_CHANGE_BOUNDARY.md)` with `](./reports/SPRINT_2_META_ADS_CHANGE_BOUNDARY.md)` and `](../SPRINT_2.0_META_ADS_BASELINE_AUDIT.md)` with `](./reports/SPRINT_2.0_META_ADS_BASELINE_AUDIT.md)`.

- [ ] **Step 3: Note the relocation in the ledger** — below the provenance note in `docs/JARVIS_MASTER_AUDIT_AND_DEVELOPMENT_LEDGER.md`:

```markdown
> **Relocation note (2026-09-14).** This ledger moved from the repository root to `docs/`, and the phase and sprint reports it cites by file name moved to `docs/reports/`. File names are unchanged, so every citation below still identifies its report. See `docs/CODEBASE_AUDIT.md`.
```

- [ ] **Step 4: Verify**

Run: `git ls-files | grep -vE '/' | grep '\.md$' ; git grep -n -E "\]\(\.\./(PHASE_|SPRINT_|JARVIS_)" -- docs ; ls docs/reports | wc -l`
Expected: only `AGENTS.md` and `README.md` at the root; no broken relative link; `29`.

- [ ] **Step 5: Proposed commit** — `docs: move 29 reports to docs/reports, ledger to docs/, archive legacy architecture`

---

### Task 9: Documentation that describes the system as it is

**Files:**
- Create: `docs/ARCHITECTURE.md`, `docs/MEMORY.md`, `docs/SKILLS.md`, `docs/API.md`, `docs/DEVELOPMENT.md`
- Rewrite: `README.md`
- Modify: `AGENTS.md`, `docs/DOCUMENTATION_PROTOCOL.md`, `docs/JARVIS_MASTER_AUDIT_AND_DEVELOPMENT_LEDGER.md`, this file (Part 3)

**Interfaces:** documentation only; no code.

- [ ] **Step 1: `docs/ARCHITECTURE.md`** — the canonical overview: the §2 concept map; the workspace dependency graph from §2; request flow `USER → apps/web → apps/api route → Orchestrator (packages/agents) → domain agent → ToolExecutor (packages/tools) → integration package → provider`, with memory recall before and extraction after; the write path `IntegrationCommandService gates → ToolExecutor executes → approval (Postgres, 10 min) / confirmation (in-memory, 2 min) → journal → audit`; links to `JARVIS_ARCHITECTURE.md` for the marketing-intelligence pipeline history.
- [ ] **Step 2: `docs/MEMORY.md`** — the §4.4 chain with file paths; what is stored (the `Memory` table, `vector(1536)`), how recall is injected, how extraction filters secrets and transient text, the knowledge chunk → embed → retrieve path, graceful degradation without `OPENAI_API_KEY`, `MemoryEngine`'s status (D-4), and B-1.
- [ ] **Step 3: `docs/SKILLS.md`** — the nine agent ids from `AGENT_IDS` with their tool allowlists from `agent-policy.ts`; tool ids per module; the rule "a capability is an agent allowlist plus tools, not a new folder"; the difference between JARVIS capabilities and `.claude/skills/` (development tooling); how to add one, citing `AGENTS.md` for integrations.
- [ ] **Step 4: `docs/API.md`** — every mount path and endpoint from the §3 inventory, grouped by router, with which routers mount only when configured and on which variable; the two inline `/api/v1/health/integrations` routes; the `/capabilities` naming note; the `/recommendations/:id/outcome` split.
- [ ] **Step 5: `docs/DEVELOPMENT.md`** — prerequisites (Node ≥ 20, pnpm 9, Docker for pgvector Postgres); the four env files and why each exists; setup commands; ports (local 3000/3001/5432, Docker 3100/3101/5433); the quality gates `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`; why `@jarvis/db` tests need Postgres; the run-jarvis driver; the "search before you create" rule.
- [ ] **Step 6: `README.md`** — accurate stack (Express + Socket.IO, OpenAI plus ElevenLabs voice, no Fastify, no Redis); the real workspace list; `cp .env.example .env`; links to the five docs and `AGENTS.md`.
- [ ] **Step 7: `AGENTS.md`** — replace the "Repository layout" table with all 18 workspaces; add "Where new code goes" (the §2 map) and "Before creating a file: search, reuse, then create"; add "Documentation precedence: AGENTS.md → docs/ARCHITECTURE.md → the ledger → reports".
- [ ] **Step 8: `docs/DOCUMENTATION_PROTOCOL.md`** — update the structure block with the five new docs, `CODEBASE_AUDIT.md`, `reports/`, `archive/` and the ledger.
- [ ] **Step 9: Ledger** — append a §8.1 correction for B-1 in the protocol's format; mark P0-2 done ("moved, not deleted"); add S-9 (SEC-1) and S-10 (SEC-2) to §9; set R-15 resolved and add R-16 (history purge, D-1) and R-17 (B-1) to §11; add a §14 row for this cleanup.
- [ ] **Step 10: Part 3 of this file** — final folder tree, files removed, merged, moved, remaining broken functionality, remaining duplicates, unresolved security risks, variable names, architecture summary, next recommendations.
- [ ] **Step 11: Verify links and secrets**

Run: `git grep -n -E "\]\((\./|\.\./)[^)]+\.md\)" -- docs README.md AGENTS.md | while IFS= read -r l; do f=${l%%:*}; t=$(echo "$l" | sed -E 's/.*\]\(([^)#]+\.md)\).*/\1/'); [ -e "$(dirname "$f")/$t" ] || echo "BROKEN: $l"; done ; git grep -n -E "sk-[A-Za-z0-9]{20,}|EAA[A-Za-z0-9]{20,}|postgresql://[^u]" -- docs README.md AGENTS.md`
Expected: no `BROKEN` lines; no credential-shaped strings.

- [ ] **Step 12: Proposed commit** — `docs: architecture, memory, skills, API and development guides matching the code`

---

### Final verification — after Task 9

- [ ] `npx turbo typecheck` → 33/33
- [ ] `npx turbo lint` → 18/18
- [ ] `pnpm build` → 18/18
- [ ] `npx turbo run test --concurrency=1 --continue --filter='!@jarvis/db'` → **4,619 passed** (4,609 + 10 new), 6 failed (B-1 only), 8 skipped
- [ ] API and web start: boot with `node .claude/skills/run-jarvis/driver.mjs` if Docker is running; otherwise record the boot check as **NOT RUN** with the reason
- [ ] `git status` reviewed; nothing unexpected staged

### Self-review of this plan

- **Brief coverage:** audit (Part 1); duplicates (§5, Tasks 3, 4, 6); one env configuration (§6, Task 7); one memory system (§4.4, Task 3); brain, skills, tools, integrations, database, config, utils, frontend, backend homes (§2, Task 9); tests identified (§3, §4.11); docs (Task 9); dependency cleanup (Tasks 2, 3, 6); security (§7, Tasks 1, 4, 5, 7); plan before change (this part); small verified batches (every task). Items deliberately not executed are listed in §10 with reasons.
- **Placeholder scan:** code steps carry complete code. Task 7 Step 4 and Task 9 specify content by an exact list of facts, all established in Part 1.
- **Consistency:** `computeParamsHash`, `redactUrlForLog`, `accessLog`, `issueConfirmation`, `consumeConfirmation` are used with the same names and signatures throughout. Expected API counts chain 1,143 → 1,147 → 1,153.

---

# Part 3 — Cleanup Results

**Executed:** 2026-09-14, on `feat/p1-3-eslint`, inline in one session. Committed as eight commits on that branch after the owner approved committing; the branch is **not pushed**. `main` was force-pushed once, only to purge the database dump (SEC-1).

## Verification after cleanup — RUN

| Gate | Before | After |
|---|---|---|
| Typecheck | 33/33 | **33/33** |
| Lint | 18/18 | **18/18** |
| Build | 18/18 | **18/18** |
| Tests outside `@jarvis/db` | 4,609 passed, 6 failed, 8 skipped | **4,619 passed, 6 failed, 8 skipped** |
| Failing file | `sprint-1.1d-memory-e2e.test.ts` (B-1) | the same file, the same six tests — nothing new broke |
| API boot | — | **NOT RUN** — Docker is not running, and the API runs startup recovery against Postgres before it listens |
| Web boot | — | **NOT RUN** — starting the production server was refused by this environment (`Permission denied`, exit 126). The production build succeeded and all 552 web tests pass |

The ten new tests: 4 in `apps/api/test/confirmation-params-binding.test.ts`, 6 in `apps/api/test/access-log.test.ts`.

After the owner approved the pending deletions, all four gates ran again with Tasks 2 and 3 complete. The results were **identical**: typecheck 33/33, lint 18/18, build 18/18, 4,619 passed, 6 failed (B-1), 8 skipped. **RUN**

## Task status

| Task | Status | Notes |
|---|---|---|
| 1 — Stop tracking personal data and build artefacts | **Done** | Dump and both `tsbuildinfo` files untracked and ignored; all still on disk |
| 2 — Scratch scripts, superseded SQL, API JWT dependency | **Done** | `jsonwebtoken` removed first. The file deletions were blocked by the environment's safety check until the owner approved them, then run and verified |
| 3 — Dead memory stubs | **Done** | Run after the owner's approval as one unit: both files, their exports, the deprecated interface and the `openai` dependency |
| 4 — Canonical parameter hash | **Done** | Test written, seen failing (2 of 4), implemented, seen passing |
| 5 — Access-log redaction | **Done** | Test written, seen failing (module missing), implemented, seen passing; lint clean |
| 6 — Unused web dependencies | **Done** | 20 packages left the install; production build and 552 tests pass |
| 7 — One environment configuration | **Done** | Template 77 names, none missing, no values; loader and schema cleaned |
| 8 — Reports and legacy architecture | **Done** | 31 renames; links fixed |
| 9 — Documentation | **Done** | Updated again once Tasks 2 and 3 were complete |

## Deviations from the plan

- The new test files for Tasks 4 and 5 were created only after the earlier task's full-suite verification, so each count was attributable to one task.
- `apps/api/src/index.ts` was edited with an exact-match script (the file uses CRLF line endings) rather than three separate edits.
- Task 7's full API run was shared with Task 5's. Task 7 changes no code any API test imports, and its own typecheck and config checks ran separately.
- Task 8's link check was widened to the contents of moved files and `docs/archive/`. It found one broken link in the archived document, now fixed.
- The web boot check could not use the `run-jarvis` driver (it needs Docker) and a direct start was refused, as recorded above.
- Tasks 2 and 3 deleted files, which the environment's safety check blocked. They ran after the owner approved them, and everything was verified again.

## Found during execution

| Id | Finding | Evidence | Action |
|---|---|---|---|
| I-29 | Five tool classes are exported and tested but never registered: `data.csv.analyze` — **granted** to `conversational-assistant` and `analytics-agent` — plus `document.analyze`, `pdf.generate`, `web.research`, `system.echo` | **RUN**: none is instantiated anywhere in production source; the container registers tools only by explicit `registry.register(...)` | Documented in `SKILLS.md`; decision **D-6** |
| I-30 | `confirmations.ts` header calls a confirmation "valid for sixty seconds"; `CONFIRMATION_TTL_MS` is two minutes | **READ** | Left as is — a comment wording issue outside this cleanup's scope |

## 1. Final folder tree

```
JARVIS/
├── apps/
│   ├── api/                 src/{config,lib,middleware,routes,services,socket}, test/, scripts/phase116b/
│   └── web/                 src/{app,components,lib}, test/
├── packages/
│   ├── core/                contracts, Zod schemas, pure utilities
│   ├── agents/              the brain: orchestrator, router, planner, policy, agents
│   ├── tools/               tools, registry, ToolExecutor, journal
│   ├── memory/              extraction, chunking, embedding, retrieval
│   ├── db/                  prisma/, src/repositories
│   ├── security/            passwords, JWT, encryption, RBAC, approvals, audit
│   ├── config/              environment schema
│   ├── ai-openai/  ai-elevenlabs/  ai-anthropic/
│   └── meta-graph/  google-ads/  google-workspace/  whatsapp/  n8n/  browser/
├── docs/
│   ├── ARCHITECTURE.md  API.md  MEMORY.md  SKILLS.md  DEVELOPMENT.md  CODEBASE_AUDIT.md
│   ├── JARVIS_MASTER_AUDIT_AND_DEVELOPMENT_LEDGER.md
│   ├── JARVIS_ARCHITECTURE.md  JARVIS_USER_MANUAL.md  JARVIS_CAPABILITY_MATRIX.md
│   ├── CONTRACTS.md  INTEGRATIONS.md  DOCUMENTATION_PROTOCOL.md  DOCUMENTATION_AUDIT.md
│   ├── JARVIS-Project-Guide.doc  (+ JARVIS-Project-Guide_files/)
│   ├── reports/             29 phase and sprint reports
│   ├── archive/             ARCHITECTURE_LEGACY_2026-08.md
│   ├── phases/
│   └── diagrams/
├── .claude/skills/          Claude Code development skills — not loaded by JARVIS
├── .env.example  .gitignore  .dockerignore
├── AGENTS.md  README.md
├── Dockerfile  docker-compose.yml  eslint.config.mjs
└── package.json  pnpm-lock.yaml  pnpm-workspace.yaml  tsconfig.base.json  turbo.json
```

## 2. Files removed

**Deleted** — proof in Part 1 §9; git history keeps every one:

| File | Why |
|---|---|
| `apps/api/test-auth.ts`, `test-orchestrator.ts`, `test-ai-provider.ts`, `test-openai-adapter.ts` | Unreferenced, excluded from every tsconfig, 18 compile errors — I-08 |
| `fix-enums.sql` | Superseded by migration `20260824010000_phase117b_outcome_worker` — I-09 |
| `packages/memory/src/memory-manager.ts`, `packages/memory/src/knowledge-base.ts` | Non-functional stubs with no references — I-04, I-05 |

**Untracked from git and ignored, kept locally:**

| File | Why |
|---|---|
| `.claude/skills/run-jarvis/backups/jarvis-data-20260903-154135.sql` | Real user data — SEC-1 |
| `apps/web/tsconfig.tsbuildinfo`, `packages/core/tsconfig.tsbuildinfo` | Regenerated build state — I-10 |

## 3. Files and code merged

| Before | Canonical now |
|---|---|
| `hashParams` in `apps/api/src/services/integrations/confirmations.ts` | `computeParamsHash` in `packages/core/src/utils/params-hash.ts` |
| `morgan("combined")` in `apps/api/src/index.ts` | `accessLog()` in `apps/api/src/middleware/access-log.ts` — same line layout, credentials redacted |
| Five env-file loads in `apps/api/src/config/env.ts` | One: the repository-root `.env` |

**Dependencies removed:** `apps/api` — `jsonwebtoken`, `@types/jsonwebtoken`. `apps/web` — `axios`, `class-variance-authority`, `motion`, `next-auth`, `zod`, `@jarvis/security`, and the `@jarvis/security` transpile entry. `packages/memory` — `openai`.
**Type removed:** the deprecated `MemoryManager` interface in `packages/core/src/types/agent.ts`.
**Configuration removed:** `GITHUB_TOKEN`, `REDIS_URL` from the schema and the template.

## 4. Files moved

| Old | New |
|---|---|
| `JARVIS_MASTER_AUDIT_AND_DEVELOPMENT_LEDGER.md` | `docs/JARVIS_MASTER_AUDIT_AND_DEVELOPMENT_LEDGER.md` |
| `docs/ARCHITECTURE.md` (legacy) | `docs/archive/ARCHITECTURE_LEGACY_2026-08.md` |
| `JARVIS_COMMAND_CENTER_V3_FINAL_REPORT.md` | `docs/reports/JARVIS_COMMAND_CENTER_V3_FINAL_REPORT.md` |
| `JARVIS_GOOGLE_MAPS_INTEGRATION_FINAL_REPORT.md` | `docs/reports/JARVIS_GOOGLE_MAPS_INTEGRATION_FINAL_REPORT.md` |
| `JARVIS_GOOGLE_MAPS_USAGE_GUARD_REPORT.md` | `docs/reports/JARVIS_GOOGLE_MAPS_USAGE_GUARD_REPORT.md` |
| `JARVIS_UI_V2_AUTH_ORB_FINAL_REPORT.md` | `docs/reports/JARVIS_UI_V2_AUTH_ORB_FINAL_REPORT.md` |
| `PHASE_9.3_REPORT.md`, `PHASE_9.3-R_REPORT.md`, `PHASE_9.3_SMOKE_TEST_REPORT.md` | `docs/reports/` (same names) |
| `PHASE_10_PRODUCTION_READINESS_AUDIT.md` | `docs/reports/` |
| `PHASE_11_MARKETING_INTELLIGENCE_ARCHITECTURE.md`, `PHASE_11.6B_REAL_OPTIMIZATION_SMOKE_TEST_REPORT.md`, `PHASE_11.7A_OUTCOME_FOUNDATION_REPORT.md`, `PHASE_11.8B_RECOMMENDATION_CONFIDENCE_REPORT.md`, `PHASE_11.9_USER_ACCEPTANCE_TEST_REPORT.md`, `PHASE_11.9A_OPPORTUNITY_SCORING_REPORT.md`, `PHASE_11.9B_OPPORTUNITY_QUEUE_REPORT.md` | `docs/reports/` |
| `SPRINT_1.1A_MEMORY_WIRING_REPORT.md`, `SPRINT_1.1B_MEMORY_EXTRACTION_REPORT.md`, `SPRINT_1.1C_MEMORY_RECALL_REPORT.md`, `SPRINT_1.1D_FULL_MEMORY_E2E_REPORT.md` | `docs/reports/` |
| `SPRINT_2.0_BASELINE_DEFECT_REPORT.md`, `SPRINT_2.0_META_ADS_BASELINE_AUDIT.md`, `SPRINT_2.1_META_ADS_AGENT_REPORT.md`, `SPRINT_2.2_META_ADS_DOMAIN_INTELLIGENCE_REPORT.md`, `SPRINT_2.3_META_ACCOUNT_CONTEXT_REPORT.md`, `SPRINT_2.4_INTENT_ROUTING_HARDENING_REPORT.md`, `SPRINT_2_FINAL_META_E2E_UAT_REPORT.md`, `SPRINT_2_META_ADS_CHANGE_BOUNDARY.md` | `docs/reports/` |
| `SPRINT_3.0_KNOWLEDGE_BASE_BASELINE_AUDIT.md`, `SPRINT_3.1_KNOWLEDGE_SCHEMA_REPOSITORY_REPORT.md` | `docs/reports/` |

**New:** `apps/api/src/middleware/access-log.ts`, two API test files, `docs/ARCHITECTURE.md` (accurate replacement), `docs/API.md`, `docs/MEMORY.md`, `docs/SKILLS.md`, `docs/DEVELOPMENT.md`, this file.
**Rewritten:** `README.md`, `.env.example`. **Updated:** `AGENTS.md`, `docs/DOCUMENTATION_PROTOCOL.md`, `docs/JARVIS_ARCHITECTURE.md` (correction + links), `docs/JARVIS_USER_MANUAL.md` (links), the ledger.

## 5. Broken functionality remaining

| Id | What | Next step |
|---|---|---|
| B-1 | **Resolved 2026-09-14** on `fix/b1-memory-e2e`. A test-harness race, not a production memory bug: fire-and-forget extraction shared the suite's mock AI provider and overwrote the chat request the assertions read. Fix: extraction gets a non-recording view of the mock; test file only. The six tests passed three consecutive runs (6 passed, 7 skipped each); API suite 1,159 passed, 8 skipped; in-process store. Not verified: the Postgres-backed tests and the full repository suite | None — command in `docs/MEMORY.md` |
| B-3 | 8 `@jarvis/db` Postgres tests fail (inherited; not run) | Run with Postgres up, then diagnose |
| B-4 | Live Google grant lacks the `adwords` scope | Re-grant |
| I-29 | `data.csv.analyze` granted to two agents but never registered | D-6 |
| — | API and web boot not verified in this session | Start Docker, then `node .claude/skills/run-jarvis/driver.mjs up` and `smoke` |

## 6. Duplicate functionality

**Removed:** the weaker parameter hash; `motion` beside `framer-motion`.
**Removed after approval:** the non-functional `MemoryManager` and `KnowledgeBase` stubs, with their two stray `new OpenAI()` clients, and the extra `PrismaClient`s in the scratch scripts.
**Remaining by decision:** `MemoryEngine` alongside the runtime chain (D-4); near-identical retry helpers in `ai-openai` and `ai-anthropic` (tied to D-3); the three-line `buildBaseUrl` in `meta-graph` and `whatsapp` (sharing it would cost more than it saves).
**Confirmed not duplicates:** the two `isWidgetId`, the two `/capabilities` endpoints, the two `.env` loaders, the provider-specific redactors.

There is now exactly one memory runtime path, one database client, one JWT verifier, and no AI client outside its adapter package.

## 7. Security issues unresolved

| Id | Issue | Severity | Owner action |
|---|---|---|---|
| SEC-1 / R-16 | Purged from local history and from GitHub `main` (`ec2e895` → `a0ed04f`, verified), but GitHub still serves the old commits through `refs/pull/1`–`3`, which no push can change | **High** — the repository is private | Send the GitHub Support purge request; reset the passwords of the 6 accounts and revoke their refresh tokens; re-clone any other copy |
| SEC-7 | No CI, so no automated secret scanning | Medium | Add CI |
| SEC-8 | Lint has no security rules | Low | Ratchet rules (R-14) |
| SEC-5 | Real account identifiers in `apps/api/scripts/phase116b/state.json` | Informational | Mask if preferred |
| SEC-6 | Per-process confirmation store and IP limiter | Informational, by design | Sticky sessions if ever scaled out |

**Resolved in this cleanup:** SEC-2 (access log), SEC-3 (confirmation hash), SEC-4 (template), and SEC-1 in part — no longer tracked, purged from history and from GitHub `main`.

## 8. Environment variables — names only

| Group | Names |
|---|---|
| **Required** | `DATABASE_URL`, `JWT_SECRET`, `OPENAI_API_KEY` |
| Application | `NODE_ENV`, `API_PORT`, `PORT`, `CORS_ORIGIN`, `OPENAI_EMBEDDING_MODEL` |
| Google OAuth and Ads | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_LOGIN_CUSTOMER_ID` |
| Encryption at rest | `JARVIS_ENCRYPTION_KEY`, `JARVIS_ENCRYPTION_KEY_VERSION`, `JARVIS_ENCRYPTION_KEY_RETIRED` |
| Meta | `META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID`, `META_GRAPH_API_VERSION` |
| n8n | `N8N_BASE_URL`, `N8N_API_KEY`, `N8N_CALLBACK_SECRET`, `N8N_TIMEOUT_MS` |
| WhatsApp | `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_API_VERSION` |
| Google Maps | `GOOGLE_MAPS_BROWSER_KEY`, `GOOGLE_MAPS_SERVER_KEY`, `GOOGLE_MAPS_MONTHLY_LIMIT` |
| Market indices | `MARKET_INDICES_API_URL`, `MARKET_INDICES_API_KEY` |
| ElevenLabs | `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL_ID`, `ELEVENLABS_OUTPUT_FORMAT`, `ELEVENLABS_STABILITY`, `ELEVENLABS_SIMILARITY_BOOST`, `ELEVENLABS_STYLE`, `ELEVENLABS_SPEAKER_BOOST`, `ELEVENLABS_SPEED` |
| AI models | `OPENAI_DEFAULT_MODEL`, `OPENAI_VISION_MODEL`, `OPENAI_TIMEOUT_MS`, `OPENAI_MAX_RETRIES` |
| Voice | `VOICE_ENABLED`, `VOICE_MAX_AUDIO_BYTES`, `VOICE_MAX_TTS_CHARS`, `OPENAI_STT_MODEL`, `OPENAI_STT_LANGUAGE`, `OPENAI_TTS_MODEL`, `OPENAI_TTS_VOICE`, `OPENAI_TTS_SPEED`, `OPENAI_TTS_INSTRUCTIONS` |
| Sign-in, sessions, runtime | `API_PUBLIC_URL`, `GOOGLE_SIGNIN_REDIRECT_URI`, `AUTH_COOKIE_NAME`, `JARVIS_ALLOW_LOCAL_ORIGIN`, `TRUST_PROXY`, `JARVIS_SHUTDOWN_GRACE_MS`, `JARVIS_IN_CONTAINER` |
| Browser automation | `BROWSER_ENABLED`, `CHROME_PATH`, `BROWSER_HEADLESS`, `BROWSER_DOMAIN_ALLOWLIST`, `BROWSER_DOWNLOAD_DIR`, `BROWSER_NAVIGATION_TIMEOUT_MS`, `BROWSER_SESSION_TIMEOUT_MS`, `BROWSER_MAX_SESSIONS`, `BROWSER_MAX_EXTRACT_CHARS`, `BROWSER_MAX_DOWNLOAD_BYTES` |
| Anthropic — not wired | `ANTHROPIC_API_KEY`, `CLAUDE_DEFAULT_MODEL`, `CLAUDE_TIMEOUT_MS`, `CLAUDE_MAX_RETRIES` |
| Web app (`apps/web/.env.local`) | `NEXT_PUBLIC_API_URL` |

77 names. Every `process.env` name read by the API and packages appears. **RUN**

## 9. Architecture summary

How **USER → UI → API → JARVIS CORE → SKILL → TOOL / INTEGRATION → RESULT** maps onto the code:

| Step | Where | What happens |
|---|---|---|
| USER | a browser | Types or speaks a request |
| UI | `apps/web` — `src/lib/api.ts` | Sends it with the access token; never calls a provider |
| API | `apps/api` — auth middleware, `routes/chat.ts` | Verifies identity from the token alone |
| JARVIS CORE | `packages/agents` — `orchestrator.ts` | Recalls memories and document passages, routes to an agent |
| SKILL | a domain agent + its allowlist in `agent-policy.ts` | Decides which tools to call; may only propose tools it is granted |
| TOOL | `packages/tools` — `ToolExecutor` | Validates, checks permission, enforces approval or confirmation, applies one deadline, journals, audits |
| INTEGRATION | a provider package through a port | Makes the provider call |
| RESULT | back through the executor and agent | Secrets stripped, reply returned, durable memories extracted afterwards |

## 10. Next development recommendations

Not implemented. In order:

1. **Finish D-1.** History and GitHub `main` were purged on 2026-09-14. Still to do: the GitHub Support request for `refs/pull/1`–`3`, the six password resets, then deleting the local pre-purge bundle.
2. **Review and merge** `feat/p1-3-eslint`. Its eight commits exist only locally.
3. **Re-clone any other copy** of this repository. Its history no longer matches GitHub and still contains the dump.
4. **Diagnose B-1** — the six failing memory end-to-end tests — before any new memory work.
5. **Add CI** running typecheck, lint, build, tests and a secret scan on every push.
6. **Decide D-2, D-3, D-4 and D-6** — hero preview, Anthropic adapter, `MemoryEngine`, unregistered tools.
7. **Refresh the Master Development Document and the capability matrix** to the current system.
8. **Migrate the remaining direct `process.env` reads** in `apps/api` into `packages/config`, keeping tests' ability to inject values.
9. **Refresh model identifiers** in the AI adapters.
