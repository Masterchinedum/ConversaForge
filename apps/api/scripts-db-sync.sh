#!/usr/bin/env bash
# Development schema sync: push Prisma schema, then apply raw SQL objects. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")"
set -a; [ -f .env ] && . ./.env; set +a
npx prisma db push --skip-generate --accept-data-loss
psql "${DATABASE_URL%%\?*}" -v ON_ERROR_STOP=1 -q -f prisma/sql/post-push.sql
npx prisma generate >/dev/null
echo "db sync complete"
