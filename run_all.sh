#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_DIR="$SCRIPT_DIR/services"
COMPOSE_FILE="$COMPOSE_DIR/docker-compose.yaml"
ENV_FILE="$COMPOSE_DIR/.env"

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "Erro: arquivo Docker Compose não encontrado: $COMPOSE_FILE" >&2
  exit 1
fi

compose_args=(--file "$COMPOSE_FILE")
if [[ -f "$ENV_FILE" ]]; then
  compose_args+=(--env-file "$ENV_FILE")
fi

cd "$COMPOSE_DIR"
echo "Destruindo os contêineres do projeto..."
docker compose "${compose_args[@]}" down --remove-orphans

echo "Reconstruindo e recriando os contêineres..."
docker compose "${compose_args[@]}" up -d --build --force-recreate

echo "Contêineres recriados."
docker compose "${compose_args[@]}" ps
