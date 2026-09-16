import express, { Request, Response } from 'express';
import cors from 'cors';
import { Pool, PoolClient } from 'pg';
import { createHash, randomUUID } from 'crypto';

const app = express();

// Habilita CORS e parse de JSON no body
app.use(cors());
app.use(express.json());

// Conexão com o PostgreSQL
const pool = new Pool({
  host: process.env.DB_HOST || 'postgres-db',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'srm_user',
  password: process.env.DB_PASSWORD || 'srm_pass',
  database: process.env.DB_NAME || 'srm_credit_db',
});

const MONEY_SCALE = 100n;
const RATE_SCALE = 10000n;
const BASE_RATE_BASIS_POINTS = 80n;
interface PricingStrategy {
  getSpreadBasisPoints(): bigint;
}

class DuplicataPricingStrategy implements PricingStrategy {
  getSpreadBasisPoints(): bigint { return 150n; }
}

class ChequePricingStrategy implements PricingStrategy {
  getSpreadBasisPoints(): bigint { return 250n; }
}

class ContratoPricingStrategy implements PricingStrategy {
  getSpreadBasisPoints(): bigint { return 200n; }
}

const pricingStrategies: Record<string, PricingStrategy> = {
  DUPLICATA: new DuplicataPricingStrategy(),
  DUPLICATA_MERCANTIL: new DuplicataPricingStrategy(),
  CHEQUE: new ChequePricingStrategy(),
  CHEQUE_PREDATADO: new ChequePricingStrategy(),
  CONTRATO: new ContratoPricingStrategy(),
  CONTRATO_SERVICO: new ContratoPricingStrategy(),
};

function getPricingStrategy(type: string): PricingStrategy {
  return pricingStrategies[type] ?? pricingStrategies.DUPLICATA;
};

function hashAssetRequest(item: Record<string, unknown>): string {
  const payload = {
    cliente: String(item.cliente).trim(),
    tipo: String(item.tipo).trim(),
    valorFace: String(item.valorFace).trim(),
    moeda: String(item.moeda).trim(),
    vencimento: String(item.vencimento).trim(),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

type AuditEvent = {
  eventType: string;
  entityType: string;
  entityId?: string;
  action: string;
  previousData?: unknown;
  currentData?: unknown;
  metadata?: Record<string, unknown>;
};

async function recordAuditEvent(client: Pool | PoolClient, event: AuditEvent): Promise<void> {
  await client.query(
    `INSERT INTO audit_events (
       event_type, entity_type, entity_id, action, previous_data, current_data, metadata
     )
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb)`,
    [
      event.eventType,
      event.entityType,
      event.entityId ?? null,
      event.action,
      event.previousData === undefined ? null : JSON.stringify(event.previousData),
      event.currentData === undefined ? null : JSON.stringify(event.currentData),
      JSON.stringify(event.metadata ?? {}),
    ],
  );
}

function roundAbnt(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) {
    throw new Error('arredondamento requer valores não negativos e denominador positivo.');
  }

  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const comparison = remainder * 2n - denominator;

  if (comparison > 0n) return quotient + 1n;
  if (comparison < 0n) return quotient;
  return quotient % 2n === 0n ? quotient : quotient + 1n;
}

function parseMoneyToCents(value: unknown): bigint {
  const text = String(value ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    throw new Error('valorFace deve ser um número positivo com até duas casas decimais.');
  }

  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * MONEY_SCALE + BigInt(fraction.padEnd(2, '0') || '0');
}

function parseRateToScale(value: unknown): bigint {
  const text = String(value ?? '').trim();
  if (!/^\d+(\.\d{1,4})?$/.test(text)) {
    throw new Error('cotação do dólar inválida.');
  }

  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * RATE_SCALE + BigInt(fraction.padEnd(4, '0') || '0');
}

function calculatePresentValueCents(faceValueCents: bigint, type: string, dueDate: string): bigint {
  const due = new Date(`${dueDate}T00:00:00Z`);
  if (Number.isNaN(due.getTime())) {
    throw new Error('vencimento inválido.');
  }

  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const daysToMaturity = Math.max(Math.ceil((due.getTime() - todayUtc) / 86400000), 0);
  const months = Math.ceil(daysToMaturity / 30);

  if (months === 0) return faceValueCents;

  const spread = getPricingStrategy(type).getSpreadBasisPoints();
  const factor = RATE_SCALE + BASE_RATE_BASIS_POINTS + spread;
  let factorPower = 1n;
  for (let period = 0; period < months; period += 1) {
    factorPower *= factor;
  }

  return roundAbnt(faceValueCents * RATE_SCALE ** BigInt(months), factorPower);
}

function calculateCurrencyValues(presentValueCents: bigint, currency: string, exchangeRate4dp: bigint) {
  if (exchangeRate4dp <= 0n) throw new Error('cotação do dólar inválida.');

  if (currency === 'USD') {
    return {
      brlCents: roundAbnt(presentValueCents * exchangeRate4dp, RATE_SCALE),
      usdCents: presentValueCents,
    };
  }

  return {
    brlCents: presentValueCents,
    usdCents: roundAbnt(presentValueCents * RATE_SCALE, exchangeRate4dp),
  };
}

async function getExchangeRate4dp(client: Pool | PoolClient = pool): Promise<bigint> {
  const result = await client.query(`
    SELECT rate
    FROM exchange_rates
    WHERE pair = 'USD_BRL'
    ORDER BY updated_at DESC
    LIMIT 1;
  `);

  if (result.rows.length === 0) throw new Error('Nenhuma cotação USD/BRL encontrada.');
  return parseRateToScale(result.rows[0].rate);
}

function serializeAsset(row: Record<string, unknown>) {
  return {
    ...row,
    valorFace: Number(row.valorFace),
    desagio: Number(row.desagio) / 100,
    valorPresenteBrl: Number(row.valorPresenteBrl) / 100,
    valorPresenteUsd: Number(row.valorPresenteUsd) / 100,
    cotacaoDolar: Number(row.cotacaoDolar) / Number(RATE_SCALE),
  };
}

async function ensureAssetSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS asset_idempotency_keys (
      cliente VARCHAR(100) NOT NULL,
      idempotency_key VARCHAR(150) NOT NULL,
      request_hash CHAR(64) NOT NULL,
      asset_id VARCHAR(50) NOT NULL UNIQUE,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (cliente, idempotency_key)
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_asset_idempotency_asset
    ON asset_idempotency_keys (asset_id);
  `);
  await pool.query(`
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
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_audit_events_entity
    ON audit_events (entity_type, entity_id, created_at DESC);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_audit_events_created_at
    ON audit_events (created_at DESC);
  `);
  await pool.query(`
    ALTER TABLE assets
    ADD COLUMN IF NOT EXISTS valor_presente_centavos NUMERIC(20, 0) NOT NULL DEFAULT 0;
  `);
  await pool.query(`
    ALTER TABLE assets
    ADD COLUMN IF NOT EXISTS valor_presente_brl_centavos NUMERIC(20, 0) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS valor_presente_usd_centavos NUMERIC(20, 0) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS desagio_centavos NUMERIC(20, 0) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS cotacao_dolar_4dp NUMERIC(20, 0) NOT NULL DEFAULT 0;
  `);

  const result = await pool.query(`
    SELECT id, tipo, valor_face, moeda, TO_CHAR(vencimento, 'YYYY-MM-DD') AS vencimento,
           valor_presente_centavos
    FROM assets
    WHERE valor_face > 0
      AND (desagio_centavos = 0
        OR valor_presente_brl_centavos = 0
        OR valor_presente_usd_centavos = 0
        OR cotacao_dolar_4dp = 0);
  `);
  const exchangeRate4dp = await getExchangeRate4dp();

  for (const asset of result.rows) {
    const faceValueCents = parseMoneyToCents(asset.valor_face);
    const presentValueCents = asset.valor_presente_centavos === '0'
      ? calculatePresentValueCents(faceValueCents, asset.tipo, asset.vencimento)
      : BigInt(asset.valor_presente_centavos);
    const desagioCents = faceValueCents - presentValueCents;
    const currencyValues = calculateCurrencyValues(presentValueCents, asset.moeda, exchangeRate4dp);
    await pool.query(
      `UPDATE assets
       SET valor_presente_centavos = $1,
           desagio_centavos = $2,
           valor_presente_brl_centavos = $3,
           valor_presente_usd_centavos = $4,
           cotacao_dolar_4dp = $5,
           updated_at = NOW()
         WHERE id = $6`,
        [presentValueCents.toString(), desagioCents.toString(), currencyValues.brlCents.toString(), currencyValues.usdCents.toString(), exchangeRate4dp.toString(), asset.id],
    );
      await recordAuditEvent(pool, {
        eventType: 'ASSET_RECALCULATED',
        entityType: 'ASSET',
        entityId: asset.id,
        action: 'UPDATE',
        currentData: {
          valorPresenteCentavos: presentValueCents.toString(),
          desagioCentavos: desagioCents.toString(),
          cotacaoDolar4dp: exchangeRate4dp.toString(),
        },
        metadata: { reason: 'schema_reconciliation' },
      });
  }
}

// ==========================================
// ENDPOINT DE CÂMBIO
// ==========================================

// GET /api/v1/cambio - Captura cotação recente
app.get('/api/v1/cambio', async (req: Request, res: Response) => {
  try {
    const query = `
      SELECT pair, rate, updated_at 
      FROM exchange_rates 
      WHERE pair = 'USD_BRL' 
      ORDER BY updated_at DESC LIMIT 1;
    `;
    const result = await pool.query(query);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Nenhuma cotação encontrada.' });
    }

    const { rate, updated_at } = result.rows[0];
    return res.json({ pair: 'USD_BRL', rate: parseFloat(rate), updatedAt: updated_at });
  } catch (error) {
    console.error('Erro ao buscar câmbio:', error);
    return res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

// ==========================================
// ENDPOINTS DE ATIVOS (/ativo)
// ==========================================

// 1. POST /api/v1/ativo - Envia uma lista de ativos para avaliação
app.post('/api/v1/ativo', async (req: Request, res: Response) => {
  const body = req.body;
  const listaAtivos = Array.isArray(body) ? body : [body];

  if (listaAtivos.length === 0) {
    return res.status(400).json({ error: 'Forneça ao menos um ativo na lista.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const exchangeRate4dp = await getExchangeRate4dp(client);
    const salvos = [];

    for (const item of listaAtivos) {
      const cliente = String(item.cliente ?? '').trim();
      const idempotencyKey = String(item.idempotencyKey ?? '').trim();
      if (!cliente || !idempotencyKey) {
        throw new Error('Cada ativo deve informar cliente e idempotencyKey.');
      }

      const requestHash = hashAssetRequest(item);
      const idempotencyResult = await client.query(
        `INSERT INTO asset_idempotency_keys (cliente, idempotency_key, request_hash, asset_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (cliente, idempotency_key) DO NOTHING
         RETURNING asset_id`,
         [cliente, idempotencyKey, requestHash, `PENDING-${randomUUID()}`],
      );
      if (idempotencyResult.rows.length === 0) {
        const existingKey = await client.query(
          `SELECT request_hash, asset_id
           FROM asset_idempotency_keys
           WHERE cliente = $1 AND idempotency_key = $2
           FOR UPDATE`,
          [cliente, idempotencyKey],
        );
        const existing = existingKey.rows[0];
        if (!existing || existing.request_hash !== requestHash) {
          throw new Error('idempotencyKey já utilizada com dados diferentes.');
        }
        const existingAsset = await client.query(
          `SELECT id, tipo, valor_face AS "valorFace", moeda,
                  TO_CHAR(vencimento, 'YYYY-MM-DD') AS vencimento,
                  desagio_centavos AS "desagio",
                  valor_presente_brl_centavos AS "valorPresenteBrl",
                  valor_presente_usd_centavos AS "valorPresenteUsd",
                  cotacao_dolar_4dp AS "cotacaoDolar", status
           FROM assets WHERE id = $1`,
          [existing.asset_id],
        );
        if (existingAsset.rows.length === 0) {
          throw new Error('Registro idempotente não encontrado.');
        }
        salvos.push(serializeAsset(existingAsset.rows[0]));
        continue;
      }

      const idGen = `ATV-${Math.floor(1000 + Math.random() * 9000)}`;
      const faceValueCents = parseMoneyToCents(item.valorFace);
      const presentValueCents = calculatePresentValueCents(faceValueCents, item.tipo, item.vencimento);
      const desagioCents = faceValueCents - presentValueCents;
      const currencyValues = calculateCurrencyValues(presentValueCents, item.moeda, exchangeRate4dp);
      const query = `
        INSERT INTO assets (
          id, tipo, valor_face, moeda, vencimento, valor_presente_centavos, desagio_centavos,
          valor_presente_brl_centavos, valor_presente_usd_centavos, cotacao_dolar_4dp, status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'AVALIADO')
        RETURNING id, tipo, valor_face AS "valorFace", moeda,
                  TO_CHAR(vencimento, 'YYYY-MM-DD') AS vencimento,
                  desagio_centavos AS "desagio",
                  valor_presente_brl_centavos AS "valorPresenteBrl",
                  valor_presente_usd_centavos AS "valorPresenteUsd",
                  cotacao_dolar_4dp AS "cotacaoDolar", status;
      `;
      const values = [
        idGen, item.tipo, Number(faceValueCents) / 100, item.moeda, item.vencimento,
        presentValueCents.toString(), desagioCents.toString(), currencyValues.brlCents.toString(),
        currencyValues.usdCents.toString(), exchangeRate4dp.toString(),
      ];
      const result = await client.query(query, values);
      await client.query(
        `UPDATE asset_idempotency_keys SET asset_id = $1
         WHERE cliente = $2 AND idempotency_key = $3`,
        [idGen, cliente, idempotencyKey],
      );
      salvos.push(serializeAsset(result.rows[0]));
      await recordAuditEvent(client, {
        eventType: 'ASSET_CREATED',
        entityType: 'ASSET',
        entityId: idGen,
        action: 'CREATE',
        currentData: result.rows[0],
        metadata: { source: 'POST /api/v1/ativo' },
      });
    }

    await client.query('COMMIT');
    return res.status(201).json(salvos);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao salvar ativos:', error);
    const message = error instanceof Error ? error.message : '';
    const status = message.includes('idempotencyKey') ? 409 : message.includes('cliente') ? 400 : 500;
    return res.status(status).json({ error: status === 500 ? 'Erro transacional ao cadastrar ativos.' : message });
  } finally {
    client.release();
  }
});

// 2. GET /api/v1/ativo - Consulta a lista de ativos e seus status
app.get('/api/v1/ativo', async (req: Request, res: Response) => {
  try {
    const query = `
      SELECT id, tipo, valor_face AS "valorFace", moeda,
             TO_CHAR(vencimento, 'YYYY-MM-DD') AS vencimento,
              desagio_centavos AS "desagio",
              valor_presente_brl_centavos AS "valorPresenteBrl",
              valor_presente_usd_centavos AS "valorPresenteUsd",
              cotacao_dolar_4dp AS "cotacaoDolar", status
      FROM assets 
      ORDER BY created_at DESC;
    `;
    const result = await pool.query(query);
    return res.json(result.rows.map(serializeAsset));
  } catch (error) {
    console.error('Erro ao consultar ativos:', error);
    return res.status(500).json({ error: 'Erro ao buscar ativos no banco.' });
  }
});

// 3. PUT /api/v1/ativo - Atualiza status dos ativos aprovados/liquidados
app.put('/api/v1/ativo', async (req: Request, res: Response) => {
  const body = req.body;
  const listaAtualizacao = Array.isArray(body) ? body : [body];

  if (listaAtualizacao.length === 0) {
    return res.status(400).json({ error: 'Nenhum ativo informado para atualização.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const exchangeRate4dp = await getExchangeRate4dp(client);
    const atualizados = [];

    for (const item of listaAtualizacao) {
      const existing = await client.query(
        `SELECT id, tipo, valor_face AS "valorFace", moeda, vencimento,
                valor_presente_centavos AS "valorPresente",
                desagio_centavos AS "desagio",
                TO_CHAR(vencimento, 'YYYY-MM-DD') AS "vencimentoFormatado"
         FROM assets WHERE id = $1 FOR UPDATE`,
        [item.id],
      );
      if (existing.rows.length === 0) continue;

      const asset = existing.rows[0];
      const nextStatus = item.status || 'LIQUIDADO';
      const desagioCents = parseMoneyToCents(asset.valorFace) - BigInt(asset.valorPresente);
      const currencyValues = calculateCurrencyValues(BigInt(asset.valorPresente), asset.moeda, exchangeRate4dp);
      const query = `
        UPDATE assets
        SET status = $1,
            valor_presente_brl_centavos = $2,
            valor_presente_usd_centavos = $3,
            cotacao_dolar_4dp = $4,
            desagio_centavos = $5,
            updated_at = NOW()
          WHERE id = $6
        RETURNING id, tipo, valor_face AS "valorFace", moeda,
                  TO_CHAR(vencimento, 'YYYY-MM-DD') AS vencimento,
                desagio_centavos AS "desagio",
                  valor_presente_brl_centavos AS "valorPresenteBrl",
                  valor_presente_usd_centavos AS "valorPresenteUsd",
                  cotacao_dolar_4dp AS "cotacaoDolar", status;
      `;
      const result = await client.query(query, [
        nextStatus, currencyValues.brlCents.toString(),
        currencyValues.usdCents.toString(), exchangeRate4dp.toString(), desagioCents.toString(), item.id,
      ]);
      if (result.rows.length > 0) {
        atualizados.push(serializeAsset(result.rows[0]));
        if (asset.status !== nextStatus) {
          await recordAuditEvent(client, {
            eventType: 'ASSET_STATUS_CHANGED',
            entityType: 'ASSET',
            entityId: item.id,
            action: 'UPDATE',
            previousData: { status: asset.status },
            currentData: { status: nextStatus },
            metadata: { source: 'PUT /api/v1/ativo' },
          });
        }
      }
    }

    await client.query('COMMIT');
    return res.json({ message: 'Ativos atualizados com sucesso.', atualizados });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao atualizar ativos:', error);
    return res.status(500).json({ error: 'Erro ao atualizar status dos ativos.' });
  } finally {
    client.release();
  }
});

const PORT = process.env.PORT || 3000;
ensureAssetSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Serviço de Câmbio e Ativos rodando na porta ${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Erro ao preparar schema de ativos:', error);
    process.exit(1);
  });
