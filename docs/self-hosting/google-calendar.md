# Google Calendar Setup

Pushes your `planned_sessions` (from `lib/training/trainingProgram.ts` — see
[`training-program.md`](training-program.md)) to two dedicated Google
Calendars: "Agon Training" and an as-yet-dormant "Agon Meals", so your
program shows up alongside the rest of your calendar with per-session
detail (sets × reps for lifts, interval structure for quality runs) and,
if you've set up route suggestions, clickable route links on run events.

## 1. Reuse or create an OAuth client

You can reuse the same Google Cloud project + OAuth client from
[`google-health.md`](google-health.md) if you already set that up — just add
one more scope and redirect URI to it. Otherwise, follow that guide's step 1
first, creating a project for this integration alone.

1. **APIs & Services → Library** → enable the **Google Calendar API**.
2. On the OAuth consent screen, add the scope
   `https://www.googleapis.com/auth/calendar`.
3. On the OAuth client, add an Authorized redirect URI matching
   `GOOGLE_CALENDAR_REDIRECT_URI`.
4. Set in `.env.local`:
   ```sh
   GOOGLE_CALENDAR_CLIENT_ID=...
   GOOGLE_CALENDAR_CLIENT_SECRET=...
   GOOGLE_CALENDAR_REDIRECT_URI=http://localhost:3000/google-calendar/callback
   ```
   (You may reuse the Health client id/secret directly if that OAuth client
   also lists this redirect URI + scope.)

## 2. Authorize + sync

```sh
pnpm gcal:auth      # one-time CLI OAuth flow, same "copy the code from the URL" pattern as gh:auth
pnpm gcal:sync       # idempotent — inserts/patches events on gcal_event_id, never duplicates
```

`gcal:sync` is run by hand — re-run it after `pnpm seed:planned` or any
program change to push the delta. The weekly job below keeps the *past* in
line with what you actually did.

## Weekly reconciliation with recorded data (MZY-417)

Recorded data is the source of truth for sessions that have already happened;
the calendar follows it. Every Monday 06:00 a timer runs
`pnpm gcal:weekly-reconcile --write`, which looks back 14 days:

1. **Reads your calendar edits back** (a moved or retitled event). Moving an
   event is how you say which day a session happened, so that date is what the
   data is attributed to.
2. **Attributes each run/ride to the session on that calendar date** — never by
   comparing clock times. Two activities on one day go to the sessions by closest
   distance; a commute's two legs by morning / afternoon.
3. **Marks the event.** Done: `✅` in the title, the actual distance, the actual
   start time and duration, and a note with the planned distance and the source.
   Nothing recorded on its day: `❌ Not done` — the event stays, history is not
   deleted. Lifts and sessions from today on are left alone (no lift data yet;
   a session still to do is not a missed one).
4. **Pushes the result** to Google Calendar and sends a one-line summary to
   Telegram.

```sh
pnpm gcal:weekly-reconcile                 # dry run: prints what would change
pnpm gcal:weekly-reconcile --write         # apply, sync, notify
pnpm gcal:weekly-reconcile --days=28       # look back further
```

It is idempotent. Install the timer from `deploy/agon-calendar-reconcile.*`
(system-wide) or `deploy/user/agon-calendar-reconcile.*` (no sudo). After
upgrading to this version run `pnpm migrate`, then `pnpm gcal:sync` once so every
event has a snapshot of what Agon pushed — reconcile only treats a difference
from that snapshot as your edit, so a changed default slot never looks like one.

## Route suggestions (optional)

If you've set up the OpenRouteService route builder
(`ORS_API_KEY` in `.env.example`, or the `local-ai` profile's self-hosted
ORS), `gcal:sync` automatically attaches 3 diverse suggested routes to each
run event with a distance target, as clickable Google Maps links. Also set
`AGON_HOME_LAT`/`AGON_HOME_LNG` (your home address, geocoded once — this is
PII, keep it in `.env.local` only) so route generation has a start point.
