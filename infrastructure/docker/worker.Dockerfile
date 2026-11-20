# syntax=docker/dockerfile:1
# Production image for @fos/worker (multi-stage, non-root).
# Build from the repository root:  docker build -f infrastructure/docker/worker.Dockerfile .

FROM node:22-alpine AS base
# OpenSSL is required by the Prisma query engine on Alpine.
RUN apk add --no-cache openssl && corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @fos/worker build
# Self-contained copy of the app with production dependencies only.
RUN pnpm --filter @fos/worker deploy --prod --legacy /out
# Generate the Prisma client inside the deployed tree (engine matches this image).
COPY packages/db/prisma /out/prisma
RUN cd /out && npx --yes prisma@6.19.3 generate --schema prisma/schema.prisma

FROM node:22-alpine AS runtime
RUN apk add --no-cache openssl && addgroup -S app && adduser -S app -G app
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=app:app /out ./
USER app
EXPOSE 4001
CMD ["node", "--enable-source-maps", "dist/main.js"]
