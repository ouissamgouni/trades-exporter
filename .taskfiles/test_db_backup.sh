#!/usr/bin/env bash
# End-to-end check of db backup / restore / rollback / commit / copy / prune on two
# throwaway scenario databases. Never touches dev, staging or prod. KEEP_SCENARIOS=1 skips teardown.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=.taskfiles/db_lib.sh
source .taskfiles/db_lib.sh

SRC=bk-src
DST=bk-dst
SEED_DST="${SEED_DST:-scenarios/demo}"
WORK="$BACKUP_ROOT/.tmp/test-db-backup"

t() { task ASSUME_YES=1 "$@"; }
hdr() { echo ""; echo "━━ $* ━━"; }
ok() { echo "  ✅ $*"; }
fail() { echo "  ❌ $*"; exit 1; }
expect_fail() { if "$@" >"$WORK/out.log" 2>&1; then cat "$WORK/out.log"; fail "expected failure: $*"; fi; }

teardown() {
  local rc=$?
  if [ "${KEEP_SCENARIOS:-0}" = "1" ]; then
    echo "KEEP_SCENARIOS=1 — leaving scenarios $SRC/$DST running"
  else
    task stop:scenario SCENARIO=$SRC KEEP_BROWSER=1 --yes >/dev/null 2>&1 || true
    task stop:scenario SCENARIO=$DST KEEP_BROWSER=1 --yes >/dev/null 2>&1 || true
    rm -rf "$BACKUP_ROOT/scenarios/$SRC" "$BACKUP_ROOT/scenarios/$DST" "$WORK"
  fi
  [ $rc -eq 0 ] && echo "" && echo "🎉 All db backup/restore checks passed" || echo "💥 FAILED (exit $rc)"
}
trap teardown EXIT
mkdir -p "$WORK"

hdr "1-2. Start a source and a target scenario DB with different data"
t start:scenario:db SCENARIO=$SRC RESET=1 >/dev/null
t start:scenario:db SCENARIO=$DST RESET=1 SEED_DIR="$SEED_DST" >/dev/null
resolve_env "scenario:$SRC" S
resolve_env "scenario:$DST" D
SRC_ROWS=$(row_fingerprint S "$S_DB")
DST_ROWS=$(row_fingerprint D "$D_DB")
[ "$SRC_ROWS" != "$DST_ROWS" ] || fail "source and target have identical row counts — use another SEED_DST"
ok "source and target differ"

hdr "3. Backup"
t db:backup:scenario SCENARIO=$SRC LABEL="Test Run" >/dev/null 2>&1
DUMP=$(list_dumps "$S_BACKUP_DIR" | head -1)
META="${DUMP%.dump}.meta"
case "$(basename "$DUMP")" in scenario-${SRC}_*Z_test-run.dump) ok "named $(basename "$DUMP")" ;; *) fail "unexpected name $DUMP" ;; esac
[ -f "$META" ] || fail "no .meta"
[ "$(meta_get "$META" sha256)" = "$(sha256_of "$DUMP")" ] || fail ".meta checksum differs"
[ "$(meta_rows "$META")" = "$SRC_ROWS" ] || fail ".meta row counts differ from the source"
[ "$(stat -f %Lp "$DUMP")" = "600" ] || fail "dump is not chmod 600"
ok ".meta checksum + row counts match the source, file is 600"

hdr "4. List with checksum verification"
t db:backup:list ENV=scenario:$SRC VERIFY=1 >"$WORK/out.log" 2>&1
grep -q "test-run" "$WORK/out.log" && grep -q "✅" "$WORK/out.log" || { cat "$WORK/out.log"; fail "list did not show a verified backup"; }
ok "listed and verified"

hdr "5. Restore dry run changes nothing"
t db:restore:scenario SCENARIO=$DST FROM_ENV=scenario:$SRC FILE=latest DRY_RUN=1 >/dev/null 2>&1
[ "$(row_fingerprint D "$D_DB")" = "$DST_ROWS" ] || fail "dry run modified the target"
ok "target untouched"

hdr "6. Restore"
t db:restore:scenario SCENARIO=$DST FROM_ENV=scenario:$SRC FILE=latest >/dev/null 2>&1
[ "$(row_fingerprint D "$D_DB")" = "$SRC_ROWS" ] || fail "target rows differ from the source after restore"
pg_query D postgres "SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = '$D_DB'" | grep -q "restored_from=$(basename "$DUMP")" || fail "provenance comment missing"
ok "target now matches the source, provenance recorded"

hdr "7. Status shows the kept previous database"
t db:restore:status:scenario SCENARIO=$DST >"$WORK/out.log" 2>&1
grep -q "${D_DB}__pre_restore_" "$WORK/out.log" || { cat "$WORK/out.log"; fail "no __pre_restore_ database listed"; }
ok "previous database kept"

hdr "8. Rollback"
t db:restore:rollback:scenario SCENARIO=$DST >/dev/null 2>&1
[ "$(row_fingerprint D "$D_DB")" = "$DST_ROWS" ] || fail "rollback did not bring back the original target rows"
[ -z "$(pre_restore_dbs D)" ] || fail "pre-restore database still present after rollback"
ok "original target data is back"

hdr "9. Corrupted backup is rejected and the target is untouched"
cp "$DUMP" "$WORK/corrupt.dump"; cp "$META" "$WORK/corrupt.meta"
printf 'X' | dd of="$WORK/corrupt.dump" bs=1 seek=200 conv=notrunc 2>/dev/null
expect_fail t db:restore:scenario SCENARIO=$DST FILE="$WORK/corrupt.dump"
grep -q "Checksum mismatch" "$WORK/out.log" || { cat "$WORK/out.log"; fail "wrong failure reason"; }
[ "$(row_fingerprint D "$D_DB")" = "$DST_ROWS" ] || fail "target changed"
db_exists D "${D_DB}__restore_tmp" && fail "temp database left behind"
ok "rejected (checksum), target untouched"

hdr "9b. Backup from unknown migration revision is refused"
cp "$DUMP" "$WORK/ahead.dump"; sed 's/^alembic_rev=.*/alembic_rev=zz_unknown_rev/' "$META" >"$WORK/ahead.meta"
expect_fail t db:restore:scenario SCENARIO=$DST FILE="$WORK/ahead.dump"
grep -q "does not know" "$WORK/out.log" || { cat "$WORK/out.log"; fail "wrong failure reason"; }
[ "$(row_fingerprint D "$D_DB")" = "$DST_ROWS" ] || fail "target changed"
ok "refused, target untouched"

hdr "10-11. Restore again, copy over it, then commit"
t db:restore:scenario SCENARIO=$DST FROM_ENV=scenario:$SRC FILE=latest >/dev/null 2>&1
t db:copy -- scenario:$SRC scenario:$DST >/dev/null 2>&1
[ "$(row_fingerprint D "$D_DB")" = "$SRC_ROWS" ] || fail "copy result differs from the source"
pg_query D postgres "SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = '$D_DB'" | grep -q "copied_from=scenario:$SRC" || fail "copy provenance missing"
[ "$(pre_restore_dbs D | wc -l | tr -d ' ')" = "2" ] || fail "expected 2 kept databases (restore + copy)"
t db:restore:commit:scenario SCENARIO=$DST >/dev/null 2>&1
[ -z "$(pre_restore_dbs D)" ] || fail "commit left pre-restore databases"
[ "$(row_fingerprint D "$D_DB")" = "$SRC_ROWS" ] || fail "commit changed live data"
ok "copy matches source, commit dropped both kept databases"

hdr "12. Prune keeps the newest"
sleep 1
t db:backup:scenario SCENARIO=$SRC LABEL=second >/dev/null 2>&1
t db:backup:prune:scenario SCENARIO=$SRC KEEP=1 >/dev/null 2>&1
REMAINING=$(list_dumps "$S_BACKUP_DIR")
[ "$(printf '%s\n' "$REMAINING" | wc -l | tr -d ' ')" = "1" ] || fail "expected 1 backup after prune"
case "$REMAINING" in *_second.dump) ;; *) fail "prune kept the wrong file: $REMAINING" ;; esac
[ -f "${REMAINING%.dump}.meta" ] && [ ! -f "$META" ] || fail ".meta files not pruned with their dumps"
ok "newest kept, older dump + .meta removed"

hdr "13. Teardown"
