# The backup service: pg_dump, and rclone to copy dumps to object storage.
FROM docker.io/library/postgres:18-alpine
RUN apk add --no-cache rclone
COPY backup.sh /usr/local/bin/backup.sh
ENTRYPOINT ["/bin/sh", "/usr/local/bin/backup.sh"]
