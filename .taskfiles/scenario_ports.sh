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
#   SC_FRONTEND_CONTAINER
#
# Port assignment:
#   - default / empty     → offset 0  (ports 5435/8002/3002)
#   - PORT_OFFSET=N       → explicit override, always wins
#   - any other name      → hash-based: cksum of name mod 9999 + 1
#
# Base ports (from config/scenario.env): DB=5435, API=8002, WEB=3002
# Run `task scenarios` to see all current port assignments.
# ─────────────────────────────────────────────────────────────

_SCENARIO="${1:-}"

# ── Port offset resolution (hash-based) ────────────────────
if [ -n "${PORT_OFFSET:-}" ]; then
  # Explicit override always wins
  SC_PORT_OFFSET=$PORT_OFFSET
elif [ -z "$_SCENARIO" ] || [ "$_SCENARIO" = "default" ]; then
  SC_PORT_OFFSET=0
else
  # Deterministic hash: cksum of name → offset 1–9999
  SC_PORT_OFFSET=$(printf '%s' "$_SCENARIO" | cksum | awk '{print ($1 % 9999) + 1}')
fi

# ── Compute ports ───────────────────────────────────────────
SC_DB_PORT=$((5435 + SC_PORT_OFFSET))
SC_API_PORT=$((8002 + SC_PORT_OFFSET))
SC_WEB_PORT=$((3002 + SC_PORT_OFFSET))

# ── Naming ────────────────────────────────────────────────────
if [ -z "$_SCENARIO" ] || [ "$_SCENARIO" = "default" ]; then
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

# ── Export for docker compose substitution ──────────────────
export POSTGRES_PORT=$SC_DB_PORT
export BACKEND_PORT=$SC_API_PORT
export FRONTEND_PORT=$SC_WEB_PORT
export ENV_NAME
export IMAGE_TAG=$ENV_NAME
