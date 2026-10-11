# The dashboard is a static SPA. In dev this image runs Vite; in production it
# only builds the assets, which nginx then serves from a shared volume (see
# docker-compose.prod.yml).

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY services/api/package.json services/api/
COPY services/redirect/package.json services/redirect/
COPY apps/dashboard/package.json apps/dashboard/
RUN npm ci --ignore-scripts

FROM deps AS dev
ENV NODE_ENV=development
COPY . .
EXPOSE 5173
CMD ["npm", "-w", "@mtlink/dashboard", "run", "dev", "--", "--host", "0.0.0.0"]

FROM deps AS build
ARG VITE_BASE_PATH=/
ENV VITE_BASE_PATH=${VITE_BASE_PATH}
COPY . .
RUN npm -w @mtlink/shared run build && npm -w @mtlink/dashboard run build

FROM node:22-bookworm-slim AS prod
WORKDIR /app
COPY --from=build /app/apps/dashboard/dist ./apps/dashboard/dist
# Nothing to run: the built assets are published through a volume and served
# by nginx. The container stays alive only to own that volume.
CMD ["sh", "-c", "echo 'dashboard assets built; served by nginx' && sleep infinity"]
