#!/usr/bin/env bash
# Project-local Redis for machines without Docker: two private instances that
# mirror docker-compose (core: noeviction + AOF, cache: allkeys-lru), with data
# in .local/redis. Never touches any other Redis on the machine.
#
#   infrastructure/scripts/local-redis.sh start|stop|status
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIR="$ROOT/.local/redis"
CORE_PORT="${FOS_REDIS_CORE_PORT:-6390}"
CACHE_PORT="${FOS_REDIS_CACHE_PORT:-6391}"
BIN="${REDIS_BIN:-redis-server}"
CLI="${REDIS_CLI:-redis-cli}"

start_one() { # name port extra-args...
  local name=$1 port=$2; shift 2
  if "$CLI" -p "$port" ping >/dev/null 2>&1; then
    echo "$name already running on $port"
    return
  fi
  mkdir -p "$DIR/$name"
  "$BIN" --port "$port" --bind 127.0.0.1 --daemonize yes --dir "$DIR/$name" \
    --pidfile "$DIR/$name.pid" --logfile "$DIR/$name.log" "$@"
  echo "$name started on $port"
}

case "${1:-}" in
  start)
    start_one core "$CORE_PORT" --appendonly yes --maxmemory-policy noeviction
    start_one cache "$CACHE_PORT" --save '' --appendonly no --maxmemory 256mb --maxmemory-policy allkeys-lru
    echo "REDIS_CORE_URL=redis://localhost:$CORE_PORT  REDIS_CACHE_URL=redis://localhost:$CACHE_PORT"
    ;;
  stop)
    for port in "$CORE_PORT" "$CACHE_PORT"; do "$CLI" -p "$port" shutdown >/dev/null 2>&1 || true; done
    echo "Stopped"
    ;;
  status)
    for port in "$CORE_PORT" "$CACHE_PORT"; do
      printf '%s: ' "$port"; "$CLI" -p "$port" ping 2>/dev/null || echo "down"
    done
    ;;
  *) echo "usage: $0 {start|stop|status}" >&2; exit 1 ;;
esac
