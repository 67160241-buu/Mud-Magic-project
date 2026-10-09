#!/bin/sh
set -e

# Logins and saved designs live in Firebase, so the API only serves /ai
# and needs no database.
echo "Starting API server..."
exec uvicorn app.main:app --host 0.0.0.0 --port 8000 "$@"
