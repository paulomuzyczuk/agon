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

- `/whoami` replies with the chat id to put in `TELEGRAM_OWNER_CHAT_ID`.

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
