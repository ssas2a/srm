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
echo "ATENÇÃO: os contêineres, imagens e volumes dos serviços serão removidos."
echo "Incluindo o contêiner srm-postgres-db, a imagem postgres:16-alpine e o volume pgdata."
echo "Os dados persistidos do PostgreSQL serão apagados."

docker compose "${compose_args[@]}" down \
  --remove-orphans \
  --rmi all \
  --volumes

# Garante a remoção explícita dos recursos do banco, mesmo se o Compose
# não conseguir removê-los por causa de nomes ou referências antigas.
docker rm -f srm-postgres-db 2>/dev/null || true
mapfile -t postgres_images < <(docker image ls --format '{{.Repository}}:{{.Tag}}' | awk '$1 ~ /^postgres(:|$)/ { print $1 }')
if ((${#postgres_images[@]} > 0)); then
  docker image rm -f "${postgres_images[@]}" 2>/dev/null || true
fi
docker volume rm -f "${COMPOSE_PROJECT_NAME:-services}_pgdata" 2>/dev/null || true

echo "Contêineres, imagens e volumes dos serviços removidos, incluindo os recursos do banco de dados."
