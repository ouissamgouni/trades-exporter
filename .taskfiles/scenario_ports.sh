#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Scenario port resolution for multi-scenario support.
# Source this at the top of start.yml/stop.yml/db.yml/logs.yml cmd blocks:
#   source .taskfiles/scenario_ports.sh "{{.SCENARIO}}"
#
# Exports:
#   QA_PORT_OFFSET, QA_DB_PORT, QA_API_PORT, QA_WEB_PORT,
#   QA_ENV_NAME, QA_PROJECT, QA_DB_CONTAINER, QA_BACKEND_CONTAINER,
#   QA_FRONTEND_CONTAINER
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
  QA_PORT_OFFSET=$PORT_OFFSET
elif [ -z "$_SCENARIO" ] || [ "$_SCENARIO" = "default" ]; then
  QA_PORT_OFFSET=0
else
  # Deterministic hash: cksum of name → offset 1–9999
  QA_PORT_OFFSET=$(printf '%s' "$_SCENARIO" | cksum | awk '{print ($1 % 9999) + 1}')
fi

# ── Compute ports ───────────────────────────────────────────
QA_DB_PORT=$((5435 + QA_PORT_OFFSET))
QA_API_PORT=$((8002 + QA_PORT_OFFSET))
QA_WEB_PORT=$((3002 + QA_PORT_OFFSET))

# ── Naming (backward compat: empty/default = same as today) ─
if [ -z "$_SCENARIO" ] || [ "$_SCENARIO" = "default" ]; then
  QA_ENV_NAME=qa
  QA_PROJECT=trades-exporter-qa
  QA_DB_CONTAINER=trades_db_qa
  QA_BACKEND_CONTAINER=trades_backend_qa
  QA_FRONTEND_CONTAINER=trades_frontend_qa
else
  QA_ENV_NAME="qa-${_SCENARIO}"
  QA_PROJECT="trades-exporter-qa-${_SCENARIO}"
  QA_DB_CONTAINER="trades_db_qa-${_SCENARIO}"
  QA_BACKEND_CONTAINER="trades_backend_qa-${_SCENARIO}"
  QA_FRONTEND_CONTAINER="trades_frontend_qa-${_SCENARIO}"
fi

# ── Export for docker compose substitution ──────────────────
export POSTGRES_PORT=$QA_DB_PORT
export BACKEND_PORT=$QA_API_PORT
export FRONTEND_PORT=$QA_WEB_PORT
export ENV_NAME=$QA_ENV_NAME
export IMAGE_TAG=$QA_ENV_NAME
