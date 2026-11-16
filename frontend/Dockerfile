# Development stage
FROM mirror.gcr.io/library/node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS development

WORKDIR /app

# Install dependencies
# patches/ is applied by the postinstall hook (patch-package), so it has to
# be in place before the install runs.
COPY package*.json ./
COPY patches ./patches
RUN npm ci

# Copy source code
COPY . .

EXPOSE 3000

CMD ["npm", "run", "dev"]

# Builder stage (uses slim/glibc to avoid Alpine musl SIGSEGV during next build)
FROM mirror.gcr.io/library/node:24-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS builder

WORKDIR /app

# patches/ is applied by the postinstall hook (patch-package), so it has to
# be in place before the install runs.
COPY package*.json ./
COPY patches ./patches
RUN npm ci

COPY . .
RUN npm run build

# Production stage (uses standalone output)
FROM mirror.gcr.io/library/node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS production
ARG GIT_SHA
ARG BUILD_DATE
ARG VERSION
LABEL org.opencontainers.image.title="Monize Frontend" \
      org.opencontainers.image.description="Frontend for Monize, a self-hosted personal finance app" \
      org.opencontainers.image.source="https://github.com/kenlasko/monize" \
      org.opencontainers.image.url="https://github.com/kenlasko/monize" \
      org.opencontainers.image.authors="ken.lasko@gmail.com" \
      org.opencontainers.image.vendor="Ken Lasko" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.version="${VERSION}" 
# Upgrade the base image's OS packages before anything else. `node:24-alpine`
# is rebuilt on Node's cadence, not Alpine's, so between rebuilds it ships
# whatever libcrypto3/libssl3 was current when the tag was cut -- that lag is
# the whole of this repository's open Trivy alerts, and it recurs every time
# Alpine publishes an OpenSSL advisory. Upgrading at build time takes the
# fixed packages from the same Alpine branch the base image already pins, so
# each rebuild clears the class rather than the ten CVEs that happen to be
# open today. `ignore-unfixed: true` on the scan means an alert that survives
# this is one Alpine has no fix for, and is genuinely ours to wait out.
#
# Install dumb-init for proper PID 1 signal handling. Drop the npm/npx/corepack
# CLI bundled in the base image: the standalone server runs via `node server.js`,
# so npm is never used at runtime, and its vendored deps (tar, ip-address,
# brace-expansion) otherwise surface as image CVEs we cannot patch directly.
RUN apk upgrade --no-cache && \
    apk add --no-cache dumb-init && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

WORKDIR /app

ENV NODE_ENV=production

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nextjs -u 1001

# Copy standalone build (much smaller than full node_modules)
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Console formatter preloaded before the standalone server so that every line
# the container emits -- including Next.js's own startup banner -- carries an
# ISO timestamp consistent with createLogger and the backend logs.
COPY --from=builder --chown=nextjs:nodejs /app/server-log-format.cjs ./

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "--require", "./server-log-format.cjs", "server.js"]
