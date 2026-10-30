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

### The isolated browser service (Phase 19.2, optional)

A separate container runs Chromium for the browser tools. It is **off**, and it
is not part of `docker compose up` — it is a compose profile, and the API only
uses it when `BROWSER_SERVICE_URL` is set as well.

It is not a sandbox by itself. It is a container with limits; Chromium keeps its
own sandbox (the launcher sets Playwright's `chromiumSandbox: true`, without
which Playwright would add `--no-sandbox` itself), and if the host cannot
support that, sessions fail rather than run unsandboxed. Under the shipped
compose settings that failure is likely: Docker's default seccomp profile
refuses the user namespaces Chromium's Linux sandbox uses. This has not been
observed yet — see step 5. Do not "fix" it with `seccomp:unconfined` or
`--no-sandbox`.

What the container receives is limited, and how far:

- **Variables.** It has no `env_file`. Compose passes it only the
  `BROWSER_SERVICE_*` and `BROWSER_*` names listed in its `environment` block
  (filled from `.env` at `docker compose` time), plus `NODE_ENV` and
  `CHROME_PATH`. The database URL, the JWT and encryption secrets and every
  provider credential stay out of it.
- **Network (Phase 19.3).** It is on the `browser` network only, with the API
  and the egress proxy; PostgreSQL and the web app are not on it. `browser` is
  an **internal** network: Docker gives it no route out, so the container's only
  way to anything beyond the API is the `browser-egress` proxy (see "Browser
  egress" below). Chromium is launched with that proxy for every connection,
  loopback included, and can resolve no other name.
- **Storage (Phase 19.4).** Its root filesystem is read-only. The one writable,
  persistent path is the named volume `jarvis-browser-artifacts`, mounted at
  `/var/lib/jarvis-browser/artifacts` for its artifact store (see "Browser
  artifacts" below); `/tmp` is a size-capped tmpfs for Chromium's scratch,
  emptied on every restart. The volume is mounted into no other service.

To enable it:

1. Generate the TLS material yourself. This deployment ships none, and both
   sides refuse to run without it: a certificate and key for the service, a CA
   both sides trust, and a client certificate for the API whose CN/SAN is the
   value of `BROWSER_SERVICE_PEER_IDENTITY`. Mount the directory into both
   containers with a `docker-compose.override.yml`; nothing here mounts it for
   you. Certificate lifetime, rotation and revocation are **not decided** (U2,
   `docs/phases/phase-19.md` §14.7): nothing rotates or revokes a certificate,
   and a leaked client certificate stays valid until you replace its CA.
2. In `.env`, set `BROWSER_ENABLED="true"` and
   `BROWSER_SERVICE_URL="https://browser-service:3200"` (an `http:` URL is
   refused), the same `BROWSER_SERVICE_KEY_ID`, `BROWSER_SERVICE_SHARED_SECRET`
   (32+ random characters) and `BROWSER_SERVICE_PEER_IDENTITY` for both sides,
   the API's `BROWSER_SERVICE_CLIENT_CERT_PATH`, `BROWSER_SERVICE_CLIENT_KEY_PATH`
   and `BROWSER_SERVICE_CA_PATH`, and the service's
   `BROWSER_SERVICE_TLS_CERT_PATH`, `BROWSER_SERVICE_TLS_KEY_PATH` and
   `BROWSER_SERVICE_TLS_CA_PATH`, as mounted. Mutual TLS is the only mode: the
   service will not start if `BROWSER_SERVICE_REQUIRE_MTLS` is set to anything
   but `true` or `BROWSER_SERVICE_TRUST_FORWARDED_PEER_IDENTITY` to anything but
   `false`.
3. Set `BROWSER_SERVICE_CHROMIUM_ENABLED="true"` for the service. Without it the
   container is up and refuses every session, by design. With it, the service
   also requires `BROWSER_SERVICE_EGRESS_PROXY_URL`, which compose sets to
   `http://browser-egress:3128`, and `BROWSER_ARTIFACT_RETENTION_HOURS`, which
   has no default and which you set in `.env` (Phase 19.4, below); it refuses
   to start without either.
4. Start it — compose starts `browser-egress` first and the browser service only
   once the proxy is healthy — then restart the API so it reads the endpoint:

```bash
docker compose --profile browser-service up -d browser-service
docker compose up -d api
```

Check it without a published port — there is none, deliberately. Port 3200
answers only a peer with a client certificate from your CA, so the check — like
the compose healthcheck — asks the loopback-only health listener on 3201, which
exists inside the container only and serves `/healthz` and nothing else:

```bash
docker compose --profile browser-service ps
docker compose exec browser-service node -e "fetch('http://127.0.0.1:3201/healthz').then(async r => console.log(r.status, await r.text()))"
```

The answer is a fixed body: `status`, `service`, the protocol version and
`chromium: enabled|disabled`. It says nothing about sessions, users or pages. If
`BROWSER_SERVICE_HEALTH_TOKEN` is set, add the header the compose healthcheck
sends.

5. Check Chromium's sandbox once in the running container (S10). It launches a
   headless browser the way the service does, offline, and prints pass/fail:

```bash
docker compose exec browser-service node apps/browser-service/scripts/s10-sandbox-check.mjs
```

   A failure to start Chromium with its sandbox means the host refuses what the
   sandbox needs, and sessions will be refused. Keep the service's Chromium off
   until a reviewed seccomp profile allows it; never answer it with
   `seccomp:unconfined` or `--no-sandbox`.

6. Check the network layer once in the running stack (S11, container mode). It
   tries direct connections that the internal network must not allow — a public
   address, the metadata address, PostgreSQL, the Docker host gateway's
   published ports — and asks the proxy for destinations it must refuse:

```bash
docker compose exec browser-service node apps/browser-service/scripts/s11-egress-check.mjs --container
```

   Every line must pass. A direct connection that succeeds means this host's
   Docker does not isolate internal networks the way the deployment relies on;
   keep Chromium off until it does. The same script without `--container` runs
   the application-layer check on any machine with a Chromium, offline.

A browser write whose outcome the API cannot prove — a timeout, a dropped
connection, a provider error after the request was sent — is recorded `UNKNOWN`
and is not sent again, even with a new approval. Treat such an action as
possibly done, and check the site before asking for it a second time.

#### Browser egress (Phase 19.3)

Three layers, each enforced without the others' help:

| Layer | Where | What it does |
|---|---|---|
| Network | `docker-compose.yml`: `browser` is `internal: true`; only `browser-egress` is also on the outbound `browser-egress` network | The browser container has no route out except the proxy, and no route to PostgreSQL at all |
| Proxy | `browser-egress` (`apps/browser-service/src/egress`) | Resolves every destination itself; refuses private, loopback, link-local, CGNAT, reserved, multicast, documentation and cloud-metadata addresses (IPv4 and IPv6, in every spelling — decimal, hex, octal, short, percent-encoded, IPv4-mapped, NAT64, 6to4, Teredo), single-label and special-use names, any name that resolves to one of them, and ports other than those allowed; then connects to exactly the address it judged |
| Browser | the service's launch options | `--proxy-server` for everything, loopback included; `--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE browser-egress`, so Chromium resolves nothing itself; WebRTC may not send UDP outside the proxy; the navigation policy still refuses literal private addresses, schemes, ports and credentials before a request is made |

Redirects are not followed by the proxy: each hop is a new request the browser
makes, and the proxy judges it on its own. A DNS answer that changes between
the check and the connection is never used: the proxy dials the address it
judged.

Configuration, all optional (`.env.example`): `BROWSER_EGRESS_ALLOWED_PORTS`
(default `80,443`), `BROWSER_EGRESS_DOMAIN_ALLOWLIST` (default: any public
host), and the DNS, connect and idle timeouts and the connection ceiling. They
can only narrow the policy. No setting opens a private or metadata destination.

**Troubleshooting**

| You see | It means | Do |
|---|---|---|
| The browser service exits at start with `BROWSER_SERVICE_EGRESS_PROXY_URL is required` | Chromium is on and no proxy is configured | Start it through compose, which sets the URL; never run Chromium without the proxy |
| `browser-service` stays `Created`, waiting | `browser-egress` is not healthy yet | `docker compose logs browser-egress`; a `browser_egress_config_invalid` line names the field to fix |
| A navigation fails with `ERR_TUNNEL_CONNECTION_FAILED` or a `403` | The proxy refused the destination | `docker compose logs browser-egress` shows `egress_denied` with the reason, the host and the port (never a path) |
| `egress_denied` with `reason: "dns-failure"` | The proxy's resolver did not answer, or the name does not exist | Check DNS from the proxy container; the browser container cannot resolve names by design |
| `reason: "blocked-address"` for a public site | The name resolves, at least in part, to a private or reserved address | Expected; the site is not reachable from this browser. Do not add an exception: there is no switch for one |
| `reason: "not-allowlisted"` | `BROWSER_EGRESS_DOMAIN_ALLOWLIST` is set and does not cover the host | Add the domain, if it should be reachable |
| `reason: "blocked-port"` | The URL uses a port outside `BROWSER_EGRESS_ALLOWED_PORTS` | Add the port only if it is a public web service you mean to reach |

The proxy logs one line per refusal with the reason, the host and the port. It
logs no path, query, header or body, and nothing for an allowed request.

The API log names the choice at start-up, with no address credentials:

```
{"level":"info","event":"browser_tools_enabled","mode":"remote","serviceHost":"browser-service:3200",…}
```

If the API logs `browser_tools_disabled`, `BROWSER_ENABLED` is not `"true"`. If
it logs `browser_registration_skipped`, the endpoint configuration is unusable
or the service could not be reached at that moment — in both cases **no browser
tool is registered**, and there is no fallback to an in-process browser.

**Rolling back** is stopping the profile and unsetting the variable: no
migration belongs to this stage, so there is no schema to undo.

```bash
docker compose --profile browser-service stop browser-service browser-egress
# remove BROWSER_SERVICE_URL from .env, then
docker compose up -d api
```

The API returns to the in-process browser when one is configured, or to no
browser tools.

#### Who may browse: the browser connection's Organization (both modes)

Browsing is a shared connection, `browser/service`, and it follows the rule
every shared connection does: **unassigned means nobody** (see "Every shared
connection needs an owner"). Before any browser session opens — in the API
process or in the separate service, it makes no difference — the API asks which
Organization owns the browser connection and whether the user belongs to it.
That Organization is also the one every artifact the session makes belongs to.
Any member may browse and read pages; a browser write (a click, typing, a
submit, a download or an upload) needs an owner or admin of that Organization,
and its approval comes from another owner or admin, as for every shared
connection.

Assign it with the same command and `$T` as the other connections:

```bash
npx tsx scripts/tenant-admin/run.ts assign-connector --provider=browser --connector=service --tenant=<tenant id> $T --execute
```

Until it is assigned — and for anyone outside that Organization — every browser
tool is refused before a session opens, in both modes, and nothing is stored.
The first refusal is the check the executor runs for every shared connection,
which answers "browser is not available to your account." A member whose role
does not allow writes is told "Your organization role does not allow changes
through browser. Ask an owner or admin of your organization." If the check
itself cannot be made, the answer is "Organization access could not be
verified, so nothing was done."

The session repeats the check, so an assignment that changes between the two is
still refused:

| Browsing | A session is refused with |
|---|---|
| In the API process | "Browsing is not available to your account." (a write: "Browser control is not available to your account.") |
| Through the separate service | "This action is not allowed." (`NOT_AUTHORIZED`; nothing is sent to the service) |

#### Browser artifacts (Phase 19.4)

A file a browser session downloads, and a screenshot it takes, is an artifact:
kept in a durable store, answered to the tools as an opaque id with metadata,
and never handed to a client as a path or as bytes. Each belongs to one user
**and** one Organization — the Organization the API resolves from the shared
connection's owner record, never one a request names. Any other user's or
Organization's id, an expired one, a deleted one and a malformed one are all
answered the same way: not found.

| Where the browser runs | Store directory | Survives |
|---|---|---|
| The browser service (compose) | `/var/lib/jarvis-browser/artifacts`, on the named volume `jarvis-browser-artifacts` | A restart, a recreated container, a rebuilt image. **Not** `docker compose down -v` or removing the volume |
| In the API process | `BROWSER_DOWNLOAD_DIR` (default `storage/browser`, relative to the API's working directory) | A restart of the process, while that directory is on persistent disk. Inside a container, put it on a volume; otherwise it ends with the container |

**Configuration** (`.env.example`):

| Variable | Default | Meaning |
|---|---|---|
| `BROWSER_ARTIFACT_RETENTION_HOURS` | **none — required** | How long an artifact is kept: 1 to 8784 hours. Your policy, not the code's. Without it the browser service refuses to start with Chromium on, and the API registers no in-process browser tools |
| `BROWSER_ARTIFACT_QUOTA_BYTES_PER_USER` | 104857600 (100 MiB) | Bytes one user may hold in one Organization |
| `BROWSER_ARTIFACT_QUOTA_BYTES_PER_ORGANIZATION` | 524288000 (500 MiB) | Bytes one Organization may hold |
| `BROWSER_ARTIFACT_MAX_COUNT_PER_USER` | 200 | Artifacts one user may hold in one Organization |
| `BROWSER_ARTIFACT_MAX_COUNT_PER_ORGANIZATION` | 1000 | Artifacts one Organization may hold |
| `BROWSER_MAX_DOWNLOAD_BYTES` | 10485760 (10 MiB) | One artifact |
| `BROWSER_ARTIFACT_SWEEP_INTERVAL_MS` | 600000 | The service's sweep interval (10000 to 86400000). The API, browsing in-process, sweeps at start-up and then every 10 minutes |

**How it holds.**

- **Writes are atomic.** The bytes are written to a temporary file in the
  store, flushed, and renamed into place; then the record, the same way. A crash
  leaves at most a temporary file, or bytes with no record — never a record
  without its bytes. The sweep removes both after ten minutes.
- **Quotas are checked under a lock**, one per Organization, which every process
  on the same directory shares (an atomic `mkdir`; a lock left by a crashed
  writer is taken over after 30 seconds). After the write, the quotas are
  counted again: if two writers ever got past the lock together, the one that
  finds itself over a quota removes its own write and is refused. A quota is
  never exceeded by what is kept.
- **Every read re-checks.** The record must be valid, its user and Organization
  the caller's, and its expiry in the future. Before an upload uses the bytes,
  their size and SHA-256 must match the record, and the file must be a regular
  file, not a link. Anything else is not found.
- **Expiry does not wait for the sweep.** An expired artifact is refused on read
  at once; the sweep (at start-up and on the interval) deletes it later. A
  sweep is safe to repeat and to run beside writers, and to run on every
  instance that shares the directory.
- **The sweep deletes only what is its own and broken.** That is: an expired
  artifact; a partial write; bytes no record names; and a record that breaks the
  contract it claims (not JSON, another id than its file's, or a wrong field of
  its version). Partial writes, orphaned bytes and broken records are left for
  ten minutes first. It **keeps**, sweep after sweep:
  - a record written by a newer release — a newer version, or a kind or a
    format this release does not know — together with its bytes, for that
    release to judge;
  - a record it could not read, with its bytes — a link in a record's place
    among them;
  - every object of a metadata directory it could not list;
  - any file or directory whose name it did not write.

  It never follows a link: a linked directory, wherever it sits in the store, is
  neither read nor emptied, and an expired artifact's bytes are removed only
  from a listing of the real `objects` directory — never through a link in its
  place. A rollback, or two releases sharing one directory, therefore loses
  nothing.
- **The directory is the store's alone.** The store writes a marker file into
  an empty directory the first time it is used, and refuses a non-empty
  directory without one: it never adopts, or deletes, files it did not write.
  Both modes check this with a sweep at start-up. The browser service exits if
  the store cannot be used. The API, browsing in-process, logs it
  (`artifact_store_unavailable` with `stage: "init"`, then
  `artifact_sweep_failed`) and keeps running; its browser tools then refuse
  every screenshot and download until the directory is fixed.

**Logs.** Store events are `artifact_store_refused` (with a `reason`:
`too-large`, `executable`, `format`, `quota` with the quota that was reached, or
`busy`), `artifact_store_unavailable` (with the `stage`),
`artifact_record_invalid` and `artifact_record_unsupported` (a newer release's
record; with the opaque artifact id), `artifact_integrity_failed` (with the
opaque artifact id), and `artifact_sweep` (counts: `expired`, `orphans`,
`partial`, `corrupt`, `preserved` — kept for a newer release — `skipped` —
links and names it did not write — and `failed`). Where browsing runs in the API
process, they are written through the operational log, as the
`browser-artifacts` component. Through the separate service, they are lines in
its own log (`docker compose logs browser-service`), with `"service":"browser"`.
No line carries a user, an Organization, a path, a file name, an origin or any
contents.

**Upgrading from before Phase 19.4.** An existing `storage/browser` directory
from an earlier release holds files in the old layout, and the store will refuse
it. Point `BROWSER_DOWNLOAD_DIR` at a new, empty directory, or empty the old one.
Nothing is lost: those files were reachable only by the process that wrote
them, and never after a restart. No database migration belongs to this stage,
so rolling back is redeploying the previous release; the store's directory can
stay, or be removed.

**Checking it on a host.** Checked on 2026-10-30 (Docker Desktop 29.9.2,
Linux containers on Windows), with an image built from
`apps/browser-service/Dockerfile` with `--no-cache`, in a separate compose
project (its own `-p`, container names and env file — never the deployment's).
The service ran as `node`. A new volume took `node:node 700` from the image,
and so did an empty volume created earlier with another owner: Docker copies
the directory's owner and mode into a volume that is empty when it is mounted.
Only the volume and `/tmp` were writable. Artifacts the store wrote on the
volume were served intact to their owner, and not found for another
Organization, after `--force-recreate` and after `down` and `up` (without
`-v`). The new container's start-up sweep removed one that had expired. The
service refused to start on a volume holding a file that is not the store's
(left in place), on a non-empty volume `node` cannot write, and without a
retention. To check your own host, after a session has taken a screenshot:

```bash
docker compose --profile browser-service exec browser-service sh -c 'id; stat -c "%U %a" /var/lib/jarvis-browser/artifacts; find /var/lib/jarvis-browser/artifacts/orgs -name "*.json" | wc -l'
docker compose --profile browser-service up -d --force-recreate browser-service
docker compose --profile browser-service exec browser-service sh -c 'find /var/lib/jarvis-browser/artifacts/orgs -name "*.json" | wc -l'
```

The service must run as `node`, the directory must be `node 700`, and the count
must be the same after the recreate (less any that expired in between).

**Troubleshooting**

Where a refusal shows depends on where the browser runs. In the API process, a
browser tool answers with the store's own sentence, and the API's log has the
event. Through the separate service, the store's codes never cross the
boundary: the service answers one of its fixed codes, and the store's event is
in the service's log, next to a `browser_service_request_failed` line with that
code.

| You see | Where | It means | Do |
|---|---|---|---|
| The service exits with `BROWSER_ARTIFACT_RETENTION_HOURS is required` (in `browser_service_config_invalid`) | Separate service | Chromium is on and no retention is set | Set it in `.env` and start it again |
| The service exits with `BROWSER_SERVICE_DOWNLOAD_DIR is required`, or says it must be absolute | Separate service | It was started outside compose without a store directory | Set an absolute path on persistent storage |
| The service exits with `browser_service_artifacts_unavailable` | Separate service | The directory is not writable by `node`, or holds files that are not an artifact store | Check the volume's ownership; never point it at a directory with other files in it |
| `browser_registration_skipped` with `BROWSER_ARTIFACT_RETENTION_HOURS is not set` | API process | The in-process browser has no retention policy | Set it; until then there are no in-process browser tools |
| `artifact_store_unavailable` (`stage: "init"`) and `artifact_sweep_failed` just after start-up | API process | `BROWSER_DOWNLOAD_DIR` is not writable, or holds files that are not an artifact store — most often a `storage/browser` from before Phase 19.4 | See "Upgrading from before Phase 19.4" below, then restart the API |
| "browser is not available to your account." — or, from the session itself, "Browsing is not available to your account.", "Browser control is not available to your account." or "This action is not allowed." | Both | The browser connection is unassigned, or the user is outside its Organization | See "Who may browse" above |
| "Artifact storage quota reached; older artifacts must expire first" (`ARTIFACT_QUOTA_EXCEEDED`); the log has `artifact_store_refused`, `reason: "quota"` and which quota | API process | The user or the Organization is full | Wait for older artifacts to expire, or raise that quota |
| "Artifact storage is not available" or "Artifact storage is busy; try again" (`ARTIFACT_STORE_UNAVAILABLE`) | API process | The store could not be written or read (`artifact_store_unavailable` names the stage), or its lock stayed busy for 5 seconds (`reason: "busy"`) | Check the directory's space and permissions; a busy lock that persists means a stuck process on the same directory |
| "Unknown download id" or "Stored file is no longer available" for an upload | API process | The id is expired, deleted, malformed or another user's or Organization's — or its bytes no longer match their record | Download the file again |
| "The browser could not perform the action." (`PROVIDER_ERROR`) for a screenshot | Separate service | A read failed. If the service log has `artifact_store_refused` or `artifact_store_unavailable` beside it, the screenshot was taken and could not be stored | As the two `API process` rows above, on the service's volume |
| "The outcome of the action is unknown; it was not retried." (`UNKNOWN_OUTCOME`) for a download or an upload | Separate service | A write failed after it was handed to the browser. The store refusing the downloaded file is one cause (its event is in the service log); an upload of an expired, deleted or foreign id is another. The API records the write UNKNOWN and never retries it | Check the service log, and the site, before asking for it again |
| `artifact_integrity_failed` | Both | An artifact's bytes no longer match its record | It is refused, and swept at expiry. Find out what changed the directory |
| `artifact_record_unsupported`, or `preserved` above zero in `artifact_sweep` | Both | Records written by a newer release, after a rollback or beside a newer instance on the same directory | Expected. They are kept, and served again once the newer release runs |

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

### Marketing: the workspace tables, and what is switched on

Since Phase 15 there is a marketing workspace. After a deploy, check that the migration arrived — `20261012120000_phase15_marketing_os` adds four tables (`MarketingCampaign`, `ContentItem`, `MarketingReport`, `MarketingResearch`) and their indexes and constraints. It alters no existing table and rewrites no existing row:

```bash
docker compose exec postgres psql -U jarvis -d jarvis -c '\dt "Marketing"*' -c '\dt "ContentItem"' -c 'SELECT count(*) AS content_items, count(*) FILTER (WHERE publication_mode IS NOT NULL) AS published FROM "ContentItem"'
```

The first listing shows `MarketingCampaign`, `MarketingReport` and `MarketingResearch` — beside `MarketingAccount`, which is older and unrelated. On a first deploy both counts are `0`. Then look for one line in the API log, which says what this deployment wired:

```bash
docker compose logs api | grep marketing_wiring
```

```
{"timestamp":"…","level":"info","service":"jarvis-api","component":"marketing","instance":"…","event":"marketing_wiring","pageResearch":"disabled (BROWSER_ENABLED is not set to true)","publishing":"disabled (MARKETING_PUBLISH_ENABLED is not set to true)","publishers":[]}
```

| It says | It means |
|---|---|
| `pageResearch: disabled …` | SEO audits and competitor pages are **off**. The two tools are not registered and the Marketing page draws no research form. In chat, a model that names one of them is answered with the reason — which names `BROWSER_ENABLED=true` and a restart — not with an error, and the audit log gains an `agent.tool_unavailable` row. This is the default in this stack: the compose file sets `BROWSER_ENABLED: "false"` |
| `pageResearch: enabled` | The API will fetch public web pages a user names, under the navigation policy and `BROWSER_DOMAIN_ALLOWLIST` |
| `publishing: disabled …` | Publishing is **off**, whatever credentials are set. This is the default, and it is what a deployment upgraded from before Phase 15 shows. No publish tool is registered, no Publish button is drawn, the publish endpoints answer `503`, and no approval for a publish can be created. In chat the marketing agent is told publishing is off and says so — with this server's own sentence, which names `MARKETING_PUBLISH_ENABLED=true` and a restart — and a model that names a publish tool anyway gets that sentence as its answer, not an error: the turn replies normally and the audit log gains an `agent.tool_unavailable` row |
| `publishing: enabled`, `publishers: []` | The switch is on, but `META_ACCESS_TOKEN` and `META_AD_ACCOUNT_ID` are not both set, so there is nothing to publish through. Nothing can be published, and chat says that instead ("switched on, but no publishing connection is configured") |
| `publishing: enabled`, `publishers: ["meta-graph:FACEBOOK"]` | The switch is on and the Meta integration is configured, so a publisher was built. Whether it can post depends on the token: it needs a Page it may create content on. That is not checked at start-up — the publish check reports it per item |

**To switch page research on in this stack**, change `BROWSER_ENABLED` to `"true"` in `docker-compose.yml` and `docker compose up -d`. It needs no browser in the image: the page reader is plain HTTP, and the browser *automation* tools stay unregistered because the image has no Chrome. Decide it deliberately — it lets the API open outbound connections to addresses users choose. Every hop is checked against the navigation policy and every resolved address must be public, and reads are limited to 20 per user per 10 minutes — a slot is reserved before each page is fetched, so the ceiling holds for requests that arrive together; set `BROWSER_DOMAIN_ALLOWLIST` to restrict it to named sites.

**To switch publishing on**, add `MARKETING_PUBLISH_ENABLED=true` to the root `.env` (the compose file passes `.env` to the API through `env_file`; nothing in `docker-compose.yml` needs to change) and `docker compose up -d api`. Only the exact value `true` switches it on. Then read the `marketing_wiring` line again: it must say `publishing: enabled` and name a publisher. To switch it off, remove the line or set it to anything else and restart the API — an approval that was waiting can then no longer be executed, and nothing is posted.

Decide it deliberately. Publishing posts **publicly**, to a Page, and JARVIS cannot take a post back. It is separate from the credentials on purpose: `META_ACCESS_TOKEN` and `META_AD_ACCOUNT_ID` alone only ever let JARVIS *read* the ad account.

**Publishing has not been exercised against a live Page.** The first real post from a deployment should be made by someone watching the Page. Nothing is published without an approval of the exact text, and nothing publishes on a schedule.

**When a publish is not confirmed.** If a post was sent and JARVIS could not learn or confirm the outcome, the item is shown as *Publish not confirmed*. Nothing more is sent for that item — a retry only looks for the post — until a person settles it on the Marketing page: the post is found and recorded, or they record that they posted it, or they say it was not published (JARVIS looks once more, then clears the attempt; that decision is in the audit log as `marketing.publish.resolve`). To see the items waiting:

```bash
docker compose exec postgres psql -U jarvis -d jarvis -c "SELECT id, title, publish_state, publish_attempt->>'code' AS code, publish_attempt->>'targetName' AS page FROM \"ContentItem\" WHERE publish_state <> 'NONE'"
```

**Limits.** Page reads (20), reports (10) and publish checks (60) are each limited per user per 10 minutes, and each takes its slot in the audit table *before* the provider is called (`marketing.limit.research`, `.report`, `.publish_check`). A request past a limit is answered `429` and reaches nothing outside JARVIS. They need PostgreSQL to be reachable; if it is not, the work is refused rather than let through.

Nothing in Phase 15 starts a background loop. One environment variable was added, and it is optional: `MARKETING_PUBLISH_ENABLED`, off by default.

### Organizations: the tenant tables, and who may use the shared connections

Since Phase 17 Stage 3A, a deployment-wide connection can belong to an **Organization** (a *tenant* in the code and the schema). After a deploy, check that the migration arrived — `20261017120000_phase17_tenant_foundation` adds one enum (`TenantRole`) and three tables (`Tenant`, `TenantMembership`, `AutomationConnectorOwner`). It alters no existing table and writes no row; there is no backfill, and no account is put into an Organization by it:

```bash
docker compose exec postgres psql -U jarvis -d jarvis -c '\dt "Tenant"*' -c '\dt "AutomationConnectorOwner"' -c 'SELECT count(*) AS organizations FROM "Tenant"'
```

**Until an operator assigns the n8n MCP connection to an Organization, n8n MCP discovery refuses everyone** — `GET /api/v1/n8n/mcp/tools` and `/automations` answer `403 TENANT_ACCESS_DENIED`, account-wide owners and admins included, and nothing reaches n8n. That is deliberate: the owner is never inferred from whoever asks first or from an account-wide role. (Discovery is reached at all only when `N8N_MCP_ENABLED=true`.) Once assigned, the Organization's owners, admins and members can read discovery; its viewers, and every account outside it, cannot.

Organizations, memberships and the connection's owner are set **only** by the operator command — there is no page, endpoint or chat command for it. Run it from `apps/api` on the host, against the database the stack publishes on port 5433. It is a dry run unless `--execute` is given, it refuses to run unless `DATABASE_URL` is set explicitly and `--confirm-target` names the same database, and `--as` names the existing account each change is recorded under in the audit log:

```bash
cd apps/api
export DATABASE_URL='postgresql://jarvis:<password>@localhost:5433/jarvis'
T='--confirm-target=localhost:5433/jarvis --as=<your account id>'

# 1. An Organization, created together with its first owner.
npx tsx scripts/tenant-admin/run.ts create-tenant --name='<Organization name>' --owner=<account id> $T --execute

# 2. Its other members: --role=owner|admin|member|viewer.
npx tsx scripts/tenant-admin/run.ts add-member --tenant=<tenant id> --user=<account id> --role=member $T --execute

# 3. The n8n MCP connection, assigned to that Organization.
npx tsx scripts/tenant-admin/run.ts assign-connector --provider=n8n --connector=mcp --tenant=<tenant id> $T --execute

# Check.
npx tsx scripts/tenant-admin/run.ts list --tenant=<tenant id> $T
```

An account's id is in the `User` table (`SELECT id, email FROM "User"`). `set-role`, `remove-member` and `unassign-connector` change and undo the same things. Every change is made in one transaction with its audit row (`tenant.create`, `tenant.member.add`, `tenant.member.role`, `tenant.member.remove`, `tenant.connector.assign`, `tenant.connector.unassign`), and an Organization can never be left without an owner — the command refuses with `LAST_OWNER`. A change applies to the very next request: membership is read from the database every time, so nobody needs to sign in again.

Each line of output is JSON. `tenant_admin_dry_run` means nothing was written; `tenant_admin_executed`, that it was; `tenant_admin_refused` carries a code (`LAST_OWNER`, `ALREADY_MEMBER`, …) and exits `65`; a usage error exits `64`, a failure `70` — and a failure has written nothing.

**Limits.** Each account may call each of the two routes 30 times a minute, whether it is served or refused. The count is kept in the API's memory and taken before the database is read: past it the answer is `429 RATE_LIMITED` with `Retry-After`, nothing is read, and only the first request past the limit in each one-minute window writes anything — one audit row (`n8n_mcp.discover` or `.catalog`, marked `throttled`) and one `n8n_mcp_throttled` warning. An account that keeps being refused therefore writes at most 31 audit rows a minute on each route. The count belongs to one API instance and starts again when the API restarts. A request that was already allowed when a membership or the connection's owner changed still completes for its caller — it is never cancelled — and waits for n8n at most twice `N8N_MCP_TIMEOUT_MS` (30 seconds by default); the next request is decided on the new state.

#### Every shared connection needs an owner (Phase 17 multi-business hardening)

Since the hardening, the deployment's other shared connections belong to an Organization too, and **nobody can use or inspect one until it is assigned** — account-wide owners and admins included. After the deploy, check that the migration arrived — `20261018120000_phase17_shared_connection_approvals` adds two nullable columns to `Approval` (`tenantId`, `decidedById`), one index and two foreign keys. It rewrites no row and needs no backfill:

```bash
docker compose exec postgres psql -U jarvis -d jarvis -c '\d "Approval"'
```

Then assign each connection this deployment configures, with the same command and the same `$T` as above:

```bash
for key in meta/ads n8n/rest whatsapp/cloud-api google-maps/server-key mcp/servers omniroute/gateway browser/service; do
  npx tsx scripts/tenant-admin/run.ts assign-connector --provider=${key%/*} --connector=${key#*/} --tenant=<tenant id> $T --execute
done
npx tsx scripts/tenant-admin/run.ts list --tenant=<tenant id> $T
```

Until a connection is assigned, the Integrations page shows it as not available to anyone and nobody can test it. For Meta Ads it means more: the dashboard, the analysis, the opportunity queue and marketing reports answer as on a deployment without Meta, and chat refuses every Meta tool with "Meta Ads is not available to your account."

Once assigned, the Organization's membership role decides — never the account-wide role:

| Membership role | Use it (read Meta Ads; see status) | See its details (ids, errors, quota) | Test it | Change Meta Ads | Approve someone else's Meta change |
|---|---|---|---|---|---|
| owner, admin | yes | yes | yes | yes | yes |
| member, viewer | yes | no | no | no | no |
| not a member | no | no | no | no | no |

**A Meta change needs two people.** A pause, a budget change or a new campaign is approved by an owner or admin of the Organization **other than the person who asked** — on their Approvals page, under "Waiting for your decision" — and the person who asked then confirms it in chat to run it, within the approval's 10 minutes. An Organization with a single owner or admin cannot change Meta Ads through JARVIS until a second is added (`add-member --role=admin`). At the moment it runs, the change is checked again: the Organization must still own the connection and both people must still hold their roles.

**Only `META_AD_ACCOUNT_ID`.** Reads and changes are limited to that one account, even when the token can reach others.

**Connection tests are budgeted.** Each account may start 10 connection tests in 10 minutes, and each Organization 30 per integration per hour. Both are slots in the audit table, taken before the provider is called (`integration.test_slot`, `integration.test_budget.<tenant id>.<integration>`); while PostgreSQL cannot be reached, tests are refused. A test of the caller's **own** Meta credentials (Credentials page) takes their slot too.

#### The n8n workflow library (Phase 18, Stage 18.1)

Since Phase 18 the server can keep a catalog of the n8n instance's workflows. After a deploy, check that the migration arrived — `20261019120000_phase18_automation_library` adds one enum and three tables (`AutomationLibraryEntry`, `AutomationLibrarySync`, `AutomationLibrarySyncRun`). It alters no existing table and writes no row:

```bash
docker compose exec postgres psql -U jarvis -d jarvis -c '\dt "AutomationLibrary"*'
```

Nothing synchronizes by itself. An owner or admin of the Organization that owns the n8n REST connection (`n8n/rest`, assigned above) starts one bounded run with `POST /api/v1/n8n/library/sync`; each run reads at most 20 pages of 250 workflows and stops, and the next request continues where it stopped. Progress, the last complete scan and each run's outcome are on `GET /api/v1/n8n/library/status`; members and viewers can read both, and nobody outside the Organization can see or start anything. Look for `automation_library_run_started` and `automation_library_run_finished` in the API log (with a failure code, never n8n's words). Runs need `N8N_BASE_URL` and `N8N_API_KEY` — the same variables the rest of the n8n integration uses; no new variable was added. A library never deletes anything: a workflow deleted in n8n is marked removed after two complete scans without it.

**Stage 18.2** adds the migration `20261019180000_phase18_library_continuation`:

- one enum and one table (`AutomationLibrarySyncChain`);
- two nullable columns on `AutomationLibrarySync` (`active_chain_id`, `chain_heartbeat_at`) and one on `AutomationLibrarySyncRun` (`chain_id`).

It alters no existing column and writes no row. The same `\dt` check above now lists four tables.

The Automations page gains a library section; its Sync and **Continue until complete** buttons appear only for the owning Organization's owners and admins.

**Continue until complete** chains bounded runs of one scan until it completes:

- It stops at 25 runs, 500 pages or 30 minutes, keeping the scan's place.
- It takes the Organization's 60-per-hour budget for every run.
- It re-checks the requester's role before every run.

Follow it on `GET /status` (`continuation`) and in the API log: `automation_library_chain_started` and `automation_library_chain_finished`, the latter with a stop code. Audit rows are `automation_library.sync_chain`.

**After a restart or a redeploy:**

- **A chain stops.** A graceful stop records it as `STOPPED` with code `SHUTDOWN`. A crash shows it as `INTERRUPTED` once its lease and heartbeat are stale (about 3 minutes).
- **Nothing resumes it.** An owner or admin presses Continue again, and the scan goes on from its last stored page.

JARVIS reaches the library through `automation.library.search`, `.status` and `.sync`. A spoken chat turn cannot start or continue a sync — the server refuses it.

**Stage 18.3B** adds the migration `20261021120000_phase18_library_allowlist_link`. It adds two nullable columns to `N8nWorkflow` (`library_entry_ref`, `library_version_id`) and one index. It writes no row, and existing allow-list rows keep null. Check it arrived:

```bash
docker compose exec postgres psql -U jarvis -d jarvis -c '\d "N8nWorkflow"'
```

The Automations page gains an **Inspect** button on each library row. It shows the workflow's sanitized structure from the stored catalog, and n8n is not contacted.

Owners and admins may **propose** a workflow for their own trigger allow-list. **Another** owner or admin approves it on the Approvals page. The requester then adds it, from the page only, never by voice.

Adding is the only step that reads n8n: one `GET /api/v1/workflows/{id}`, kept to the webhook's path, method and auth mode. It changes nothing in n8n and runs nothing. Each trigger still needs its own approval.

What to look for:

- **Log:** `automation_library_allowlist_applied`.
- **Audit rows:** `automation_library.inspect`, `.allowlist_propose` and `.allowlist_apply`.

An Organization with a single owner and no admin cannot approve its own proposals, by design.

**Stage 18.4** adds the migration `20261021180000_phase18_automation_drafts`:

- two tables, `AutomationDraft` and `AutomationDraftVersion`;
- their indexes and foreign keys;
- one trigger, `automation_draft_version_immutability`, which refuses any `UPDATE` of a stored draft version.

It alters no existing table and writes no row. Check that it arrived:

```bash
docker compose exec postgres psql -U jarvis -d jarvis -c '\dt "AutomationDraft"*'
docker compose exec postgres psql -U jarvis -d jarvis -c "SELECT tgname FROM pg_trigger WHERE tgname = 'automation_draft_version_immutability'"
```

The Automations page gains a **Plan an automation** section, and JARVIS gains `automation.workflow.match` and `automation.draft.*`:

- **Matching** compares a request with the stored library.
- **Drafts** are plans saved in JARVIS: owners and admins create and revise them; members read them.
- **Nothing in n8n is read, changed, activated or run.** The draft tables are the only new state.

What to look for:

- **Log:** `automation_draft_created` and `automation_draft_revised`.
- **Audit rows:** `automation_planning.match`, `.draft_create`, `.draft_revise` (and `.draft_read` for refused reads).

No new environment variable was added.

**Still decided per account, not by Organization:** sending a WhatsApp message (only the account the phone number is assigned to), triggering an n8n workflow (only the account's own registered workflows), the read-only Maps tools (any account, within `GOOGLE_MAPS_MONTHLY_LIMIT`) and the reviewed MCP servers. Publishing to a Facebook Page is off unless `MARKETING_PUBLISH_ENABLED=true`, and is not Organization-checked: leave it off on a deployment that serves more than one business.

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

The Phase 15 migration is additive in the same way. `20261012120000_phase15_marketing_os` adds four tables and alters none; a release from before Phase 15 never reads or writes them. Its migration step was run against a database that already had the Phase 15 migration (2026-10-12): `29 migrations found`, `No pending migrations to apply.` Rolling back to before Phase 15 leaves the marketing rows in place and unreachable — the older release has no route, tool or page for them — and they are there again when the newer release returns. **A post that was published stays published**: rolling back does not, and cannot, take anything down from a Page.

The Phase 17 migration is additive in the same way. `20261017120000_phase17_tenant_foundation` adds three tables and an enum and alters none; a release from before it never reads or writes them, so they stay in place across a rollback and are used again when the newer release returns. (Rolling back also takes away the Organization check on n8n MCP discovery: a release from before Phase 17 Stage 3A has its own rules for those routes. The routes have not been part of a deployed release yet.) It was applied on a fresh database after every earlier migration (2026-10-17, `31 migrations found`, all applied); it has not been run against the real stack.

The Phase 17 hardening's migration is additive too. `20261018120000_phase17_shared_connection_approvals` adds two nullable columns to `Approval`, an index and two foreign keys; a release from before it never reads them, so they stay across a rollback. **Rolling back reopens finding H2**: the older release has no Organization check on Meta Ads, so any account can again read and change the deployment's ad account, and an approval waiting for another owner or admin can be approved by the person who asked for it. Coming forward again is safe: an approval approved by its own requester while the older release ran carries no independent approver, and the newer release refuses to run it.

The Phase 18 migration is additive as well. `20261019120000_phase18_automation_library` adds three tables and an enum and alters none; a release from before it never reads them. Rolling back leaves the catalog in place and unreachable, and it is used again when the newer release returns. A run that was in progress when the API stopped is closed as interrupted by the next run, and its scan resumes from the last stored page. It was applied on a fresh database after every earlier migration (2026-10-18, `32 migrations found`, all applied); it has not been run against the real stack.

The Stage 18.2 migration is additive too. `20261019180000_phase18_library_continuation` adds a table, an enum and three nullable columns, and changes no existing column. A release from before it never reads them, so they stay across a rollback.

Rolling back to Stage 18.1 brings back the 18.1 behaviour:

- **No Continue button, and no library tools for JARVIS.** The last chain's row stays, unreachable.
- **The older release ignores the chain columns.** If a chain was running when the rollback happened, it leaves at most its last run's lease, which expires within 3 minutes like any interrupted run's.

When the newer release returns, a chain still marked `RUNNING` is shown and closed as interrupted.

It was applied on a fresh database after every earlier migration (2026-10-20, `34 migrations found`, all applied); it has not been run against the real stack.

The Stage 18.3B migration is additive too. `20261021120000_phase18_library_allowlist_link` adds two nullable columns and an index to `N8nWorkflow`, and changes no existing column. Rolling back to 18.3A:

- **The older release ignores the columns.** A workflow added from the library stays on its owner's allow-list, an ordinary row that `n8n.trigger` reads as before.
- **No Inspect, propose or add.** The page loses the controls; JARVIS loses the tools.
- **Proposals are left behind.** One still waiting names a tool the older release does not have, so it can never run there. It expires within 10 minutes.

When the newer release returns, the columns are read again.

It was applied on a fresh database after every earlier migration (2026-10-21, `35 migrations found`, all applied); it has not been run against the real stack.

The Stage 18.4 migration is additive too. `20261021180000_phase18_automation_drafts` adds two tables, a function and a trigger on its own new table, and changes nothing that exists. Rolling back to 18.3B:

- **The older release never reads the tables.** Drafts stay in place, unreachable.
- **No planning section, no planning tools.** The page and JARVIS lose them; nothing else changes.
- **Nothing to settle.** Drafts are plans and were never in n8n, so no workflow or allow-list row depends on them.

When the newer release returns, the drafts are there again, each at the version it was left at.

It was applied on a fresh database after every earlier migration (2026-10-21, `36 migrations found`, all applied); it has not been run against the real stack.

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

**Phase 15, 2026-10-12 — what was checked, and what was not.** Checked, on a throwaway pgvector container on port 5436: all 30 migrations apply from nothing; the previous release's migration step then reports `No pending migrations to apply.` against that database; and the `psql` commands in "Marketing: the workspace tables" return what that section says. **Not** done for Phase 15: building the image, starting the stack, deploying, or rolling back a running stack. The `marketing_wiring` log line was read from the API's tests, not from a container. Nothing was published to a live Page, and the real stack was not touched.

**Not rehearsed:**

- Anything on the real stack — ports 3100, 3101 and 5433. No deployment, rollback, backup or restore has been run against it.
- `docker compose build` itself. The images were built with `docker build --target runtime` and their own tags: the same `Dockerfile` and target, without replacing `jarvis-app:latest`.
- `git switch --detach` in this folder. The previous release's files came from `git archive` into a separate folder.
- A migration failing in the stack. The failure was produced with a one-off container; that the stack then restarts in a loop is inferred from the bad-configuration case, where it did.
- A hosted error tracker or uptime monitor. None is configured.
