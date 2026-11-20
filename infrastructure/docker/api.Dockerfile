# syntax=docker/dockerfile:1
# Production image for @fos/api (multi-stage, non-root).
# Build from the repository root:  docker build -f infrastructure/docker/api.Dockerfile .

FROM node:22-alpine AS base
# OpenSSL is required by the Prisma query engine on Alpine.
RUN apk add --no-cache openssl && corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @fos/api build
# Self-contained copy of the app with production dependencies only.
RUN pnpm --filter @fos/api deploy --prod --legacy /out
# Generate the Prisma client inside the deployed tree (engine matches this image).
COPY packages/db/prisma /out/prisma
# The schema is a folder of .prisma files; use the workspace's Prisma CLI (same version
# as @prisma/client) so the client is generated into /out/node_modules.
RUN cd /out && /repo/packages/db/node_modules/.bin/prisma generate --schema prisma/schema

FROM node:22-alpine AS runtime
RUN apk add --no-cache openssl && addgroup -S app && adduser -S app -G app
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=app:app /out ./
USER app
EXPOSE 4000
CMD ["node", "--enable-source-maps", "dist/server.js"]
