#!/usr/bin/env bash
# Compose wiring for a scenario (dev included): every service of an
# environment lives in ONE compose project ($SC_PROJECT_NAME).
#
# Usage (after sourcing scenario_ports.sh so SC_* are set):
#   source .taskfiles/scenario_compose.sh <repo-root>
#   docker compose -p $SC_PROJECT_NAME up -d postgres

_sc_root="$1"

COMPOSE_FILE="${_sc_root}/infra/docker/docker-compose.db.yml"
export COMPOSE_FILE

# Placeholders so `docker compose` can interpolate even when a task loads no dotenv.
: "${POSTGRES_USER:=trades_user}"
: "${POSTGRES_PASSWORD:=trades_password}"
: "${POSTGRES_DB:=${SC_DB_NAME:-postgres}}"
export POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB

# Containers carry pinned names, so ones left over from an older compose
# project would collide with `up`. Data lives in named volumes and is
# untouched by removing the container.
sc_compose_adopt_containers() {
  local container project
  for container in "trades_db_${ENV_NAME}"; do
    project=$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$container" 2>/dev/null || true)
    if [ -n "$project" ] && [ "$project" != "$SC_PROJECT_NAME" ]; then
      echo "↪️  Adopting $container into compose project $SC_PROJECT_NAME (data volume kept)"
      docker rm -f "$container" >/dev/null 2>&1 || true
    fi
  done
}

unset _sc_root
