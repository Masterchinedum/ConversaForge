#!/bin/sh
# Usage: entrypoint.sh api|worker|migrate
set -e
case "$1" in
  migrate)
    npx prisma migrate deploy
    ;;
  worker)
    exec node --enable-source-maps dist/worker.js
    ;;
  api|*)
    if [ "${RUN_MIGRATIONS_ON_START:-false}" = "true" ]; then npx prisma migrate deploy; fi
    exec node --enable-source-maps dist/main.js
    ;;
esac
