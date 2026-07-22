#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

BACKUP_ROOT="${BACKUP_ROOT:-./backups}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
BACKUP_ID="$(date -u +%Y%m%dT%H%M%SZ)"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/native-sfu-backup.XXXXXX")"
PLAIN_BUNDLE="${BACKUP_ROOT}/native-sfu-${BACKUP_ID}.tar.gz"

cleanup() {
  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Required command is missing: $1" >&2
    exit 1
  }
}

read_secret() {
  local direct_value="${1:-}"
  local file_path="${2:-}"
  if [[ -n "${direct_value}" ]]; then
    printf '%s' "${direct_value}"
    return
  fi
  if [[ -n "${file_path}" && -r "${file_path}" ]]; then
    tr -d '\r\n' < "${file_path}"
    return
  fi
  return 1
}

checksum_files() {
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "${WORK_DIR}" && sha256sum mongo.archive.gz assets/*.tar.gz > SHA256SUMS)
  else
    (cd "${WORK_DIR}" && shasum -a 256 mongo.archive.gz assets/*.tar.gz > SHA256SUMS)
  fi
}

archive_directory() {
  local label="$1"
  local source_path="$2"
  mkdir -p "${WORK_DIR}/assets"
  if [[ -d "${source_path}" ]]; then
    tar -C "${source_path}" -czf "${WORK_DIR}/assets/${label}.tar.gz" .
  else
    tar -C "${WORK_DIR}" -czf "${WORK_DIR}/assets/${label}.tar.gz" --files-from /dev/null
  fi
}

require_command mongodump
require_command tar
mkdir -p "${BACKUP_ROOT}"

MONGO_URI="$(read_secret "${MONGODB_URI:-}" "${MONGODB_URI_FILE:-}")" || {
  echo "MONGODB_URI or MONGODB_URI_FILE is required" >&2
  exit 1
}

echo "Creating MongoDB archive..."
mongodump --uri="${MONGO_URI}" --archive="${WORK_DIR}/mongo.archive.gz" --gzip

echo "Archiving server-stored artifacts..."
archive_directory recordings "${RECORDING_LOCAL_PATH:-./recordings}"
archive_directory chat-attachments "${CHAT_ATTACHMENT_LOCAL_PATH:-./chat-attachments}"
archive_directory class-materials "${CLASS_MATERIAL_LOCAL_PATH:-./class-materials}"
archive_directory profile-media "${PROFILE_MEDIA_LOCAL_PATH:-./profile-media}"

cat > "${WORK_DIR}/MANIFEST.txt" <<EOF
backup_id=${BACKUP_ID}
created_at=${BACKUP_ID}
database=mongodb
redis_included=false
recording_storage_driver=${RECORDING_STORAGE_DRIVER:-local}
note=Redis presence and room-affinity keys are intentionally not restored.
EOF

checksum_files
tar -C "${WORK_DIR}" -czf "${PLAIN_BUNDLE}" .

OUTPUT_BUNDLE="${PLAIN_BUNDLE}"
if [[ -n "${BACKUP_AGE_RECIPIENT:-}" ]]; then
  require_command age
  age --recipient "${BACKUP_AGE_RECIPIENT}" --output "${PLAIN_BUNDLE}.age" "${PLAIN_BUNDLE}"
  rm -f "${PLAIN_BUNDLE}"
  OUTPUT_BUNDLE="${PLAIN_BUNDLE}.age"
fi

if [[ "${BACKUP_RETENTION_DAYS}" =~ ^[0-9]+$ ]]; then
  find "${BACKUP_ROOT}" -maxdepth 1 -type f -name 'native-sfu-*.tar.gz*' -mtime "+${BACKUP_RETENTION_DAYS}" -delete
fi

echo "Backup complete: ${OUTPUT_BUNDLE}"
