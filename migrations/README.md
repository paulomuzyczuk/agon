# migrations/ — the single source of truth for schema

Every schema change is a timestamped `.sql` file here, applied in filename order
by `scripts/migrate.ts` (`pnpm migrate`). This mirrors the sihha discipline
(CLAUDE.md "Migrations are the single source of truth"): **never** ad-hoc DDL via
a dashboard, an MCP tool, or `psql` by hand. If it isn't a migration file, it
didn't happen.

## Running

```bash
pnpm db:up          # start local Docker Postgres
pnpm migrate        # apply all pending migrations
pnpm migrate --status   # list applied vs pending, apply nothing
```

The runner records each applied file in `public.schema_migrations` and wraps
each migration in a transaction, so a failure rolls back cleanly and a re-run is
a no-op. Against production, set `DATABASE_URL` to the VPS Postgres.

## Naming

`YYYYMMDDHHMMSS_snake_case_description.sql`, e.g.
`20260723000000_core_schema.sql`. The timestamp prefix is the applied order and
the primary key in `schema_migrations` — never rename an applied file.

## Expand → verify → contract

Destructive changes (dropping/renaming a column or table, tightening a type)
are split across **separate, sequenced** migrations:

1. **Expand** — add the new column/table/constraint alongside the old; deploy;
   backfill.
2. **Verify** — confirm reads/writes use the new shape and the old one is idle.
3. **Contract** — a later migration drops the old column/table.

Never expand-and-contract in one file: it makes rollback impossible and couples
the deploy to a data backfill. A rename is `add new` → backfill → `drop old`.
