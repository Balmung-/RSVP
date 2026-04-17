#!/bin/sh
set -u

echo "[start] PORT=${PORT:-unset} HOSTNAME=${HOSTNAME:-unset} NODE_ENV=${NODE_ENV:-unset}"
echo "[start] DATABASE_URL=${DATABASE_URL:+set}${DATABASE_URL:-UNSET}"

if [ -n "${DATABASE_URL:-}" ]; then
  echo "[start] running prisma db push..."
  node ./node_modules/prisma/build/index.js db push --accept-data-loss --skip-generate 2>&1 || echo "[start] prisma db push failed — continuing"
else
  echo "[start] DATABASE_URL unset — skipping prisma db push"
fi

echo "[start] launching next server..."
exec node server.js
