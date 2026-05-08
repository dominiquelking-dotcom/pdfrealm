#!/usr/bin/env bash
set -euo pipefail

./infra/wait-for-postgres.sh

# Optional: auto-apply SQL schema/migrations. Disable by setting AUTO_MIGRATE=0 in docker-compose.yml
if [ "${AUTO_MIGRATE:-0}" = "1" ]; then
  echo "AUTO_MIGRATE=1 -> applying SQL if present..."

  if [ -f /app/evidence_schema.sql ]; then
    echo "Applying evidence_schema.sql"
    psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -f /app/evidence_schema.sql
  fi

  if compgen -G "/app/migrations/*.sql" > /dev/null; then
    echo "Applying migrations/*.sql"
    for f in /app/migrations/*.sql; do
      echo " -> $f"
      psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -f "$f"
    done
  else
    echo "No migrations/*.sql found (skipping)."
  fi
fi

echo "Starting server..."
exec npm run start
