#!/usr/bin/env bash
# Start the development Postgres. Uses compose when available, plain podman/docker otherwise.
set -euo pipefail
cd "$(dirname "$0")/.."
engine=$(command -v podman || command -v docker || { echo "podman or docker is required" >&2; exit 1; })
if $engine compose version >/dev/null 2>&1; then
  exec $engine compose up -d db
fi
if $engine container exists rawtisserie-db 2>/dev/null || $engine inspect rawtisserie-db >/dev/null 2>&1; then
  exec $engine start rawtisserie-db
fi
exec $engine run -d --name rawtisserie-db \
  -e POSTGRES_USER=rawtisserie -e POSTGRES_PASSWORD=rawtisserie -e POSTGRES_DB=rawtisserie \
  -p 5433:5432 -v rawtisserie-db-data:/var/lib/postgresql \
  docker.io/library/postgres:18-alpine
