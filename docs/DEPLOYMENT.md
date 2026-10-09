# Deployment Runbook

How to deploy JARVIS, check that the deployment is healthy, and roll it back. Every command here is one this repository's `docker-compose.yml` and `package.json` scripts actually support. Verified on 2026-10-06 against an isolated copy of the stack — see [What was rehearsed](#what-was-rehearsed).

There is one operator and one deployment: the Docker stack on the operator's machine. Nothing here assumes a second environment, a load balancer or an on-call rota, because none exists.

---

## The stack

`docker-compose.yml` runs three containers from two images.

| Service | Container | Host port | What it is |
|---|---|---|---|
| `postgres` | `jarvis-docker-postgres` | 5433 | PostgreSQL 16 with pgvector, data in the `jarvis-docker-pgdata` volume |
| `api` | `jarvis-docker-api` | 3101 | The Express API. Applies migrations, then starts |
| `web` | `jarvis-docker-web` | 3100 | The Next.js dashboard |

`api` and `web` are the same image, `jarvis-app:latest`, started with different commands. The local development stack uses 5432, 3001 and 3000 and is a separate database; the two can run side by side.

## 1. Prerequisites

- Docker Desktop running: `docker info` answers.
- The repository checked out at the commit you intend to deploy: `git log -1 --oneline`.
- A `.env` file at the repository root. It is not in git. `docker-compose.yml` hands it to the API as `env_file`.

Run the commands from the repository root, in PowerShell. In Git Bash, put `MSYS_NO_PATHCONV=1` in front of any `docker exec` command that names a path inside a container (`/tmp/…`): Git Bash otherwise rewrites that path into a Windows one, and the command fails.

## 2. Environment variables

Names and meanings are in [`.env.example`](../.env.example) and [DEVELOPMENT.md](./DEVELOPMENT.md). The compose file overrides the few that must differ inside a container — `DATABASE_URL`, `CORS_ORIGIN`, `API_PORT`, `API_PUBLIC_URL`, `GOOGLE_REDIRECT_URI`, `AUTH_COOKIE_NAME` — so a `.env` written for local development works unchanged.

The image sets `NODE_ENV=production`, and in production the API **refuses to start** on a configuration it cannot run safely. It names each failing variable and never prints a value:

| Variable | Refused when |
|---|---|
| `DATABASE_URL` | missing; not a `postgresql://` or `postgres://` URL that names a host; or the placeholder from `.env.example`. In this stack the compose file sets it, so `.env` cannot get it wrong; the check is for an API started some other way |
| `JWT_SECRET` | shorter than 32 characters, a published placeholder, or too little variety to be a secret |
| `OPENAI_API_KEY` | missing, or the placeholder from `.env.example` |
| `CORS_ORIGIN` | missing, `*`, or a localhost address without `JARVIS_ALLOW_LOCAL_ORIGIN=true` (the compose file sets that opt-in, because this stack really is local) |
| `JARVIS_ENCRYPTION_KEY` | missing while Google OAuth is configured |

A refusal is in `docker compose logs api`, under one of two headings. The first means a variable is missing or has the wrong form; the second, that it is present and well-formed and still not safe to run on:

```
Invalid server environment variables:
{ JWT_SECRET: [ 'String must contain at least 32 character(s)' ] }
```

```
Unsafe production configuration:
  OPENAI_API_KEY: is the placeholder from .env.example, not a real key
```

The API exits, Docker starts it again, and it refuses again: `docker compose ps` shows the API restarting every few seconds and never `(healthy)`. Correct the variable in `.env`, then `docker compose up -d` — a plain restart does not read `.env` again.

`JARVIS_ENCRYPTION_KEY` has two more cases, and neither is on that list:

- **Set, but not 32 bytes of base64.** The API stops while starting, with `Encryption key must decode to exactly 32 bytes for AES-256`. It prints the reason and never the key.
- **Not set at all, with Google OAuth not configured.** The API starts, with the integration commands switched off entirely — and with them every integration action that writes outside JARVIS. The log says `"event":"integration_commands_disabled"`. That is a refusal, not a fallback: nothing stores a credential or a confirmation unencrypted or in memory instead.

One timing spans two places. The API gives work that is already running `JARVIS_SHUTDOWN_GRACE_MS` (30 seconds unless set) to finish when it is asked to stop. Docker kills a container `stop_grace_period` after asking, and the compose file sets that to 40 seconds for the API. **If you raise the first, raise the second above it.**

## 3. Before you deploy

Two steps make a rollback possible. Neither changes the running system.

**Back up the database.** Taken inside the container and copied out, so no shell re-encodes it:

```bash
docker exec jarvis-docker-postgres pg_dump -U jarvis -d jarvis --format=custom -f /tmp/jarvis-pre-deploy.dump
docker exec jarvis-docker-postgres pg_restore --list /tmp/jarvis-pre-deploy.dump
docker cp jarvis-docker-postgres:/tmp/jarvis-pre-deploy.dump <a private folder outside the repository>
docker exec jarvis-docker-postgres rm /tmp/jarvis-pre-deploy.dump
```

The second command reads the dump back and prints its contents list — a couple of hundred lines naming every table. A list means the backup is readable; an error means it is not, and there is no backup yet. The last command removes the copy left inside the container.

The dump holds real user rows — emails, password hashes, chat history. Keep it out of the repository and delete it when it is no longer needed.

**Keep the image that is running now**, under a second name:

```bash
docker tag jarvis-app:latest jarvis-app:rollback
```

The build in step 5 moves `jarvis-app:latest` to the new image. Without this tag the old one is left unnamed and is awkward to find again. `rollback` is overwritten at the next deployment; to keep an image for longer, give it a name of its own as well, the way earlier ones on this machine were kept (`docker images jarvis-app` lists them, for example `jarvis-app:s7-895ceb4`).

Note the commit that is deployed now, too — `git log -1 --oneline` before you move to the new one. A rollback needs it.

## 4. Database migrations

There is no separate migration step. The API container runs

```bash
pnpm --filter @jarvis/db exec prisma migrate deploy
```

before it starts the server, every time it starts. `migrate deploy` applies only the migrations the database has not seen, in order, and is safe to repeat. If a migration fails, the server is never started: the container exits, Docker starts it again and it fails again, so `docker compose ps` shows the API restarting. The failure is in `docker compose logs api`.

To see what a running deployment has applied:

```bash
docker compose exec api pnpm --filter @jarvis/db exec prisma migrate status
```

Migrations in this repository only go forward. There are no down-migrations, and an applied migration is never edited — Prisma checks each file against the checksum it recorded. To undo a schema change, write a new migration.

## 5. Deploy

```bash
docker compose build
docker compose up -d
```

`up -d` recreates the containers whose image changed and leaves the database container and its data alone. The API waits for PostgreSQL to be healthy, and the web app waits for the API.

## 6. Check that it is healthy

Give it a minute or two: the API's health check allows 40 seconds for start-up and the web app's 30, and the web app starts only once the API is healthy. In the rehearsals the whole stack was healthy between 25 and 80 seconds after `up -d`.

```bash
docker compose ps
```

All three services should say `(healthy)`. Then ask each one directly:

```bash
curl http://localhost:3101/api/v1/health/live
curl http://localhost:3101/api/v1/health/ready
curl http://localhost:3100/healthz
```

(In Windows PowerShell 5.1, type `curl.exe` — plain `curl` there is a different command.)

| Ask | Healthy answer | What it tells you |
|---|---|---|
| `/api/v1/health/live` | `200` `{"status":"alive",…}` | The API process is up and answering |
| `/api/v1/health/ready` | `200` `{"status":"ready","checks":{"database":"ok"},…}` | It can reach the database and is not shutting down |
| `/healthz` on the web port | `200` `{"status":"ok","service":"jarvis-web",…}` | The web server is up and answering |

`ready` is the one that proves the deployment works. `live` only proves a process exists.

## 7. Check the confirmation store

Since Phase 13, a confirmation of an external write is a row in PostgreSQL rather than memory in one process. After a deploy, check that its table arrived with the migrations:

```bash
docker compose exec postgres psql -U jarvis -d jarvis -c "SELECT count(*) FROM information_schema.tables WHERE table_name = 'Confirmation';"
```

`1` means it is there. `prisma migrate status` in step 4 says the same thing a different way: `20261006120000_phase13_confirmation` is applied.

When someone next confirms an external write through the Integration Center, the API log shows the pair of events for it, by id — never the token, the parameters or the summary:

```bash
docker compose logs api --since 10m
```

```
{"timestamp":"…","level":"info","service":"jarvis-api","component":"confirmations","event":"confirmation_issued","confirmationId":"…",…}
{"timestamp":"…","level":"info","service":"jarvis-api","component":"confirmations","event":"confirmation_consumed","confirmationId":"…",…}
```

### Memory: project scope and retention

Since Phase 14, memory can belong to a project and expired memories are purged. After a deploy, check that the migration arrived — `20261008120000_phase14_memory_project_scope` adds the `Project` table and a nullable `projectId` column to `Memory` and `Conversation`, and rewrites no existing row:

```bash
docker compose exec postgres psql -U jarvis -d jarvis -c '\d "Project"' -c 'SELECT count(*) AS memories, count("projectId") AS in_a_project FROM "Memory"'
```

Every memory that existed before the deploy has no project: it is personal, exactly as before. The retention sweep starts with the API (`memory_retention_started` in the log, then `memory_retention_sweep_completed` with counts) and runs every `JARVIS_MEMORY_RETENTION_INTERVAL_MS` — six hours unless set; `0` switches the purge off, in which case expired memories stay hidden from recall but are never deleted. The first sweep after this deploy deletes memories that expired more than 30 days ago; nothing that has not expired, and nothing without an expiry date, is ever touched by it.

## 8. After the deployment

Look at what the API said while starting:

```bash
docker compose logs api --since 10m
```

| You should see | Meaning |
|---|---|
| `No pending migrations to apply.` or `All migrations have been successfully applied.` | The schema matches this release |
| `"event":"startup_recovery_complete"` | Work interrupted by the last stop was accounted for |
| `"event":"api_started"` | The port is open |

| You should not see | Meaning |
|---|---|
| `Invalid server environment variables:` or `Unsafe production configuration:` | A variable in section 2 is wrong. The API keeps restarting until it is corrected |
| `"event":"monitor_exception"` | An error nobody handled. See [Monitoring](#monitoring) |
| `"event":"unhandled_rejection"` or `"uncaught_exception"` | The same, and it escaped every handler |

Then use it: sign in at http://localhost:3100, send one chat message, open the Integrations page.

---

## Rolling back

### When

Roll back when a deployment has made things worse and the cause is not obvious within a few minutes. In particular:

- the API container does not become healthy, or keeps restarting;
- `/api/v1/health/ready` stays `503` although `docker compose ps` shows PostgreSQL healthy;
- the log shows `monitor_exception` or `request_failed` at level `error` for ordinary requests that worked before;
- an external write is refused with a message about having nowhere to record a confirmation, or answers `INTERNAL_ERROR` at the confirmation step;
- a migration failed, and the API therefore never started.

Rolling back is always safe to try first. It changes which code runs and nothing else.

### How

A release is two things: the image, and the `docker-compose.yml` that says how to run it and how to check it. Put **both** back. First the files, to the commit noted in step 3; then the image, under the name the stack uses; then recreate the two application containers without building:

```bash
git switch --detach <the commit that was deployed before>
docker tag jarvis-app:rollback jarvis-app:latest
docker compose up -d --no-build --force-recreate api web
```

If you did not tag the image in step 3, build the previous release from its source instead of the second and third lines:

```bash
docker compose build
docker compose up -d
```

Then check it the way that release is checked. `docker compose ps` should show the API `(healthy)`, and `/api/v1/health/live` and `/api/v1/health/ready` should answer `200`. A release from before Phase 13 has no `/healthz` and no health check on the web container: `docker compose ps` shows it as `Up` with nothing after it, and the test is that http://localhost:3100 loads.

`git switch --detach` only changes the files in the folder; it does not touch `.env`, the database or anything that is running. To come back afterwards, `git switch` to the branch you were on (normally `main`).

**Why the files and not just the image.** If only the image is put back and the newer `docker-compose.yml` stays, a release from before Phase 13 runs and serves pages normally — but about two minutes later `docker compose ps` reports the web container `unhealthy`. The newer file asks it for `/healthz`, which that release does not have. Nothing restarts the container and nothing depends on that reading; it is a false alarm, not an outage, and it is the reason for the first line above.

### The database stays where it is

**Do not undo a migration to roll back.** A previous release starting against a database that already has newer migrations is fine: its `migrate deploy` step reports `No pending migrations to apply.` and the server starts. This was checked for the Phase 13 migration specifically.

That works because migrations here are additive. `20261006120000_phase13_confirmation` adds one table and touches nothing else; a release from before Phase 13 never reads or writes it. Leave the table in place — it is used again the next time the newer release is deployed.

A migration that **failed part-way** is different. Prisma records it as failed and will refuse to apply anything after it until it is resolved, and how to resolve it depends on what the migration had already done. Roll the application back so the service is up, then stop and work out the state of the database before touching it.

### Confirmations across a rollback

A confirmation lives for two minutes, so at most a few are ever pending.

| Situation | What happens |
|---|---|
| Asked on the new release, confirmed after rolling back | The older release keeps confirmations in its own memory and does not know this one. It answers "not recognised"; the user asks again. **Nothing runs** |
| Asked on the old release, confirmed after deploying the new one | The same, the other way round |
| Rows left in the `Confirmation` table after a rollback | Inert. Nothing reads them, and each is deleted about a day after it expires, the next time the newer release issues a confirmation |

In every case the write is refused rather than run twice or run unconfirmed. The cost of a rollback to a user who was mid-confirmation is being asked once more.

### What can be lost

| Action | Risk |
|---|---|
| Rolling the application back | None to stored data |
| A stop that outlasts the grace period | Work still running is cut off. An external write that was in flight stays in the execution journal as unfinished and is reconciled at the next start; it is never silently repeated |
| Restoring the backup from step 3 | **Everything written since the backup is gone**: conversations, memories, approvals, audit rows. This is a last resort for a database that is actually damaged, and it is the owner's decision. It is not part of an ordinary rollback and nothing in this repository does it automatically |

### Restoring the backup — last resort

Only for a database that is damaged, and only as the owner's decision: this replaces what is in the database with what was in it when the backup was taken. Nothing in the repository runs these for you.

```bash
docker compose stop api web
docker cp <the private folder>/jarvis-pre-deploy.dump jarvis-docker-postgres:/tmp/jarvis-pre-deploy.dump
docker exec jarvis-docker-postgres dropdb -U jarvis jarvis
docker exec jarvis-docker-postgres createdb -U jarvis jarvis
docker exec jarvis-docker-postgres pg_restore -U jarvis -d jarvis /tmp/jarvis-pre-deploy.dump
docker exec jarvis-docker-postgres rm /tmp/jarvis-pre-deploy.dump
docker compose start api web
```

The application is stopped first so nothing is connected while the database is replaced; if `dropdb` says the database is being accessed by other users, something still is. `pg_restore` prints nothing when it succeeds. The database is then exactly as it was at the backup, including which migrations it has, and the API applies whatever its release still needs when it starts. Finish with section 6.

**Replace the whole database; do not restore over it.** `pg_restore --clean` into the existing database looks like a shortcut and is a trap: it only replaces the tables that are in the backup. A table a newer release added — `Confirmation`, for a backup from before Phase 13 — is left behind, and the next start fails with `P3018 … relation "Confirmation" already exists`. That was tried, and that is what happened.

---

## Stopping

```bash
docker compose stop api
```

Docker sends the API `SIGTERM`. It stops accepting new side-effecting work at once, lets running executions and open requests finish within the grace period, closes what is left, disconnects from the database and exits. The log shows the sequence:

```
"event":"shutdown_initiated" → "drain_finished" → "connections_closed" → "shutdown_complete"
```

`"connections_closed"` with `"forced":true` means some connection had to be cut when the grace period ran out. While it is stopping, `/api/v1/health/ready` answers `503` `draining`.

## Monitoring

Nothing here depends on a monitoring service. Everything below works with none configured, and the application behaves the same whether or not anything is watching.

### Uptime

Point an external uptime monitor at these. None needs credentials, and none returns configuration.

| Endpoint | Healthy | Unhealthy | Use it for |
|---|---|---|---|
| `GET /api/v1/health/ready` (API) | `200`, `"status":"ready"` | `503` `"not_ready"` — the database did not answer within 2 seconds; `503` `"draining"` — it is shutting down | **The one to alert on.** It is what "JARVIS is working" means |
| `GET /api/v1/health/live` (API) | `200`, `"status":"alive"` | No answer | Restart decisions. It never touches the database, so a database outage cannot get a healthy process killed |
| `GET /healthz` (web) | `200`, `"status":"ok"` | No answer | The dashboard's own server. It deliberately does not ask the API |
| `GET /api/v1/health` (API) | `200`, `"status":"ok"` or `"draining"` | No answer | The original probe, kept as it was. It answers `200` even while draining |

A failed readiness check names the dependency (`"checks":{"database":"failed"}`) and nothing about why: a database driver's error text contains a host, a port and sometimes a password.

The Docker health checks ask `live` and `healthz`, because their job is to say whether a container is running. `docker compose ps` shows the result.

### Errors

The API reports every error nobody handled to one place, the error monitor. With no service configured, each report is a log line:

```
{"timestamp":"…","level":"error","service":"jarvis-api","component":"http","event":"monitor_exception","severity":"error","message":"…","traceId":"…",…}
```

| Reported | From |
|---|---|
| A request that threw and was answered with a `5xx` status | The HTTP error handler. A `4xx` is the caller's mistake and is not reported |
| An integration command that failed in a way nothing expected — the confirmation store being unreachable is one such failure | The integration command service. The command is refused with `INTERNAL_ERROR`; a write is never run |
| An unhandled promise rejection or uncaught exception | The process, as `"severity":"fatal"` |
| A step of shutdown failed | The shutdown controller |

A refusal is not an error and is not reported: a confirmation that expired, a provider that answered "no", a rate limit. Those are in the audit trail.

With no service configured, a failed request therefore appears twice in the log — once as `request_failed`, the request's own line, and once as `monitor_exception`, the report. A hosted tracker would receive only the second.

Any log-based alert can match `"event":"monitor_exception"`. To send reports to a hosted error tracker instead, give `createErrorMonitor` a sink for it in `apps/api/src/services/observability/index.ts`; nothing that reports changes. Whatever the sink, an event is redacted before it leaves — tokens, passwords, headers and the credentials in a connection URL are removed — and a sink that is down or slow never fails or delays a request.

### Logs

Operational events are one JSON object per line with `timestamp`, `level`, `service`, `component` and `event`:

```bash
docker compose logs api --since 1h
```

| `event` | When |
|---|---|
| `api_started`, `startup_recovery_complete` | Start-up |
| `shutdown_initiated`, `drain_finished`, `connections_closed`, `shutdown_complete` | Shutdown |
| `request_failed` | A request ended in an error: `warn` for a `4xx`, `error` for a `5xx` |
| `confirmation_issued`, `confirmation_consumed`, `confirmation_refused` | An external write was described, confirmed, or refused, with the reason |
| `monitor_exception`, `monitor_message` | A report to the error monitor |

Not every line in the log has this shape yet. The request log is one text line per request, and older components write JSON without a timestamp. The events above are the ones to build checks on.

## When something is wrong

There is no escalation path beyond the operator, so this is an order of work rather than a list of people.

1. **Is it up?** `docker compose ps`, then the three checks in section 6.
2. **What does it say?** `docker compose logs api --since 15m`. Look for the "should not see" lines in section 8.
3. **Did it start after a deployment?** Roll back first, investigate second.
4. **Is the database the problem?** `docker compose logs postgres --since 15m`. `ready` at `503` with `"database":"failed"` while `live` is `200` means the API is fine and cannot reach PostgreSQL.
5. **Has something been written outside JARVIS that should not have been?** Stop the API: `docker compose stop api`. That stops every external write. Then read the audit trail before starting it again.
6. **Might data or a credential have been exposed?** That is a security incident, not a deployment problem. The open ones and what they need from the owner are in [CODEBASE_AUDIT.md](./CODEBASE_AUDIT.md), "Security issues unresolved".

## What was rehearsed

Recorded so the claims above can be told apart from intentions.

**Run for real on 2026-10-06**, on an isolated copy of this stack — its own project name, ports, database volume and image tags, and placeholder credentials, so the real deployment was never touched. Three images were built with this `Dockerfile`: the Phase 13 release twice (once mid-way, once from the final code) and the release before it.

| What | How | Result |
|---|---|---|
| Deploy onto an empty database | `docker compose up -d` | Three containers healthy in about 25 seconds; 28 migrations applied from nothing |
| Deploy onto a database from before Phase 13, with data in it | The new release started against it | It applied `20261006120000_phase13_confirmation` by itself and started healthy; the existing row was still there |
| Deploy onto a current database | Plain `docker compose up -d` after the image changed | `api` and `web` recreated; `postgres` neither recreated nor restarted; `No pending migrations to apply.` |
| Health | The three `curl` checks in section 6, and `docker compose ps` | `200` each; all three containers `(healthy)` |
| Migration status and confirmation store | The commands in sections 4 and 7 | `28 migrations found`, `Database schema is up to date!`; count `1` |
| A confirmation across a restart | Asked for an external write over HTTP, `docker compose restart api`, then confirmed | The new process accepted it; presenting it a second time was refused as not recognised; an expired one was refused as expired. The table held a SHA-256, no token and no parameter |
| Secrets in the logs | Searched every log line for each credential in use, and for bearer tokens, JWTs and passwords in URLs | None found |
| The database going away | `docker compose stop postgres`, then `start` | `live` stayed `200`; `ready` went `503` with `"database":"failed"`; an ordinary request and a request for an external write were each answered `500` with a generic message and reported as `monitor_exception`; `ready` returned to `200` by itself, with no API restart |
| Stopping | `docker compose stop api`, three ways | Nothing connected: shut down in 14 ms. An idle keep-alive connection open: 0.1 s, nothing forced. A request that never completes: waited the 30-second grace, cut it (`"forced":true`), exited with code 0 — before Docker's 40-second limit |
| A bad configuration | Started the image on eight wrong configurations, and once with no encryption key | The eight were refused as section 2 says, without printing a value; with no key it started with the integration commands off. In the stack, the refused container restarted in a loop until corrected |
| Rolling back — image and files | The steps under "How" | API healthy in 15 seconds; web app up with no health check, pages loading; database container untouched |
| Rolling back — image only | The same, keeping the newer `docker-compose.yml` | API healthy in 22 seconds, saying `27 migrations found` and `No pending migrations to apply.` against a database with 28. The web app served pages and was marked `unhealthy` two minutes later, for the reason given under "How" |
| Confirmations across the rollback | Asked on one release, confirmed on the other, both ways | Refused as not recognised each time. Nothing ran |
| Backup | The four commands in section 3 | Dump read back, then restored into an empty database: the same 30 tables and the same row counts |
| Restoring the backup | The steps under "Restoring the backup", with a backup from before Phase 13 | The database returned to its 27 migrations and its row; the new release then applied the 28th and started healthy |
| Restoring over the database instead | `pg_restore --clean --if-exists` | Six errors, the `Confirmation` table left behind, and the next start failed with `P3018` — which is why the runbook does not do it |

The steps the last code changes could affect — the database going away, a confirmation across a restart, stopping, the search of the logs — were repeated on the image built from the final code. The backup, health and confirmation-store commands were run in PowerShell as well as Git Bash, all but the `rm` line.

**Not rehearsed:**

- Anything on the real stack — ports 3100, 3101 and 5433. No deployment, rollback, backup or restore has been run against it.
- `docker compose build` itself. The images were built with `docker build --target runtime` and their own tags: the same `Dockerfile` and target, without replacing `jarvis-app:latest`.
- `git switch --detach` in this folder. The previous release's files came from `git archive` into a separate folder.
- A migration failing in the stack. The failure was produced with a one-off container; that the stack then restarts in a loop is inferred from the bad-configuration case, where it did.
- A hosted error tracker or uptime monitor. None is configured.
