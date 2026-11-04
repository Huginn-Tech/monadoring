# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Values the dashboard bundle is built with (see docker-compose.yml)
ARG MAINNET_VALIDATORS
ARG TESTNET_VALIDATORS
ARG MAINNET_RPCS
ARG TESTNET_RPCS
ENV MAINNET_VALIDATORS=$MAINNET_VALIDATORS \
    TESTNET_VALIDATORS=$TESTNET_VALIDATORS \
    MAINNET_RPCS=$MAINNET_RPCS \
    TESTNET_RPCS=$TESTNET_RPCS

# Copy source files (.dockerignore keeps .env and secrets out)
COPY . .

# Build application
RUN npm run build

# Production stage
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Create non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy built files
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3030

ENV PORT=3030
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
