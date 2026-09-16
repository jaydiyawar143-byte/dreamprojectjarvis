# ---------------------------------------------------------------------------
# JARVIS — production image for the API and the web app.
#
# ONE image, two services. The API and the web app share a pnpm workspace with
# eleven internal packages; splitting them into separate images would mean
# building those packages twice and keeping two dependency graphs honest. The
# compose file runs this image twice with different commands and ports.
#
# Multi-stage so the runtime layer carries no source, no dev dependencies and
# no build toolchain — only the compiled output and what it needs to run.
#
# Two things that are load-bearing and easy to get wrong:
#
#   PRISMA. `turbo build` does not run `prisma generate`, so it is invoked
#   explicitly below. The schema declares a `linux-musl-openssl-3.0.x` binary
#   target for exactly this image; without it the client has no query engine
#   Alpine can load and the failure appears at runtime, not at build.
#
#   NEXT_PUBLIC_*. Next inlines those at BUILD time, so the API URL the browser
#   will call has to be known here. It points at the published API port on the
#   HOST, not at the compose service name, because the browser runs on the host
#   and cannot resolve `api`.
# ---------------------------------------------------------------------------

# Node 24 (R-19). Node 20 reached end of life on 2026-04-30, and the test
# toolchain — jsdom 30, undici 8 — cannot start on it, so CI had to run a
# different major from the one production ran. Both are Node 24 now.
# `node:24-alpine` still ships Corepack, so the pnpm pin below is unchanged.
FROM node:24-alpine AS base
# openssl is not optional: Prisma probes for libssl to pick a query engine and,
# without it, warns and falls back to an openssl-1.1.x engine that Alpine does
# not have. libc6-compat covers the glibc-linked binaries some tools ship.
#
# `corepack prepare` bakes the pnpm version into the image. Without it corepack
# downloads pnpm on first use, which turns every container start into a network
# call that fails on an offline host.
RUN apk add --no-cache libc6-compat openssl \
    && corepack enable \
    && corepack prepare pnpm@9.0.0 --activate
WORKDIR /workspace


# --- deps ------------------------------------------------------------------
# Manifests only, so a source edit does not invalidate the install layer.
FROM base AS deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/agents/package.json ./packages/agents/
COPY packages/ai-anthropic/package.json ./packages/ai-anthropic/
COPY packages/ai-elevenlabs/package.json ./packages/ai-elevenlabs/
COPY packages/ai-openai/package.json ./packages/ai-openai/
COPY packages/browser/package.json ./packages/browser/
COPY packages/config/package.json ./packages/config/
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/
COPY packages/google-ads/package.json ./packages/google-ads/
COPY packages/google-workspace/package.json ./packages/google-workspace/
COPY packages/memory/package.json ./packages/memory/
COPY packages/meta-graph/package.json ./packages/meta-graph/
COPY packages/n8n/package.json ./packages/n8n/
COPY packages/security/package.json ./packages/security/
COPY packages/tools/package.json ./packages/tools/
COPY packages/whatsapp/package.json ./packages/whatsapp/

RUN pnpm install --frozen-lockfile


# --- build -----------------------------------------------------------------
FROM base AS build

COPY --from=deps /workspace/node_modules ./node_modules
COPY --from=deps /workspace/apps ./apps
COPY --from=deps /workspace/packages ./packages
COPY . .

# The browser served by this image talks to the API on the host's published
# port. Overridable at build time for a different deployment.
ARG NEXT_PUBLIC_API_URL=http://localhost:3101/api/v1
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}

# Prisma first: @jarvis/db's tsc build imports the generated client's types.
RUN pnpm --filter @jarvis/db exec prisma generate
RUN pnpm build


# --- runtime ---------------------------------------------------------------
# Everything compiled, plus the dependency tree. Dev-only packages are pruned.
FROM base AS runtime

ENV NODE_ENV=production

COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/package.json ./package.json
COPY --from=build /workspace/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build /workspace/packages ./packages
COPY --from=build /workspace/apps ./apps

# NOT pruned to production dependencies. The Prisma CLI that applies migrations
# on start is a devDependency, so pruning would remove the one tool the API
# needs before it can serve a request. Trading ~100MB for a stack that can
# actually migrate itself is the right way round.

# Unprivileged. The whole workspace is handed over, not just storage: Prisma
# writes into node_modules when it resolves an engine, and a read-only tree
# there fails at container start rather than at build.
RUN mkdir -p /workspace/storage && chown -R node:node /workspace
USER node

# Overridden per service in docker-compose.yml.
CMD ["node", "apps/api/dist/index.js"]
