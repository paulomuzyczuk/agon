# Agon Telegram Bot — Command Guide

Reference for the Telegram bot (`@paulo_agon_bot`). Authoritative source: the
parser in `services/telegram/commands.ts` and execution in
`services/telegram/handlers.ts`. Keep this in sync when those change.

## Two golden rules

1. **Text messages must start with `/`.** Free-form text (e.g. "recalculate my
   routes to 12 km") is _not_ understood — only **voice notes** get
   natural-language parsing. Any non-`/` text replies
   `⚠️ Not a command — messages must start with "/".`
2. **The bot only answers while it's running.** It responds when the local
   long-poll listener is up (`pnpm telegram:poll`, needs `pnpm db:up`) **or** a
   webhook is registered. If neither is running, messages go unanswered (and may
   be consumed silently). Run exactly one of poll **xor** webhook, never both.

## Logging commands

- **`/weight <kg>`** — log body weight for today. Range 0–400 kg. →
  `/weight 86.2`
- **`/bf <percent>`** — log body-fat % for today. Range 1–75 %. → `/bf 16.8`
- **`/sweat <pre> <post> <fluid-L>`** — sweat-rate weigh-in; derives L/h from
  today's run duration and recalibrates the sweat baseline. Needs a run logged
  today, else stored as-is. → `/sweat 86.4 85.8 0.5`
- **`/maintained <task> [on <bike>]`** — log a completed bike maintenance
  service (resets that task's km/day counter on that bike). Task is matched
  against `public.gear_maintenance_tasks` (v1: `chain-lube`, `chain-drivetrain`,
  `brake-pads`); free text like "chain lube" is normalized to `chain-lube`.
  With one active bike in `gear`, `on <bike>` can be left out. With several,
  name one: an exact name (case-insensitive) or any unique part of it
  ("grail" → "Canyon Grail"); otherwise the reply lists the active bikes.
  → `/maintained chain-lube`, `/maintained brake pads on grail`

## Query & sync

- **`/week`** — current block/week + this week's run & lift counts.
- **`/sync`** — incremental Google Health run pull → "Pulled N new run(s)."
  Token/network errors degrade to a friendly reply.
- **`/whoami`** — replies with this chat's id and the line to put in `.env.local`
  (`TELEGRAM_OWNER_CHAT_ID=…`) so Agon can message you. Use it instead of
  calling `getUpdates` by hand, which fights the running bot for the same
  updates.
- **`/undo`** — reverse the **last** logged entry (weight / bf / sweat /
  maintained / voice note). Never deletes a pre-existing run.

## Missed-stop nudges

After each sync, Agon looks for runs/rides whose recording kept going after
you stopped, e.g. left running at home. When it finds one it sends a message
like "🏠 Looks like the recording kept running after you got home — ride on
29 Sep: last 3:05 (64 m, 26 s moving)". The message has two tap-to-send
commands:

- **`/trim_<n>`** — cut that tail off, the same as the activity page's
  "Late stop" correction. Distance, moving time and the stream are trimmed,
  and the change survives re-syncs. `/trim <n>` works too.
- **`/keep_<n>`** — leave the activity as recorded. You won't be asked
  about it again.

`<n>` is the number in the message. The same suggestion shows on the
activity page with "Trim it" / "Keep as is".

## Route builder

```
/route <km> [through <A; B>] [finish <place>] [bike [road | gravel] [flat | hilly]] [today | tomorrow | YYYY-MM-DD]
```

- **Distance is required and comes first.** Max 100 km.
- **Day** defaults to **today**; also accepts `tomorrow` or an explicit ISO date
  (`2026-08-25`). Natural dates like "Saturday" do **not** parse.
- **`through`** — up to 6 waypoints, `;`-separated (so a name may contain a
  comma, e.g. `through Tiergarten, Berlin; Kreuzberg`). Also accepts ` and `.
- **`finish`** — finish at a place (also accepts "finishing near" /
  "ending near"). A finish away from the start makes the route **one-way**,
  and its calendar link says so ("Route 1 · 20.4 km one-way — …"). Name the
  Bezirk or postcode for an address that exists twice in Berlin
  (`finish Schloßstraße 1, Steglitz`).
- An area in `through` (a forest, park, lake — e.g. `through Grunewald`) keeps
  the route's extra distance **inside** that area, not just touching its edge.
- **Mode** — any of `bike` / `biking` / `cycle` / `cycling` / `ride` / `riding`
  / `mtb` anywhere in the text switches to a cycling loop (Google Maps link
  opens in bicycling directions). Default is a running loop (foot-walking) if
  no mode keyword is present.
- **Bike preferences** (bike mode only) — mapped onto what OpenRouteService
  actually offers:
  - **Surface** picks the ORS cycling profile: `road` / `paved` / `tarmac` /
    `asphalt` → `cycling-road` (paved roads); `gravel` / `mtb` / `offroad` /
    `unpaved` → `cycling-mountain` (accepts tracks and trails). Neither →
    `cycling-regular`. On a running route these words are just text (a place
    may be called "… Road").
  - **Hills** set ORS's gradient weighting: `flat` / `no hills` /
    `avoid hills` → prefer gentle gradients; `hilly` / `hills` / `climb(s)` /
    `climbing` → prefer climbs. A hill word on a running route is an error
    (ORS has no gradient option for running).
  - No bike-lane option: ORS has none beyond the profile itself, which already
    prefers cycleways. The OSRM fallback (used once the ORS quota runs out)
    has one bike mode and ignores both preferences.
  - The reply echoes what was applied, e.g. `🚴 Ad hoc route (road, flat)`.
- Word order is flexible — `through`, `finish`, the mode and preference
  keywords, and the day token may appear in any order.

Behaviour: builds **3 directionally-diverse routes** (loops, or one-way/through
routes stretched to the distance by a detour) for the chosen day's **run**
session, attaches them under the **🧭 Ad hoc routes** section of the calendar
event (**🚴** instead of 🧭 in the reply for a `bike` request), and patches the
event immediately (falls back to "appears next sync" if the calendar push
fails). If **no** run is planned that day, it creates a lightweight ad-hoc run
session so there's an event to attach to — this still happens for `bike`
requests too (no separate ride-session concept yet). There's no attaching a route to a
lift or rest day.

The ad-hoc section is kept independent from the auto "🗺️ Suggested routes from
home" section, so ad-hoc routes survive future `pnpm gcal:sync` runs.

Examples:

- `/route 12` — three ~12 km loops from home, today
- `/route 12 tomorrow`
- `/route 25 through Tiergarten finish Alexanderplatz tomorrow`
- `/route 40 bike finish Grunewald` — a one-way cycling route instead of running
- `/route 20 bike through Grunewald finish Schloßstraße 1, Steglitz`
- `/route 60 road bike flat` — a paved, flat 60 km loop
- `/route 45 gravel ride through Grunewald hilly`

## Voice notes (the only free-form input)

Send a voice note (no `/` needed). It is transcribed locally (Whisper) →
auto-classified as **lift / run / body** → parsed into structured data → saved,
with a summary reply. Use these for:

- **Lift sessions** — exercises, sets, reps, RPE
- **Run notes** — fueling, perceived effort, pain/discomfort, general notes
- **Body notes** — weight / body-fat mentions

A voice note is the only input that requires the transcription + LLM stack to be
configured; all text commands work without it.
