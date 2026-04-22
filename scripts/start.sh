#!/bin/sh
set -u

echo "[start] PORT=${PORT:-unset} HOSTNAME=${HOSTNAME:-unset} NODE_ENV=${NODE_ENV:-unset}"
if [ -n "${DATABASE_URL:-}" ]; then
  echo "[start] DATABASE_URL=set"
else
  echo "[start] DATABASE_URL=UNSET"
fi

# Schema sync strategy: prisma db push with --accept-data-loss.
#
# This works because the deploy model is "one admin owns the schema"
# and every change lands through this repo. There is no hand-edited
# Postgres state to protect. On boot we reconcile the live schema to
# prisma/schema.prisma — additive changes (new tables, new columns,
# new indexes) apply without touching data; removed tables or
# renamed columns ARE destructive, so:
#
#   - Column renames: add-new + backfill + remove-old across two
#     deploys, not a single rename commit.
#   - Table removals: drop data first if anything writes there, then
#     remove the model from the schema and let db push drop the table.
#
# If the tenant ever needs to preserve hand-made schema changes, or
# roll back safely after a breaking change, swap to:
#   node ./node_modules/prisma/build/index.js migrate deploy
# after creating a prisma/migrations/ baseline. That's a one-way door
# — once migrations exist, db push can no longer be the source of
# truth. Defer until the tenant demands it.
if [ -n "${DATABASE_URL:-}" ]; then
  echo "[start] running prisma db push..."
  if ! node ./node_modules/prisma/build/index.js db push --accept-data-loss --skip-generate 2>&1; then
    if [ "${DB_PUSH_FORCE_RESET_ON_FAILURE:-false}" = "true" ]; then
      echo "[start] prisma db push failed - retrying with --force-reset"
      node ./node_modules/prisma/build/index.js db push --force-reset --accept-data-loss --skip-generate 2>&1
    else
      echo "[start] prisma db push failed - aborting boot"
      echo "[start] set DB_PUSH_FORCE_RESET_ON_FAILURE=true for one test-only deploy if you need an automatic reset"
      exit 1
    fi
  fi
else
  echo "[start] DATABASE_URL unset — skipping prisma db push"
fi

echo "[start] launching next server..."
exec node server.js
