#!/bin/sh
set -e

echo "Running database migrations..."
# Logins and saved designs now live in Firebase, so the API's only job is
# /ai. A migration problem in the old Postgres schema must not stop it.
if ! alembic upgrade head; then
  echo "WARNING: database migrations failed; starting the API anyway (AI routes don't need the database)."
fi

echo "Starting API server..."
exec uvicorn app.main:app --host 0.0.0.0 --port 8000 "$@"
