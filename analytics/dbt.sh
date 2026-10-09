#!/usr/bin/env bash
# Run dbt against Agon's Postgres via the pinned container — no host-side Python
# venv (the image IS the isolated environment). Passes every argument through to
# dbt, so it works for any subcommand:
#
#   ./analytics/dbt.sh parse            # compile-only (no DB needed)
#   ./analytics/dbt.sh build            # seed + run + test
#   ./analytics/dbt.sh run --select fct_relative_effort
#   ./analytics/dbt.sh source freshness
#
# Also available as `pnpm dbt <args>` (see package.json).
#
# Defaults target the LOCAL dev stack (the agon-db Docker Postgres on the host),
# with dbt running as the least-privilege dbt_writer role. Every value is
# overridable via env, so the same script works on the tower — export the
# DBT_* vars there (or use the compose `dbt` profile in
# deploy/docker-compose.selfhost.yml).
#
# One-time local setup: dbt_writer is created without a password (migration
# 20260723001000_analytics_roles.sql uses peer auth). Give it the local password
# this script expects:
#
#   docker exec agon-db psql -U agon -d agon \
#     -c "ALTER ROLE dbt_writer LOGIN PASSWORD 'dbtlocal';"
#
set -euo pipefail

DBT_IMAGE="${DBT_IMAGE:-ghcr.io/dbt-labs/dbt-postgres:1.9.0}"
DBT_HOST="${DBT_HOST:-host.docker.internal}"
DBT_PORT="${DBT_PORT:-5432}"
DBT_USER="${DBT_WRITER_USER:-dbt_writer}"
DBT_PASSWORD="${DBT_WRITER_PASSWORD:-dbtlocal}"
DBT_DBNAME="${DBT_DBNAME:-agon}"
DBT_SCHEMA="${DBT_SCHEMA:-analytics}"
DBT_SSLMODE="${DBT_SSLMODE:-disable}"

# dbt runs INSIDE the container, where a loopback address means the container
# itself — never the Postgres on the host. Anything that exports DBT_HOST=127.0.0.1
# (.env.local does, for host-side tools) would otherwise point dbt at nothing and
# it would fail to connect with no obvious cause. Loopback always means "the host
# machine" here, so translate it; a non-loopback host (a compose service name on
# the tower, a remote warehouse) is passed through untouched.
case "${DBT_HOST}" in
  127.0.0.1|localhost|::1) DBT_HOST="host.docker.internal" ;;
esac

# Directory of this script → the dbt project root (analytics/).
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec docker run --rm --platform linux/amd64 \
  --add-host=host.docker.internal:host-gateway \
  -v "${PROJECT_DIR}:/usr/app" -w /usr/app \
  -e DBT_PROFILES_DIR=/usr/app \
  -e DBT_HOST="${DBT_HOST}" \
  -e DBT_PORT="${DBT_PORT}" \
  -e DBT_USER="${DBT_USER}" \
  -e DBT_PASSWORD="${DBT_PASSWORD}" \
  -e DBT_DBNAME="${DBT_DBNAME}" \
  -e DBT_SCHEMA="${DBT_SCHEMA}" \
  -e DBT_SSLMODE="${DBT_SSLMODE}" \
  "${DBT_IMAGE}" "$@"
