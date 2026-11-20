#!/usr/bin/env bash
# Project-local PostgreSQL + PostGIS for machines without Docker.
# Runs a private instance (default port 5433) with data in .local/postgres,
# never touching any other PostgreSQL server on the machine.
#
#   infrastructure/scripts/local-postgres.sh init     # create cluster, role, databases, extensions
#   infrastructure/scripts/local-postgres.sh start|stop|status
#
# Requires PostgreSQL binaries with PostGIS available, e.g. on macOS:
#   brew install postgresql@18 postgis   (PG_BIN defaults to the postgresql@18 keg)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PG_BIN="${PG_BIN:-/opt/homebrew/opt/postgresql@18/bin}"
PGDATA="${PGDATA:-$ROOT/.local/postgres}"
PORT="${FOS_PG_PORT:-5433}"
LOG="$ROOT/.local/postgres.log"

# Must match .env.example (development-only credentials).
DB_USER=fos
DB_PASSWORD=fos_dev_password

# macOS: the postmaster refuses to start without a valid LC_ALL.
export LC_ALL="${LC_ALL:-en_US.UTF-8}"

pg() { "$PG_BIN/$1" "${@:2}"; }

case "${1:-}" in
  init)
    if [[ -f "$PGDATA/PG_VERSION" ]]; then
      echo "Cluster already exists at $PGDATA"
    else
      mkdir -p "$PGDATA"
      pg initdb -D "$PGDATA" --auth=scram-sha-256 --username=postgres \
        --pwfile=<(printf '%s\n' postgres_local) --encoding=UTF8 --locale=C >/dev/null
      echo "Initialised cluster at $PGDATA"
    fi
    "$0" start
    export PGPASSWORD=postgres_local
    pg psql -h localhost -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$DB_USER') THEN
    CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASSWORD';
  END IF;
END \$\$;
-- Development only, mirroring docker-compose (POSTGRES_USER is a superuser):
-- Prisma's shadow database must be able to CREATE EXTENSION postgis.
ALTER ROLE $DB_USER SUPERUSER;
SQL
    for db in fos fos_test; do
      if ! pg psql -h localhost -p "$PORT" -U postgres -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1; then
        pg createdb -h localhost -p "$PORT" -U postgres -O "$DB_USER" "$db"
      fi
      # Extensions need superuser; Prisma migrations then find them present.
      pg psql -h localhost -p "$PORT" -U postgres -d "$db" -q -v ON_ERROR_STOP=1 \
        -c 'SET client_min_messages = warning; CREATE EXTENSION IF NOT EXISTS postgis; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS unaccent; CREATE EXTENSION IF NOT EXISTS citext; CREATE EXTENSION IF NOT EXISTS pgcrypto;'
    done
    echo "Ready: postgresql://$DB_USER:$DB_PASSWORD@localhost:$PORT/fos (and /fos_test)"
    ;;
  start)
    if pg pg_ctl -D "$PGDATA" status >/dev/null 2>&1; then
      echo "Already running on port $PORT"
    else
      pg pg_ctl -D "$PGDATA" -l "$LOG" -o "-p $PORT -k /tmp" -w start >/dev/null
      echo "Started on port $PORT (log: $LOG)"
    fi
    ;;
  stop)
    pg pg_ctl -D "$PGDATA" -m fast -w stop >/dev/null && echo "Stopped"
    ;;
  status)
    pg pg_ctl -D "$PGDATA" status || true
    ;;
  *)
    echo "usage: $0 {init|start|stop|status}" >&2
    exit 1
    ;;
esac
