#!/usr/bin/env bash
# Nightly backup: Postgres dump + local media storage (skip storage when using S3 — use bucket versioning/replication).
# Usage: infra/scripts/backup.sh [backup_dir]   (run on the host next to infra/docker-compose.prod.yml)
set -euo pipefail
DIR="${1:-./backups}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$DIR"
cd "$(dirname "$0")/.."
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U "${POSTGRES_USER:-conversaforge}" -d conversaforge --format=custom --no-owner > "$DIR/db-$TS.dump"
if docker compose -f docker-compose.prod.yml ps api >/dev/null 2>&1; then
  docker compose -f docker-compose.prod.yml run --rm --no-deps -v "$(realpath "$DIR")":/backup --entrypoint sh api \
    -c "tar czf /backup/storage-$TS.tgz -C /data storage" || echo "storage backup skipped"
fi
# Keep 14 days
find "$DIR" -type f -mtime +14 -delete
echo "Backup written to $DIR ($TS)"
