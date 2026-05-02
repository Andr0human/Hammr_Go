# syntax=docker/dockerfile:1.6
#
# Build context: repository root (so npm workspaces resolve).
# Build:   docker build -f apps/node/Dockerfile -t hammr-controller .

FROM node:20-bookworm-slim AS build
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# Install only the workspaces the controller needs. apps/web stays out of the
# image so we don't pull Next.js, MUI, etc. into the build.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/node/package.json apps/node/
RUN npm ci --workspace=@hammr/shared --workspace=@hammr/node --include-workspace-root

COPY packages/shared packages/shared
COPY apps/node apps/node
RUN npm run build -w @hammr/shared \
 && npm run build -w @hammr/node

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/node/package.json ./apps/node/package.json
COPY --from=build /app/apps/node/dist ./apps/node/dist
COPY --from=build /app/apps/node/scripts ./apps/node/scripts
COPY --from=build /app/apps/node/migrations ./apps/node/migrations

EXPOSE 3000 3001 4000
CMD ["sh", "-c", "node apps/node/scripts/migrate-clickhouse.mjs && node apps/node/dist/index.js"]
