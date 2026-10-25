# Self-Hosting Agon

Agon is designed to be self-hosted by anyone who wants their own personal
health/training data platform, not a service you sign up for — see
`CLAUDE.md` → "Infrastructure" for why (GDPR data-controller exposure for
strangers' health data, Google's restricted-scope OAuth verification doesn't
scale to a multi-tenant product, and the default `claude` CLI LLM path rides
a personal Anthropic subscription). This doc set is the fresh-install path:
`git clone` → your own running instance, reachable from your own phone, with
none of your data ever leaving your own machine.

If you're the *original* athlete/maintainer migrating this exact instance to
new hardware (not standing up a fresh one), use
[`deploy/SETUP.md`](../../deploy/SETUP.md) instead — it's a dump-and-restore
runbook, not a from-scratch guide.

## What you get

- A Postgres database holding your own training/nutrition/biometric data —
  never a shared or hosted database.
- A web dashboard (PWA) reachable from your own devices over
  [Tailscale](https://tailscale.com/), gated by a single login secret.
- A Telegram bot for low-friction voice/text logging.
- Optional integrations you turn on one at a time: Strava, Google Health,
  Google Calendar, a fully-local AI stack (no API keys), route suggestions.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) + Docker Compose (bundled
  with Docker Desktop, or the `docker-compose-plugin` package on Linux).
- [Node.js 22](https://nodejs.org/) + [pnpm](https://pnpm.io/) (`corepack
  enable` gets you the pinned pnpm version from this repo's `package.json`)
  — needed to run `pnpm bootstrap` and any one-off admin script from your
  own machine; the app itself runs entirely inside Docker.
- A Telegram account (for the bot) and, optionally, Strava/Google accounts
  for the integrations you want.

## 1. Clone and bootstrap

```sh
git clone <this-repo-url> agon
cd agon
pnpm install
pnpm bootstrap
```

`pnpm bootstrap` (`scripts/bootstrap.ts`) does everything that can actually
be automated:

- Copies `.env.example` → `.env.local` (never overwrites an existing one).
- Copies `config/athlete-profile.example.json` and
  `config/nutrition-goals.example.json` to their `.local.json` counterparts —
  placeholder values, safe to run the app against immediately.
- Copies `docs/training-program.example.md` → `.local.md` — a generic sample
  program.
- Generates random values for the secrets that don't need a human to choose
  them (`AGON_WEB_SECRET`, `AGON_SESSION_SIGNING_KEY`,
  `TELEGRAM_WEBHOOK_SECRET`).
- Starts the local Postgres (`docker compose up -d db`) and applies every
  migration, so you land on a real, empty, correctly-shaped schema.

It deliberately does **not** run any seed script or touch OAuth — see
"What's still manual" below.

## 2. Build and start the app

```sh
docker compose --env-file .env.local up -d --build app bot
```

This builds the image once (`Dockerfile` — multi-stage, non-root, `pnpm
build` produces a `next.config.mjs` `output: 'standalone'` build) and starts
two containers from it: `app` (the web dashboard) and `bot` (the Telegram
long-poll listener). See `docker-compose.yml`'s own comments for the full
profile list (`local-ai`, `analytics`) and one-off admin script usage
(`docker compose --env-file .env.local run --rm app tsx scripts/<name>.ts`).

The `app` service also bind-mounts `./data` read-write — `lib/auth/`
persists your migrated login-secret hash there on first login (see
[`network-exposure.md`](network-exposure.md)). Docker creates that host
directory for you, but on Linux make sure it's writable by uid 1000 (the
image's non-root user) if you see permission errors in `docker compose logs
app`: `mkdir -p data && sudo chown 1000:1000 data`.

Check it's up:

```sh
docker compose --env-file .env.local ps
docker compose --env-file .env.local logs -f app
```

By default the app binds `127.0.0.1` only on the host (see
[`network-exposure.md`](network-exposure.md) for reaching it from another
device). Open <http://127.0.0.1:3000> — you should land on the login page.
Log in with the `AGON_WEB_SECRET` value `pnpm bootstrap` generated (`grep
AGON_WEB_SECRET .env.local`).

## 3. Fill in your real profile

The app runs on placeholder data until you edit two files:

- **`config/athlete-profile.local.json`** — your time zone, program start
  date/length, HR max/resting, sweat rate, starting weight/body-fat %. See
  `lib/athleteProfile.ts` for what each field means.
- **`docs/training-program.local.md`** (documentation) + **`lib/training/trainingProgram.ts`**
  (the code that actually generates `planned_sessions`) — your own training
  program's weekly structure and volume. See
  [`training-program.md`](training-program.md) for why these are two separate
  files and how to edit them together.

Restart the app after editing `config/athlete-profile.local.json` (it's
read once at process start): `docker compose --env-file .env.local restart app bot`.

## Back up the database first

Before you log anything you'd mind losing, set up the daily backup:
[`backups.md`](backups.md). Everything you enter lives in one Docker volume,
and a single `docker compose down -v` deletes it.

## 4. Turn on the integrations you want

Each one is optional and independent — skip anything you don't need.

| Integration | What it gives you | Guide |
|---|---|---|
| Telegram bot | Voice/text logging, `/sync`, `/route`, etc. | [`telegram.md`](telegram.md) |
| Google Health | Live run/wellness sync (runs, HR, sleep, HRV) | [`google-health.md`](google-health.md) |
| Google Calendar | Training plan pushed to your calendar | [`google-calendar.md`](google-calendar.md) |
| Strava | Historical backfill / one-time enrichment | [`strava.md`](strava.md) |
| Tailscale | Reach the dashboard from your phone, off your LAN | [`network-exposure.md`](network-exposure.md) |
| Android app | Native shell for screen-off recording (sideloaded APK) | [`android-app.md`](android-app.md) |

Every OAuth-based integration needs **you** to register your own app in that
vendor's developer console — this cannot be scripted, and this project never
ships or holds a shared OAuth client on your behalf (same position as the
sibling Hephaistos project's "every self-hoster creates their own OAuth
app"). Each guide above walks through it.

## 5. Seed reference data

Once your config files have real values:

```sh
pnpm seed:gear
pnpm seed:fueling
pnpm seed:foods
pnpm seed:meals
pnpm seed:nutrition-goals
pnpm seed:planned
```

These run against the same Postgres the containers use
(`DATABASE_URL=postgresql://agon:agon@127.0.0.1:5432/agon`, published on
`127.0.0.1:5432` by `docker-compose.yml`'s `db` service) — run them from your
own machine, not inside a container.

`nutrition-goals` reads `config/nutrition-goals.local.json` — same pattern as
the athlete profile: fill in real values before seeding, or it seeds
placeholders.

## What's still manual, and why

- **OAuth app registration** per integration you want (Strava, Google
  Health, Google Calendar, Telegram BotFather) — each is a human
  click-through in a vendor console; see each integration's guide.
- **Installing and logging into Tailscale** on this host, if you want to
  reach the app from another device — see
  [`network-exposure.md`](network-exposure.md).
- **Filling in your real numbers** in `config/athlete-profile.local.json`
  and your real program in `docs/training-program.local.md` +
  `lib/training/trainingProgram.ts`.
- **Turning on voice-note parsing** — `AGON_LLM_PROVIDER` defaults to
  `ollama` (no vendor account, no lock-in — see `.env.example`'s "LLM
  provider abstraction" section), so bring it up with `docker compose
  --env-file .env.local --profile local-ai up -d ollama` and `docker compose
  --env-file .env.local exec ollama ollama pull qwen2.5:7b`; swapping to
  `claude-cli` or `anthropic` (BYOK) is a one-line env change, never
  required.

  **Ollama already running on this machine?** Either skip the container and
  set `AGON_LLM_BASE_URL` to the host Ollama, or keep the container and set
  `OLLAMA_HOST_PORT` (and `ORS_HOST_PORT` for routing) in `.env.local` so the
  host ports don't collide. If you bind-mount the host Ollama's model directory
  into the container to avoid a re-download, it must be **read-write** (a
  `:ro` mount crash-loops on Ollama's startup migration), and that directory
  is not Agon's: never delete it as part of cleaning up Agon. Local transcription (whisper.cpp) is a separate opt-in overlay,
  see [telegram.md](telegram.md); routing (a self-hosted OpenRouteService) is the
  `local-routing` profile (`up -d ors-app`).

## Updating

```sh
git pull
docker compose --env-file .env.local build app bot
docker compose --env-file .env.local up -d app bot
docker compose --env-file .env.local run --rm app tsx scripts/migrate.ts
```

See the `agon` project in Linear for what changed between
versions, and CLAUDE.md's migration discipline (EXPAND-only, forward-only —
`migrate.ts` is always safe to re-run).

## Troubleshooting

- **Login page never appears / 500 on every route** — `AGON_WEB_SECRET` is
  unset; the app refuses to start without one (`scripts/start-web.ts`
  crashes early rather than serving unauthenticated). Check
  `docker compose --env-file .env.local logs app`.
- **"refusing to bind the all-interfaces wildcard"** — you're running
  `pnpm start` directly on a host (not via Docker) with
  `AGON_WEB_BIND_HOST=0.0.0.0` and no `AGON_WEB_ALLOW_PUBLIC`. See
  [`network-exposure.md`](network-exposure.md).
- **A container restarts in a loop** — `docker compose --env-file .env.local
  logs <service>` almost always shows a clear cause (missing env var, DB not
  yet healthy — `depends_on: condition: service_healthy` should prevent
  this, but check `docker compose --env-file .env.local ps db` first).
- **An integration silently does nothing** — every optional integration
  degrades gracefully on a missing env var rather than erroring; check
  `.env.example`'s comments for what each one needs, and that
  integration's guide above.
