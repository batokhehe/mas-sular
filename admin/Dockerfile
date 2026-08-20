# syntax=docker/dockerfile:1.7
#
# Mas Sular admin — production image (Next.js standalone).
#
# `output: 'standalone'` makes Next trace the modules the server actually
# reaches and emit them next to server.js, so the runtime stage copies a
# ready-to-run tree instead of installing dependencies a second time.
#
# IMPORTANT — NEXT_PUBLIC_* are inlined into the client bundle at BUILD time.
# They are build arguments, not runtime env: changing one requires a rebuild.
# They are public by definition; never pass a secret this way.

ARG NODE_IMAGE=node:22.20.0-alpine3.21
ARG PNPM_VERSION=10.0.0

FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-admin,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM base AS build
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build
# Fail the BUILD, not the container, if standalone lands somewhere unexpected.
# Next nests output under the package path when it detects a monorepo root
# (locally: .next/standalone/admin/server.js). This build context is the repo
# alone, so it must not nest — assert that rather than trust it.
RUN test -f .next/standalone/server.js \
    || { echo "ERROR: standalone server.js not at .next/standalone/server.js"; \
         find .next/standalone -maxdepth 3 -name server.js; exit 1; }

FROM ${NODE_IMAGE} AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3002 \
    HOSTNAME=0.0.0.0
RUN apk add --no-cache dumb-init
WORKDIR /app

# Three pieces make up a runnable standalone build. static/ and public/ are
# NOT included in standalone/ by design and must be placed alongside it.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public

# F59 (Option A): strip package managers from the RUNTIME image. Nothing here
# invokes them — the app is `node server.js` and the healthcheck is
# `node -e fetch(...)` — but `npx <anything>` is the most convenient way to run
# arbitrary remote code after an RCE, and this service has egress via `edge`.
# Safe because they are self-contained symlink targets: node is a standalone
# binary at /usr/local/bin/node and is untouched.
# NOT removed: sh/busybox (CMD-SHELL healthchecks and docker exec depend on it),
# dumb-init, node. BusyBox therefore still exposes wget/nc as applets — accepted
# residual risk; removing the /usr/bin/wget symlink would be cosmetic only.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v* /sbin/apk /etc/apk /lib/apk /usr/share/apk /var/cache/apk

USER node
EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3002)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
