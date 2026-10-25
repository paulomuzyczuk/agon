# Agon — fresh setup on the Linux tower

> **This is the athlete's own hardware-migration runbook** (existing Mac →
> new tower, dump & restore), not a fresh-install guide for a new self-hoster.
> If you're standing up your **own** instance of Agon for the first time, use
> **[`docs/self-hosting/README.md`](../docs/self-hosting/README.md)** instead —
> it covers `pnpm bootstrap`, the Docker image, and per-integration OAuth setup
> from a clean checkout with no prior database to migrate.

A top-to-bottom runbook for standing Agon up on the self-hosted Linux tower
(CLAUDE.md → Infrastructure). Follow the steps in order. Commands assume
Debian/Ubuntu (`apt`); adapt to your distro. **Migration path: dump & restore** —
your existing database (all runs/routes/planned sessions **and the Google OAuth
tokens**) is copied over, so there is **no re-consent** on the tower.

> Doing this with Claude Code on the tower? It auto-reads `CLAUDE.md`; point it at
> **this file** and it can follow the checklist. Have your secrets (`.env.local`)
> and the DB dump ready first (steps 0–2).

---

## 0. Prerequisites (install on the tower)

```sh
sudo apt update
sudo apt install -y git curl build-essential cmake ffmpeg

# Node 22 LTS (matches .nvmrc) + pnpm via corepack
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo corepack enable            # provides pnpm

# Docker Engine + compose plugin (for Postgres, Ollama, ORS)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER" # log out/in so `docker` works without sudo
```

**GPU (optional, for local models — RTX 3070 Ti):** install the NVIDIA driver and
the **NVIDIA Container Toolkit** so Docker can use the GPU:
<https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html>.
Skip if you'll use the hosted fallback (step 5B).

---

## 1. Clone + install

```sh
sudo mkdir -p /opt/agon && sudo chown "$USER" /opt/agon
git clone <your-agon-repo-url> /opt/agon
cd /opt/agon
pnpm install
```

---

## 2. Secrets — `.env.local`

`.env.local` is gitignored, so it does **not** come with the clone. Copy it from
your Mac (a USB pendrive is perfect — keeps secrets off the network):

```sh
cp /media/usb/.env.local /opt/agon/.env.local
chmod 600 /opt/agon/.env.local          # lock it down
```

Then edit these lines for the Linux tower (see `.env.example` for the full list):

```sh
# Local models (step 5A). Omit / use hosted values for the fallback (5B).
AGON_LLM_PROVIDER=ollama
AGON_LLM_MODEL=qwen2.5:7b
AGON_LLM_BASE_URL=http://localhost:11434
AGON_TRANSCRIPTION_PROVIDER=whisper-cpp
AGON_TRANSCRIPTION_MODEL=/opt/whisper.cpp/models/ggml-medium.bin
AGON_TRANSCRIPTION_WHISPER_BIN=whisper-cli
# Self-hosted routing (optional); geocoding stays hosted (self-hosted ORS has no Pelias)
ORS_BASE_URL=http://localhost:8080/ors
ORS_GEOCODE_BASE_URL=https://api.openrouteservice.org
```

Everything else transfers as-is. `DATABASE_URL` stays
`postgresql://agon:agon@127.0.0.1:5432/agon` (the local Docker Postgres runs on the
tower too). OAuth `*_REDIRECT_URI`s stay `localhost` — fine, since dump & restore
means you won't run the consent flow again.

> ⚠️ Securely wipe the pendrive afterward (`shred`/reformat) — it held secrets.

---

## 3. Database — dump & restore (carries data **and** OAuth tokens)

**On the Mac** (the `db` service in `docker-compose.yml`):

```sh
# schema + data (custom format)
docker compose --env-file .env.local exec db pg_dump -U agon -Fc agon > agon.dump
# OPTIONAL: cluster-global roles (pg_dump omits them — see note below)
docker compose --env-file .env.local exec db pg_dumpall -U agon --roles-only > agon-roles.sql
```

Move `agon.dump` (and optionally `agon-roles.sql`) to the tower via the pendrive.

**On the tower:**

```sh
cd /opt/agon
pnpm db:up                              # start the local Postgres (empty agon db)
# wait ~5s for it to be healthy, then restore:
docker compose --env-file .env.local exec -T db pg_restore -U agon -d agon --clean --if-exists --no-owner < agon.dump
pnpm migrate                            # applies any migrations newer than the dump (idempotent)
```

**Roles caveat (only matters for the MCP server / analytics, NOT the bot):**
`pg_dump` does **not** include cluster-global roles (`mcp_reader`, `dbt_writer`,
`lightdash_reader`). After restore, `schema_migrations` marks their
creation-migrations as already applied, so `pnpm migrate` won't recreate them on
the new cluster. The **bot doesn't need them** (it uses the `agon` role from
`docker-compose`). If you use the MCP server or analytics, restore the roles:

```sh
# either: bring them across from the Mac dump (ignore "role agon already exists")
docker compose --env-file .env.local exec -T db psql -U agon -d postgres < agon-roles.sql
# or: re-run just those migration files by hand, e.g.
docker compose --env-file .env.local exec -T db psql -U agon -d agon < migrations/20260730000000_mcp_reader_role.sql
```

---

## 4. Verify the core app

```sh
pnpm test                               # unit suite — should be all green
# confirm your data came across:
docker compose --env-file .env.local exec db psql -U agon -d agon -c "SELECT count(*) FROM runs;"
docker compose --env-file .env.local exec db psql -U agon -d agon -c "SELECT count(*) FROM google_calendar_oauth_tokens;"  # 1 = tokens carried over
```

---

## 5. AI providers — pick ONE path

### 5A. Fully local, free, open-source (recommended for the tower)

```sh
# Ollama + self-hosted OpenRouteService (root docker-compose.yml's `local-ai` and
# `local-routing` profiles — merged from the former deploy/docker-compose.selfhost.yml)
docker compose --env-file .env.local --profile local-ai up -d ollama
docker compose --env-file .env.local --profile local-routing up -d ors-app
docker compose --env-file .env.local exec ollama ollama pull qwen2.5:7b     # or llama3.1:8b

# whisper.cpp (build with CUDA to use the GPU)
git clone https://github.com/ggerganov/whisper.cpp /opt/whisper.cpp
cd /opt/whisper.cpp
cmake -B build -DGGML_CUDA=1 && cmake --build build -j --config Release
sudo ln -sf /opt/whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper-cli
./models/download-ggml-model.sh medium                 # → models/ggml-medium.bin
cd /opt/agon

# Self-hosted ORS routing: drop a Geofabrik extract + build the graph once
mkdir -p ors-docker/files
curl -L -o ors-docker/files/region.osm.pbf \
  https://download.geofabrik.de/europe/germany/berlin-latest.osm.pbf
# set REBUILD_GRAPHS: 'True' in docker-compose.yml for the first run, then
# `docker compose --env-file .env.local --profile local-routing up -d ors-app` and wait for the graph
# build (watch: docker compose --env-file .env.local logs -f ors-app), then set it back to 'False'.
```

Smoke-test routing + geocoding end to end:

```sh
pnpm route:suggest --km 5               # should print 3 routes with place labels
```

### 5B. Hosted fallback (zero local-model setup)

In `.env.local`: `AGON_TRANSCRIPTION_PROVIDER=openai` (+ `AGON_TRANSCRIPTION_API_KEY`)
and `AGON_LLM_PROVIDER=anthropic` (+ `AGON_LLM_API_KEY`), and leave `ORS_BASE_URL`
unset (hosted routing). All config, no code.

---

## 6. Run the Telegram bot as an always-on service

```sh
sudo cp deploy/agon-bot.service /etc/systemd/system/agon-bot.service
sudoedit /etc/systemd/system/agon-bot.service    # set User=, WorkingDirectory=/opt/agon, pnpm path
sudo systemctl daemon-reload
sudo systemctl enable --now agon-bot
systemctl status agon-bot                         # active (running)?
journalctl -u agon-bot -f                         # tail logs; send the bot a text command to test
```

`Restart=always` + `WantedBy=multi-user.target` = survives crashes and reboots.
Long-polling dials out to Telegram, so **no public URL / port-forward / TLS**.
Keep the tower awake (disable sleep). Run **only one** poll listener; never poll +
webhook at once. See `deploy/README.md` for details.

---

## 7. Scheduled syncs (optional, later)

Add `cron` jobs or `systemd` timers for the periodic pulls, e.g. daily:

```sh
cd /opt/agon && pnpm gh:sync        # new runs from Google Health
cd /opt/agon && pnpm gcal:sync      # push planned sessions + route links
cd /opt/agon && pnpm gh:wellness --since=$(date -d '2 days ago' +%F)
```

---

## Troubleshooting

- **`/sync` or calendar fails with "no stored tokens"** → the DB restore didn't
  carry the OAuth tables. Re-check step 3 (the `oauth_tokens` counts), or re-auth
  with `pnpm gh:auth` / `pnpm gcal:auth`.
- **`route:suggest` errors on geocoding** → `ORS_GEOCODE_BASE_URL` must point at the
  hosted API (`ORS_API_KEY` set); a self-hosted ORS has no geocoder.
- **Ollama/whisper "connection refused"** → is the container up
  (`docker ps`) / is `whisper-cli` on PATH? Fall back to 5B to unblock.
- **Bot not responding** → `journalctl -u agon-bot -e`; confirm exactly one poll
  listener and that `TELEGRAM_BOT_TOKEN` is set.
