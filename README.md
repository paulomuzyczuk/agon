# Agon

> "Your body, logged. Your progress, earned."

Agon is a personal health data platform for hybrid athletes. It ingests
training, nutrition, and biometric data from multiple sources, enriches it
with qualitative context captured via voice, and surfaces it through a
unified dashboard and a Claude-powered consulting layer.

It's built to be **self-hosted by you**, not signed up for as a service —
your health data never leaves your own machine.

```
Google Health API (live) ─┐
Strava (historical) ───────┤
Cronometer (CSV, backlogged) ┤──→ Postgres ──→ dbt marts ──→ Lightdash
Telegram Bot (voice+text) ──┘        ├──→ PWA dashboard (Next.js)
                                      └──→ MCP server (consulting layer)
```

## What you get

- A Postgres database holding your own training/nutrition/biometric data —
  never a shared or hosted database.
- A web dashboard (PWA) reachable from your own devices, gated by a single
  login secret.
- A Telegram bot for low-friction voice/text logging.
- A read-only MCP server so any MCP-capable LLM client can query your own
  data as a consulting layer.
- Optional integrations you turn on one at a time: Strava, Google Health,
  Google Calendar, a fully-local AI stack (no API keys required), route
  suggestions.

## Getting started

Follow **[`docs/self-hosting/README.md`](docs/self-hosting/README.md)** —
`git clone` → your own running instance, reachable from your own phone, with
none of your data ever leaving your own machine.

## Repo layout

- `app/`, `components/` — Next.js App Router PWA
- `services/`, `app/api/` — backend logic and API routes
- `services/mcp/` — the read-only MCP consulting server
- `migrations/` — forward-only, expand-only schema (source of truth)
- `analytics/` — dbt project (marts feeding Lightdash)
- `docs/self-hosting/` — the install/operate guide set
- `CLAUDE.md` — project conventions and architecture for AI-assisted work
- `CREDITS.md` — attribution ledger for borrowed ideas/formulas/data

## License

[MIT](LICENSE).
