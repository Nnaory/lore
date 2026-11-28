# syntax=docker/dockerfile:1
# Lambda container image for the animation verifier (design 5.13; Requirements 34.6, 37.13).
#
# Build (linux/amd64, no provenance or SBOM: Lambda rejects an OCI image index):
#   docker build --platform linux/amd64 --provenance=false --sbom=false \
#     -t lore-verifier:local animation-verifier
#
# `npm ci` needs animation-verifier/package-lock.json, which is NOT committed yet. Generate it
# once, online, and commit it before the first build (it also feeds check-animation-versions.py):
#   cd animation-verifier && npm install --save-exact
# Do not hand-write the lockfile, and do not replace `npm ci` with `npm install` here.
#
# Layout at ${LAMBDA_TASK_ROOT} (/var/task), which the code depends on:
#   package.json         "type": "module" (dist/*.js are ES modules); versions.ts reads it via ../package.json
#   node_modules/        production dependencies only. Step 4 (tsc) reads react/remotion declarations from
#                        <PKG_ROOT>/node_modules (@types/react, csstype, remotion, typescript/lib/*.d.ts);
#                        all of them are `dependencies`, so `npm prune --omit=dev` keeps them.
#   dist/handler.js      the handler (CMD below)
#   dist/animation-contract.json   next to the handler (handler.ts CONTRACT_LOCATIONS[0])
#   dist/eslint.config.mjs         internal ESLint config for step 3 (lint.ts CONFIG_LOCATIONS[0])
#   dist/eslint-plugin-lore/       the compiled local ESLint plugin that config imports
#   dist/steps/render-worker.js    worker file next to render-host.js (DEFAULT_WORKER_URL)
# PKG_ROOT (typecheck.ts) is two levels above dist/steps/, so it is /var/task and not /var/task/dist.
#
# NODE_ENV is deliberately left unset: React then runs its development build, so React warnings
# surface as RENDER_CONSOLE_* diagnostics (design 5.13). The Lambda gets no Terraform-defined
# environment variables and the render Worker runs with `env: {}`.
FROM node:22-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json eslint.config.mjs ./
# Type declarations for eslint.config.mjs; lint.ts imports its type through typeof import(...).
COPY eslint.config.d.mts ./
COPY src ./src
COPY eslint-plugin-lore ./eslint-plugin-lore
COPY contract ./contract
# `npm run build` = tsc for src/ -> dist/ and tsc for eslint-plugin-lore/ -> dist/eslint-plugin-lore/.
RUN npm run build && npm prune --omit=dev && cp contract/animation-contract.json eslint.config.mjs dist/

FROM public.ecr.aws/lambda/nodejs:22
WORKDIR ${LAMBDA_TASK_ROOT}
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
COPY --from=build /build/package.json ./package.json
CMD ["dist/handler.handler"]
