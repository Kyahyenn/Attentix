FROM node:20-alpine AS builder
WORKDIR /usr/src/app
COPY package*.json ./
# Production dependencies only: test and lint tools never reach the image.
RUN npm ci --omit=dev

FROM node:20-alpine
WORKDIR /usr/src/app
ENV NODE_ENV=production
# Configured through the environment: no .env generation, no port fallback, no browser to open.
ENV AUTO_ENV=false NO_AUTO_OPEN=true

COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY . .

# App code stays root-owned (read-only for the app user); only data/ is writable.
RUN mkdir -p /usr/src/app/data && chown -R node:node /usr/src/app/data

USER node
EXPOSE 3000

# Lets Docker (and `docker compose ps`) see when the app is really answering.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-3000}/healthz || exit 1

CMD ["node", "src/index.js"]
