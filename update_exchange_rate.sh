#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/services/.env"
PAIR="${2:-USD_BRL}"
RATE="${1:-}"

if [[ -z "$RATE" || ! "$RATE" =~ ^[0-9]+(\.[0-9]{1,4})?$ || "$RATE" =~ ^0+(\.0+)?$ ]]; then
  echo "Uso: $0 <cotacao> [par]" >&2
  echo "Exemplo: $0 5.4200 USD_BRL" >&2
  exit 1
fi

if [[ ! "$PAIR" =~ ^[A-Z0-9_]+$ ]]; then
  echo "Erro: o par deve conter somente letras maiusculas, numeros e underscore." >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Erro: arquivo de ambiente nao encontrado: $ENV_FILE" >&2
  exit 1
fi

set -a
source "$ENV_FILE"
set +a

: "${DB_USER:?DB_USER deve ser informado em services/.env}"
: "${DB_PASSWORD:?DB_PASSWORD deve ser informado em services/.env}"
: "${DB_NAME:?DB_NAME deve ser informado em services/.env}"
: "${DB_HOST:?DB_HOST deve ser informado em services/.env}"
: "${DB_PORT:?DB_PORT deve ser informado em services/.env}"
: "${DB_CONTAINER_NAME:?DB_CONTAINER_NAME deve ser informado em services/.env}"

if ! docker inspect -f '{{.State.Running}}' "$DB_CONTAINER_NAME" 2>/dev/null | grep -q '^true$'; then
  echo "Erro: o container $DB_CONTAINER_NAME nao esta em execucao." >&2
  exit 1
fi

docker exec -i \
  -e PGPASSWORD="$DB_PASSWORD" \
  "$DB_CONTAINER_NAME" \
  psql -v ON_ERROR_STOP=1 \
    -h "$DB_HOST" \
    -p "$DB_PORT" \
    -U "$DB_USER" \
    -d "$DB_NAME" \
    --set=pair="$PAIR" \
    --set=rate="$RATE" <<'SQL'
BEGIN;

WITH previous AS (
  SELECT pair, rate, updated_at
  FROM exchange_rates
  WHERE pair = :'pair'
  ORDER BY updated_at DESC
  LIMIT 1
), inserted AS (
  INSERT INTO exchange_rates (pair, rate, updated_at)
  VALUES (:'pair', :'rate'::numeric, NOW())
  RETURNING id, pair, rate, updated_at
)
INSERT INTO audit_events (
  event_type, entity_type, entity_id, action,
  previous_data, current_data, metadata
)
SELECT
  'EXCHANGE_RATE_UPDATED',
  'EXCHANGE_RATE',
  inserted.pair,
  'CREATE',
  COALESCE(to_jsonb(previous), 'null'::jsonb),
  to_jsonb(inserted),
  jsonb_build_object('source', 'update_exchange_rate.sh')
FROM inserted
LEFT JOIN previous ON previous.pair = inserted.pair;

COMMIT;
SQL

echo "Cotacao $PAIR atualizada para $RATE com auditoria registrada."
