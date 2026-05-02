#!/usr/bin/env bash
# Nightly pg_dump of the system DB + every tenant DB → Cloudflare R2.
# Cron: 0 2 * * *  bash /opt/extraaedge/scripts/backup-all-dbs.sh >> /var/log/extraaedge/backup.log 2>&1
# Requires: pg_dump installed, AWS CLI configured against R2 (or rclone).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Load env
if [ -f .env ]; then export $(grep -v '^#' .env | xargs); fi

DATE="$(date -u +%Y-%m-%d)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "[$(date -u +%FT%TZ)] Dumping system DB $SYSTEM_DB_NAME..."
PGPASSWORD="$SYSTEM_DB_PASSWORD" pg_dump -h "$SYSTEM_DB_HOST" -p "$SYSTEM_DB_PORT" -U "$SYSTEM_DB_USER" -Fc "$SYSTEM_DB_NAME" > "$TMP/$SYSTEM_DB_NAME.dump"
gzip "$TMP/$SYSTEM_DB_NAME.dump"

# List tenant DBs
PGPASSWORD="$SYSTEM_DB_PASSWORD" psql -h "$SYSTEM_DB_HOST" -p "$SYSTEM_DB_PORT" -U "$SYSTEM_DB_USER" -d "$SYSTEM_DB_NAME" -Atc "SELECT db_name FROM tenants WHERE deleted_at IS NULL" | while read -r DB; do
  [ -z "$DB" ] && continue
  echo "[$(date -u +%FT%TZ)] Dumping tenant DB $DB..."
  PGPASSWORD="$TENANT_DB_SUPERUSER_PASSWORD" pg_dump -h "$TENANT_DB_HOST" -p "$TENANT_DB_PORT" -U "$TENANT_DB_SUPERUSER" -Fc "$DB" > "$TMP/$DB.dump"
  gzip "$TMP/$DB.dump"
done

# Upload to R2 via AWS CLI (configured with R2 endpoint) or rclone
# Expected env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
echo "[$(date -u +%FT%TZ)] Uploading to R2 bucket $R2_BUCKET/backups/$DATE/..."
for f in "$TMP"/*.gz; do
  aws s3 cp "$f" "s3://$R2_BUCKET/backups/$DATE/$(basename "$f")" \
    --endpoint-url "https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com" \
    --no-progress
done

echo "[$(date -u +%FT%TZ)] Backup complete."
