# Database backups and restore

All of Agon's data (every meal, health log, lifting session, and live
recording you've entered) lives in one Postgres database, in one Docker
volume (`agon_agon_pgdata`). Ingested data can be re-pulled from Google
Health or Strava. What you typed in can't. On 2026-09-08 that volume was
deleted and every athlete-authored table was lost, because there was no
backup (MZY-113). This page makes sure that can't happen twice.

## What runs

`pnpm db:backup` (`scripts/backup-db.ts`):

1. Runs `pg_dump -Fc` inside the Postgres container (`docker exec`, never
   `docker compose`, so it can't resolve to the wrong compose project).
2. Writes to `<dir>/agon-<UTC timestamp>.dump.partial`, verifies the archive
   with `pg_restore -l`, and only then renames it to `.dump`.
3. Rotates old dumps. The newest `AGON_BACKUP_KEEP_DAILY` (default 14) are
   kept, plus the newest dump of each of the newest `AGON_BACKUP_KEEP_WEEKLY`
   (default 8) ISO weeks. Rotation only runs after a verified dump, and never
   touches files that don't match `agon-<timestamp>.dump`, so hand-taken
   dumps such as `agon-pre-<something>-….dump` stay until you remove them.
4. On any failure it exits non-zero and messages Telegram (if
   `TELEGRAM_OWNER_CHAT_ID` is set). Success is silent.

| Env var | Default | |
|---|---|---|
| `AGON_BACKUP_DIR` | `./backups` (gitignored) | Put this on a **different disk**, ideally one synced off the machine. |
| `AGON_BACKUP_KEEP_DAILY` | `14` | |
| `AGON_BACKUP_KEEP_WEEKLY` | `8` | |
| `AGON_DB_CONTAINER` | `agon-db-1` | |
| `AGON_DOCKER_HOST` | unset (the CLI's current context) | Pins the Docker engine, e.g. `unix:///var/run/docker.sock`. Needed when a scheduler's `docker` resolves to Docker Desktop's empty engine (`no such container`). |

## Schedule it

- **Linux, normal user (systemd, no sudo):** `deploy/user/agon-backup.service`
  and `deploy/user/agon-backup.timer`, daily at 03:30. Install steps are in the
  service file's header. Run `loginctl enable-linger "$USER"` once, or user
  timers stop when you log out. Check the installed unit with
  `systemd-analyze --user verify`, then run it once by hand and read
  `journalctl --user -u agon-backup`.
- **Linux tower (system-wide systemd):** `deploy/agon-backup.service` and
  `deploy/agon-backup.timer`, daily at 03:30; they assume `User=agon` and
  `/opt/agon`. Install steps are in the service file's header.
- **macOS dev machine (launchd):** `deploy/com.agon.backup.plist`, daily at
  03:30 and caught up on wake. Install steps are in the plist's header comment.
  It logs to `backups/backup.log`.

## Prove it restores: the drill

```sh
pnpm db:restore-drill
```

The drill takes a fresh dump through the same code path, restores it into a
scratch database `agon_restore_test` in the same container, and compares
exact `count(*)` for every table in every non-system schema. A table written
to while the dump ran is reported as INCONCLUSIVE, not FAIL. The drill then
drops the scratch database. It never writes to the live database.

Run it after any migration, and every month or so. Last run (2026-09-24):
`69 tables, 3567 rows matched, 0 failed, 0 inconclusive`.

## Restoring for real

Only do this when the live data is actually gone or corrupt. **Take a dump of
whatever is there now first** (`pnpm db:backup`), even if it looks broken.

```sh
# 1. Stop everything that writes (app, bot). Leave the db container up.
docker compose -p agon --env-file .env.local stop app bot

# 2. Pick the dump.
ls -lt backups/*.dump | head

# 3. Restore into a NEW database first and check it.
docker exec agon-db-1 createdb -U agon agon_restored
docker exec -i agon-db-1 pg_restore -U agon -d agon_restored --exit-on-error \
  < backups/agon-YYYYMMDDTHHMMSSZ.dump
docker exec agon-db-1 psql -U agon -d agon_restored -c 'select count(*) from meal_logs'

# 4. Swap it in. Rename, don't drop: the old DB stays until you're sure.
docker exec agon-db-1 psql -U agon -d postgres -c \
  'ALTER DATABASE agon RENAME TO agon_broken_YYYYMMDD'
docker exec agon-db-1 psql -U agon -d postgres -c \
  'ALTER DATABASE agon_restored RENAME TO agon'

# 5. Bring writers back, then run pending migrations (the dump may predate some).
docker compose -p agon --env-file .env.local start app bot
pnpm migrate
```

If the whole volume is gone (the 2026-09-08 case), run `pnpm db:up` first to
get an empty cluster with the `agon` role, then do step 3 with
`-d agon` directly. The warehouse roles (`mcp_reader`, the dbt writer) are
cluster-level and not in a `pg_dump`. Recreate them the way a fresh install
does ([README](README.md)) before restoring, or the grants in the dump fail
under `--exit-on-error`. In that case drop the flag and read the warnings.

## Recovering from a device

Every device where you've signed into the PWA keeps a **full copy** of
everything you've entered: meals, health logs, lab values, routines and
session adjustments (MZY-207). The first sync downloads all of it, not just
recent entries. If the server loses that data and no dump has it (or the dump
is older), any one of your devices can put it back.

1. On the device, in the sync line at the top of any page, tap **Export**. It
   downloads `agon-device-export-<date>.json`. If you can, export from the
   device you used most recently.
2. Copy the file to the server, take a dump of whatever is there now
   (`pnpm db:backup`), and do a dry run:

   ```sh
   pnpm db:restore-device-export ~/agon-device-export-2026-09-25.json
   ```

   This lists, per table, how many rows the export has and how many are
   missing on the server.
3. Write it:

   ```sh
   pnpm db:restore-device-export ~/agon-device-export-2026-09-25.json --apply
   ```

The restore goes through the same merge as normal syncing
(`services/sync/restore.ts`). Every field keeps its original timestamp, so
anything the server already has that is **newer** wins, nothing is ever
deleted, and running it twice changes nothing. That makes it safe to run
against a live server and safe to repeat with exports from several devices.

What a device does **not** hold: ingested data (runs, streams, wellness,
weather), reference data (foods, meal templates, goals, the training
program), and credentials. Those come back from their sources or from a
`pg_dump`. The device copy is a second line of defence, not a replacement for
the daily backup above.
