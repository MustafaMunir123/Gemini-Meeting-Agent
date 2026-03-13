# Gemini Sidekick — Cloud Run (Next.js + voice WS on one port)
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000 && \
    npm config set fetch-retries 5 && \
    npm ci

COPY . .
RUN npm run build

# Production image
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# Copy app and install production deps only
COPY --from=builder /app/package.json /app/package-lock.json* ./
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/server.js ./
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/next.config.js ./
COPY --from=builder /app/src ./src
COPY --from=builder /app/tsconfig.json ./

RUN npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000 && \
    npm config set fetch-retries 5 && \
    npm ci --omit=dev

EXPOSE 8080

CMD ["node", "server.js"]
