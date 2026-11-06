#!/usr/bin/env bash
# Backup / restore for the local Postgres envs. Called by the db:backup* / db:restore* tasks.
#
#   db_backup.sh backup   <env> [label]
#   db_backup.sh list     [env]        VERIFY=1 to checksum every file
#   db_backup.sh prune    <env>        KEEP=10, DRY_RUN=1
#   db_backup.sh restore  <env>        FILE=<path|latest>, FROM_ENV=<env>, MIGRATE=0, DRY_RUN=1, NO_BACKUP=1
#   db_backup.sh commit   <env>        drop the databases kept by previous restores
#   db_backup.sh rollback <env>        swap the most recent pre-restore database back in
#   db_backup.sh status   <env>
#
# env = dev | staging | prod | scenario[:<name>]
set -euo pipefail

# shellcheck source=.taskfiles/db_lib.sh
source "$(dirname "$0")/db_lib.sh"

CMD="${1:-}"; shift || true

usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

meta_or_name_label() {
  local f="$1" meta="${1%.dump}.meta" l
  l=$(meta_get "$meta" label)
  [ -n "$l" ] && { printf '%s' "$l"; return; }
  l=$(basename "$f" .dump); l="${l##*_}"
  printf '%s' "$l"
}

print_dump_row() {
  # print_dump_row <index> <file> [check]
  local i="$1" f="$2" meta="${2%.dump}.meta" created rev rows
  created=$(meta_get "$meta" created_utc)
  [ -n "$created" ] || created=$(date -u -r "$(file_mtime "$f")" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "?")
  rev=$(meta_get "$meta" alembic_rev); rev="${rev:-?}"
  rows=$(meta_get "$meta" row_total); rows="${rows:--}"
  [ -f "$meta" ] || rev="(legacy, no .meta)"
  printf '  %3s  %-20s  %-9s  %-22s  %9s  %8s  %-28s %s\n' \
    "$i" "${created/T/ }" "$(human_age "$(file_mtime "$f")")" "$(meta_or_name_label "$f")" \
    "$(human_size "$(file_size "$f")")" "$rows" "$rev" "${3:-}" >&2
}

print_dump_header() {
  printf '  %3s  %-20s  %-9s  %-22s  %9s  %8s  %-28s %s\n' "#" "CREATED (UTC)" "AGE" "LABEL" "SIZE" "ROWS" "MIGRATION REV" "${1:-}" >&2
}

checksum_status() {
  local f="$1" meta="${1%.dump}.meta"
  [ -f "$meta" ] || { echo "–"; return; }
  [ "$(meta_get "$meta" sha256)" = "$(sha256_of "$f")" ] && echo "✅" || echo "❌ CORRUPT"
}

cmd_backup() {
  local spec="${1:?env required}" label="${2:-${LABEL:-manual}}" f
  resolve_env "$spec" T
  f=$(create_backup T "$label")
  set -- "task db:backup:list   # see all backups" \
    "task db:restore:$T_TASK_SUFFIX   # restore one (pick from a list)" \
    "task db:backup:prune:$T_TASK_SUFFIX KEEP=10   # keep only the newest 10"
  [ "$T_KIND" = prod ] && set -- "$@" "task db:restore:staging FROM_ENV=prod FILE=${f#"$REPO_ROOT"/}   # rehearse: prove this backup restores"
  next_steps "$@"
}

list_dir() {
  # list_dir <title> <dir>
  local title="$1" dir="$2" i=0 f check=""
  local files
  files=$(list_dumps "$dir")
  [ -n "$files" ] || return 0
  echo "" >&2
  echo "📦 $title  (${dir#"$REPO_ROOT"/})" >&2
  [ "${VERIFY:-0}" = "1" ] && check="CHECKSUM"
  print_dump_header "$check"
  while IFS= read -r f; do
    i=$((i + 1))
    [ "${VERIFY:-0}" = "1" ] && check=$(checksum_status "$f")
    print_dump_row "$i" "$f" "$check"
  done <<EOF
$files
EOF
}

cmd_list() {
  local spec="${1:-}" d
  if [ -n "$spec" ]; then
    resolve_env "$spec" T
    list_dir "$T_SPEC" "$T_BACKUP_DIR"
  else
    for d in dev staging prod; do list_dir "$d" "$BACKUP_ROOT/$d"; done
    if [ -d "$BACKUP_ROOT/scenarios" ]; then
      for d in "$BACKUP_ROOT"/scenarios/*/; do
        [ -d "$d" ] && list_dir "scenario:$(basename "$d")" "${d%/}"
      done
    fi
    # Pre-convention dumps dropped directly in the backups root.
    list_dir "unsorted" "$BACKUP_ROOT"
  fi
  [ -n "$(find "$BACKUP_ROOT" -name '*.dump' 2>/dev/null | head -1)" ] || echo "No backups yet under ${BACKUP_ROOT#"$REPO_ROOT"/}" >&2
  next_steps \
    "task db:backup:<env> LABEL=<why>        # take a backup (env: dev | staging | prod | scenario SCENARIO=x)" \
    "task db:restore:<env>                   # restore one" \
    "task db:backup:list VERIFY=1            # also verify checksums"
}

cmd_prune() {
  local spec="${1:?env required}" keep="${KEEP:-10}" i=0 f removed=0
  resolve_env "$spec" T
  case "$keep" in ''|*[!0-9]*) die "KEEP must be a number (got '$keep')" ;; esac
  [ "$keep" -ge 1 ] || die "KEEP must be >= 1"
  step "Pruning $T_SPEC backups — keeping the newest $keep"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    i=$((i + 1))
    [ "$i" -le "$keep" ] && continue
    removed=$((removed + 1))
    if [ "${DRY_RUN:-0}" = "1" ]; then
      info "would delete $(basename "$f")"
    else
      rm -f "$f" "${f%.dump}.meta"
      info "deleted $(basename "$f")"
    fi
  done <<EOF
$(list_dumps "$T_BACKUP_DIR")
EOF
  [ "$removed" -gt 0 ] || info "Nothing to prune ($i backup(s))"
  [ "${DRY_RUN:-0}" = "1" ] && [ "$removed" -gt 0 ] && echo "" >&2 && echo "🔍 Dry run — nothing deleted." >&2
  next_steps "task db:backup:list ENV=$T_SPEC"
}

pick_backup() {
  # pick_backup <dir> <title> — echoes the chosen dump path.
  local dir="$1" files n choice f i=0
  files=$(list_dumps "$dir")
  [ -n "$files" ] || die "No backups in ${dir#"$REPO_ROOT"/}. Take one with: task db:backup:<env>"
  n=$(printf '%s\n' "$files" | wc -l | tr -d ' ')
  [ -r /dev/tty ] && [ -t 0 ] || die "No terminal to pick a backup from — pass FILE=<path> or FILE=latest"
  echo "" >&2
  echo "📦 Backups of $2  (${dir#"$REPO_ROOT"/})" >&2
  print_dump_header
  while IFS= read -r f; do i=$((i + 1)); print_dump_row "$i" "$f"; done <<EOF
$files
EOF
  echo "" >&2
  printf 'Restore which backup? [1-%s, Enter = 1 (newest), q = quit]: ' "$n" >&2
  read -r choice </dev/tty
  case "$choice" in
    "") choice=1 ;;
    q|Q) echo "Cancelled." >&2; exit 1 ;;
    *[!0-9]*) die "Not a number: $choice" ;;
  esac
  [ "$choice" -ge 1 ] && [ "$choice" -le "$n" ] || die "Out of range: $choice"
  printf '%s\n' "$files" | sed -n "${choice}p"
}

cmd_restore() {
  local spec="${1:?env required}" from file
  resolve_env "$spec" T
  from="${FROM_ENV:-$spec}"
  resolve_env "$from" F

  case "${FILE:-}" in
    "")      file=$(pick_backup "$F_BACKUP_DIR" "$F_SPEC") ;;
    latest)  file=$(list_dumps "$F_BACKUP_DIR" | head -1); [ -n "$file" ] || die "No backups in ${F_BACKUP_DIR#"$REPO_ROOT"/}" ;;
    */*)     file="$FILE" ;;
    *)       file="$F_BACKUP_DIR/$FILE" ;;
  esac
  [ -f "$file" ] || die "Backup not found: $file"

  restore_dump T "$file" "restored_from=$(basename "$file")" pre-restore

  if [ "${DRY_RUN:-0}" = "1" ]; then
    next_steps "task db:restore:$T_TASK_SUFFIX${FROM_ENV:+ FROM_ENV=$FROM_ENV} FILE=${file#"$REPO_ROOT"/}   # run it for real"
    return 0
  fi
  echo "" >&2
  echo "✅ $T_SPEC restored from $(basename "$file")" >&2
  [ -n "$PRE_BACKUP" ] && info "Safety backup of the previous data: ${PRE_BACKUP#"$REPO_ROOT"/}"
  next_steps \
    "Check the app (status bar shows the DB revision and where it was restored from)" \
    "task db:restore:commit:$T_TASK_SUFFIX     # happy: drop the kept previous database" \
    "task db:restore:rollback:$T_TASK_SUFFIX   # not happy: swap the previous database back"
}

cmd_commit() {
  local spec="${1:?env required}" dbs d
  resolve_env "$spec" T
  require_db_container T
  dbs=$(pre_restore_dbs T)
  [ -n "$dbs" ] || { echo "Nothing to commit — no pre-restore databases for $T_SPEC." >&2; return 0; }
  step "Dropping databases kept by previous restores of $T_SPEC"
  for d in $dbs; do
    if [ "${DRY_RUN:-0}" = "1" ]; then info "would drop $d"; else drop_db T "$d" >/dev/null; info "dropped $d"; fi
  done
  [ "${DRY_RUN:-0}" = "1" ] && echo "🔍 Dry run — nothing dropped." >&2 && return 0
  echo "" >&2
  echo "✅ Restore committed — rollback is no longer possible (pre-restore dump files are kept)." >&2
  next_steps "task db:backup:list ENV=$T_SPEC"
}

cmd_rollback() {
  local spec="${1:?env required}" pre live discarded
  resolve_env "$spec" T
  require_db_container T
  live="$T_DB"
  pre=$(pre_restore_dbs T | head -1)
  [ -n "$pre" ] || die "No pre-restore database for $T_SPEC — nothing to roll back to (dump files: task db:backup:list ENV=$T_SPEC)"
  discarded="${live}__rolled_back_$(utc_now | tr '[:upper:]' '[:lower:]')"
  step "Swapping $pre back in as $live"
  if [ "${DRY_RUN:-0}" = "1" ]; then
    info "would rename $live → $discarded, $pre → $live, then drop $discarded"
    echo "🔍 Dry run — no changes made." >&2
    return 0
  fi
  if db_exists T "$live"; then
    pg_psql T postgres >/dev/null <<SQL
ALTER DATABASE "$live" WITH ALLOW_CONNECTIONS false;
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('$live', '$pre') AND pid <> pg_backend_pid();
ALTER DATABASE "$live" RENAME TO "$discarded";
ALTER DATABASE "$pre" RENAME TO "$live";
SQL
    drop_db T "$discarded" >/dev/null
  else
    pg_psql T postgres -c "ALTER DATABASE \"$pre\" RENAME TO \"$live\"" >/dev/null
  fi
  info "✅ $live is back to its state before the restore (rev $(alembic_rev T "$live"))"
  restart_backend T
  next_steps "task db:restore:status:$T_TASK_SUFFIX"
}

cmd_status() {
  local spec="${1:?env required}"
  resolve_env "$spec" T
  require_db_container T
  echo "" >&2
  echo "🗄️  $T_SPEC databases in $T_CONTAINER" >&2
  pg_psql T postgres -c "SELECT datname AS database,
      pg_size_pretty(pg_database_size(oid)) AS size,
      coalesce(shobj_description(oid, 'pg_database'), '') AS provenance
    FROM pg_database WHERE datname LIKE '$T_DB%' ORDER BY datname" >&2
  info "Current migration rev: $(alembic_rev T "$T_DB")"
  if [ -n "$(pre_restore_dbs T)" ]; then
    next_steps \
      "task db:restore:commit:$T_TASK_SUFFIX     # keep the restored data, drop the previous copy" \
      "task db:restore:rollback:$T_TASK_SUFFIX   # go back to the previous copy"
  else
    next_steps "task db:backup:$T_TASK_SUFFIX LABEL=<why>"
  fi
}

case "$CMD" in
  backup)   cmd_backup "$@" ;;
  list)     cmd_list "$@" ;;
  prune)    cmd_prune "$@" ;;
  restore)  cmd_restore "$@" ;;
  commit)   cmd_commit "$@" ;;
  rollback) cmd_rollback "$@" ;;
  status)   cmd_status "$@" ;;
  *) usage ;;
esac
