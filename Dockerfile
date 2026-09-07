FROM node:20-alpine

WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/package.json
COPY packages ./packages

RUN corepack enable && pnpm install --frozen-lockfile

WORKDIR /workspace/apps/web

EXPOSE 3000

CMD ["sh", "-lc", "pnpm dev --hostname 0.0.0.0 --port 3000"]
