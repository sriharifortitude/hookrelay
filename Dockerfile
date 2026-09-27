# One image, three roles, chosen by the command:
#   api (default)   node dist/server.js
#   worker          node dist/worker/main.js
#   migrate         node_modules/.bin/prisma migrate deploy
#
# Debian slim rather than Alpine: Prisma's query engine links against
# OpenSSL, and building and running on the same base means the engine
# binary Prisma picks at generate time is the one that runs.
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx prisma generate && npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
# CHECKPOINT_DISABLE: Prisma's CLI otherwise phones home for update checks
# and caches the answer under $HOME, which is read-only in production.
ENV NODE_ENV=production PORT=4000 CHECKPOINT_DISABLE=1
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json ./
USER node
EXPOSE 4000
# No wget or curl in the slim image; Node 22 has fetch.
HEALTHCHECK --interval=10s --timeout=3s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 4000) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/server.js"]
