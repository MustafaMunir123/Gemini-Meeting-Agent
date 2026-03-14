<<<<<<< Updated upstream
# Gemini Sidekick — Cloud Run (Next.js + voice WS on one port; zoom-bot needs Chromium)
=======
>>>>>>> Stashed changes
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000 && \
    npm config set fetch-retries 5 && \
    npm ci

# NEXT_PUBLIC_* is inlined at build time (client bundle). Pass at build: --build-arg NEXT_PUBLIC_GEMINI_API_KEY=...
ARG NEXT_PUBLIC_GEMINI_API_KEY
ENV NEXT_PUBLIC_GEMINI_API_KEY=$NEXT_PUBLIC_GEMINI_API_KEY

COPY . .
RUN npm run build

<<<<<<< Updated upstream
# Production image: Debian so we can install Playwright/Chromium for the zoom-bot
FROM node:20-bookworm AS runner
=======
FROM node:20-alpine AS runner
>>>>>>> Stashed changes

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

<<<<<<< Updated upstream
# Copy app and install production deps (includes playwright)
=======
>>>>>>> Stashed changes
COPY --from=builder /app/package.json /app/package-lock.json* ./
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/server.js ./
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/next.config.js ./
COPY --from=builder /app/src ./src
COPY --from=builder /app/tsconfig.json ./

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000 && \
    npm config set fetch-retries 5 && \
    npm ci --omit=dev && \
    npx playwright install chromium chromium_headless_shell --with-deps

EXPOSE 8080

CMD ["node", "server.js"]




