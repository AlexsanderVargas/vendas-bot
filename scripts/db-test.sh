#!/usr/bin/env bash
# Aplica todas as migrations em um PostgreSQL descartável e roda a suíte de
# asserções de RLS. Uso: bash scripts/db-test.sh
#
# Requer postgresql-16 + postgresql-16-postgis-3 instalados.
# Em CI (POSTGRES_HOST definido), usa o serviço existente em vez de subir um.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_NAME="${DB_NAME:-vendas_bot_test}"

if [[ -n "${POSTGRES_HOST:-}" ]]; then
  export PGHOST="$POSTGRES_HOST" PGPORT="${POSTGRES_PORT:-5432}"
  export PGUSER="${POSTGRES_USER:-postgres}" PGPASSWORD="${POSTGRES_PASSWORD:-postgres}"
  psql -d postgres -c "drop database if exists ${DB_NAME}" >/dev/null
  psql -d postgres -c "create database ${DB_NAME}" >/dev/null
else
  PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
  PGHOME="${PGHOME:-/var/lib/postgresql/vendas-bot-test}"
  PORT="${PGTEST_PORT:-5455}"

  su postgres -c "rm -rf ${PGHOME} && mkdir -p ${PGHOME}/data ${PGHOME}/run \
    && ${PGBIN}/initdb -D ${PGHOME}/data -U postgres -A trust" >/dev/null
  su postgres -c "${PGBIN}/pg_ctl -D ${PGHOME}/data \
    -o '-k ${PGHOME}/run -p ${PORT} -c listen_addresses=' -l ${PGHOME}/pg.log start" >/dev/null
  trap "su postgres -c '${PGBIN}/pg_ctl -D ${PGHOME}/data stop -m fast' >/dev/null 2>&1 || true" EXIT

  export PGHOST="${PGHOME}/run" PGPORT="$PORT" PGUSER=postgres
  createdb "$DB_NAME"
fi

echo "==> stub do ambiente Supabase"
psql -d "$DB_NAME" -v ON_ERROR_STOP=1 -q -f "${ROOT}/scripts/sql/00_supabase_stub.sql"

echo "==> migrations"
for file in "${ROOT}"/supabase/migrations/*.sql; do
  echo "    $(basename "$file")"
  psql -d "$DB_NAME" -v ON_ERROR_STOP=1 -q -f "$file"
done

echo "==> asserções de RLS e regras de negócio"
for file in "${ROOT}"/scripts/sql/test_*.sql; do
  [[ -e "$file" ]] || continue
  echo "    $(basename "$file")"
  psql -d "$DB_NAME" -v ON_ERROR_STOP=1 -q -f "$file"
done

echo "==> OK: migrations aplicadas e asserções aprovadas"
