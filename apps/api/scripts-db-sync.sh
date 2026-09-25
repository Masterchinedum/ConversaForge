#!/usr/bin/env bash
# Development schema sync: push Prisma schema, then apply raw SQL objects. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")"
set -a; [ -f .env ] && . ./.env; set +a
# Prisma cannot alter the generated FTS column; drop it first (post-push.sql recreates it, data is derived).
psql "${DATABASE_URL%%\?*}" -q -c 'ALTER TABLE IF EXISTS "KnowledgeChunk" DROP COLUMN IF EXISTS "tsv"' >/dev/null 2>&1 || true
npx prisma db push --skip-generate --accept-data-loss
psql "${DATABASE_URL%%\?*}" -v ON_ERROR_STOP=1 -q -f prisma/sql/post-push.sql
npx prisma generate >/dev/null
echo "db sync complete"
