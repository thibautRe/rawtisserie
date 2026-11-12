#!/bin/sh
# Nightly database dumps for deploy/compose.yaml's `backup` service. Once a day, from
# BACKUP_HOUR (UTC) on, dumps the database to /backups/rawtisserie-YYYY-MM-DD.dump
# (pg_dump's custom format, for pg_restore), then deletes dumps older than
# BACKUP_KEEP_DAYS. A day missed while the machine was down is caught up on start.
#
# With BACKUP_S3_BUCKET set, dumps are also copied to that bucket (rclone's `offsite`
# remote, configured by the environment), where dumps older than BACKUP_KEEP_DAYS are
# deleted too. A failed upload is retried every 10 minutes until it goes through.
set -eu

pending=/backups/.upload-pending

# Steps are chained with && because `set -e` doesn't apply inside `backup || …`.
backup() {
  file="/backups/rawtisserie-$(date -u +%F).dump"
  rm -f "$file.part"
  pg_dump --format=custom --file="$file.part" \
    && mv "$file.part" "$file" \
    && echo "backup: wrote $file ($(du -h "$file" | cut -f1))" \
    && find /backups -name 'rawtisserie-*.dump' -mtime +"$BACKUP_KEEP_DAYS" -print -delete \
    | sed 's/^/backup: deleted /' \
    && if [ -n "${BACKUP_S3_BUCKET:-}" ]; then touch "$pending"; fi
}

# Copies the dumps the bucket doesn't have yet, then deletes its old ones.
upload() {
  remote="offsite:$BACKUP_S3_BUCKET"
  rclone copy /backups "$remote" --include 'rawtisserie-*.dump' \
    && rclone delete "$remote" --include 'rawtisserie-*.dump' --min-age "${BACKUP_KEEP_DAYS}d" \
    && rm "$pending" \
    && echo "backup: copied to $remote"
}

# PID 1 in its container: stop on SIGTERM (compose stop) and SIGINT instead of being killed.
trap 'exit 0' TERM INT

# On start too, so that a configuration mistake shows in the logs right away.
if [ -n "${BACKUP_S3_BUCKET:-}" ]; then touch "$pending"; fi

while true; do
  if [ "$(date -u +%H)" -ge "$BACKUP_HOUR" ] && [ ! -f "/backups/rawtisserie-$(date -u +%F).dump" ]; then
    backup || echo "backup: failed, retrying in 10 minutes"
  fi
  if [ -f "$pending" ]; then
    upload || echo "backup: upload failed, retrying in 10 minutes"
  fi
  # In the background, so that the trap runs during the wait.
  sleep 600 &
  wait $!
done
