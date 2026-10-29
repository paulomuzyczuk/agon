# Deploy — self-hosted Linux tower

Agon runs on the athlete's own always-on **Linux home server** (decision
2026-08-01, superseding the Hetzner VPS plan — see `CLAUDE.md` → Infrastructure).
Data stays on-premises (GDPR by construction), zero monthly cost.

## What runs on the tower

- **Telegram bot** — the long-poll listener (`pnpm telegram:poll`) under `systemd`
  (`agon-bot.service`). This is what makes the bot "always running".
- **Postgres** — the app database (local Docker `docker-compose.yml`, or a native
  install; point `DATABASE_URL` at it).
- **Data-freshness check** — `pnpm data:freshness` nightly under a `systemd` timer
  (`agon-freshness.service` + `.timer`). The ingestion dead-man's switch: alerts to
  Telegram when a pipeline stops feeding the database. A user-level pair with no
  sudo is in `deploy/user/agon-freshness.*`; its header lists the one-time setup
  (a password for the `dbt_writer` role, and `DBT_DOCKER_NETWORK=host` on Linux
  so the dbt container can reach a loopback-only Postgres).
- **Bike maintenance check** — `pnpm gear:check-maintenance` nightly under a
  `systemd` timer (`agon-gear-maintenance.service` + `.timer`). Alerts to Telegram
  when a bike crosses a maintenance threshold (e.g. chain lube every 300 km).
- **Database backup** — `pnpm db:backup` nightly. Either as a user unit with no
  sudo (`deploy/user/agon-backup.*`, for a clone in a home directory) or as the
  system-wide pair (`deploy/agon-backup.*`, `User=agon`, `/opt/agon`). Details and
  the restore drill: `docs/self-hosting/backups.md`.
- **Weekly calendar reconciliation** — `pnpm gcal:weekly-reconcile --write` on
  Mondays 06:00 under a `systemd` timer (`agon-calendar-reconcile.*`, or the
  user-level pair in `deploy/user/`). Marks last fortnight's sessions done /
  not done from the recorded data and pushes that to Google Calendar. See
  `docs/self-hosting/google-calendar.md`.
- **Sync from Google Health and Strava** — `pnpm sync:all` once a day, as the
  user-level pair `deploy/user/agon-sync.*` (MZY-420). Runs `gh:sync`,
  `gh:wellness`, `strava:sync` and `strava:sync-rides`, then recomputes the derived
  metrics (`re:backfill`, `re:backfill-rides`, `be:backfill`, `fueling:backfill`,
  `tl:backfill`, `rp:backfill`) as independent steps: one
  failing source doesn't stop the others, the unit ends failed, and the owner gets
  one Telegram message per new failure. It deliberately leaves out plain
  `gcal:sync`, which overwrites hand edits in Calendar. Pair it with the nightly
  freshness check above, which also catches a sync that stopped running.
- **n8n** — self-hosted automation (later).
- Weather enrichment runs inside the sync scripts; nothing else needs its own timer.

## Why long-poll, not webhook

The bot **dials out** to Telegram (`getUpdates`), so it needs **no public URL,
port-forwarding, or TLS** — nothing is exposed through the home router. A webhook
would require all of that plus a stable public hostname; deliberately not used.

> Run exactly **one** poll listener, and never poll + webhook simultaneously —
> Telegram allows a single update channel.

## Install the bot service

```sh
# 1. Check out the repo (e.g. /opt/agon), install Node + pnpm (corepack), fill .env.local
sudo cp deploy/agon-bot.service /etc/systemd/system/agon-bot.service
sudoedit /etc/systemd/system/agon-bot.service     # set User / WorkingDirectory / pnpm path

# 2. Enable + start (and on every boot)
sudo systemctl daemon-reload
sudo systemctl enable --now agon-bot

# 3. Observe
systemctl status agon-bot
journalctl -u agon-bot -f
```

`Restart=always` brings it back after a crash; `WantedBy=multi-user.target` starts
it on boot. Keep the tower awake (disable sleep/hibernate).

## Install the data-freshness check

The dead-man's switch on ingestion. Between 2026-08-04 and 2026-08-20 no run
reached the database — Health Connect had stopped feeding Google Health — and
nothing said so; the training-load curve quietly went wrong and the gap was found
by accident, eight days in. This is what tells you next time.

```sh
sudo cp deploy/agon-freshness.service deploy/agon-freshness.timer /etc/systemd/system/
sudoedit /etc/systemd/system/agon-freshness.service   # set User / WorkingDirectory

sudo systemctl daemon-reload
sudo systemctl enable --now agon-freshness.timer

systemctl list-timers agon-freshness       # when it next runs
sudo systemctl start agon-freshness        # run it once, right now
journalctl -u agon-freshness -n 50         # read the verdict
```

Set `TELEGRAM_OWNER_CHAT_ID` in `.env.local` or the alert is only printed to the
journal, never delivered. The service needs **Docker** available to its `User`
(dbt runs in the pinned container via `analytics/dbt.sh`).

It runs at 08:00 rather than overnight so the alert lands when you can act on it,
and `Persistent=true` means a check missed while the tower was off runs as soon as
it is back — a missed check looks exactly like a passing one, which is the failure
this mechanism exists to prevent.

Thresholds live in `analytics/models/staging/_sources.yml`, per table, with the
reasoning in comments. Tune them there, not in the unit.

## Install the gear-maintenance check

Bike maintenance alerts (chain lube, drivetrain, brake pads) on mileage
thresholds — a much simpler check than data-freshness: a direct Postgres query
comparing each active bike's current mileage against
`public.gear_maintenance_tasks`, no Docker/dbt dependency.

```sh
sudo cp deploy/agon-gear-maintenance.service deploy/agon-gear-maintenance.timer /etc/systemd/system/
sudoedit /etc/systemd/system/agon-gear-maintenance.service   # set User / WorkingDirectory

sudo systemctl daemon-reload
sudo systemctl enable --now agon-gear-maintenance.timer

systemctl list-timers agon-gear-maintenance       # when it next runs
sudo systemctl start agon-gear-maintenance        # run it once, right now
journalctl -u agon-gear-maintenance -n 50         # read the verdict
```

Set `TELEGRAM_OWNER_CHAT_ID` in `.env.local` or the alert is only printed to the
journal, never delivered. Unlike data-freshness, a clean bike is **not** itself
worth a Telegram message — only a threshold crossing is, so this never messages
on a healthy check. Runs at 08:05 (5 minutes after the freshness timer, so they
don't contend) with `Persistent=true`. Thresholds live in
`public.gear_maintenance_tasks` — tune with an `UPDATE`, not a migration, unless
adding a new task.

## Fully-local AI stack (free, open-source, no API keys)

The root `docker-compose.yml`'s `local-ai` (Ollama) and `local-routing` (OpenRouteService) profiles run the AI + routing services
on the tower (merged from the former `deploy/docker-compose.selfhost.yml` —
self-hosting decision, see `CLAUDE.md` → "App packaging"):

```sh
docker compose --env-file .env.local --profile local-ai up -d ollama
docker compose --env-file .env.local --profile local-routing up -d ors-app
docker compose --env-file .env.local exec ollama ollama pull qwen2.5:7b     # or llama3.1:8b
```

Then in `.env.local`:

```sh
# LLM parsing → local Ollama (GPU)
AGON_LLM_PROVIDER=ollama
AGON_LLM_MODEL=qwen2.5:7b
AGON_LLM_BASE_URL=http://localhost:11434

# Voice-note transcription → local whisper.cpp (mlx-whisper is Apple-only)
AGON_TRANSCRIPTION_PROVIDER=whisper-cpp
AGON_TRANSCRIPTION_MODEL=/opt/whisper.cpp/models/ggml-medium.bin
AGON_TRANSCRIPTION_WHISPER_BIN=whisper-cli

# Routing → local ORS; geocoding stays hosted (self-hosted ORS has no Pelias)
ORS_BASE_URL=http://localhost:8080/ors
ORS_GEOCODE_BASE_URL=https://api.openrouteservice.org
```

A voice note then transcribes (whisper.cpp on the GPU) and parses (Ollama on the
GPU) entirely on-box — $0 marginal cost, nothing leaves the tower.

- **whisper.cpp** needs `ffmpeg` + a built binary on PATH and a GGML model. Build
  with CUDA to use the RTX 3070 Ti:
  ```sh
  git clone https://github.com/ggerganov/whisper.cpp && cd whisper.cpp
  cmake -B build -DGGML_CUDA=1 && cmake --build build -j --config Release
  ./models/download-ggml-model.sh medium
  ```
- **Ollama** GPU needs the NVIDIA Container Toolkit on the host (compose has the
  `deploy.resources` GPU block; drop it for CPU-only).
- **Self-hosted ORS** does routing only; geocoding (place names + route "via"
  descriptions) stays on the hosted ORS free tier via `ORS_GEOCODE_BASE_URL`
  (keep `ORS_API_KEY` set). Drop a Geofabrik `.osm.pbf` into
  `ors-docker/files/` (repo root) and set `REBUILD_GRAPHS: 'True'` on first run.

### Zero-setup fallback

If you'd rather not run local models: `AGON_TRANSCRIPTION_PROVIDER=openai`
(+ key) for STT, and `AGON_LLM_PROVIDER=claude-cli` (needs the `claude` CLI +
subscription) or `anthropic` (+ key) for parsing. All config, no code.
