#!/usr/bin/env bash
# Copy a database between local envs, using the same safe restore path as db:restore
# (restore into a temp DB → check rows → migrate → rename swap; previous DB kept for rollback).
#
#   db_copy.sh <src> <dst> [--dry-run] [--no-migrate] [--no-backup]
#   env = dev | staging | prod | scenario[:<name>]
#
# Staging/prod targets get a durable pre-copy backup first (unless --no-backup).
# Migrations run by default, to the revision the target's deployed code expects.
set -euo pipefail

# shellcheck source=.taskfiles/db_lib.sh
source "$(dirname "$0")/db_lib.sh"

SRC_SPEC=""
DST_SPEC=""
DRY_RUN="${DRY_RUN:-0}"
MIGRATE="${MIGRATE:-1}"
NO_BACKUP="${NO_BACKUP:-0}"

for arg in "$@"; do
  case "$arg" in
    --dry-run)    DRY_RUN=1 ;;
    --no-migrate) MIGRATE=0 ;;
    --migrate)    MIGRATE=1 ;;
    --no-backup)  NO_BACKUP=1 ;;
    -*) die "Unknown flag: $arg" ;;
    *)
      if   [ -z "$SRC_SPEC" ]; then SRC_SPEC="$arg"
      elif [ -z "$DST_SPEC" ]; then DST_SPEC="$arg"
      else die "Unexpected argument: $arg"
      fi ;;
  esac
done
[ -n "$SRC_SPEC" ] && [ -n "$DST_SPEC" ] || die "Usage: $0 <src> <dst> [--dry-run] [--no-migrate] [--no-backup]"
export DRY_RUN MIGRATE

resolve_env "$SRC_SPEC" S
resolve_env "$DST_SPEC" D
[ "$S_CONTAINER/$S_DB" != "$D_CONTAINER/$D_DB" ] || die "Source and target are the same database ($S_CONTAINER/$S_DB)"
require_db_container S
require_db_container D
db_exists S "$S_DB" || die "Source database $S_DB does not exist in $S_CONTAINER"

echo "" >&2
echo "🔄 Copy $S_SPEC ($S_CONTAINER/$S_DB) → $D_SPEC ($D_CONTAINER/$D_DB)" >&2

TMP_DIR="$BACKUP_ROOT/.tmp"
mkdir -p "$TMP_DIR" && chmod 700 "$TMP_DIR"
BASE="$TMP_DIR/copy_${S_LABEL}_to_${D_LABEL}_$(utc_now)"
EXIT_HOOK='rm -f "$BASE.dump" "$BASE.meta"'
EXPECTED_META="$BASE.meta"
trap run_exit_hook EXIT

step "Dumping $S_SPEC"
ROWS_BEFORE=$(row_fingerprint S "$S_DB")
(umask 077; dump_db S "$S_DB" "$BASE.dump") || die "pg_dump failed"
write_meta S "$S_DB" "$BASE.dump" "copy" "$BASE.meta" "$ROWS_BEFORE"
info "✅ $(human_size "$(file_size "$BASE.dump")"), rev $(meta_get "$BASE.meta" alembic_rev)"

export NO_BACKUP
restore_dump D "$BASE.dump" "copied_from=$S_SPEC/$S_DB" "pre-copy-from-$S_LABEL"

if [ "$DRY_RUN" = "1" ]; then
  next_steps "task db:copy -- $SRC_SPEC $DST_SPEC   # run it for real"
  exit 0
fi

echo "" >&2
echo "✅ Copied $S_SPEC → $D_SPEC" >&2
[ -n "$PRE_BACKUP" ] && info "Safety backup of the previous $D_SPEC data: ${PRE_BACKUP#"$REPO_ROOT"/}"
next_steps \
  "Check the $D_SPEC app" \
  "task db:restore:commit:$D_TASK_SUFFIX     # happy: drop the kept previous database" \
  "task db:restore:rollback:$D_TASK_SUFFIX   # not happy: swap the previous database back"
