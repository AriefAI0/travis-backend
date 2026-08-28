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
# --force: auto-accept statements so the push never blocks on a prompt
CMD ["bunx", "drizzle-kit", "push", "--force"]

# runtime: bun + ffmpeg (ffprobe ships with the ffmpeg package)
FROM oven/bun:1.3-debian AS runtime
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock ./
COPY src ./src

# DATA_DIR default lands here — mount it to survive redeploys
VOLUME /app/data
EXPOSE 8788
CMD ["bun", "src/index.ts"]
