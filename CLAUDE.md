# Agon — Personal Performance Tracking Platform

> "Your body, logged. Your progress, earned."

Agon is a personal health data platform for hybrid athletes. It ingests training,
nutrition, and biometric data from multiple sources, enriches it with qualitative
context captured via voice, and surfaces it through a unified dashboard and a
Claude-powered consulting layer.

This file carries only what every session needs regardless of what it's
touching. Domain-specific detail lives in `.claude/rules/*.md` — loaded
automatically only when a session touches those code paths (`nutrition.md`,
`general-health.md`, `run-ingestion.md`, `premium-parity.md`,
`live-recording.md`, `self-hosting.md`, `analytics.md`, `voice-capture.md`).
The exception is `engineering.md` (design, testing, security and git rules),
which loads in every session; the rules a tool can check run in CI instead
(`.github/workflows/check.yml`; decision:
`docs/decisions/0001-engineering-rules-baseline.md`). Shipped-feature history
and open work: tracked in Linear (below), not in this repo.

---

## Athlete Profile

A single hybrid athlete on a 3-block running+lifting program. Exact
numeric anchors (dates, HR, weight, sweat rate) are config, not hardcoded —
`config/athlete-profile.local.json` (`lib/athleteProfile.ts`, gitignored;
`.example.json` is the template). Program document:
`docs/training-program.local.md` (human-readable; `lib/training/trainingProgram.ts`
is what the app reads) — see `docs/self-hosting/training-program.md`.

---

## Architecture

```
Google Health API (live) ─┐
Strava (historical) ───────┤
Cronometer (CSV, backlogged) ┤──→ Postgres ──→ dbt marts ──→ Lightdash
Telegram Bot (voice+text) ──┘        ├──→ PWA dashboard (Next.js)
                                      └──→ MCP server (consulting layer)
```

Self-hosted Linux tower (shared with the athlete's Hephaistos
project) — always-on, zero cost, GDPR by construction. Postgres = Supabase
Cloud in prod / local Docker in dev, plain `DATABASE_URL`. PWA = Next.js
App Router, mobile-first. Voice capture: see
`.claude/rules/voice-capture.md`. Analytics = dbt + Lightdash. MCP server
(`services/mcp/`, `pnpm mcp`) is read-only (`READ ONLY` transactions +
least-privilege `mcp_reader` role): `describe_schema`/`run_sql` +
curated tools (`recent_runs`, `training_summary`, `nutrition_summary`,
`health_summary`, `data_freshness`, `athlete_profile`, ...) +
`suggest_routes` (generates only, never saves) + vault tools. Full
decision history (the Strava→Google-Health pivot, self-hosting packaging,
dbt/analytics decisions): tracked in Linear (`agon` project). Deploy detail:
`docs/self-hosting/` (fresh install), `deploy/SETUP.md` (hardware
migration), `.claude/rules/self-hosting.md` / `.claude/rules/analytics.md`
(code-level design). Not yet stood up on the actual tower — see Linear
issue MZY-24.

---

## Engineering Benchmark — sihha

`~/projects/sihha` (personal caretaking platform, CRUD-focused Next.js PWA)
is the structural benchmark. Mirror unless Agon has a documented reason to
deviate:

- **Stack**: TypeScript strict, Next.js App Router + React, Postgres,
  `zod` at every API boundary, `pino` structured logging, `pnpm`, Jest unit
  + separate integration suite, Prettier (not yet enforced: 107 files fail
  `format:check`; no pre-commit hook yet — see decision 0001).
- **Directory split**: `app/api/` + `services/` + migrations = backend;
  `app/<pages>/` + `components/` = frontend; `lib/` = shared types/
  constants; `scripts/` = tsx admin/seed scripts; `analytics/` = dbt.
- **Migrations are the single source of truth** — every schema change is a
  file applied with the CLI, never ad-hoc DDL. Destructive changes use
  expand → verify → contract.
- **Guard-rails**: seed-script production guard (refuse non-loopback DB
  URLs unless overridden), `.env.local` always points dev at local
  Postgres, file-size budgets in CI (`.github/workflows/check.yml`, since
  2026-10-08), least-privilege warehouse roles.

Agon does NOT inherit sihha's multi-user/RBAC/institution layer, FHIR
facade, or alerting ledger — single-user; auth stays minimal until an
open-source multi-user story is actually needed.

---

## Knowledge Vault Policy & Model Portability

The consulting layer reads a Karpathy-style LLM wiki vault (sports science).
**The vault is private — copyrighted source material — and must never
enter this repo or the public repo.** `vault_path` from local config/env
only (`AGON_VAULT_PATH`); `vault.example/` ships the sample page format.

**No LLM Lock-In**: Agon must never be hard-wired to a single LLM provider.
The MCP server is model-agnostic by construction (open protocol, no
prompts/provider SDKs inside it). Server-side LLM calls (voice-note
parsing) go through one provider-abstraction module
(`LlmCompletionClient`/`TranscriptionClient`, `services/llm/`) — swapping
models is a config change + at most one adapter file, never a refactor.
Current adapters — LLM: `ollama` (default — local, free, no vendor account,
so a fresh self-hosted install is never locked into Anthropic; mirrors the
sibling Hephaistos project's own default), `claude-cli` (opt-in, this
project's own dev machine), `anthropic` (opt-in, BYOK). Transcription:
`mlx-whisper` (default, Apple-Silicon-only), `whisper-cpp` (Linux-tower
default), `openai` (keyless fallback). Build history: tracked in Linear.

---

## Data Sources & Schema

| Data Type | Source App | Status |
|---|---|---|
| Run GPS + pace | Google Health (Fitbit Air + phone connected-GPS) | Live primary source |
| Run/ride GPS + pace | Agon's own recorder (Android app, `app/record`) | Built (MZY-281/282) |
| Run GPS + pace | Strava | Live while Premium API is enabled (outranks Google Health); backfill retained |
| Run HR (wrist, granular) | Fitbit Air → Google Health | Live |
| Run HR (chest strap) | Garmin HRM 200 → manual import | Planned |
| Wellness (resting HR, sleep, HRV, activity) | Google Health API | Live |
| Run GPS/HR (fallback) | Samsung Health / Garmin / Strava export | Built (file importer) |
| Nutrition | Cronometer | CSV import backlogged |
| Weightlifting / qualitative notes | Telegram voice note | Built |
| Weather | Open-Meteo | Built |
| Training schedule → calendar | Google Calendar API | Built |

Cross-source priority for the same activity: **Agon > Strava (when Premium
API is enabled) / file exports > Google Health**. A higher-priority arrival
absorbs and replaces a lower-priority twin (MZY-225). Ingestion detail
(source-agnostic identity, priority, dedupe, watermarks):
`.claude/rules/run-ingestion.md`. Authoritative schema: `migrations/*.sql`
(forward-only, EXPAND-only) or the MCP `describe_schema` tool at runtime.
Core tables: `runs`/`run_streams` (identity via `(source, external_id)`),
`lifting_sessions`→`lifting_exercises`→`lifting_sets`,
`fueling_products`/`run_fueling_items`, `planned_sessions`, `nutrition_days`,
`body_metrics`, `qualitative_logs`. Nutrition/general-health tables:
`.claude/rules/nutrition.md` / `.claude/rules/general-health.md`.

---

## Nutrition & General Health

Both built, PWA-visible (`/nutrition`, `/health`), and MCP-exposed
(`nutrition_summary`, `health_summary`). Cronometer is the decided
nutrition app (CSV import still backlogged — PWA logging is an interim
bridge). Full schema/formulas: `.claude/rules/nutrition.md` /
`.claude/rules/general-health.md`. History and open items: tracked in
Linear.

---

## Premium-Parity Features

Features Strava keeps behind its paywall (or doesn't offer), reimplemented
on Agon's own data — full designs in `.claude/rules/premium-parity.md`:
weather integration, PR predictions (self-calibrated Riegel exponent),
Google Calendar sync, set-level lifting logging + e1RM progression, run +
ride fueling/hydration model, route builder (OpenRouteService), Relative Effort
(Banister TRIMP, feeds training load in `.claude/rules/analytics.md`).

---

## Google Calendar Conventions

Agon syncs to **dedicated calendars, never the athlete's primary one**:
"Agon Training" (planned running + lifting sessions) and "Agon Meals"
(nutrition plan). Before creating or editing any Agon-originated event,
resolve the calendar ID via `list_calendars` — don't assume the primary
calendar. Match the existing house style (see any live event on "Agon
Training" for a concrete example): emoji-prefixed title (e.g. "🏃 Long
run — 25 km"), description with `Block N · Week M`, `Target: X km`,
`HR cap: Y bpm` (omit for quality/lift sessions per
`docs/training-program.local.md`), and a trailing "Planned by Agon" line.
Ad-hoc personal errands (e.g. a shopping trip) stay on the primary
calendar and are never conflated with a training session, even if they
share a location with a planned run.

**Hand edits win.** The athlete edits synced events directly in Google
Calendar (changing a run's distance, deleting a lifting session, moving
a time) — these edits are authoritative and must survive: never silently
overwrite an event back to the program's original value, and never treat
a hand-edited event as "wrong" without asking first. Mechanically (since
MZY-208) Calendar is a human-origin sync peer: reconcile merges its edits
field by field through `mergeField()`, stamped with the event's `updated`
time — so no program/machine write can overwrite them, and between human
edits (Calendar, a device, a manual script) the newest wins. This means the
calendar can legitimately drift from `lib/training/trainingProgram.ts` on specific dates — that's expected, not a bug
to fix. When asked to recalculate a route or other distance-derived
detail for a session, use the **distance in the event's current title**
(the live, possibly hand-edited value), never the original program value,
even if they differ.

---

## Live Run Recording

Local BLE heart-rate capture (`app/record`) with a local IndexedDB
write-ahead buffer, flushed to `run_streams` on stop. **Read
`.claude/rules/live-recording.md` before debugging any Garmin HRM 200
Bluetooth issue** — it has two connection modes and only one works with a
generic client. A genuine local-first/multi-device architecture for the
whole PWA is a separate, larger backlog item.

---

## Backlog & Changelog

Open work and shipped-feature history live in Linear (workspace `muzyczk`,
team `mzyczk`, project `agon`) — migrated 2026-09-18 from the former
`backlog.md`/`changelog.md` file pair (that migration was itself the
completion of the former top backlog item). Query via the `mcp__linear__*`
tools (e.g. `list_issues` with `project: "agon"`) for current open work and
shipped-feature provenance; there is no local file and no auto-`@import`
any more, so session-start task context is an on-demand MCP lookup, not
automatic — revisit if that turns out to matter in practice.

---

## Prior Art & Attribution

The open-source fitness/self-tracking landscape was scanned in
`/docs/landscape-scan.md`. **Credit discipline is mandatory:**

- Copy **code** only from **permissive** (MIT/Apache/BSD) projects,
  retaining license headers. From **copyleft** (AGPL/GPL) projects —
  reimplement the idea, never copy source. Formulas (Banister/Riegel/
  VDOT/e1RM) are free to use regardless.
- Attribute borrowed **data**: BLS (CC BY 4.0), Open Food Facts (ODbL,
  share-alike), USDA (CC0).
- Maintain `CREDITS.md` + an inline comment at every borrow site.

---

## Consulting Context

When working with Claude on this project, always provide: current block/
week number, relevant recent session data (performance/load questions),
any acute symptoms or deviations from plan. Cross-domain analysis —
nutrition, running, and lifting data interpreted together, not in
isolation — is the goal.
