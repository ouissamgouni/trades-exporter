#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Scenario port resolution for multi-scenario support.
# Source this at the top of start.yml/stop.yml/db.yml/logs.yml cmd blocks:
#   source .taskfiles/scenario_ports.sh "{{.SCENARIO}}"
#
# Naming/variable convention mirrors salsa-events-calendar's
# scenario_ports.sh (SC_* prefix, ENV_NAME unprefixed, "scenario-<name>"
# labels). The unnamed/default instance uses "scenario-default" (rather
# than bare "scenario") to avoid colliding with the tracked
# config/scenario.env template that the runtime config/${ENV_NAME}.env
# symlink is created from.
#
# Exports:
#   SC_PORT_OFFSET, SC_DB_PORT, SC_API_PORT, SC_WEB_PORT,
#   ENV_NAME, SC_PROJECT_NAME, SC_DB_CONTAINER, SC_BACKEND_CONTAINER,
#   SC_FRONTEND_CONTAINER, SC_DB_NAME (+ SC_DEBUGPY_PORT for dev)
#
# Port assignment:
#   - dev                 → pinned (5432/8000/5173, debugpy 5678) — dev is just
#                           a scenario named "dev"; see scenarios/dev/config.env
#   - default / empty     → offset 0  (ports 5435/8002/3002)
#   - PORT_OFFSET=N       → explicit override, always wins
#   - any other name      → hash-based: cksum of name mod 9999 + 1,
#                           auto-skipping any offset whose ports collide with a
#                           reserved fixed-env port (see RESERVED_PORTS below)
#
# Base ports (from config/scenario.env): DB=5435, API=8002, WEB=3002
# Reserved (never used by scenarios): dev 5432/8000/5173/5678,
#   staging 5433/8001/3001, prod 5434/8080/3000
# Run `task scenarios` to see all current port assignments.
# ─────────────────────────────────────────────────────────────

_SCENARIO="${1:-}"
# ── Reserved ports (fixed local envs) ─────────────────
# Scenario ports are hash-derived and must never land on a port that a fixed
# env (dev/staging/prod) statically binds. Keep this list in sync with
# scenarios/dev/config.env + config/{staging,prod}.local.env (POSTGRES_PORT/BACKEND_PORT/FRONTEND_PORT +
# dev DEBUGPY_PORT). Named scenarios skip any offset colliding with these.
RESERVED_PORTS="5432 8000 5173 5678 5433 8001 3001 5434 8080 3000"
_port_reserved() {
  case " $RESERVED_PORTS " in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}
# ── Port offset resolution (hash-based) ────────────────────
if [ "$_SCENARIO" = "dev" ]; then
  SC_PORT_OFFSET=0
elif [ -n "${PORT_OFFSET:-}" ]; then
  # Explicit override always wins
  SC_PORT_OFFSET=$PORT_OFFSET
elif [ -z "$_SCENARIO" ] || [ "$_SCENARIO" = "default" ]; then
  SC_PORT_OFFSET=0
else
  # Deterministic hash: cksum of name → offset 1–9999
  SC_PORT_OFFSET=$(printf '%s' "$_SCENARIO" | cksum | awk '{print ($1 % 9999) + 1}')

  # Skip offsets whose resulting ports collide with a reserved fixed-env port
  # (dev/staging/prod). Deterministic: same name always starts from the same
  # hash and steps +1 the same way, so it resolves to the same final offset.
  _tries=0
  while :; do
    _db=$((5435 + SC_PORT_OFFSET))
    _api=$((8002 + SC_PORT_OFFSET))
    _web=$((3002 + SC_PORT_OFFSET))
    if _port_reserved "$_db" || _port_reserved "$_api" || _port_reserved "$_web"; then
      SC_PORT_OFFSET=$(( (SC_PORT_OFFSET % 9999) + 1 ))
      _tries=$((_tries + 1))
      [ "$_tries" -ge 9999 ] && break
      continue
    fi
    break
  done
fi

# ── Compute ports ───────────────────────────────────────────
if [ "$_SCENARIO" = "dev" ]; then
  SC_DB_PORT=5432
  SC_API_PORT=8000
  SC_WEB_PORT=5173
  SC_DEBUGPY_PORT=5678
else
  SC_DB_PORT=$((5435 + SC_PORT_OFFSET))
  SC_API_PORT=$((8002 + SC_PORT_OFFSET))
  SC_WEB_PORT=$((3002 + SC_PORT_OFFSET))
fi

# ── Naming ────────────────────────────────────────────────────
if [ "$_SCENARIO" = "dev" ]; then
  ENV_NAME=dev
  SC_PROJECT_NAME=trades-exporter-dev
  SC_DB_CONTAINER=trades_db_dev
  SC_BACKEND_CONTAINER=trades_backend_dev
  SC_FRONTEND_CONTAINER=trades_frontend_dev
  SC_DB_NAME=trades_db_dev
elif [ -z "$_SCENARIO" ] || [ "$_SCENARIO" = "default" ]; then
  ENV_NAME=scenario-default
  SC_PROJECT_NAME=trades-exporter-scenario-default
  SC_DB_CONTAINER=trades_db_scenario-default
  SC_BACKEND_CONTAINER=trades_backend_scenario-default
  SC_FRONTEND_CONTAINER=trades_frontend_scenario-default
else
  ENV_NAME="scenario-${_SCENARIO}"
  SC_PROJECT_NAME="trades-exporter-scenario-${_SCENARIO}"
  SC_DB_CONTAINER="trades_db_scenario-${_SCENARIO}"
  SC_BACKEND_CONTAINER="trades_backend_scenario-${_SCENARIO}"
  SC_FRONTEND_CONTAINER="trades_frontend_scenario-${_SCENARIO}"
fi

# Every non-dev scenario has its own container, so they share one DB name.
[ "$_SCENARIO" = "dev" ] || SC_DB_NAME=trades_db_scenario

# ── Export for docker compose substitution ──────────────────
export POSTGRES_PORT=$SC_DB_PORT
export BACKEND_PORT=$SC_API_PORT
export FRONTEND_PORT=$SC_WEB_PORT
export ENV_NAME
export IMAGE_TAG=$ENV_NAME
export SC_PORT_OFFSET SC_DB_PORT SC_API_PORT SC_WEB_PORT SC_DB_NAME
export SC_PROJECT_NAME SC_DB_CONTAINER SC_BACKEND_CONTAINER SC_FRONTEND_CONTAINER
