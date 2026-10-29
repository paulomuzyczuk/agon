# Changelog

What changed, for people who run Agon themselves. Newest first. Each entry says
whether you need to do anything beyond the usual update (see "Updating" in
[`docs/self-hosting/README.md`](docs/self-hosting/README.md)). Migrations run
with `pnpm migrate`; they are forward-only.

## Unreleased (2026-10-29)

**Calendar**

- `pnpm gcal:sync --dry-run` previews a sync and writes nothing.
- `pnpm session:adjust` can pin a start time (`--at=18:30`), and `--calendar`
  addresses a session that was already moved by the date it sits on now.
- A Monday job reconciles the calendar with your recorded runs and rides:
  done sessions get a check mark and the real distance, sessions with no
  activity are tagged "Not done". Needs `pnpm migrate`, then `pnpm gcal:sync`
  once. Optional timer: `deploy/agon-calendar-reconcile.timer`
  (see `docs/self-hosting/google-calendar.md`).
- Reconcile no longer reads a changed default time slot as a hand edit: it now
  compares against what Agon last pushed.

**Telegram**

- **Action needed:** the bot now answers only the chat in `TELEGRAM_OWNER_CHAT_ID`.
  Before this, anyone who found the bot could run its commands or send it voice
  notes. If you have not set the variable, the bot answers `/whoami` only: send
  it, put the id in `.env.local`, restart `bot`. Other chats are ignored
  silently. If you use the webhook, also set `TELEGRAM_WEBHOOK_SECRET`.
- `/whoami` replies with the chat id to put in `TELEGRAM_OWNER_CHAT_ID`.

**Rides**

- Power zones: time in the seven Coggan zones per ride, from a power meter's
  measured stream and your FTP. Shown on the ride page and in `fct_ride_power`.
  Needs `pnpm migrate`; rides already scored get zones after
  `pnpm power:backfill-metrics --write`. Rides without a power meter are unchanged.

**Scheduled jobs**

- `pnpm sync:all` pulls Google Health and Strava in one go and recomputes
  Relative Effort, best efforts, fueling balance, training load and race
  predictions afterwards: the sync scripts never did, so those stayed as old as
  your last manual `pnpm re:backfill --write` and friends. User units
  `deploy/user/agon-sync.*` run it once a day at 05:15. A failing source doesn't
  stop the others; you get one Telegram message per new failure. Optional:
  install the units as described in `deploy/README.md`.
- `deploy/user/agon-freshness.*` is a user-level nightly `pnpm data:freshness`.
  On Linux with the native Docker engine it needs a password for the
  `dbt_writer` role and `DBT_DOCKER_NETWORK=host` in `.env.local` (the unit's
  header lists the steps). `analytics/dbt.sh` now runs the container as your
  user there.

## 2026-10-25

**Calendar and training**

- Evening runs, Tuesday/Thursday bike commutes (with a chest-strap reminder on
  the morning ride), weekday lifts at 22:30.
- Monthly 5/10/15/21.1 km time trials, run as a single out-and-back route picked
  on traffic lights.
- The default sync window looks back 3 days.

**Data**

- Missing ride heart rate is filled from Google Health.
- Missed-stop detection covers short stationary tails on rides and lists open
  suggestions on the dashboard.
- Late-stop trims also cut device and power arrays.
- Recording a standing wheel or a still crank stores 0 instead of a gap.

**Self-hosting**

- `.env.example` no longer puts comments on empty `KEY=` lines (they were being
  read as values). CI now fails on that, and on environment variables the code
  reads that `.env.example` does not list.
- Host ports for Ollama and OpenRouteService are movable, and the two have
  separate Compose profiles so a busy port cannot stop the app.
- Linux voice notes: opt-in overlay `docker-compose.voice.yml` (whisper.cpp and
  ffmpeg in the bot image).
- User-level systemd backup units that need no sudo; `AGON_DOCKER_HOST` pins the
  Docker engine for backups.
- Docs: prerequisites (Node.js 22 or newer, corepack, NVIDIA Container
  Toolkit), `data/` ownership on Linux, state that lives outside Postgres,
  updating, uninstalling, Strava source priority.

**Security**

- Dependency updates: Next 15.5.28, zod 4.6.7, and refreshed body-parser,
  ip-address and fast-uri.
- The login redirect is built from the forwarded host, so it works behind
  `tailscale serve`.

**PWA**

- 192/512 px and maskable icons in the web manifest.
