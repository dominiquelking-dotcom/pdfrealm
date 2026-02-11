#!/usr/bin/env bash
set -euo pipefail
host="${PGHOST:-db}"
port="${PGPORT:-5432}"
echo "Waiting for Postgres at ${host}:${port} ..."
for i in {1..60}; do
  if pg_isready -h "$host" -p "$port" >/dev/null 2>&1; then
    echo "Postgres is ready."
    exit 0
  fi
  sleep 1
done
echo "ERROR: Postgres not ready after 60s"
exit 1
