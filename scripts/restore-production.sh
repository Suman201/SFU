#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

if [[ "${RESTORE_CONFIRMATION:-}" != "restore-production-data" ]]; then
  echo "Set RESTORE_CONFIRMATION=restore-production-data to acknowledge this restore." >&2
  exit 1
fi

BACKUP_BUNDLE="${BACKUP_BUNDLE:-}"
if [[ -z "${BACKUP_BUNDLE}" || ! -r "${BACKUP_BUNDLE}" ]]; then
  echo "BACKUP_BUNDLE must point to a readable backup archive." >&2
  exit 1
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/native-sfu-restore.XXXXXX")"
cleanup() {
  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

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

ARCHIVE="${BACKUP_BUNDLE}"
if [[ "${BACKUP_BUNDLE}" == *.age ]]; then
  command -v age >/dev/null 2>&1 || {
    echo "age is required to decrypt this backup." >&2
    exit 1
  }
  ARCHIVE="${WORK_DIR}/backup.tar.gz"
  AGE_ARGS=(--decrypt --output "${ARCHIVE}")
  if [[ -n "${BACKUP_AGE_IDENTITY_FILE:-}" ]]; then
    AGE_ARGS+=(--identity "${BACKUP_AGE_IDENTITY_FILE}")
  fi
  age "${AGE_ARGS[@]}" "${BACKUP_BUNDLE}"
fi

command -v mongorestore >/dev/null 2>&1 || {
  echo "mongorestore is required." >&2
  exit 1
}
command -v tar >/dev/null 2>&1 || {
  echo "tar is required." >&2
  exit 1
}

if tar -tzf "${ARCHIVE}" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  echo "Backup archive contains an unsafe path." >&2
  exit 1
fi
tar -C "${WORK_DIR}" -xzf "${ARCHIVE}"

if command -v sha256sum >/dev/null 2>&1; then
  (cd "${WORK_DIR}" && sha256sum --check SHA256SUMS)
else
  (cd "${WORK_DIR}" && shasum -a 256 --check SHA256SUMS)
fi

MONGO_URI="$(read_secret "${MONGODB_URI:-}" "${MONGODB_URI_FILE:-}")" || {
  echo "MONGODB_URI or MONGODB_URI_FILE is required" >&2
  exit 1
}

MONGO_RESTORE_ARGS=(--uri="${MONGO_URI}" --archive="${WORK_DIR}/mongo.archive.gz" --gzip)
if [[ "${RESTORE_DROP_EXISTING:-false}" == "true" ]]; then
  MONGO_RESTORE_ARGS+=(--drop)
fi

echo "Restore the database only while backend writers are stopped. Continuing in 5 seconds..."
sleep 5
mongorestore "${MONGO_RESTORE_ARGS[@]}"

restore_directory() {
  local label="$1"
  local target="$2"
  if tar -tzf "${WORK_DIR}/assets/${label}.tar.gz" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
    echo "Artifact archive ${label} contains an unsafe path." >&2
    exit 1
  fi
  mkdir -p "${target}"
  tar -C "${target}" -xzf "${WORK_DIR}/assets/${label}.tar.gz"
}

restore_directory recordings "${RECORDING_LOCAL_PATH:-./recordings}"
restore_directory chat-attachments "${CHAT_ATTACHMENT_LOCAL_PATH:-./chat-attachments}"
restore_directory class-materials "${CLASS_MATERIAL_LOCAL_PATH:-./class-materials}"
restore_directory profile-media "${PROFILE_MEDIA_LOCAL_PATH:-./profile-media}"

echo "Restore complete. Start Redis clean, then start backend nodes and verify health before admitting traffic."
