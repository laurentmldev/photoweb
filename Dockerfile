# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------
# 1. deps: install production node_modules in isolation, so later
#    layers (and rebuilds triggered only by app-code changes) don't
#    repay the full npm install.
# ---------------------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

# ---------------------------------------------------------------------
# 2. runtime image
# ---------------------------------------------------------------------
FROM node:20-alpine

# su-exec: lets the entrypoint start as root (to fix volume ownership),
# then drop to an unprivileged user before actually running the app.
RUN apk add --no-cache su-exec

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY views ./views

# Sample/starter config, content and images (sample/), staged under
# /app/sample. These are NOT the live paths the app reads from: the app
# reads /app/data/{config,content,galleries,photos}, which are external
# volumes (see docker-compose.yml) and are expected to be empty the
# first time the container runs on a fresh host. The entrypoint copies
# the sample into each of those volumes on first run only, so
# `docker compose up` shows a working site immediately; any volume the
# host operator has already populated is left untouched.
COPY sample ./sample

RUN mkdir -p /app/data/config /app/data/content /app/data/galleries /app/data/photos

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
