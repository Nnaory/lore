# syntax=docker/dockerfile:1
ARG NODE_VERSION=26

FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
ARG NODE_OPTIONS=""
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# Project store, inlined into the client bundle by `next build` (r13 spec):
#   idb  — browser IndexedDB only (default)
#   http — the LORE API, with IndexedDB as a local cache
ARG NEXT_PUBLIC_PROJECT_STORE=idb
ENV NEXT_PUBLIC_PROJECT_STORE=${NEXT_PUBLIC_PROJECT_STORE}
# Lesson animations made by the AI, inlined into the client bundle by `next build` like the flag
# above (design 7.9, Requirement 36.1). Only the exact value `on` turns them on. The default `off`
# builds the app as it was before the feature. Pass `--build-arg NEXT_PUBLIC_ANIMATIONS=on` only
# after the checks of Requirement 36.4. Changing it needs a new build, not a new container env.
ARG NEXT_PUBLIC_ANIMATIONS=off
ENV NEXT_PUBLIC_ANIMATIONS=${NEXT_PUBLIC_ANIMATIONS}
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN useradd --create-home --uid 10001 app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
USER app
EXPOSE 3000
LABEL org.opencontainers.image.source="https://github.com/Nnaory/lore"
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
