FROM node:20-alpine AS builder
WORKDIR /usr/src/app
COPY package*.json ./
# --omit=dev replaces the deprecated --only=production: test/lint tooling never reaches the image.
RUN npm ci --omit=dev

FROM node:20-alpine
WORKDIR /usr/src/app
ENV NODE_ENV=production
# Containers are configured through their environment: no .env generation, no port fallback, no browser to open.
ENV AUTO_ENV=false NO_AUTO_OPEN=true

COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY . .

# Application code stays owned by root (read-only for the runtime user); only the data directory is writable.
RUN mkdir -p /usr/src/app/data && chown -R node:node /usr/src/app/data

USER node
EXPOSE 3000

# Lets Docker (and `docker compose ps`) see when the app is really answering.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-3000}/healthz || exit 1

CMD ["node", "src/index.js"]
