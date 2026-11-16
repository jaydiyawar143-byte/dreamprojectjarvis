# ---------------------------------------------------------------------------
# JARVIS — the isolated browser service (Phase 19, Stage 19.2).
#
# WHY ITS OWN IMAGE. The API holds no browser in this deployment: Chromium runs
# here, in a container with its own user, its own memory and CPU limits, its own
# PID ceiling and no published port. That is a boundary the API's own image
# cannot express, and it is the reason the tools talk to this process over a
# signed request instead of to a local browser.
#
# THIS IS NOT A SANDBOX BY ITSELF. A container is a process boundary with
# resource limits, not a security product. Chromium keeps its own sandbox: the
# launcher sets Playwright's `chromiumSandbox: true` (ADR-19-010; without it
# Playwright adds `--no-sandbox` itself — Stage 19.2 audit, H1). If the host
# cannot give the sandbox the kernel features it needs, the browser does not
# start. Network egress is a separate, later control (Stage 19.3): this image
# has ordinary outbound access and must not be treated as if it had none.
#
# DEBIAN, NOT ALPINE (Phase 19 S10). On Alpine, Chromium's own seccomp policy
# killed its GPU process and the browser exited within seconds: musl 1.2.6
# implements pwrite() with the pwritev2 syscall, which the GPU process's policy
# does not allow. It allows pwrite64, which glibc's pwrite() uses. The record
# is docs/phases/phase-19.md §20.9.
#
# PINNED. The base image is pinned by digest, and Chromium to one Debian
# package version from Debian's signed archive. A Chromium security update is a
# deliberate change to this file: bump the version on the install line (and in
# the compose test that pins it), rebuild, and run S10 and S11 again
# (docs/DEPLOYMENT.md). Once Debian supersedes the pinned version it no longer
# resolves, so a stale pin fails the build instead of changing the browser.
# ---------------------------------------------------------------------------

# Node 24.22.3 on Debian 13 (trixie), by digest. Its `node` user is uid/gid
# 1000, which the compose tmpfs home and the artifact volume expect.
FROM node:24.22.3-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0 AS base
# openssl: Prisma's generator reads the OpenSSL version from it to pick its
# engine (build stage), as it did on Alpine.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@9.0.0 --activate
WORKDIR /workspace


# --- deps ------------------------------------------------------------------
# Manifests only, so a source edit does not invalidate the install layer. Every
# workspace manifest is copied because the lockfile covers all of them; the
# install itself is filtered to this service and what it depends on.
FROM base AS deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/browser-service/package.json ./apps/browser-service/
COPY apps/web/package.json ./apps/web/
COPY packages/agents/package.json ./packages/agents/
COPY packages/ai-anthropic/package.json ./packages/ai-anthropic/
COPY packages/ai-elevenlabs/package.json ./packages/ai-elevenlabs/
COPY packages/ai-openai/package.json ./packages/ai-openai/
COPY packages/browser/package.json ./packages/browser/
COPY packages/browser-protocol/package.json ./packages/browser-protocol/
COPY packages/config/package.json ./packages/config/
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/
COPY packages/google-ads/package.json ./packages/google-ads/
COPY packages/google-workspace/package.json ./packages/google-workspace/
COPY packages/mcp/package.json ./packages/mcp/
COPY packages/memory/package.json ./packages/memory/
COPY packages/meta-graph/package.json ./packages/meta-graph/
COPY packages/n8n/package.json ./packages/n8n/
COPY packages/omniroute/package.json ./packages/omniroute/
COPY packages/security/package.json ./packages/security/
COPY packages/tools/package.json ./packages/tools/
COPY packages/whatsapp/package.json ./packages/whatsapp/

RUN pnpm install --frozen-lockfile --filter @jarvis/browser-service...


# --- build -----------------------------------------------------------------
FROM base AS build

COPY --from=deps /workspace/node_modules ./node_modules
COPY --from=deps /workspace/apps ./apps
COPY --from=deps /workspace/packages ./packages
COPY . .

# Prisma first: @jarvis/db is in this service's build graph (@jarvis/browser ->
# @jarvis/memory -> @jarvis/db), and its tsc build imports the generated
# client's types. The schema is present by now — `COPY . .` above brings
# packages/db/prisma/schema.prisma in.
RUN pnpm --filter @jarvis/db exec prisma generate

# The service and every workspace package it imports, in dependency order.
RUN pnpm --filter @jarvis/browser-service... build


# --- runtime ---------------------------------------------------------------
FROM base AS runtime

ENV NODE_ENV=production
# Debian's chromium, pinned to one version from trixie-security, with only the
# dependencies it declares (--no-install-recommends) plus one font package, so
# that pages render text. The setuid helper, `chromium-sandbox`, is a separate
# package and is never installed: `no-new-privileges` would stop it working
# anyway, and S10 requires the namespace sandbox. The build fails if the
# package or its binary is present, or if the real binary is missing.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
         chromium=156.0.8078.79-1~deb13u1 \
         chromium-common=156.0.8078.79-1~deb13u1 \
         fonts-liberation \
    && rm -rf /var/lib/apt/lists/* \
    && if dpkg-query -W -f='${Status}' chromium-sandbox 2>/dev/null | grep -q 'ok installed'; then \
         echo 'chromium-sandbox must not be installed' >&2; exit 1; \
       fi \
    && test ! -e /usr/lib/chromium/chrome-sandbox \
    && test -x /usr/lib/chromium/chromium
# The real binary, not /usr/bin/chromium. That path is Debian's wrapper script,
# which adds its own switches (/etc/chromium.d) to every launch, so the
# service's reviewed launch options would no longer be the only switches.
ENV CHROME_PATH=/usr/lib/chromium/chromium

COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/package.json ./package.json
COPY --from=build /workspace/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build /workspace/packages ./packages
COPY --from=build /workspace/apps/browser-service ./apps/browser-service

# Phase 19.4 — the durable artifact store's directory, owned by the
# unprivileged user and readable by nobody else. Compose mounts a named volume
# here (`BROWSER_SERVICE_DOWNLOAD_DIR`); a new volume takes this ownership and
# mode from the image. Nothing else in the image is writable.
RUN mkdir -p /var/lib/jarvis-browser/artifacts \
    && chown -R node:node /var/lib/jarvis-browser \
    && chmod 700 /var/lib/jarvis-browser/artifacts

USER node

# The service refuses to start unless its key, secret, peer identity and TLS
# material are present — mutual TLS is its only mode — so a container that
# starts is one whose authentication is configured. Its liveness listener
# (BROWSER_SERVICE_HEALTH_PORT, 3201) binds 127.0.0.1 inside the container
# only, so it is not exposed.
EXPOSE 3200
CMD ["node", "apps/browser-service/dist/index.js"]
