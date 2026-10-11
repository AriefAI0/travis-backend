# deps: install production dependencies from the lockfile only
FROM oven/bun:1.3-debian AS deps
USER root
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# migrate: full deps (drizzle-kit included) — one-shot schema push target
FROM oven/bun:1.3-debian AS migrate
USER root
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY drizzle.config.ts ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
# migrate_log names the broken connection; migrate applies pending SQL headless
# (push prompts on constraints against live data and dies without a TTY)
CMD ["sh", "-c", "bun scripts/migrate_log.ts && bunx drizzle-kit migrate"]

# runtime: bun + ffmpeg (ffprobe ships with the ffmpeg package) + LibreOffice
# (the report PDF converter) + Carlito, metric-compatible with the absent Calibri
FROM oven/bun:1.3-debian AS runtime
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ffmpeg \
    libreoffice-writer \
    fonts-crosextra-carlito \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock ./
COPY src ./src

# NODE_ENV stays unset on purpose. Set to production, Bun stops bundling the
# report editor page at runtime and points the page at asset paths its own
# pre-build does not emit on this version — the page then loads nothing.
# Revisit with a working pre-build: the page ships unminified until then.

# DATA_DIR default lands here — mount it to survive redeploys
VOLUME /app/data
EXPOSE 8788
CMD ["bun", "src/index.ts"]
