#!/usr/bin/env bash
# Shared helpers for db_backup.sh / db_copy.sh. Source it; must stay bash 3.2 compatible (macOS).
#
# Env specs: dev | staging | prod | scenario | scenario:<name>
# Postgres client tools always run INSIDE the env's DB container (docker exec), so
# pg_dump / pg_restore versions always match the server.

REPO_ROOT="${ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BACKUP_ROOT="${BACKUP_ROOT:-$REPO_ROOT/backend/data/backups}"
ALEMBIC_BIN="$REPO_ROOT/.venv/bin/alembic"

die()  { echo "❌ $*" >&2; exit 1; }
info() { echo "   $*" >&2; }
step() { echo "" >&2; echo "▶ $*" >&2; }
warn() { echo "⚠️  $*" >&2; }

utc_now()  { date -u +%Y%m%dT%H%M%SZ; }
utc_iso()  { date -u +%Y-%m-%dT%H:%M:%SZ; }

sha256_of() { shasum -a 256 "$1" | awk '{print $1}'; }

file_mtime() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1"; }

file_size() { wc -c <"$1" | tr -d ' '; }

human_size() {
  awk -v b="$1" 'BEGIN { split("B KB MB GB TB", u); i = 1; while (b >= 1024 && i < 5) { b /= 1024; i++ } printf (i == 1 ? "%d %s" : "%.1f %s"), b, u[i] }'
}

human_age() {
  local s=$(( $(date +%s) - $1 ))
  if   [ "$s" -lt 3600 ];   then echo "$(( s / 60 ))m ago"
  elif [ "$s" -lt 86400 ];  then echo "$(( s / 3600 ))h ago"
  else                           echo "$(( s / 86400 ))d ago"
  fi
}

sanitize_label() {
  local l
  l=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' | tr -s '-')
  l="${l#-}"; l="${l%-}"
  printf '%s' "${l:-manual}"
}

# ── Env resolution ───────────────────────────────────────────

env_layers() {
  local c="$REPO_ROOT/config"
  case "$1" in
    dev)      printf '%s\n' "$c/base.env" "$REPO_ROOT/scenarios/dev/config.env" "$c/secrets.env" "$c/secrets.dev.env" ;;
    staging)  printf '%s\n' "$c/base.env" "$c/staging.local.env" "$c/secrets.env" "$c/secrets.staging.local.env" ;;
    prod)     printf '%s\n' "$c/base.env" "$c/prod.local.env" "$c/secrets.env" "$c/secrets.prod.local.env" ;;
    scenario) printf '%s\n' "$c/base.env" "$c/scenario.env" "$c/secrets.env" "$c/secrets.scenario.env" ;;
    *) die "Unknown env '$1' (expected dev | staging | prod | scenario[:<name>])" ;;
  esac
}

env_value() {
  # env_value <key> <kind> — last value of KEY across the kind's config layers.
  local key="$1" layer line value=""
  for layer in $(env_layers "$2"); do
    [ -f "$layer" ] || continue
    line=$(grep -E "^[[:space:]]*${key}=" "$layer" | tail -1 || true)
    [ -n "$line" ] || continue
    value="${line#*=}"
    value="${value%$'\r'}"
    value="${value%\"}"; value="${value#\"}"
  done
  printf '%s' "$value"
}

# _v <prefix> <NAME> — value of ${prefix}_NAME (bash 3.2 has no namerefs).
_v() { local n="${1}_${2}"; printf '%s' "${!n:-}"; }

_set() { eval "${1}_${2}=\$3"; }

resolve_env() {
  # resolve_env <spec> <prefix> — sets <prefix>_{SPEC,KIND,LABEL,NAME,USER,PASS,DB,HOST,PORT,
  # CONTAINER,BACKEND_CONTAINER,API_PORT,BACKUP_DIR,PROTECTED,TASK_SUFFIX}.
  local spec="$1" p="$2" kind name="" label container backend db port api_port dir suffix
  case "$spec" in
    dev|staging|prod) kind="$spec" ;;
    scenario)         kind=scenario; name=default ;;
    scenario:dev)     kind=dev; spec=dev ;;
    scenario:*)       kind=scenario; name="${spec#scenario:}" ;;
    *) die "Unknown env '$spec' (expected dev | staging | prod | scenario[:<name>])" ;;
  esac

  if [ "$kind" = scenario ]; then
    local resolved state
    state="$REPO_ROOT/.taskfiles/.scenario-state/$name.env"
    resolved=$(
      # shellcheck disable=SC1090,SC1091
      source "$REPO_ROOT/.taskfiles/scenario_ports.sh" "$name" >/dev/null 2>&1
      # shellcheck disable=SC1090
      [ -f "$state" ] && source "$state"
      printf '%s|%s|%s|%s|%s|%s' "$ENV_NAME" "$SC_DB_CONTAINER" "$SC_BACKEND_CONTAINER" "$SC_DB_NAME" "$SC_DB_PORT" "$SC_API_PORT"
    )
    IFS='|' read -r label container backend db port api_port <<EOF
$resolved
EOF
    dir="$BACKUP_ROOT/scenarios/$name"
    suffix="scenario SCENARIO=$name"
    spec="scenario:$name"
  else
    label=$(env_value ENV_NAME "$kind")
    label="${label:-$kind}"
    container="trades_db_$label"
    backend="trades_backend_$label"
    db=$(env_value POSTGRES_DB "$kind")
    port=$(env_value POSTGRES_PORT "$kind")
    api_port=$(env_value BACKEND_PORT "$kind")
    dir="$BACKUP_ROOT/$kind"
    suffix="$kind"
  fi

  local user pass
  user=$(env_value POSTGRES_USER "$kind")
  pass=$(env_value POSTGRES_PASSWORD "$kind")
  [ -n "$user" ] || die "POSTGRES_USER missing in config layers for $spec"
  [ -n "$pass" ] || die "POSTGRES_PASSWORD missing in config layers for $spec"
  [ -n "$db" ]   || die "POSTGRES_DB missing in config layers for $spec"

  _set "$p" SPEC "$spec"
  _set "$p" KIND "$kind"
  _set "$p" NAME "$name"
  _set "$p" LABEL "$label"
  _set "$p" USER "$user"
  _set "$p" PASS "$pass"
  _set "$p" DB "$db"
  _set "$p" HOST localhost
  _set "$p" PORT "$port"
  _set "$p" API_PORT "$api_port"
  _set "$p" CONTAINER "$container"
  _set "$p" BACKEND_CONTAINER "$backend"
  _set "$p" BACKUP_DIR "$dir"
  _set "$p" TASK_SUFFIX "$suffix"
  case "$kind" in staging|prod) _set "$p" PROTECTED 1 ;; *) _set "$p" PROTECTED 0 ;; esac
}

container_running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || true)" = "true" ]
}

require_db_container() {
  local c
  c=$(_v "$1" CONTAINER)
  container_running "$c" && return 0
  case "$(_v "$1" KIND)" in
    dev)      die "DB container $c is not running. Start it: task start:dev" ;;
    staging)  die "DB container $c is not running. Start it: task start:staging:local" ;;
    prod)     die "DB container $c is not running. Start it: task start:prod:local" ;;
    scenario) die "DB container $c is not running. Start it: task start:scenario:db SCENARIO=$(_v "$1" NAME)" ;;
  esac
}

# ── Postgres primitives (run inside the DB container) ────────

pg_psql() {
  # pg_psql <prefix> <db> [psql args...]
  local p="$1" db="$2"; shift 2
  docker exec -i -e PGPASSWORD="$(_v "$p" PASS)" "$(_v "$p" CONTAINER)" \
    psql -X -q -v ON_ERROR_STOP=1 -U "$(_v "$p" USER)" -d "$db" "$@"
}

pg_query() { pg_psql "$1" "$2" -tA -c "$3"; }

db_exists() {
  [ "$(pg_query "$1" postgres "SELECT 1 FROM pg_database WHERE datname = '$2'")" = "1" ]
}

alembic_rev() {
  pg_query "$1" "$2" "SELECT version_num FROM alembic_version LIMIT 1" 2>/dev/null || true
}

table_count() {
  pg_query "$1" "$2" "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'" 2>/dev/null || echo "?"
}

row_fingerprint() {
  # Exact per-table row counts, one "table=count" per line, sorted by table.
  pg_query "$1" "$2" "SELECT format('%s=%s', tablename,
      (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', tablename), false, true, '')))[1]::text)
    FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
}

server_version() { pg_query "$1" postgres "SHOW server_version" 2>/dev/null || true; }

dump_db() {
  # dump_db <prefix> <db> <outfile>
  docker exec -e PGPASSWORD="$(_v "$1" PASS)" "$(_v "$1" CONTAINER)" \
    pg_dump -U "$(_v "$1" USER)" -Fc "$2" >"$3"
}

restore_into() {
  # restore_into <prefix> <db> <dumpfile> — strict: aborts (and rolls back) on the first error.
  local u
  u=$(_v "$1" USER)
  docker exec -i -e PGPASSWORD="$(_v "$1" PASS)" "$(_v "$1" CONTAINER)" \
    pg_restore -U "$u" -d "$2" --no-owner --role="$u" --exit-on-error --single-transaction <"$3"
}

dump_readable() {
  # dump_readable <prefix> <dumpfile> — pg_restore can parse the archive's table of contents.
  docker exec -i "$(_v "$1" CONTAINER)" pg_restore --list <"$2" >/dev/null 2>&1
}

create_db() { pg_psql "$1" postgres -c "CREATE DATABASE \"$2\" OWNER \"$(_v "$1" USER)\""; }

drop_db() { pg_psql "$1" postgres -c "DROP DATABASE IF EXISTS \"$2\" WITH (FORCE)"; }

# ── Backup metadata (.meta: KEY=VALUE, rows.<table>=<count>) ─

meta_get() { { grep -E "^$2=" "$1" 2>/dev/null || true; } | head -1 | cut -d= -f2-; }

meta_rows() { { grep -E '^rows\.' "$1" 2>/dev/null || true; } | sed 's/^rows\.//'; }

write_meta() {
  # write_meta <prefix> <db> <dumpfile> <label> <metafile> [rows_before_dump]
  local p="$1" db="$2" f="$3" label="$4" out="$5" rows
  rows=$(row_fingerprint "$p" "$db")
  # Writes during the dump would make counts unreliable; then record none (restore skips the check).
  if [ -n "${6:-}" ] && [ "$6" != "$rows" ]; then
    warn "Row counts changed while dumping — backup is fine, but restore will skip the row-count check"
    rows=""
  fi
  {
    echo "format=1"
    echo "file=$(basename "$f")"
    echo "env=$(_v "$p" SPEC)"
    echo "label=$label"
    echo "created_utc=$(utc_iso)"
    echo "source=$(_v "$p" CONTAINER)/$db"
    echo "alembic_rev=$(alembic_rev "$p" "$db")"
    echo "server_version=$(server_version "$p")"
    echo "git_sha=$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || true)"
    echo "size_bytes=$(file_size "$f")"
    echo "sha256=$(sha256_of "$f")"
    echo "table_count=$(table_count "$p" "$db")"
    [ -n "$rows" ] && echo "row_total=$(printf '%s\n' "$rows" | awk -F= '{s += $2} END {print s + 0}')"
    printf '%s\n' "$rows" | sed '/^$/d; s/^/rows./'
  } >"$out"
}

verify_dump() {
  # verify_dump <prefix> <dumpfile> — checksum vs .meta (when present) + archive readability.
  local p="$1" f="$2" meta="${2%.dump}.meta" want got
  [ -f "$f" ] || die "Backup not found: $f"
  if [ -f "$meta" ]; then
    want=$(meta_get "$meta" sha256)
    got=$(sha256_of "$f")
    [ "$want" = "$got" ] || die "Checksum mismatch for $(basename "$f") — the file is corrupted or was modified (expected ${want:0:12}…, got ${got:0:12}…)"
    info "✅ Checksum matches .meta"
  else
    warn "No .meta next to $(basename "$f") (legacy backup) — skipping checksum and row-count checks"
  fi
  dump_readable "$p" "$f" || die "pg_restore cannot read $(basename "$f") (truncated, not a -Fc dump, or made by a newer pg_dump)"
  info "✅ Archive readable"
}

# ── Backups on disk ──────────────────────────────────────────

list_dumps() {
  # list_dumps <dir> — newest first.
  [ -d "$1" ] || return 0
  local f
  for f in "$1"/*.dump; do
    [ -f "$f" ] && printf '%s %s\n' "$(file_mtime "$f")" "$f"
  done | sort -rn | cut -d' ' -f2-
}

create_backup() {
  # create_backup <prefix> <label> — prints the new dump path on stdout.
  local p="$1" label db dir ts base partial
  label=$(sanitize_label "${2:-manual}")
  db=$(_v "$p" DB)
  dir=$(_v "$p" BACKUP_DIR)
  require_db_container "$p"
  db_exists "$p" "$db" || die "Database $db does not exist in $(_v "$p" CONTAINER)"
  mkdir -p "$dir" && chmod 700 "$dir" "$BACKUP_ROOT" 2>/dev/null || true
  ts=$(utc_now)
  base="$dir/$(_v "$p" LABEL)_${ts}_${label}"
  partial="$base.dump.partial"
  (
    umask 077
    trap 'rm -f "$partial" "$base.meta.partial"' EXIT
    step "Backing up $(_v "$p" SPEC) ($(_v "$p" CONTAINER)/$db) — label '$label'"
    rows_before=$(row_fingerprint "$p" "$db")
    dump_db "$p" "$db" "$partial" || die "pg_dump failed"
    dump_readable "$p" "$partial" || die "Fresh dump is not readable by pg_restore"
    write_meta "$p" "$db" "$partial" "$label" "$base.meta.partial" "$rows_before"
    sed -i.bak "s|^file=.*|file=$(basename "$base").dump|" "$base.meta.partial" && rm -f "$base.meta.partial.bak"
    mv "$partial" "$base.dump"
    mv "$base.meta.partial" "$base.meta"
    trap - EXIT
  ) || exit 1
  info "✅ $(basename "$base").dump ($(human_size "$(file_size "$base.dump")"), rev $(meta_get "$base.meta" alembic_rev), $(meta_get "$base.meta" row_total) rows)"
  printf '%s\n' "$base.dump"
}

# ── Migration target for restored DBs ────────────────────────

migration_source() {
  # migration_source <prefix> — source tree whose migrations match the code running against this env.
  local p="$1" kind sha short wt
  kind=$(_v "$p" KIND)
  case "$kind" in
    dev|scenario) printf '%s' "$REPO_ROOT"; return ;;
  esac
  sha=$(git -C "$REPO_ROOT" rev-parse --verify --quiet "refs/deploys/$kind/db" 2>/dev/null || true)
  if [ -z "$sha" ]; then
    [ "$kind" = prod ] && die "No refs/deploys/prod/db — cannot tell which migrations prod runs. Deploy the db first or use MIGRATE=0."
    warn "No refs/deploys/$kind/db — migrating with the working tree"
    printf '%s' "$REPO_ROOT"; return
  fi
  short=$(git -C "$REPO_ROOT" rev-parse --short=7 "$sha")
  wt="$REPO_ROOT/.worktrees/ref-$short"
  if [ ! -d "$wt" ]; then
    mkdir -p "$REPO_ROOT/.worktrees"
    git -C "$REPO_ROOT" worktree add --detach "$wt" "$sha" >/dev/null 2>&1 || die "Could not create worktree $wt for refs/deploys/$kind/db"
  fi
  printf '%s' "$wt"
}

rev_known() {
  # rev_known <source_tree> <rev>
  grep -rqsE "^revision([^=]*)=[[:space:]]*['\"]$2['\"]" "$1/backend/db/alembic/versions/"
}

head_rev() {
  (cd "$1" && PYTHONPATH="$1" "$ALEMBIC_BIN" -c backend/alembic.ini heads 2>/dev/null | awk '/\(head\)/ {print $1}' | head -1)
}

migrate_db() {
  # migrate_db <prefix> <db> <source_tree>
  local p="$1" url
  url="postgresql://$(_v "$p" USER):$(_v "$p" PASS)@$(_v "$p" HOST):$(_v "$p" PORT)/$2"
  (cd "$3" && PYTHONPATH="$3" DATABASE_URL="$url" "$ALEMBIC_BIN" -c backend/alembic.ini upgrade head 2>&1 | sed 's/^/   /' >&2)
}

# ── Restore engine: tmp DB → verify → migrate → atomic rename swap ──

restore_dump() {
  # restore_dump <prefix> <dumpfile> <provenance> [safety_backup_label]
  # Honors: DRY_RUN=1, MIGRATE=0, NO_BACKUP=1, ASSUME_YES=1, CONFIRM=<db>, EXPECTED_META=<meta file>.
  # Sets PRE_BACKUP to the safety dump taken of a staging/prod target.
  local p="$1" f="$2" provenance="$3" safety_label="${4:-pre-restore}" live tmp ts pre meta src="" dump_rev expected_rev live_rev
  live=$(_v "$p" DB)
  tmp="${live}__restore_tmp"
  meta="${EXPECTED_META:-${f%.dump}.meta}"
  ts=$(utc_now | tr '[:upper:]' '[:lower:]')
  pre="${live}__pre_restore_${ts}"

  require_db_container "$p"
  step "Checking backup file"
  verify_dump "$p" "$f"

  dump_rev=$(meta_get "$meta" alembic_rev)
  live_rev=""
  db_exists "$p" "$live" && live_rev=$(alembic_rev "$p" "$live")

  if [ "${MIGRATE:-1}" != "0" ]; then
    src=$(migration_source "$p") || exit 1
    expected_rev=$(head_rev "$src")
    if [ -n "$dump_rev" ] && ! rev_known "$src" "$dump_rev"; then
      die "Backup is at migration '$dump_rev', which the target's code ($src) does not know (backup is newer or from another branch). Refusing."
    fi
  fi

  echo "" >&2
  echo "🔄 Restore plan" >&2
  echo "═══════════════════════════════════════════════════" >&2
  info "Backup:    $(basename "$f") ($(human_size "$(file_size "$f")"))"
  info "Target:    $(_v "$p" SPEC) → $(_v "$p" CONTAINER)/$live (currently rev ${live_rev:-none})"
  info "Backup at: rev ${dump_rev:-unknown}, $(meta_get "$meta" row_total || true) rows"
  if [ "${MIGRATE:-1}" != "0" ]; then
    info "Migrate:   → ${expected_rev:-?} using $src"
  else
    info "Migrate:   no (MIGRATE=0, exact snapshot)"
  fi
  info "Steps:     restore into $tmp → check rows → migrate → rename $live → $pre, $tmp → $live"
  echo "═══════════════════════════════════════════════════" >&2

  if [ "${DRY_RUN:-0}" = "1" ]; then
    echo "" >&2
    echo "🔍 Dry run — no changes made." >&2
    return 0
  fi

  if [ "$(_v "$p" KIND)" = prod ]; then
    confirm_typed "$live"
  else
    confirm_yn "Replace $(_v "$p" SPEC) database $live?"
  fi

  PRE_BACKUP=""
  if [ "$(_v "$p" PROTECTED)" = 1 ] && [ "${NO_BACKUP:-0}" != "1" ] && db_exists "$p" "$live"; then
    PRE_BACKUP=$(create_backup "$p" "$safety_label")
  fi

  drop_db "$p" "$tmp" >/dev/null
  trap 'drop_db "'"$p"'" "'"$tmp"'" >/dev/null 2>&1 || true; run_exit_hook' EXIT

  step "Restoring into $tmp"
  create_db "$p" "$tmp" >/dev/null
  restore_into "$p" "$tmp" "$f" || die "pg_restore failed — $live was not touched"
  info "✅ Restored"

  if [ -f "$meta" ] && [ -n "$(meta_rows "$meta")" ]; then
    step "Comparing row counts with the backup's .meta"
    local got
    got=$(row_fingerprint "$p" "$tmp")
    if [ "$got" != "$(meta_rows "$meta")" ]; then
      diff <(meta_rows "$meta") <(printf '%s\n' "$got") | sed 's/^/   /' >&2 || true
      die "Row counts differ from the backup's .meta — $live was not touched"
    fi
    info "✅ $(printf '%s\n' "$got" | wc -l | tr -d ' ') tables, row counts match"
  fi

  if [ "${MIGRATE:-1}" != "0" ]; then
    step "Migrating $tmp to ${expected_rev:-head}"
    migrate_db "$p" "$tmp" "$src" || die "Migration failed — $live was not touched"
    info "✅ Now at rev $(alembic_rev "$p" "$tmp")"
  fi

  pg_psql "$p" postgres -c "COMMENT ON DATABASE \"$tmp\" IS '$provenance; restored_at=$(utc_iso); rev=$(alembic_rev "$p" "$tmp")'" >/dev/null

  step "Swapping $tmp → $live"
  if db_exists "$p" "$live"; then
    pg_psql "$p" postgres >/dev/null <<SQL
ALTER DATABASE "$live" WITH ALLOW_CONNECTIONS false;
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('$live', '$tmp') AND pid <> pg_backend_pid();
ALTER DATABASE "$live" RENAME TO "$pre";
ALTER DATABASE "$tmp" RENAME TO "$live";
ALTER DATABASE "$pre" WITH ALLOW_CONNECTIONS true;
SQL
    info "✅ Previous database kept as $pre"
  else
    pg_psql "$p" postgres -c "ALTER DATABASE \"$tmp\" RENAME TO \"$live\"" >/dev/null
    info "✅ $live created"
  fi
  trap run_exit_hook EXIT

  restart_backend "$p"
}

restart_backend() {
  local p="$1" c port i
  c=$(_v "$p" BACKEND_CONTAINER)
  if container_running "$c"; then
    step "Restarting $c (drops connections to the old database)"
    docker restart "$c" >/dev/null
    port=$(_v "$p" API_PORT)
    if [ -n "$port" ]; then
      for i in $(seq 1 30); do
        curl -sf "http://localhost:$port/api/v1/health" >/dev/null 2>&1 && { info "✅ Backend healthy on :$port"; return 0; }
        sleep 1
      done
      warn "Backend did not report healthy on :$port within 30s"
    fi
  else
    info "No backend container running for $(_v "$p" SPEC) — a locally running backend reconnects on its next request (pool_pre_ping)"
  fi
}

pre_restore_dbs() { pg_query "$1" postgres "SELECT datname FROM pg_database WHERE datname LIKE '$(_v "$1" DB)\_\_pre\_restore\_%' ORDER BY datname DESC"; }

# Callers needing cleanup set EXIT_HOOK instead of their own EXIT trap (restore_dump owns the trap).
EXIT_HOOK=""
run_exit_hook() { if [ -n "$EXIT_HOOK" ]; then eval "$EXIT_HOOK" || true; fi; }

confirm_yn() {
  local reply
  [ "${ASSUME_YES:-0}" = "1" ] && return 0
  [ -r /dev/tty ] && [ -t 0 ] || die "Non-interactive: pass ASSUME_YES=1 to confirm"
  printf '%s [y/N] ' "$1" >&2
  read -r reply </dev/tty
  case "$reply" in y|Y|yes) ;; *) echo "Cancelled — nothing changed." >&2; exit 1 ;; esac
}

confirm_typed() {
  # Prod needs the DB name typed back (or CONFIRM=<db> when non-interactive).
  local want="$1" got="${CONFIRM:-}"
  if [ -z "$got" ]; then
    [ -r /dev/tty ] && [ -t 0 ] || die "Non-interactive prod restore: pass CONFIRM=$want"
    printf '🚨 This replaces the PRODUCTION database. Type its name (%s) to continue: ' "$want" >&2
    read -r got </dev/tty
  fi
  [ "$got" = "$want" ] || die "Confirmation did not match — nothing changed"
}

next_steps() {
  echo "" >&2
  echo "Next:" >&2
  local line
  for line in "$@"; do echo "   $line" >&2; done
}
