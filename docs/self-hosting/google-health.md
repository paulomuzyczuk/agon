# Google Health Setup

Google Health is Agon's primary **live run source** (run GPS, HR, wellness —
resting HR, HRV, sleep, active minutes) if you record on a Fitbit/phone via
Google Health, replacing the now-paywalled Strava API.

## 1. Create a Google Cloud project + OAuth client

1. [console.cloud.google.com](https://console.cloud.google.com) → create a
   project (e.g. "agon").
2. **APIs & Services → Library** → enable the **Health API**.
3. **APIs & Services → OAuth consent screen** → User type "External",
   publishing status **"Testing"**, add yourself as a Test user. (Testing
   mode is fine indefinitely for single-user personal use — no Google
   verification review needed, which is exactly why this integration is
   per-self-hoster rather than something this project could ship a shared
   client for. Google restricts a Testing-mode refresh token's lifetime —
   see step 4's re-auth note.)
4. **Credentials → Create Credentials → OAuth client ID** → type "Web
   application"; add an Authorized redirect URI matching
   `GOOGLE_HEALTH_REDIRECT_URI` (default
   `http://localhost:3000/google-health/callback` — nothing actually needs
   to be listening there, see step 3 below).
5. Copy the client id/secret into `.env.local`:
   ```sh
   GOOGLE_HEALTH_CLIENT_ID=...
   GOOGLE_HEALTH_CLIENT_SECRET=...
   GOOGLE_HEALTH_REDIRECT_URI=http://localhost:3000/google-health/callback
   ```

## 2. Authorize (one-time, CLI-driven, no server needed)

```sh
pnpm gh:auth
```

This prints a consent URL. Open it, approve, and Google redirects your
browser to `GOOGLE_HEALTH_REDIRECT_URI` with `?code=...` in the address bar —
the page itself won't load (nothing is listening there), which is expected;
copy the `code` value out of the URL, then:

```sh
pnpm gh:auth <code>
```

This exchanges the code and stores a refresh token
(`google_health_oauth_tokens` table) — sync is automatic and headless from
then on. Scopes requested: `googlehealth.activity_and_fitness.readonly`
(runs), `googlehealth.location.readonly` (GPS route), and
`googlehealth.health_metrics_and_measurements.readonly` (HR/wellness).

## 3. Sync

```sh
pnpm gh:sync          # runs, incremental
pnpm gh:wellness       # resting HR / HRV / sleep / active minutes / weight (date-range backfill)
```

Or via Telegram: `/sync` (if the bot is running — see
[`telegram.md`](telegram.md)).

## Re-consent

A Testing-mode Google OAuth app's refresh token can expire; if a sync starts
failing with an auth error, just re-run `pnpm gh:auth` to get a fresh one —
no data is lost, this only affects the token.
