#!/bin/sh
# Nightly database dumps for deploy/compose.yaml's `backup` service. Once a day, from
# BACKUP_HOUR (UTC) on, dumps the database to /backups/rawtisserie-YYYY-MM-DD.dump
# (pg_dump's custom format, for pg_restore), then deletes dumps older than
# BACKUP_KEEP_DAYS. A day missed while the machine was down is caught up on start.
set -eu

backup() {
  file="/backups/rawtisserie-$(date -u +%F).dump"
  pg_dump --format=custom --file="$file.part"
  mv "$file.part" "$file"
  echo "backup: wrote $file ($(du -h "$file" | cut -f1))"
  find /backups -name 'rawtisserie-*.dump' -mtime +"$BACKUP_KEEP_DAYS" -print -delete \
    | sed 's/^/backup: deleted /'
}

while true; do
  if [ "$(date -u +%H)" -ge "$BACKUP_HOUR" ] && [ ! -f "/backups/rawtisserie-$(date -u +%F).dump" ]; then
    backup || echo "backup: failed, retrying in 10 minutes"
  fi
  sleep 600
done
