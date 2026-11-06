#!/usr/bin/env bash
# Deploy one component of a local docker-compose env (staging|prod) from SOURCE_DIR.
# Env (ENV_NAME, IMAGE_TAG, ports, DATABASE_URL) comes from the calling task's dotenv.
# Usage: deploy_component.sh <db|backend|frontend> [SOURCE_DIR] [VERSION_TAG]
set -euo pipefail

COMPONENT="${1:?component required (db|backend|frontend)}"
SRC="$(cd "${2:-.}" && pwd)"
VERSION_TAG="${3:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${ENV_NAME:?ENV_NAME not set — call via a deploy:<env>:local:* task}"
: "${IMAGE_TAG:?IMAGE_TAG not set — call via a deploy:<env>:local:* task}"

COMPOSE=(docker compose -f "$ROOT/infra/docker/docker-compose.unified.yml" -p "trades-exporter-$ENV_NAME")

image_tags() {
  echo "-t trades-exporter-$1:$IMAGE_TAG"
  if [ -n "$VERSION_TAG" ]; then echo "-t trades-exporter-$1:$VERSION_TAG"; fi
}

case "$COMPONENT" in
  db)
    "${COMPOSE[@]}" up -d --wait postgres
    echo "Running migrations from $SRC on localhost:$POSTGRES_PORT/$POSTGRES_DB..."
    # alembic.ini prepends the cwd to sys.path, so run from inside SOURCE_DIR.
    (cd "$SRC" && PYTHONPATH="$SRC" "$ROOT/.venv/bin/alembic" -c backend/alembic.ini upgrade head)
    echo "✅ Migrations applied"
    ;;
  backend)
    # shellcheck disable=SC2046
    docker build $(image_tags backend) -f "$SRC/backend/Dockerfile" "$SRC"
    # --no-deps skips postgres; ensure it exists or the backend cannot resolve host "postgres".
    "${COMPOSE[@]}" up -d --wait postgres
    "${COMPOSE[@]}" up -d --no-deps --wait backend
    HEALTH_URL="http://localhost:$BACKEND_PORT/api/v1/health"
    echo "Smoke test: GET $HEALTH_URL"
    if curl -sf --retry 6 --retry-delay 5 --retry-connrefused "$HEALTH_URL" >/dev/null; then
      echo "✅ Backend health check passed: $HEALTH_URL"
    else
      echo "⚠️  Health check failed or timed out — check: task logs:$ENV_NAME:local"
    fi
    ;;
  frontend)
    # shellcheck disable=SC2046
    docker build $(image_tags frontend) --build-arg VITE_API_URL="http://localhost:$BACKEND_PORT" "$SRC/frontend"
    "${COMPOSE[@]}" up -d --no-deps frontend
    echo "✅ Frontend running on http://localhost:$FRONTEND_PORT"
    ;;
  *)
    echo "❌ Unknown component '$COMPONENT' (expected db|backend|frontend)" >&2
    exit 1
    ;;
esac
