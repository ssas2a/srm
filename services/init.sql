-- Tabela de Histórico de Câmbio
CREATE TABLE IF NOT EXISTS exchange_rates (
    id SERIAL PRIMARY KEY,
    pair VARCHAR(10) NOT NULL,
    rate NUMERIC(10, 4) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_exchange_rates_pair_updated 
ON exchange_rates (pair, updated_at DESC);

-- Tabela de rastreabilidade dos eventos de negócio do backend
CREATE TABLE IF NOT EXISTS audit_events (
    id BIGSERIAL PRIMARY KEY,
    event_type VARCHAR(80) NOT NULL,
    entity_type VARCHAR(50) NOT NULL,
    entity_id VARCHAR(100),
    action VARCHAR(50) NOT NULL,
    previous_data JSONB,
    current_data JSONB,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_events_entity
ON audit_events (entity_type, entity_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_events_created_at
ON audit_events (created_at DESC);

-- Chaves de idempotência por cliente e por ativo
CREATE TABLE IF NOT EXISTS asset_idempotency_keys (
    cliente VARCHAR(100) NOT NULL,
    idempotency_key VARCHAR(150) NOT NULL,
    request_hash CHAR(64) NOT NULL,
    asset_id VARCHAR(50) NOT NULL UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (cliente, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_asset_idempotency_asset
ON asset_idempotency_keys (asset_id);

INSERT INTO exchange_rates (pair, rate) 
VALUES ('USD_BRL', 5.3650);

-- Tabela de Ativos da Plataforma (Novos Endpoints)
CREATE TABLE IF NOT EXISTS assets (
    id VARCHAR(50) PRIMARY KEY,
    tipo VARCHAR(50) NOT NULL,
    valor_face NUMERIC(15, 2) NOT NULL,
    moeda VARCHAR(3) NOT NULL,
    vencimento DATE NOT NULL,
    valor_presente_centavos NUMERIC(20, 0) NOT NULL DEFAULT 0,
    desagio_centavos NUMERIC(20, 0) NOT NULL DEFAULT 0,
    valor_presente_brl_centavos NUMERIC(20, 0) NOT NULL DEFAULT 0,
    valor_presente_usd_centavos NUMERIC(20, 0) NOT NULL DEFAULT 0,
    cotacao_dolar_4dp NUMERIC(20, 0) NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'AVALIADO',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE assets
ADD COLUMN IF NOT EXISTS valor_presente_centavos NUMERIC(20, 0) NOT NULL DEFAULT 0;

ALTER TABLE assets
ADD COLUMN IF NOT EXISTS valor_presente_brl_centavos NUMERIC(20, 0) NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS valor_presente_usd_centavos NUMERIC(20, 0) NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS desagio_centavos NUMERIC(20, 0) NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS cotacao_dolar_4dp NUMERIC(20, 0) NOT NULL DEFAULT 0;
