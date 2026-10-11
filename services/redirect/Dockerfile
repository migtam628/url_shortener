# The redirect service. Kept separate from the API image so it carries no
# Prisma engine, no argon2 binary and no QR renderer — the hot path should
# ship as little as possible.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY services/api/package.json services/api/
COPY services/redirect/package.json services/redirect/
COPY apps/dashboard/package.json apps/dashboard/
RUN npm ci --ignore-scripts

FROM deps AS dev
ENV NODE_ENV=development
COPY . .
EXPOSE 4001
CMD ["npm", "-w", "@mtlink/redirect", "run", "dev"]

FROM deps AS build
COPY . .
RUN npm -w @mtlink/shared run build && npm -w @mtlink/redirect run build

FROM node:22-bookworm-slim AS prod
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/services/redirect/dist ./services/redirect/dist
COPY --from=build /app/services/redirect/package.json ./services/redirect/package.json

USER node
EXPOSE 4001
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "services/redirect/dist/index.js"]
