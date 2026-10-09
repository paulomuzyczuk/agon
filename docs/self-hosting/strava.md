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
