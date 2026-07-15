#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Shared DB schema bootstrap + seed, used by `start:scenario` (and its
# `scenario:db` / `scenario:backend` variants) for every named scenario,
# including the test-suite scenarios (`backend-integration-tests`,
# `backend-e2e-tests`, `frontend_e2e`). Assumes the target database already
# exists and is reachable.
#
# Required env:
#   ROOT_DIR      Repo root (for PYTHONPATH + locating .venv/alembic.ini)
#   DATABASE_URL  Connection string for the target database
#
# Optional env:
#   SEED_DIR       Path to a scenario seed directory (assets/accounts/...).
#                  Omit to seed default data only.
#   WITH_DEFAULTS  "1" to seed default data first, then layer SEED_DIR on top.
# ─────────────────────────────────────────────────────────────
set -euo pipefail

: "${ROOT_DIR:?ROOT_DIR must be set}"
: "${DATABASE_URL:?DATABASE_URL must be set}"

VENV_PY="$ROOT_DIR/.venv/bin/python"
VENV_ALEMBIC="$ROOT_DIR/.venv/bin/alembic"
ALEMBIC_INI="$ROOT_DIR/backend/alembic.ini"

export PYTHONPATH="$ROOT_DIR"
export DATABASE_URL

echo "Creating tables from SQLModel..."
"$VENV_PY" -c "from backend.db.database import get_engine; from backend.db.models import SQLModel; SQLModel.metadata.create_all(get_engine())"

echo "Stamping database to current migration..."
"$VENV_ALEMBIC" -c "$ALEMBIC_INI" stamp head

echo "Checking migration chain is in sync with current models (alembic check)..."
"$VENV_ALEMBIC" -c "$ALEMBIC_INI" check

if [ "${WITH_DEFAULTS:-0}" = "1" ] && [ -n "${SEED_DIR:-}" ]; then
  echo "Seeding default data first (WITH_DEFAULTS=1)..."
  "$VENV_PY" -m backend.scripts.seed
fi

if [ -n "${SEED_DIR:-}" ]; then
  echo "Seeding from $SEED_DIR..."
  "$VENV_PY" -m backend.scripts.seed --seed-dir "$SEED_DIR"
else
  echo "Seeding default data..."
  "$VENV_PY" -m backend.scripts.seed
fi

echo "✅ Database schema + seed ready"
