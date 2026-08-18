#!/usr/bin/env bash
# Aplica o seed de demonstração. Uso: bash scripts/seed.sh
#
# Sem argumentos, usa o mesmo PostgreSQL descartável do db-test.sh.
# Contra outro banco, informe a conexão:
#   PGURL='postgres://...' bash scripts/seed.sh
#
# Rodar duas vezes não duplica nada.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SEED="${ROOT}/scripts/sql/seed_demo.sql"

if [[ -n "${PGURL:-}" ]]; then
  psql "$PGURL" -v ON_ERROR_STOP=1 -f "$SEED"
  exit 0
fi

DB_NAME="${DB_NAME:-vendas_bot_test}"

if [[ -n "${POSTGRES_HOST:-}" ]]; then
  export PGHOST="$POSTGRES_HOST" PGPORT="${POSTGRES_PORT:-5432}"
  export PGUSER="${POSTGRES_USER:-postgres}" PGPASSWORD="${POSTGRES_PASSWORD:-postgres}"
else
  PGHOME="${PGHOME:-/var/lib/postgresql/vendas-bot-test}"
  export PGHOST="${PGHOME}/run" PGPORT="${PGTEST_PORT:-5455}" PGUSER=postgres
fi

psql -d "$DB_NAME" -v ON_ERROR_STOP=1 -f "$SEED"
