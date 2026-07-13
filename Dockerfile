# OptiScan production image — single-instance VPS / Docker / Railway deploy.
# One long-running service owns HTTP + the background runtime (scanner, Supervisor,
# paper engine, scheduler). SQLite lives on the mounted volume at /app/data.
FROM node:20-bookworm-slim AS base
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Default port for a plain `docker run`; on Railway the injected PORT overrides it.
ENV PORT=8780
ENV HOSTNAME=0.0.0.0

# gosu lets the root entrypoint fix the volume owner, then drop to the unprivileged
# user (signal-safe, unlike `su`).
RUN apt-get update && apt-get install -y gosu && rm -rf /var/lib/apt/lists/*
RUN groupadd -g 1001 nodejs && useradd -u 1001 -g nodejs nodejs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nodejs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nodejs:nodejs /app/.next/static ./.next/static
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# The persistent /app/data directory is created here; the actual persistent volume
# is attached manually through Railway and mounted at /app/data (Railway does not
# support the Dockerfile VOLUME instruction). The entrypoint fixes its ownership.
RUN mkdir -p /app/data && chown nodejs:nodejs /app/data

EXPOSE 8780

# Lightweight probe on the injected PORT; /api/healthz never 503s for market/model/
# discord state (only for a genuinely unopenable DB).
HEALTHCHECK --interval=60s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "const p=process.env.PORT||8780;fetch('http://127.0.0.1:'+p+'/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Entrypoint runs as root (fixes /app/data owner) then execs the server as nodejs.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]
