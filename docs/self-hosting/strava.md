# Strava Setup (historical backfill / one-time enrichment)

Strava is **not** Agon's live run source — its API has required a paid
Strava subscription per developer since 2026-06-30, which defeats the point
of a free, self-hosted tool (see `CLAUDE.md`'s "Run Ingestion Pivot").
[`google-health.md`](google-health.md) covers the live path instead.

Strava is still useful for two one-time things: pulling your **historical**
activity data (before you started using Agon), and, during any window you
happen to have Strava premium, enriching Google-Health-sourced runs with
richer GPS/elevation/HR streams Google Health doesn't expose for
GPS-chip-less devices.

## 1. Create a Strava API app

1. [strava.com/settings/api](https://www.strava.com/settings/api) → create
   an app. Set the "Authorization Callback Domain" to `localhost`.
2. Set in `.env.local`:
   ```sh
   STRAVA_CLIENT_ID=...
   STRAVA_CLIENT_SECRET=...
   STRAVA_REDIRECT_URI=http://localhost:3000/strava/callback
   ```

## 2. Authorize

```sh
pnpm strava:auth
```

Same "open the URL, copy the `code` from the redirect, paste it back"
pattern as [`google-health.md`](google-health.md)'s step 2.

## 3. Backfill

```sh
pnpm strava:backfill               # historical activities → runs + full run_streams (HR/pace/altitude/GPS; rate-limit-aware, resumable)
pnpm strava:backfill --no-streams  # summaries only (much lighter on the rate limit)
```

This is a one-time pull, free-tier-friendly (paced to stay under Strava's
free rate limits). It does not need to run again unless you want to
backfill more history later.

## 4. Enrichment (needs Strava premium for that window)

If you have Strava premium active (even temporarily — a gift month, a free
trial), `pnpm strava:enrich` matches existing Google-Health runs to Strava
activities by time overlap and fills in GPS/elevation/max-HR + attaches a
richer stream, without creating duplicate runs:

```sh
pnpm strava:enrich              # dry run — prints what would change
pnpm strava:enrich --write      # apply
```

Not required — Agon works fully without Strava premium; this only improves
data richness for runs recorded on GPS-chip-less devices (e.g. a Fitbit
without connected-GPS).

## Which source wins when two have the same run

When the same run arrives from several sources, one row is kept. Priority is
**Agon's own recorder and manual entries > Strava (while its API is enabled for
you) or a file export > Google Health**. If a Strava run arrives for a run you
already have from Google Health, the Google Health row is **replaced**: the
Strava run is written, the old row's streams, gear, fueling and notes are moved
onto it, and the old row is deleted. That is expected, not duplication. If the
old and new start more than 5 minutes apart, neither is deleted. After a
supersession, rerun the derived backfills (relative effort, best efforts,
training load, race predictions) with `--write`. Details:
`.claude/rules/run-ingestion.md`.

## What it looks like without a subscription

The Strava API now needs an active paid Strava subscription on the developer
account. Without it the sync stops with an error of the form
`strava: GET /… failed (<HTTP status> …)`; a `429` is Strava's rate limit
(wait and rerun, the backfill resumes), not the paywall. Agon works fully
without Strava; use [`google-health.md`](google-health.md) for the live path.

## Runs and rides are separate commands

- `pnpm strava:sync` pulls new **runs** since the newest Strava run in the
  database (deprecated as a live source, kept for anyone with API access).
- `pnpm strava:sync-rides` does the same for **rides**
  (`--no-streams`, `--no-gear` to go lighter). Needs `pnpm strava:auth` first.

Neither command touches the other's activities, so run both if you want both.
