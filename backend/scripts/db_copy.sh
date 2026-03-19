#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# db_copy.sh — Copy a PostgreSQL database between environments
# ─────────────────────────────────────────────────────────────
#
# Usage:
#   ./db_copy.sh <src_env_file> <dst_env_file> [--dry-run]
#
# Each env file must define:
#   POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB,
#   POSTGRES_HOST, POSTGRES_PORT
#
# Examples:
#   ./db_copy.sh .env.dev .env.test
#   ./db_copy.sh .env.test .env.prod --dry-run
# ─────────────────────────────────────────────────────────────
set -euo pipefail

# ── Helpers ──────────────────────────────────────────────────

die()  { echo "❌ $*" >&2; exit 1; }
info() { echo "   $*"; }

parse_env() {
  # parse_env <file> <prefix>  — sets PREFIX_USER, PREFIX_PASS, etc.
  local file="$1" prefix="$2"
  [[ -f "$file" ]] || die "Env file not found: $file"

  local user pass db host port
  user=$(grep '^POSTGRES_USER='     "$file" | head -1 | cut -d= -f2 | tr -d '\r')
  pass=$(grep '^POSTGRES_PASSWORD=' "$file" | head -1 | cut -d= -f2 | tr -d '\r')
  db=$(grep   '^POSTGRES_DB='       "$file" | head -1 | cut -d= -f2 | tr -d '\r')
  host=$(grep '^POSTGRES_HOST='     "$file" | head -1 | cut -d= -f2 | tr -d '\r')
  port=$(grep '^POSTGRES_PORT='     "$file" | head -1 | cut -d= -f2 | tr -d '\r')

  [[ -n "$user" ]] || die "POSTGRES_USER missing in $file"
  [[ -n "$pass" ]] || die "POSTGRES_PASSWORD missing in $file"
  [[ -n "$db"   ]] || die "POSTGRES_DB missing in $file"
  [[ -n "$host" ]] || die "POSTGRES_HOST missing in $file"
  [[ -n "$port" ]] || die "POSTGRES_PORT missing in $file"

  eval "${prefix}_USER='$user'"
  eval "${prefix}_PASS='$pass'"
  eval "${prefix}_DB='$db'"
  eval "${prefix}_HOST='$host'"
  eval "${prefix}_PORT='$port'"
}

table_count() {
  # table_count <host> <port> <user> <pass> <db> — prints number of public tables
  PGPASSWORD="$4" psql -h "$1" -p "$2" -U "$3" --no-password -d "$5" \
    -tAq -c "SELECT count(*) FROM pg_tables WHERE schemaname='public';" 2>/dev/null || echo "?"
}

test_connection() {
  # test_connection <host> <port> <user> <pass> <db> — returns 0 if OK
  PGPASSWORD="$4" psql -h "$1" -p "$2" -U "$3" --no-password -d "$5" \
    -tAq -c "SELECT 1;" >/dev/null 2>&1
}

# ── Parse arguments ──────────────────────────────────────────

DRY_RUN=false
SRC_ENV=""
DST_ENV=""

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    *)
      if [[ -z "$SRC_ENV" ]]; then
        SRC_ENV="$arg"
      elif [[ -z "$DST_ENV" ]]; then
        DST_ENV="$arg"
      else
        die "Unexpected argument: $arg"
      fi
      ;;
  esac
done

[[ -n "$SRC_ENV" ]] || die "Missing source env file.\nUsage: $0 <src_env> <dst_env> [--dry-run]"
[[ -n "$DST_ENV" ]] || die "Missing target env file.\nUsage: $0 <src_env> <dst_env> [--dry-run]"

# ── Parse env files ──────────────────────────────────────────

parse_env "$SRC_ENV" "SRC"
parse_env "$DST_ENV" "DST"

[[ "$SRC_DB" != "$DST_DB" || "$SRC_PORT" != "$DST_PORT" || "$SRC_HOST" != "$DST_HOST" ]] \
  || die "Source and target resolve to the same database ($SRC_HOST:$SRC_PORT/$SRC_DB)"

# ── Display plan ─────────────────────────────────────────────

echo ""
echo "🔄 Database Copy"
echo "═══════════════════════════════════════════════════"
echo "   Source:  $SRC_HOST:$SRC_PORT/$SRC_DB"
echo "   Target:  $DST_HOST:$DST_PORT/$DST_DB"
echo "═══════════════════════════════════════════════════"
echo ""

# ── Check connectivity ───────────────────────────────────────

echo "🔗 Checking connections..."
test_connection "$SRC_HOST" "$SRC_PORT" "$SRC_USER" "$SRC_PASS" "$SRC_DB" \
  || die "Cannot connect to source: $SRC_HOST:$SRC_PORT/$SRC_DB"
info "✅ Source OK"

# For target, try connecting to 'postgres' db first (target db may not exist yet)
test_connection "$DST_HOST" "$DST_PORT" "$DST_USER" "$DST_PASS" "postgres" \
  || die "Cannot connect to target host: $DST_HOST:$DST_PORT"
info "✅ Target host OK"
echo ""

# ── Table counts (before) ───────────────────────────────────

SRC_TABLES=$(table_count "$SRC_HOST" "$SRC_PORT" "$SRC_USER" "$SRC_PASS" "$SRC_DB")
echo "📊 Source tables: $SRC_TABLES"

if test_connection "$DST_HOST" "$DST_PORT" "$DST_USER" "$DST_PASS" "$DST_DB" 2>/dev/null; then
  DST_TABLES_BEFORE=$(table_count "$DST_HOST" "$DST_PORT" "$DST_USER" "$DST_PASS" "$DST_DB")
  echo "📊 Target tables (before): $DST_TABLES_BEFORE"
else
  echo "📊 Target database does not exist yet (will be created)"
fi
echo ""

# ── Dry-run stop ─────────────────────────────────────────────

if $DRY_RUN; then
  echo "🔍 Dry run — no changes made."
  exit 0
fi

# ── Step 1: Dump source ─────────────────────────────────────

DUMP_FILE=$(mktemp /tmp/trades_db_copy_XXXXXX.dump)
trap 'rm -f "$DUMP_FILE"' EXIT

echo "📤 Dumping source database..."
PGPASSWORD="$SRC_PASS" pg_dump \
  -h "$SRC_HOST" -p "$SRC_PORT" -U "$SRC_USER" \
  --no-password -Fc "$SRC_DB" -f "$DUMP_FILE"
info "Dump size: $(du -sh "$DUMP_FILE" | cut -f1)"
echo ""

# ── Step 2: Drop & recreate target ──────────────────────────

echo "🗑️  Dropping target database ($DST_DB)..."
PGPASSWORD="$DST_PASS" psql \
  -h "$DST_HOST" -p "$DST_PORT" -U "$DST_USER" \
  --no-password -d postgres \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DST_DB' AND pid <> pg_backend_pid();" \
  -c "DROP DATABASE IF EXISTS \"$DST_DB\";" \
  -c "CREATE DATABASE \"$DST_DB\" OWNER \"$DST_USER\";" \
  >/dev/null 2>&1
info "Recreated $DST_DB"
echo ""

# ── Step 3: Restore ─────────────────────────────────────────

echo "📥 Restoring into target database..."
# pg_restore returns exit code 1 for warnings (e.g. transaction_timeout on
# version mismatch). Capture the exit code and only fail on real errors.
set +e
RESTORE_OUTPUT=$(PGPASSWORD="$DST_PASS" pg_restore \
  -h "$DST_HOST" -p "$DST_PORT" -U "$DST_USER" \
  --no-password --no-owner --role="$DST_USER" \
  -d "$DST_DB" "$DUMP_FILE" 2>&1)
RESTORE_RC=$?
set -e

if [[ $RESTORE_RC -ne 0 ]]; then
  # Check if the output only contains warnings (not fatal errors)
  FATAL_ERRORS=$(echo "$RESTORE_OUTPUT" | grep -c "FATAL\|could not connect\|no matching tables" || true)
  if [[ $FATAL_ERRORS -gt 0 ]]; then
    echo "$RESTORE_OUTPUT"
    die "Restore failed with fatal errors (exit code $RESTORE_RC)"
  fi
  info "⚠️  pg_restore exited with warnings (non-fatal, usually version mismatch)"
fi
echo ""

# ── Step 4: Verify ──────────────────────────────────────────

echo "🔍 Verifying..."
DST_TABLES_AFTER=$(table_count "$DST_HOST" "$DST_PORT" "$DST_USER" "$DST_PASS" "$DST_DB")
echo "   Source tables: $SRC_TABLES"
echo "   Target tables: $DST_TABLES_AFTER"

if [[ "$SRC_TABLES" == "$DST_TABLES_AFTER" ]]; then
  info "✅ Table counts match"
else
  info "⚠️  Table count mismatch — check for errors above"
fi

echo ""
echo "✅ Done — $SRC_HOST:$SRC_PORT/$SRC_DB  →  $DST_HOST:$DST_PORT/$DST_DB"
