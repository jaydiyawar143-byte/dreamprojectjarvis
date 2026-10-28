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
# CHROMIUM'S VERSION IS NOT PINNED HERE. Alpine's `chromium` is whatever the
# base image's repository serves, so a rebuild can change it. The pinning
# decision (and a signed package source) is open work, recorded in
# docs/phases/phase-19.md; this file does not pretend otherwise.
# ---------------------------------------------------------------------------

FROM node:24-alpine AS base
RUN apk add --no-cache libc6-compat openssl \
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

# The service and every workspace package it imports, in dependency order.
RUN pnpm --filter @jarvis/browser-service... build


# --- runtime ---------------------------------------------------------------
FROM base AS runtime

ENV NODE_ENV=production
# Alpine's chromium package; the symlink keeps one executable path regardless
# of which of the two names the package provides.
RUN apk add --no-cache chromium \
    && if [ ! -x /usr/bin/chromium ] && [ -x /usr/bin/chromium-browser ]; then \
         ln -s /usr/bin/chromium-browser /usr/bin/chromium; \
       fi
ENV CHROME_PATH=/usr/bin/chromium

COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/package.json ./package.json
COPY --from=build /workspace/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build /workspace/packages ./packages
COPY --from=build /workspace/apps/browser-service ./apps/browser-service

# A writable directory for a session's downloads, and nothing else writable in
# the image. `BROWSER_SERVICE_DOWNLOAD_DIR` points here in compose.
RUN mkdir -p /workspace/storage/downloads \
    && chown -R node:node /workspace/storage

USER node

# The service refuses to start unless its key, secret, peer identity and TLS
# material are present — mutual TLS is its only mode — so a container that
# starts is one whose authentication is configured. Its liveness listener
# (BROWSER_SERVICE_HEALTH_PORT, 3201) binds 127.0.0.1 inside the container
# only, so it is not exposed.
EXPOSE 3200
CMD ["node", "apps/browser-service/dist/index.js"]
