# Multi-stage build for the API service and the click worker — they share an
# image and differ only in the command. Multi-arch base so the same
# Dockerfile builds on the x86-64 VPS and on an Apple Silicon Mac.

# ---- deps ------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy only manifests first so the dependency layer caches across source edits.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY services/api/package.json services/api/
COPY services/redirect/package.json services/redirect/
COPY apps/dashboard/package.json apps/dashboard/
RUN npm ci --ignore-scripts

# ---- dev -------------------------------------------------------------------
FROM deps AS dev
ENV NODE_ENV=development
COPY . .
RUN npx prisma generate --schema services/api/prisma/schema.prisma
EXPOSE 4000
CMD ["npm", "-w", "@mtlink/api", "run", "dev"]

# ---- build -----------------------------------------------------------------
FROM deps AS build
COPY . .
RUN npx prisma generate --schema services/api/prisma/schema.prisma \
 && npm -w @mtlink/shared run build \
 && npm -w @mtlink/api run build

# ---- prod ------------------------------------------------------------------
FROM node:22-bookworm-slim AS prod
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/services/api/dist ./services/api/dist
COPY --from=build /app/services/api/package.json ./services/api/package.json
COPY --from=build /app/services/api/prisma ./services/api/prisma

# Drop privileges. The node image ships a `node` user for exactly this.
USER node

EXPOSE 4000
# tini reaps zombies and forwards SIGTERM, which is what makes the graceful
# shutdown handler in src/index.ts actually run on `docker stop`.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "services/api/dist/index.js"]
