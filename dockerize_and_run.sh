#!/usr/bin/env bash
set -euo pipefail

echo "== PDFRealm dockerize bootstrap (docker-compose v1) =="

command -v docker >/dev/null 2>&1 || { echo "ERROR: docker not found"; exit 1; }
command -v docker-compose >/dev/null 2>&1 || { echo "ERROR: docker-compose not found"; exit 1; }

mkdir -p infra

# Keep secrets + big dirs out of GitHub
cat > .gitignore <<'EOF'
node_modules/
.env
.env.*
*aws*key*
Access keys for aws
uploads/
backups/
data/
db.dump
schema.sql
*.log
.DS_Store
.idea/
.vscode/
EOF

# If these were accidentally tracked, untrack them
if [ -d .git ]; then
  git rm -r --cached node_modules uploads backups data 2>/dev/null || true
  git rm --cached .env "Access keys for aws" db.dump schema.sql 2>/dev/null || true
fi

cat > .dockerignore <<'EOF'
.git
node_modules
uploads
backups
data
.env
.env.*
db.dump
schema.sql
*.log
.DS_Store
EOF

# Backup existing Dockerfile if present
if [ -f Dockerfile ]; then
  ts="$(date +%Y%m%d_%H%M%S)"
  cp -a Dockerfile "Dockerfile.bak.${ts}"
  echo "Backed up existing Dockerfile -> Dockerfile.bak.${ts}"
fi

cat > Dockerfile <<'EOF'
FROM node:20-bookworm-slim

WORKDIR /app

# deps for pdf-poppler/qpdf + common native builds (fabric/canvas) + psql for optional SQL migrations
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    python3 make g++ pkg-config \
    libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    poppler-utils qpdf ghostscript \
    postgresql-client \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .

EXPOSE 8080
CMD ["bash","-lc","./infra/start.sh"]
EOF

cat > infra/wait-for-postgres.sh <<'EOF'
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
EOF
chmod +x infra/wait-for-postgres.sh

cat > infra/start.sh <<'EOF'
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
EOF
chmod +x infra/start.sh

# IMPORTANT: name this docker-compose.yml for docker-compose v1
cat > docker-compose.yml <<'EOF'
version: "3.9"

services:
  db:
    image: postgres:16
    environment:
      POSTGRES_DB: pdfrealm
      POSTGRES_USER: pdfrealm
      POSTGRES_PASSWORD: pdfrealm_dev_password
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $$POSTGRES_USER -d $$POSTGRES_DB"]
      interval: 5s
      timeout: 3s
      retries: 30

  app:
    build:
      context: .
      dockerfile: Dockerfile
    depends_on:
      db:
        condition: service_healthy

    # loads your local .env into the container (not committed due to .gitignore)
    env_file:
      - .env

    environment:
      DATABASE_URL: postgres://pdfrealm:pdfrealm_dev_password@db:5432/pdfrealm
      PGHOST: db
      PGPORT: "5432"
      PGUSER: pdfrealm
      PGPASSWORD: pdfrealm_dev_password
      PGDATABASE: pdfrealm
      PORT: "8080"
      AUTO_MIGRATE: "1"

    ports:
      - "8080:8080"

    volumes:
      - .:/app
      - /app/node_modules
      - ./uploads:/app/uploads

volumes:
  pgdata:
EOF

echo "Building + starting containers..."
docker-compose up -d --build

echo
echo "== Done =="
echo "App:  http://localhost:8080"
echo "Logs: docker-compose logs -f app"
