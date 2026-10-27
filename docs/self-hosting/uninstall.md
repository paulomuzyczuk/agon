# Uninstalling Agon

Agon puts things in four places: Docker (containers, images, volumes), files in
your clone, schedulers on the host, and accounts at other services. Remove each
deliberately. **Your data is only in the `agon_pgdata` volume and your backups;
once both are gone it cannot be recovered.** Take a last `pnpm db:backup` and
copy it somewhere safe first if you might want it.

## 1. Stop and remove the containers

```sh
# Stops and removes containers and networks. Keeps your database volume.
docker compose --env-file .env.local down
```

Pass the same `-f` overlay files and `--profile` flags you started with, or the
services from them keep running.

To also delete the volumes (**this deletes your database**):

```sh
docker compose --env-file .env.local down -v
```

`down -v` removes only the named volumes this Compose project created
(`agon_pgdata`, `ollama-models`). Check with `docker volume ls` first.

> **Do not delete a shared Ollama.** If you pointed Agon at an Ollama that was
> already on the machine, or bind-mounted the host Ollama's model directory into
> the container, those models are not Agon's. Never remove that directory or
> `~/.ollama` as part of cleaning up Agon, and do not stop a host Ollama service
> that other projects use. Only the `ollama-models` volume is Agon's own.

Optionally remove the images: `docker image ls | grep agon`, then `docker image rm <id>`.

## 2. Remove schedulers on the host

Whichever you installed:

```sh
systemctl --user disable --now agon-backup.timer agon-calendar-reconcile.timer   # user units (deploy/user/)
sudo systemctl disable --now agon-backup.timer agon-bot agon-freshness.timer agon-gear-maintenance.timer agon-calendar-reconcile.timer
launchctl bootout gui/$(id -u)/com.agon.backup                    # macOS
```

then delete the unit files you copied (`~/.config/systemd/user/agon-*`,
`/etc/systemd/system/agon-*`, `~/Library/LaunchAgents/com.agon.backup.plist`) and run
`systemctl daemon-reload`. If you enabled
`loginctl enable-linger` only for Agon, `loginctl disable-linger "$USER"`
reverses it.

## 3. Delete your files

In the clone: `.env.local`, `config/*.local.json`, `docs/training-program.local.md`,
`data/` (the login-secret hash), `backups/` (or wherever `AGON_BACKUP_DIR` points;
this is your only copy of the data once the volume is gone), and the knowledge
vault if you made one for Agon. Then delete the clone.

## 4. Clean up outside this machine

- **Telegram:** delete the bot with `/deletebot` in @BotFather.
- **Strava:** revoke Agon at strava.com/settings/apps and delete your API app at
  strava.com/settings/api.
- **Google (Health, Calendar):** remove the access at
  myaccount.google.com/permissions, delete the OAuth client in your Google Cloud
  project (or the project), and delete the **Agon Training** and **Agon Meals**
  calendars in Google Calendar.
- **Tailscale:** remove any `tailscale serve` configuration for Agon and, if the
  machine was only joined for it, remove the machine from your tailnet.
- **Android app:** uninstall the sideloaded APK.
