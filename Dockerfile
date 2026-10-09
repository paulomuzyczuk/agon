# syntax=docker/dockerfile:1
# Agon — self-host image.
#
# This image carries ONLY code + dependencies. Secrets are injected via
# docker-compose's `env_file:` (never baked in); config/*.local.json (the only
# local file path the running app itself reads — see lib/athleteProfile.ts)
# is bind-mounted at runtime — never copied in (see .dockerignore). That keeps
# the per-instance trust boundary intact: the image is shareable, secrets
# never leave the host. Mirrors the sibling Hephaistos project's self-host
# Dockerfile.
#
# One image, multiple roles, selected by overriding CMD (docker-compose.yml's
# `app`/`bot` services; `docker compose run --rm app tsx scripts/<name>.ts` for
# one-off admin scripts) — see CLAUDE.md "choosing-architecture-style": the web
# process and the bot process don't need different scaling/reliability
# profiles, so splitting them into separate images buys nothing. Because every
# non-Next script in this repo runs via `tsx` directly (no compiled-JS step —
# confirmed in package.json), the runtime stage keeps the FULL dependency tree
# (not pruned to production-only) and the full source tree, not just the Next.js
# build output. Every runtime command invokes `node_modules/.bin` binaries
# directly (`tsx`, `node server.js`) rather than going through `pnpm run` — see
# the runtime stage's own comment for why. The web role runs via
# `next.config.mjs`'s `output: 'standalone'` entrypoint (`tsx
# scripts/start-web.ts` → `node server.js`, PORT/HOSTNAME-driven — see
# lib/webBind.ts) rather than `next start`, which Next.js explicitly warns is
# incompatible with standalone output; a future split into a web-only image
# could drop the full node_modules copy in favor of just `.next/standalone`'s
# own pruned one.
#
# Multi-arch: built for linux/amd64 and linux/arm64 (`docker buildx build
# --platform linux/amd64,linux/arm64`) — see docs/self-hosting/README.md.

ARG NODE_VERSION=22-slim

# package.json pins `packageManager: pnpm@11.1.3` — `corepack enable` alone
# reads that field and activates the exact pinned version in the deps/builder
# stages below (install + `next build`). The runtime stage doesn't need pnpm
# at all — see its own comment.

# ── deps: install the full dependency tree (prod + dev — tsx-run scripts need
# devDependencies like tsx itself) ──────────────────────────────────────────
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN corepack enable
RUN pnpm install --frozen-lockfile

# ── builder: compile the Next.js production build ───────────────────────────
FROM node:${NODE_VERSION} AS builder
RUN corepack enable
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# public/ holds the service worker (public/sw.js, MZY-207); mkdir -p keeps the
# runtime stage's COPY below safe if it is ever emptied again.
RUN mkdir -p public
# next.config.mjs `output: 'standalone'` — no real secrets are needed at build
# time (no DB/API calls happen during `next build` for this app's route
# handlers, which are all dynamic, not statically generated).
RUN pnpm build

# ── runtime: non-root, full source + full deps (web + bot + admin scripts) ──
FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Non-root user (wiki/topics/security-principles.md, Nygard Ch.11: "never run
# as root"; the only privileged capability — binding <1024 — isn't needed,
# Agon's default port is 3000). The base node:22-slim image already ships a
# uid/gid-1000 `node` user — reuse it rather than creating a colliding one.
# Bind-mounted volumes (config/) must be writable by this UID on Linux hosts —
# chown on the host, or set `user:` in compose, if your files aren't owned by 1000.

# Run scripts via `node_modules/.bin` directly, NOT `pnpm <script>` — pnpm 11's
# pre-run dependency-status check (`runDepsStatusCheck`) wants to interactively
# confirm a node_modules purge/reinstall before every `pnpm run`, which a
# container has no TTY for; `.npmrc`'s `verify-deps-before-run=false` (written
# for local dev) did not suppress it here, and pnpm's own suggested `CI=true`
# workaround makes it reinstall from the registry on every container start
# instead — undesirable for a self-hosted image that should start offline from
# what's already baked in. Calling the resolved binary directly sidesteps the
# whole check.
ENV PATH="/app/node_modules/.bin:${PATH}"

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/server.js ./server.js
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.mjs ./next.config.mjs
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/services ./services
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/config ./config

RUN chown -R node:node /app
USER node

# AGON_WEB_BIND_HOST/_PORT (lib/webBind.ts, read by scripts/start-web.ts)
# control what the server binds inside the container — docker-compose.yml
# sets 0.0.0.0 here deliberately and controls the REAL host-level exposure via
# its `ports:` mapping instead; see docs/self-hosting/network-exposure.md.
EXPOSE 3000

# Default role: the web app. Override CMD for the bot
# (["tsx", "scripts/telegram-poll.ts"]) or one-off admin scripts
# (`docker compose run --rm app tsx scripts/migrate.ts`) — see docker-compose.yml.
CMD ["tsx", "scripts/start-web.ts"]
