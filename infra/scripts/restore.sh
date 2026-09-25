#!/usr/bin/env bash
# Restore a database dump produced by backup.sh. DESTRUCTIVE: replaces the current database.
# Usage: infra/scripts/restore.sh backups/db-<ts>.dump
set -euo pipefail
DUMP="$1"
cd "$(dirname "$0")/.."
read -r -p "This will overwrite the conversaforge database. Type RESTORE to continue: " ok
[ "$ok" = "RESTORE" ] || { echo aborted; exit 1; }
docker compose -f docker-compose.prod.yml stop api worker web
docker compose -f docker-compose.prod.yml exec -T postgres pg_restore -U "${POSTGRES_USER:-conversaforge}" -d conversaforge --clean --if-exists --no-owner < "$DUMP"
docker compose -f docker-compose.prod.yml start api worker web
echo "Restored $DUMP"
