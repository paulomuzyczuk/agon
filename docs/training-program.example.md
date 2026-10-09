# Training Program (example)

> **This is a template**, not real data. Copy this file to
> `docs/training-program.local.md` (gitignored — never committed) and replace
> every value below with your own program. See
> `docs/self-hosting/training-program.md` for the full walkthrough.
>
> **Important — this file is documentation, not config the app parses.** Unlike
> `config/athlete-profile.local.json` (read directly by the app), this Markdown
> file is a human-readable reference only. The program logic the app actually
> runs lives in `lib/training/trainingProgram.ts` (`BLOCK_1`/`BLOCK_2`/`BLOCK_3` — the
> "executable encoding" of the tables below). To run your own program, edit
> **both**: this file (so the plan is documented) and `lib/training/trainingProgram.ts`
> (so `scripts/seed-planned-sessions.ts` actually seeds it). This repo
> deliberately doesn't parse this Markdown into a generic program schema/DSL —
> every program's shape differs enough that a schema general enough to cover
> all of them would be its own large project; hand-editing one TypeScript file
> for your own program is the simpler, more honest trade-off for now.

---

## Parameters

| Field | Value | Source |
|---|---|---|
| Program start | **2026-01-05** (Mon) | `config/athlete-profile.local.json` `trainingStartDate` |
| Weeks per block | **8** | `config/athlete-profile.local.json` `programWeeksPerBlock` |
| Blocks | **3** | `config/athlete-profile.local.json` `programBlockCount` |
| Total length | 24 weeks | derived |
| Week alignment | Monday-aligned 7-day buckets | `lib/training/trainingBlocks.ts` |
| Max HR | 190 bpm | `config/athlete-profile.local.json` `hrMax` |
| Easy-run HR cap, Block 1 | **160 bpm** (example) | your program |

Blocks map to calendar weeks as:

| Block | Program weeks | Calendar (Mon start → Sun end) |
|---|---|---|
| 1 | 1–8 | 2026-01-05 → 2026-03-01 |
| 2 | 9–16 | 2026-03-02 → 2026-04-26 |
| 3 | 17–24 | 2026-04-27 → 2026-06-21 |

---

## How this file drives `planned_sessions`

Each block defines a **weekly template** (one row per session; a day may have
both a run and a lift) plus a **weekly-volume table** that scales run distances
across the block's weeks (including deload weeks). `lib/training/trainingProgram.ts`'s
`expandProgram()` expands `template × weeksPerBlock × start date` into one
`planned_sessions` row per session:

| planned_sessions column | comes from |
|---|---|
| `date` | program start + (week−1)×7 + weekday offset |
| `block`, `week` | `computeBlockWeek(date)` (`lib/training/trainingBlocks.ts`) |
| `session_kind` | `run` / `lift` / `rest` (template) |
| `description` | template label (e.g. "Easy run", "Lift A — full body") |
| `target_distance_km` | template distance × week's volume scaling (runs only) |
| `target_hr_cap` | template HR cap (easy runs); `NULL` for quality sessions & lifts |
| `target_session_type` | run: `easy`/`long`/`tempo`/`intervals`/`vo2max`; lift: whatever labels your split uses |
| `status` | `planned` |

`rest` days are seeded as rows too (so the calendar shows a deliberate rest,
and compliance can distinguish "planned rest" from "missed session").

---

## Block 1 — Weeks 1–8 (2026-01-05 → 2026-03-01)

**Theme:** Example — rebuild the base.
**Running:** 4 days/week, ~30 km/week.
**Lifting:** 3 days/week, full body (Sessions A / B / C).

### Weekly template

| Weekday | Kind | Description | Type | Base km | HR cap |
|---|---|---|---|---|---|
| Mon | rest | Rest | — | — | — |
| Tue | run | Easy run | easy | 7 | 160 |
| Tue | lift | Lift A — full body | A | — | — |
| Wed | run | Easy run | easy | 6 | 160 |
| Thu | lift | Lift B — full body | B | — | — |
| Fri | run | Easy run | easy | 7 | 160 |
| Sat | run | Long easy run | long | 10 | 160 |
| Sun | lift | Lift C — full body | C | — | — |

Base week = 30 km (7 + 6 + 7 + 10). Run distances scale to the weekly target below.

### Weekly volume (km)

| Week | 1 | 2 | 3 | 4 (deload) | 5 | 6 | 7 | 8 (deload) |
|---|---|---|---|---|---|---|---|---|
| Target | 28 | 30 | 31 | 26 | 30 | 31 | 31 | 27 |

---

## Block 2 — Weeks 9–16 (2026-03-02 → 2026-04-26)

**Theme:** Example — build intensity.
**Running:** 4–5 days/week.
**Lifting:** 3 days/week, Upper/Lower split.

### Weekly template

| Weekday | Kind | Description | Type | Base km | HR cap |
|---|---|---|---|---|---|
| Mon | rest | Rest | — | — | — |
| Tue | run | Tempo | intervals | 8 | — |
| Wed | run | Easy run | easy | 6 | 162 |
| Wed | lift | Lift — Upper | upper | — | — |
| Thu | run | Easy run | easy | 7 | 162 |
| Fri | lift | Lift — Lower | lower | — | — |
| Sat | run | Long easy run | long | 13 | 164 |
| Sun | run | Recovery easy run | easy | 5 | 155 |

Base week = 39 km. Distances scale to the weekly target below.

### Weekly volume (km)

| Week | 9 | 10 | 11 | 12 (deload) | 13 | 14 | 15 | 16 (deload) |
|---|---|---|---|---|---|---|---|---|
| Target | 36 | 38 | 40 | 32 | 38 | 39 | 40 | 34 |

---

## Block 3 — Weeks 17–24 (2026-04-27 → 2026-06-21)

**Theme:** Example — peak, then taper.
**Running:** 4–5 days/week. Long run 15–18 km.
**Lifting:** 3 days/week, Push/Pull/Legs split.

### Weekly template

| Weekday | Kind | Description | Type | Base km | HR cap |
|---|---|---|---|---|---|
| Mon | rest | Rest | — | — | — |
| Tue | run | Quality — VO2max / tempo | vo2max | 9 | — |
| Wed | run | Easy run | easy | 7 | 162 |
| Wed | lift | Lift — Push | push | — | — |
| Thu | lift | Lift — Pull | pull | — | — |
| Fri | run | Easy run | easy | 7 | 162 |
| Sat | run | Long run | long | 16 | 164 |
| Sun | lift | Lift — Legs | legs | — | — |

Base week = 39 km. Distances scale to the weekly target below.

### Weekly volume (km)

| Week | 17 | 18 | 19 | 20 (deload) | 21 | 22 | 23 | 24 (taper) |
|---|---|---|---|---|---|---|---|---|
| Target | 38 | 40 | 42 | 35 | 39 | 41 | 42 | 34 |

---

## Session library

Per-session detail rendered into the Google Calendar event descriptions
(`lib/training/sessionDetails.ts`). Keyed on session type — replace with your own
exercise selection.

### Lift sessions

**Block 1 — Full body**
- **A:** Back squat 3×5 · Bench press 3×5 · Barbell row 3×8
- **B:** Deadlift 3×5 · Overhead press 3×5 · Lat pulldown 3×10
- **C:** Front squat 3×6 · Incline DB press 3×8 · Pull-up 3×AMRAP

**Block 2 — Upper/Lower**
- **Upper:** Bench press 4×6–8 · Weighted pull-up 4×6–8 · Overhead press 4×8
- **Lower:** Back squat 4×6–8 · Romanian deadlift 4×8 · Leg curl 3×12

**Block 3 — Push/Pull/Legs**
- **Push:** Bench press 5×5 · Overhead press 4×6 · Dips 3×8
- **Pull:** Deadlift 4×4 · Weighted pull-up 4×6 · Barbell row 4×8
- **Legs:** Back squat 5×5 · Romanian deadlift 4×6 · Leg press 3×10

### Quality runs

- **Intervals (Block 2 tempo):** WU 2 km easy → 4×1000 m @ threshold, 200 m jog recovery → CD 2 km easy
- **VO2max (Block 3):** WU 2 km easy → 5×800 m @ 5K pace, 400 m jog recovery → CD 2 km easy

### Default calendar times

Set to your own time zone (`config/athlete-profile.local.json` `timeZone`).

- **Runs:** 12:00 start; duration estimated from distance × pace.
- **Lifts:** 22:00 start on weekdays, 19:30 on weekends, 60 min.
