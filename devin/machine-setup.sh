#!/usr/bin/env bash
# Devin machine setup — paste into Settings → Devin's Workspace → Setup
# (or point Devin's snapshot at this script). It runs ONCE when the machine
# snapshot is built, so every session that follows starts a native Superset
# in seconds instead of provisioning from scratch.
#
# Why native (no Docker): the session only ever runs ONE Superset on a single
# VM, so docker-in-docker just adds image pulls + a storage layer. Installing
# Postgres + Redis + the Python/Node deps directly means code edits go live on
# a simple restart, which makes the stakeholder follow-up loop fast.
#
# Assumes an Ubuntu-based Devin machine with the fork already cloned at the
# workspace root (cwd = repo root). Idempotent — safe to re-run.
set -euo pipefail

# Ubuntu's default `postgresql` is fine for Superset's metadata DB — no need to
# pin v17 (that's only what the compose file happened to use). Using the distro
# package avoids the PGDG key/repo dance, which is the most failure-prone step.
echo "▶ system packages (PostgreSQL, Redis, build deps — Ubuntu/apt)"
sudo apt-get update -y
sudo apt-get install -y --no-install-recommends \
  postgresql postgresql-contrib redis-server \
  libpq-dev build-essential pkg-config \
  python3-dev python3-venv python3-pip \
  libssl-dev libffi-dev curl ca-certificates

# Node 22 via nvm (matches superset-frontend engines: node ^22, npm ^10).
export NVM_DIR="$HOME/.nvm"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  echo "▶ installing nvm + Node 22"
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
fi
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm install 22
nvm alias default 22

echo "▶ starting Postgres + Redis"
sudo service postgresql start
sudo service redis-server start

echo "▶ creating the superset metadata role + database"
sudo -u postgres psql -v ON_ERROR_STOP=1 <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'superset') THEN
    CREATE ROLE superset LOGIN PASSWORD 'superset';
  END IF;
END $$;
SELECT 'CREATE DATABASE superset OWNER superset'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'superset')\gexec
SQL

echo "▶ Python venv + editable install of the app (with postgres extras)"
python3 -m venv "$HOME/.superset-venv"
# shellcheck disable=SC1091
. "$HOME/.superset-venv/bin/activate"
pip install --upgrade pip wheel
pip install -e ".[postgres]"
[ -f requirements/development.txt ] && pip install -r requirements/development.txt || true

echo "▶ pre-installing frontend deps (warms node_modules so session builds are fast)"
( cd superset-frontend && npm ci )

cat <<'NOTE'

✅ Machine setup complete. Pre-provisioned for native Superset:
   • PostgreSQL 17 running; role/db 'superset' created
   • Redis 7 running
   • Python venv at ~/.superset-venv with `pip install -e .[postgres]`
   • superset-frontend/node_modules populated via `npm ci`

Per session, Devin only needs to (see the API prompt in server/devin.js):
   . ~/.superset-venv/bin/activate
   export SUPERSET__SQLALCHEMY_DATABASE_URI=postgresql+psycopg2://superset:superset@localhost/superset
   export REDIS_HOST=localhost REDIS_PORT=6379
   superset db upgrade && superset fab create-admin ... && superset init
   ( cd superset-frontend && npm run build )
   superset run -h 0.0.0.0 -p 8088      # then expose 8088 as the deploy_url
NOTE
